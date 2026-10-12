// Sidebar: enabled sources grouped by group (view filter + status), and the
// include / exclude tag filters.

import { api, $, h } from './dom.js';
import { icon } from './icons.js';
import { state, groupSources, isCountryGroup, SECTIONS, sectionOf } from './state.js';
import { scheduleRender, rebuildTagCache, iconUrl } from './feed.js';
import { ui, saveUi } from './ui.js';
import { toggleSearchSource } from './sourcesearch.js';


const SCOPES     = ['T+D', 'T', 'D'];                // TagScope 0=Both 1=Title 2=Description
const SCOPE_TIPS = [
  'Scope: Title + Description — click to switch to Title only',
  'Scope: Title only — click to switch to Description',
  'Scope: Description only — click to switch to Both',
];
const TYPE_ICON = { rss: '', googlenews: 'G', gdelt: '◍', bluesky: '🦋', telegram: '✈', guardian: 'API', nyt: 'API', newsapi: 'API' };

const statEls = new Map();                         // source id → status element

// Sources

export function renderSources() {
  const groups = groupSources(state.sources.filter(s => s.enabled));
  statEls.clear();

  const root = $('source-groups');
  if (!groups.length) {
    root.replaceChildren(h('p', { class: 'muted pad' }, 'No sources enabled. Add some under Settings → Sources.'));
    return;
  }

  // Countries / Areas / Other, each under its own title, divided by a line.
  const boxes = groups.map(([grp, sources]) => {
    const boxes = [];
    const groupBox = h('input', { type: 'checkbox' });
    const syncGroup = () => {
      const on = sources.filter(s => !state.hiddenSources.has(s.id)).length;
      groupBox.checked = on === sources.length;
      groupBox.indeterminate = on > 0 && on < sources.length;
    };
    const rows = sources.map(s => {
      const box  = h('input', { type: 'checkbox', checked: !state.hiddenSources.has(s.id) });
      const stat = h('span', { class: 'stat' });
      statEls.set(s.id, stat);
      paintStatus(s.id);
      box.addEventListener('change', () => {
        if (box.checked) state.hiddenSources.delete(s.id); else state.hiddenSources.add(s.id);
        row.classList.toggle('off', !box.checked);
        syncGroup();
        saveHidden();
        scheduleRender();
      });
      boxes.push([s, box]);
      const icon = TYPE_ICON[s.type];
      const row = h('label', { class: `check source${state.hiddenSources.has(s.id) ? ' off' : ''}${state.searchSources.has(s.id) ? ' in-search' : ''}`,
        title: `${s.name}\n${describeSource(s)}\nRight-click: limit the search to this source`, dataset: { id: s.id },
        oncontextmenu: e => { e.preventDefault(); toggleSearchSource(s.id); } },
        box, sourceIcon(s), h('span', { class: 'name' }, s.name),
        icon && h('span', { class: 'type-icon' }, icon),
        s.category && !isCountryGroup(grp) && h('span', { class: 'cat' }, `[${s.category}]`), stat);
      return row;
    });
    groupBox.addEventListener('change', () => {
      for (const [s, b] of boxes) {
        b.checked = groupBox.checked;
        if (groupBox.checked) state.hiddenSources.delete(s.id); else state.hiddenSources.add(s.id);
        b.closest('.source').classList.toggle('off', !groupBox.checked);
      }
      saveHidden();
      scheduleRender();
    });
    syncGroup();
    // Collapsible: the chevron folds the group away (remembered across launches).
    const collapsed = (ui.collapsedGroups ?? []).includes(grp);
    const box = h('div', { class: `group${collapsed ? ' collapsed' : ''}` });
    const fold = h('button', { class: 'fold', title: 'Collapse / expand',
      onclick: e => {
        e.preventDefault();
        e.stopPropagation();
        const now = box.classList.toggle('collapsed');
        const set = new Set(ui.collapsedGroups ?? []);
        if (now) set.add(grp); else set.delete(grp);
        saveUi({ collapsedGroups: [...set] });
      } }, icon('fold'));
    box.append(
      // Chevron at the right end, in line with the source counts, so the title keeps its place.
      h('label', { class: 'check group-head' }, groupBox, h('span', {}, grp), fold),
      h('div', { class: 'group-body' }, ...rows));
    box.dataset.grp = grp;
    return box;
  });
  const sections = SECTIONS.map(({ key, title }) => {
    const members = boxes.filter(b => sectionOf(b.dataset.grp) === key);
    return members.length && h('div', { class: 'source-section', dataset: { section: key } },
      h('div', { class: 'caps section-title' }, title), ...members);
  }).filter(Boolean);
  root.replaceChildren(...sections.flatMap((s, i) => i ? [h('hr', { class: 'section-rule' }), s] : [s]));
  applySourceFilter();
}

