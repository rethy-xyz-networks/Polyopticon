// Settings panel: General (app settings), Sources (add/edit/remove), Accounts
// (API keys, Bluesky, Telegram login) and Storage.

import { api, $, h, maxAgeLabel, bytes, flash } from './dom.js';
import { icon } from './icons.js';
import { state, groupSources } from './state.js';
import { onSnapshotsCleared } from './tabs.js';

const SETTING_LABELS = {
  FontSize: v => `${v}pt`,
  DescriptionLength: v => (v === 0 ? 'Off' : `${v} characters`),
  RefreshIntervalSeconds: v => `${v}s`,
  MaxArticleAgeHours: maxAgeLabel,
  MaxFeedItems: v => String(v),
  WebViewZoom: v => `${Math.round(v * 100)}%`,
  SourceStaggerMs: v => `${v} ms`,
  LogRetentionCount: v => `${v} files`,
  SnapshotRetentionDays: v => (v === 0 ? 'Forever' : `${v} days`),
};

let onSettingChanged = () => {};
let saveTimer = null;

// General

export function setSetting(key, value) {
  if (state.settings[key] === value) return;
  state.settings[key] = value;
  onSettingChanged(key);
  syncSettingControl(key);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveSettings(state.settings), 250);
}

export function syncSettingControl(key) {
  const v = state.settings[key];
  const ctl = document.querySelector(`[data-setting="${key}"]`);
  if (!ctl) return;
  if (ctl.classList.contains('segmented'))
    for (const b of ctl.children) b.classList.toggle('on', Number(b.dataset.value) === v);
  else if (ctl.type === 'checkbox') ctl.checked = v;
  else if (document.activeElement !== ctl || ctl.type !== 'range') ctl.value = v;
  const out = document.querySelector(`output[data-for="${key}"]`);
  if (out) out.textContent = SETTING_LABELS[key](v);
}

function bindGeneral() {
  for (const ctl of document.querySelectorAll('[data-setting]')) {
    const key = ctl.dataset.setting;
    if (ctl.classList.contains('segmented'))
      ctl.addEventListener('click', e => { const b = e.target.closest('button'); if (b) setSetting(key, Number(b.dataset.value)); });
    else if (ctl.type === 'checkbox') ctl.addEventListener('change', () => setSetting(key, ctl.checked));
    else if (ctl.type === 'range')    ctl.addEventListener('input', () => setSetting(key, Number(ctl.value)));
    else                              ctl.addEventListener('change', () => setSetting(key, ctl.value));
  }
}

// Panel open / close / tabs

export function openSettings(tab = 'general') {
  const overlay = $('settings-overlay');
  showTab(tab);
  overlay.hidden = false;
  $('btn-settings').classList.add('on');
  // Next frame, so the panel slides in — unless it was closed again in the meantime.
  requestAnimationFrame(() => { if ($('btn-settings').classList.contains('on')) overlay.classList.add('open'); });
}

const isOpen = () => !$('settings-overlay').hidden && $('btn-settings').classList.contains('on');

/**
 * The ⚙️ button (no tab): open, or close if open. The ✏️ sources button: open on
 * Sources, or close if Sources is already showing (another page switches to Sources).
 */
export function toggleSettings(tab) {
  const current = document.querySelector('#settings-tabs button.on')?.dataset.tab;
  if (isOpen() && (!tab || tab === current)) closeSettings();
  else openSettings(tab ?? 'general');
}

export function closeSettings() {
  const overlay = $('settings-overlay');
  if (overlay.hidden) return;
  $('btn-settings').classList.remove('on');
  overlay.classList.remove('open');
  // Hidden once it has slid out (0.2 s). A timer, not transitionend: closed before it
  // ever slid in, there is no transition, and an invisible overlay would block clicks.
  setTimeout(() => { if (!$('btn-settings').classList.contains('on')) overlay.hidden = true; }, 250);
}