// Finding a source
// Every word typed must appear in the source's name, its group (country) or its
// category code; accents and case don't matter ("ruv" finds RÚV). Typing a country
// therefore shows all of its sources. Collapsed groups open while a search is active.

const plainText = s => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

export function applySourceFilter() {
  const words = plainText($('source-filter').value).split(/\s+/).filter(Boolean);
  const root = $('source-groups');
  root.classList.toggle('filtering', words.length > 0);
  let shown = 0;
  for (const group of root.querySelectorAll('.group')) {
    let any = false;
    for (const row of group.querySelectorAll('.source')) {
      const s = state.sourcesById.get(Number(row.dataset.id));
      const text = plainText(`${group.dataset.grp} ${s?.name} ${s?.category}`);
      const match = words.every(w => text.includes(w));
      row.classList.toggle('filtered-out', !match);
      if (match) { any = true; shown++; }
    }
    group.classList.toggle('filtered-out', !any);
  }
  // A section with nothing left to show hides with its title; a line only sits between shown sections.
  let anyShown = false;
  for (const section of root.querySelectorAll('.source-section')) {
    const empty = !section.querySelector('.group:not(.filtered-out)');
    section.classList.toggle('filtered-out', empty);
    section.previousElementSibling?.classList.toggle('filtered-out', empty || !anyShown);
    anyShown ||= !empty;
  }
  $('source-filter-empty').hidden = !words.length || shown > 0;
}

export function bindSourceFilter() {
  const input = $('source-filter');
  input.addEventListener('input', applySourceFilter);
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; applySourceFilter(); }
  });
}

// Source icons

const FIXED_SITE = { gdelt: 'gdeltproject.org', googlenews: 'news.google.com', guardian: 'theguardian.com', nyt: 'nytimes.com', newsapi: 'newsapi.org' };

/** The site a source's stories come from — feed hosts like feeds.bbci.co.uk rarely have an icon. */
function sourceSite(s) {
  const c = s.config ?? {};
  if (s.type === 'telegram' && c.channel) return { url: `https://t.me/${c.channel}` };
  if (FIXED_SITE[s.type]) return { site: FIXED_SITE[s.type] };
  if (s.type === 'bluesky') {
    // A custom-domain handle (reuters.com) is the publisher itself.
    const handle = c.mode === 'author' && String(c.handle || '').replace(/^@/, '');
    return { site: handle && handle.includes('.') && !handle.endsWith('.bsky.social') ? handle : 'bsky.app' };
  }
  // RSS etc.: the most common site among this source's stories, else the feed's own host.
  const counts = new Map();
  let n = 0;
  for (const it of state.items) {
    if (it.sourceId !== s.id || !it.url) continue;
    const url = iconUrl(it);
    if (url) counts.set(url, (counts.get(url) ?? 0) + 1);
    if (++n >= 30) break;
  }
  if (counts.size) return { icon: [...counts].sort((a, b) => b[1] - a[1])[0][0] };
  try { return { site: new URL(c.url).hostname.replace(/^(feeds?|rss|www)\d*\./, '') }; } catch { return {}; }
}