function showTab(tab) {
  for (const b of document.querySelectorAll('#settings-tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('.settings-page')) p.hidden = p.dataset.page !== tab;
  if (tab === 'sources') renderSourceList();
  if (tab === 'accounts') renderAccounts();
  if (tab === 'storage') renderStorage();
}

// Sources

let editing = null;          // source being edited (object) or {} for new; null = list view
let confirmDelete = null;    // source id awaiting delete confirmation

export function renderSourceList() {
  const page = $('sources-page');
  if (editing) return renderSourceEditor(page);

  const groups = groupSources(state.sources);

  page.replaceChildren(
    h('div', { class: 'src-toolbar' },
      h('button', { class: 'primary-btn', onclick: () => { editing = { type: 'rss', enabled: true, config: {} }; renderSourceList(); } }, '+ Add source'),
      h('span', { class: 'muted' }, `${state.sources.filter(s => s.enabled).length} of ${state.sources.length} enabled`)),
    ...groups.map(([grp, list]) => h('div', { class: 'src-group' },
      h('h4', {}, grp),
      ...list.map(s => {
        const st = state.statuses.get(s.id);
        const status = !s.enabled ? null
          : st?.isError ? h('span', { class: 'stat red' }, ` · ${st.label}`)
          : st ? h('span', { class: 'stat' }, ` · OK · ${state.sourceCounts.get(s.id) ?? 0} in list`)
          : h('span', { class: 'stat' }, ' · waiting for first poll');
        return h('div', { class: `src-row${s.enabled ? '' : ' disabled'}` },
          h('span', { class: 'dot', style: `background:${s.color}` }),
          h('div', { class: 'src-main' },
            h('div', { class: 'src-name' }, s.name),
            h('div', { class: 'src-type' }, state.types[s.type]?.label ?? s.type, status)),
          confirmDelete === s.id
            ? h('span', { class: 'confirm' }, 'Delete with its stored items?',
                h('button', { class: 'link-btn danger', onclick: async () => { confirmDelete = null; await api.deleteSource(s.id); } }, 'Delete'),
                h('button', { class: 'link-btn', onclick: () => { confirmDelete = null; renderSourceList(); } }, 'Cancel'))
            : [
                h('label', { class: 'switch mini', title: s.enabled ? 'Enabled' : 'Disabled' },
                  h('input', { type: 'checkbox', checked: s.enabled, onchange: e => api.toggleSource(s.id, e.target.checked) }),
                  h('span', { class: 'track' })),
                h('button', { class: 'icon-btn', title: 'Edit', onclick: () => { editing = structuredClone(s); renderSourceList(); } }, icon('edit')),
                h('button', { class: 'icon-btn', title: 'Delete', onclick: () => { confirmDelete = s.id; renderSourceList(); } }, icon('delete')),
              ]);
      })))
  );
}

function renderSourceEditor(page) {
  const s = editing;
  const types = state.types;
  const meta = types[s.type];
  const groupsList = [...new Set(state.sources.map(x => x.grp))];
  const err = h('div', { class: 'form-error', hidden: true });

  const field = (label, input, help) => h('label', { class: 'form-field' }, h('span', {}, label), input, help && h('small', {}, help));

  const typeSel = h('select', { disabled: !!s.id, onchange: e => { editing = { ...s, type: e.target.value, config: {} }; renderSourceList(); } },
    Object.entries(types).map(([k, t]) => h('option', { value: k, selected: k === s.type }, t.label)));
  const name  = h('input', { type: 'text', value: s.name ?? '', placeholder: 'Shown on the badge' });
  const grp   = h('input', { type: 'text', value: s.grp ?? '', placeholder: 'Sidebar group', list: 'group-list' });
  const cat   = h('input', { type: 'text', value: s.category ?? '', placeholder: 'e.g. US, TG', maxlength: 8 });
  const color = h('input', { type: 'color', value: s.color || '#1565C0' });
  const interval = h('input', { type: 'number', min: meta.minInterval, step: 5, value: s.config.interval ?? '',
    placeholder: meta.defaultInterval === 'global' ? 'Refresh interval setting' : `${meta.defaultInterval}` });

  const cfgInputs = meta.fields.map(f => {
    const input = f.type === 'select'
      ? h('select', {}, f.options.map(([v, l]) => h('option', { value: v, selected: (s.config[f.key] ?? f.default) === v }, l)))
      : h('input', { type: f.type === 'url' ? 'url' : 'text', value: s.config[f.key] ?? '', placeholder: f.placeholder ?? '' });
    input.dataset.key = f.key;
    return field(f.label + (f.required ? ' *' : ''), input);
  });

  const needsKey = meta.credential && !state.accounts?.[meta.credential];

  const save = async () => {
    const config = {};
    for (const el of page.querySelectorAll('[data-key]')) config[el.dataset.key] = el.value;
    if (interval.value) config.interval = Number(interval.value);
    const res = await api.saveSource({
      id: s.id, type: s.type, name: name.value, grp: grp.value, category: cat.value,
      color: s.id || color.dataset.touched ? color.value : null, enabled: s.enabled !== false, config,
    });
    if (!res.ok) { err.textContent = res.error; err.hidden = false; return; }
    editing = null;
    renderSourceList();
  };
  color.addEventListener('input', () => { color.dataset.touched = '1'; });

  page.replaceChildren(
    h('div', { class: 'editor' },
      h('h4', {}, s.id ? `Edit “${s.name}”` : 'Add source'),
      field('Type', typeSel),
      h('p', { class: 'help' }, meta.help),
      needsKey && h('p', { class: 'warn-box' }, 'This source type needs an API key; add it under ',
        h('button', { class: 'link-btn', onclick: () => showTab('accounts') }, 'Accounts'), '.'),
      ...cfgInputs,
      h('div', { class: 'form-row' }, field('Name *', name), field('Badge', cat)),
      h('div', { class: 'form-row' }, field('Group', grp), field('Colour', color)),
      field(`Poll every (seconds, min ${meta.minInterval})`, interval),
      h('datalist', { id: 'group-list' }, groupsList.map(g => h('option', { value: g }))),
      err,
      h('div', { class: 'form-actions' },
        h('button', { class: 'primary-btn', onclick: save }, s.id ? 'Save' : 'Add'),
        h('button', { class: 'link-btn', onclick: () => { editing = null; renderSourceList(); } }, 'Cancel'))));
  (cfgInputs[0]?.querySelector('input') ?? name).focus();
}

// Accounts

const KEY_SERVICES = [
  ['guardianKey', 'The Guardian', 'https://open-platform.theguardian.com/access/', 'Free developer key, 500 calls/day.'],
  ['nytKey', 'New York Times', 'https://developer.nytimes.com/get-started', 'Free key; enable “Times Newswire” and “Top Stories” for your app.'],
  ['newsapiKey', 'NewsAPI.org', 'https://newsapi.org/register', 'Free developer plan: 100 requests/day, articles delayed 24h.'],
];

let tgPrompt = null;   // { what, hint } while the login is waiting for input
let tgError = null;
let tgBusy = false;

export function renderAccounts() {
  const acc = state.accounts;
  const page = $('accounts-page');
  const link = (url, text) => h('button', { class: 'link-btn', onclick: () => api.openExternal(url) }, text);

  // Telegram
  const tg = acc.telegram;
  const apiId = h('input', { type: 'text', value: tg.apiId, placeholder: 'api_id (numbers)' });
  const apiHash = h('input', { type: 'password', placeholder: tg.hasApiHash ? '•••••••• saved' : 'api_hash' });
  const phone = h('input', { type: 'tel', placeholder: '+1 902 555 0123' });
  const tgSection = h('section', { class: 'acct' },
    h('h4', {}, '✈ Telegram'),
    tg.user
      ? [h('p', {}, 'Logged in as ', h('b', {}, tg.user), '. Channels are read directly and joined channels arrive instantly.'),
         h('button', { class: 'link-btn danger', onclick: async () => { await api.telegramLogout(); } }, 'Log out')]
      : [
          h('p', { class: 'help' }, 'Optional: public channels already work without an account. Logging in adds instant delivery and channels without a web preview. Create an app at ',
            link('https://my.telegram.org/apps', 'my.telegram.org'), ' to get your own api_id and api_hash.'),
          tgPrompt
            ? tgPromptForm()
            : h('div', { class: 'form-grid' }, apiId, apiHash, phone,
                h('button', { class: 'primary-btn', disabled: tgBusy, onclick: async () => {
                  tgError = null; tgBusy = true; renderAccounts();
                  const res = await api.telegramLogin({ apiId: apiId.value.trim() || tg.apiId, apiHash: apiHash.value.trim(), phone: phone.value });
                  if (!res.ok) { tgError = res.error; tgBusy = false; renderAccounts(); }
                } }, tgBusy ? 'Connecting…' : 'Log in')),
        ],
    tgError && h('div', { class: 'form-error' }, tgError));

  // Bluesky
  const bHandle = h('input', { type: 'text', value: acc.bluesky?.handle ?? '', placeholder: 'you.bsky.social' });
  const bPass = h('input', { type: 'password', placeholder: acc.bluesky ? '•••••••• saved' : 'App password' });
  const bsky = h('section', { class: 'acct' },
    h('h4', {}, '🦋 Bluesky'),
    h('p', { class: 'help' }, 'Optional: makes search more reliable. Use an ',
      link('https://bsky.app/settings/app-passwords', 'app password'), ', not your main password.'),
    h('div', { class: 'form-grid two' }, bHandle, bPass,
      h('button', { class: 'primary-btn', onclick: async e => {
        if (!bHandle.value || !bPass.value) return;
        state.accounts = await api.saveAccounts({ bluesky: { handle: bHandle.value, appPassword: bPass.value } });
        flash(e.target, 'Saved ✓'); renderAccounts();
      } }, 'Save'),
      acc.bluesky && h('button', { class: 'link-btn danger', onclick: async () => {
        state.accounts = await api.saveAccounts({ bluesky: null }); renderAccounts();
      } }, 'Remove')));

  // API keys
  const keys = h('section', { class: 'acct' }, h('h4', {}, '🔑 API keys'),
    h('p', { class: 'help' }, 'All free. Keys are encrypted with your Windows account and never shown again.'),
    ...KEY_SERVICES.map(([k, label, url, note]) => {
      const input = h('input', { type: 'password', placeholder: acc[k] ? '•••••••• saved' : 'Paste key' });
      return h('div', { class: 'key-row' },
        h('div', { class: 'key-label' }, h('b', {}, label), acc[k] && h('span', { class: 'ok-tag' }, '✓ saved'),
          h('small', {}, note, ' ', link(url, 'Get a key'))),
        h('div', { class: 'key-input' }, input,
          h('button', { class: 'primary-btn', onclick: async () => {
            if (!input.value.trim()) return;
            state.accounts = await api.saveAccounts({ [k]: input.value }); renderAccounts();
          } }, 'Save'),
          acc[k] && h('button', { class: 'link-btn danger', onclick: async () => {
            state.accounts = await api.saveAccounts({ [k]: '' }); renderAccounts();
          } }, 'Clear')));
    }));

  page.replaceChildren(tgSection, bsky, keys);
}

function tgPromptForm() {
  const isCode = tgPrompt.what === 'code';
  const input = h('input', { type: isCode ? 'text' : 'password', inputmode: isCode ? 'numeric' : null, autocomplete: 'one-time-code',
    placeholder: isCode ? 'Login code' : `2FA password${tgPrompt.hint ? ` (hint: ${tgPrompt.hint})` : ''}` });
  const submit = () => {
    if (!input.value) return;
    api.telegramAnswer(tgPrompt.what, input.value);
    tgPrompt = null; tgError = null; tgBusy = true;
    renderAccounts();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  setTimeout(() => input.focus());
  return h('div', {},
    h('p', {}, isCode ? 'Telegram sent a login code to your Telegram app (or by SMS). Enter it here:' : 'Your account has two-step verification. Enter your password:'),
    h('div', { class: 'form-grid two' }, input, h('button', { class: 'primary-btn', onclick: submit }, 'Continue')));
}

function bindTelegramEvents() {
  api.onTelegramAsk((what, hint) => { tgPrompt = { what, hint }; tgBusy = false; renderAccounts(); openSettings('accounts'); });
  api.onTelegramError((message, fatal) => {
    tgError = /PHONE_CODE_INVALID/.test(message) ? 'That code was wrong; try again.'
            : /PASSWORD_HASH_INVALID/.test(message) ? 'Wrong password; try again.'
            : /PHONE_NUMBER_INVALID/.test(message) ? 'Telegram rejected that phone number. Include the country code, e.g. +1…'
            : /API_ID_INVALID/.test(message) ? 'api_id / api_hash were rejected; copy them again from my.telegram.org.'
            : message;
    if (fatal) { tgPrompt = null; tgBusy = false; }
    renderAccounts();
  });
  api.onTelegramDone(() => { tgPrompt = null; tgError = null; tgBusy = false; });
}

// Storage

async function renderStorage() {
  const [s, t] = await Promise.all([api.storageStats(), api.translateStats()]);
  $('storage-stats').replaceChildren(
    ...[['Stored items', s.items.toLocaleString()], ['Article opens', s.opens.toLocaleString()],
        ['Saved articles', s.snapshots.toLocaleString()], ['Database', bytes(s.dbBytes)],
        ['Saved pages on disk', bytes(s.pagesOnDisk)], ['Translation models', bytes(t.modelsBytes)]]
      .map(([k, v]) => h('div', { class: 'stat-row' }, h('span', {}, k), h('b', {}, v))),
    h('p', { class: 'log-path' }, s.dataDir));
}

/** A delete button: the first click asks "Sure?", a second within 4 s runs `action`. */
function bindClearButton(id, action) {
  const btn = $(id), label = btn.textContent;
  let armed = null;
  const disarm = () => { clearTimeout(armed); armed = null; btn.textContent = label; };
  btn.addEventListener('click', async () => {
    if (!armed) { btn.textContent = 'Click again to delete'; armed = setTimeout(disarm, 4000); return; }
    disarm();
    btn.disabled = true;
    try { await action(); flash(btn, 'Cleared ✓', 1500); }
    catch { flash(btn, 'Failed', 1500); }
    finally { btn.disabled = false; renderStorage(); }
  });
}

// Media bias
// Each RSS source is looked up once (main/bias.js); this shows how far that has got and forces a new lookup.

export function renderBiasStatus() {
  const feeds = state.sources.filter(s => s.type === 'rss');
  const checked = feeds.filter(s => state.bias.has(s.id));
  const rated = checked.filter(s => state.bias.get(s.id).outlet?.x != null);
  const p = state.biasProgress;
  $('bias-status').textContent = p ? `Looking up feed ${p.done + 1} of ${p.total}…`
    : !feeds.length ? ''
    : `${checked.length} of ${feeds.length} feeds checked, ${rated.length} with a rating.${checked.length < feeds.length ? ' The rest are looked up shortly after start-up, or when added.' : ''}`;
  $('btn-bias-recheck').disabled = !!p;
}

// Screenshot folder
// Chosen with the system folder picker; empty means the Pictures folder.

export function renderScreenshotFolder() {
  const custom = state.settings.ScreenshotFolder;
  const dir = custom || state.picturesDir || 'Pictures';
  $('screenshot-folder').textContent = $('screenshot-folder').title = dir;
  $('btn-screenshot-folder-reset').hidden = !custom;
}

function bindScreenshotFolder() {
  $('btn-screenshot-folder').addEventListener('click', async () => {
    const dir = await api.chooseScreenshotFolder();
    if (dir) setSetting('ScreenshotFolder', dir);
  });
  $('btn-screenshot-folder-reset').addEventListener('click', () => setSetting('ScreenshotFolder', ''));
}

// Init

export function initSettings(onChange) {
  onSettingChanged = onChange;
  bindGeneral();
  bindTelegramEvents();
  bindScreenshotFolder();
  for (const b of document.querySelectorAll('#settings-tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  $('settings-overlay').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSettings(); });
  $('btn-open-data').addEventListener('click', () => api.openDataDir());
  $('btn-bias-recheck').addEventListener('click', async () => { await api.recheckBias(); renderBiasStatus(); });
  renderBiasStatus();
  bindClearButton('btn-clear-articles', async () => { await api.clearArticles(); onSnapshotsCleared(); });
  bindClearButton('btn-clear-models', () => api.clearModels());
}

/** Re-render whichever settings page is visible after sources/accounts change. */
export function refreshSettingsPage() {
  if ($('settings-overlay').hidden) return;
  const tab = document.querySelector('#settings-tabs button.on')?.dataset.tab;
  if (tab === 'sources') renderSourceList();
  if (tab === 'accounts') renderAccounts();
}