function sourceIcon(s) {
  const tile = h('span', { class: 'src-fav', style: `background:${s.color || '#555'}` }, (s.name.match(/[A-Za-z0-9]/)?.[0] ?? '•').toUpperCase());
  const found = sourceSite(s);
  const src = found.icon ?? iconUrl({ url: found.url, site: found.site });
  if (src) {
    const img = h('img', { src, alt: '', decoding: 'async', draggable: 'false' });
    img.addEventListener('load', () => tile.classList.add('has-img'), { once: true });
    img.addEventListener('error', () => img.remove(), { once: true });
    tile.append(img);
  }
  return tile;
}

const saveHidden = () => saveUi({ hiddenSources: [...state.hiddenSources] });

function describeSource(s) {
  const t = state.types[s.type]?.label ?? s.type;
  const c = s.config;
  const detail = c.url || c.query || c.channel && `t.me/${c.channel}` || c.handle && `@${c.handle}` || c.keywords || c.section || '';
  return `${t}${detail ? ` — ${detail}` : ''}`;
}

export function setStatus(sourceId, label, isError) {
  state.statuses.set(sourceId, { label, isError });
  paintStatus(sourceId);
}

// Errors show their label (HTTP 403, NO KEY…); otherwise the number of this
// source's items in the live list.
function paintStatus(sourceId) {
  const el = statEls.get(sourceId);
  if (!el) return;
  const st = state.statuses.get(sourceId);
  if (st?.isError) {
    el.textContent = st.label;
    el.className = 'stat red';
    el.title = 'Last poll failed — see Settings → Sources';
    return;
  }
  const n = state.sourceCounts.get(sourceId) ?? 0;
  el.textContent = st || n ? String(n) : '';
  el.className = `stat ${n > 149 ? 'red' : n > 75 ? 'orange' : n > 25 ? 'green' : ''}`;
  el.title = 'Items in the live list';
}

let countsQueued = false;
export function repaintCounts() {
  if (countsQueued) return;
  countsQueued = true;
  requestAnimationFrame(() => { countsQueued = false; for (const id of statEls.keys()) paintStatus(id); });
}

// Tags

function tagsChanged() {
  rebuildTagCache();
  api.saveTags(state.tags);
  renderTags();
  scheduleRender();
}

export function renderTags() {
  for (const kind of ['Inclusions', 'Exclusions']) {
    const list = state.tags[kind];
    $(`tags-${kind}`).replaceChildren(...list.map(tag =>
      h('li', { class: tag.IsActive ? '' : 'inactive' },
        h('input', { type: 'checkbox', checked: tag.IsActive, title: 'Enable / disable',
          onchange: e => { tag.IsActive = e.target.checked; tagsChanged(); } }),
        h('span', { class: 'text', title: tag.Text }, tag.Text),
        h('button', { class: 'icon-btn', title: SCOPE_TIPS[tag.Scope],
          onclick: () => { tag.Scope = (tag.Scope + 1) % 3; tagsChanged(); } }, SCOPES[tag.Scope]),
        h('button', { class: 'icon-btn remove', title: 'Remove tag',
          onclick: () => {
            list.splice(list.indexOf(tag), 1);
            api.log('info', `${kind === 'Inclusions' ? 'Inclusion' : 'Exclusion'} tag removed: '${tag.Text}'`);
            tagsChanged();
          } }, icon('close')))));
  }
}

export function bindTagForms() {
  for (const form of document.querySelectorAll('.tag-add')) {
    form.addEventListener('submit', e => {
      e.preventDefault();
      const input = form.querySelector('input');
      const text = input.value.trim();
      const list = state.tags[form.dataset.kind];
      if (!text || list.some(t => t.Text.toLowerCase() === text.toLowerCase())) return;
      list.push({ Text: text, IsActive: true, Scope: 0 });
      input.value = '';
      api.log('info', `${form.dataset.kind === 'Inclusions' ? 'Inclusion' : 'Exclusion'} tag added: '${text}'`);
      tagsChanged();
    });
  }
}
