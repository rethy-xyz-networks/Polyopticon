// Story tabs. Each tab shows one article in one of three modes:
//   live   — the real page (captured for offline use once it finishes loading)
//   page   — the saved MHTML copy (works offline)
//   reader — clean text extracted at save time (works offline)
// plus two app pages: the keyboard shortcut list (Ctrl+? or the ? button) and the Scratchpad (📜),
// and 'chan' tabs, live only: 4chan (the 🍀 button: /pol/ and threads opened from it) and
// public Telegram channels (the ✈️ button: t.me/s/<channel>).

import { api, $, h, flash, relTime, showMenu } from './dom.js';
import { icon } from './icons.js';
import { state } from './state.js';
import { markSaved, unmarkAllSaved, siteIcon } from './feed.js';
import { renderShortcutList } from './shortcuts.js';
import { makeReorderable } from './reorder.js';
import { telegramChannelOf, telegramUrl, parseTelegramChannel } from './telegram.js';
import { initScratch, focusScratch, flushScratch, appendToScratch } from './scratchpad.js';

// Background article pages keep running scripts, ads and video. Only the most
// recently used few stay alive; older ones are discarded and reload on return.
const MAX_LIVE_VIEWS = 3;
const CAPTURE_DELAY_MS = 3000;
// Chromium net errors that mean "can't reach the site" → fall back to the saved copy.
const OFFLINE_ERRORS = new Set([-7, -21, -100, -101, -102, -104, -105, -106, -109, -118, -130, -137, -324]);

const MODE_LABEL = { live: 'Live', page: 'Saved page', reader: 'Reader' };

export const activeTab = () => state.tabs.find(t => t.id === state.activeTabId) ?? null;

// Opening

export async function openTab(it, { preferSaved = false } = {}) {
  if (!it.url) {
    api.log('warn', `Tab: skipped '${it.title}' — no URL`);
    return;
  }
  const existing = state.tabs.find(t => !t.kind && t.item.url === it.url);
  if (existing) return activateTab(existing);

  const tab = newTab(it);
  state.tabs.push(tab);
  api.recordOpen(it.id, 'tab');
  api.setState('app.story_tabs', state.tabs.length);
  saveTabs();

  tab.snap = await api.snapshot(it.id);
  if (preferSaved || !navigator.onLine) tab.mode = tab.snap.pageUrl ? 'page' : tab.snap.hasText ? 'reader' : 'live';
  if (state.settings.AlwaysOpenInBrowser && tab.mode === 'live') {
    // Still tracked as a tab so it shows its summary; the page itself opens outside.
    api.recordOpen(it.id, 'browser');
  }
  activateTab(tab);
}

// The app's own pages are tabs like any other (reorder, pin, close): the shortcut list, and the
// Scratchpad (scratchpad.js), one permanent note. No web page, nothing saved with the tab.
const HELP_TAB_ID = -1;
const SCRATCH_TAB_ID = -999999;
const APP_TABS = {
  help:    { id: HELP_TAB_ID,    title: 'Keyboard shortcuts' },
  scratch: { id: SCRATCH_TAB_ID, title: 'Scratchpad' },
};
const isApp = tab => tab?.kind === 'help' || tab?.kind === 'scratch';
const appTab = kind => ({ ...newTab({ id: APP_TABS[kind].id, title: APP_TABS[kind].title, sourceName: 'Polyopticon' }), kind });

export function openHelpTab() {
  let tab = state.tabs.find(t => t.id === HELP_TAB_ID);
  if (!tab) {
    tab = appTab('help');
    state.tabs.push(tab);
    saveTabs();
  }
  activateTab(tab);
}

export function openScratchTab() {
  let tab = state.tabs.find(t => t.id === SCRATCH_TAB_ID);
  if (!tab) {
    tab = appTab('scratch');
    state.tabs.push(tab);
    api.setState('app.story_tabs', state.tabs.length);
    saveTabs();
  }
  activateTab(tab);
  focusScratch();
}

// 4chan and Telegram channels
// Not stories: no item in the database, never saved. They run on their own
// memory-only session (src/main/fourchan.js); a middle-clicked link in one opens
// as another tab of the same kind, so single threads can be watched. Like story
// tabs they can be reordered, pinned (they reopen at the next start), zoomed, and
// moved with Back / Forward / Reload.

const CHAN_HOME = 'https://boards.4chan.org/pol/';
let nextChanId = -2;                                           // -1 is the shortcut list

const siteOf = url => (telegramChannelOf(url) ? 'telegram' : '4chan');
const SITE_LABEL = { '4chan': '4chan', telegram: 'Telegram' };
const SITE_ICON  = { '4chan': 'chan', telegram: 'telegram' };

/** A readable name until the page sends its title: "/pol/", "/pol/ 123456" or "@durov". */
function chanTitle(url) {
  const tg = telegramChannelOf(url);
  if (tg) return `@${tg}`;
  try {
    const [board, kind, no] = new URL(url).pathname.split('/').filter(Boolean);
    if (!board) return '4chan';
    return kind === 'thread' && no ? `/${board}/ ${no}` : `/${board}/`;
  } catch { return url; }
}

/** The 🍀 button: the /pol/ tab, opened if needed. */
export function openChanHome() {
  const home = state.tabs.find(t => t.kind === 'chan' && t.home);
  if (home) return activateTab(home);
  openChanTab(CHAN_HOME, { home: true });
}

/**
 * The ✈️ button: a new Telegram tab. Where the title would be there's a field for the channel's
 * name or link; once connected the field goes away and the tab shows the channel's page.
 */
export function openTelegramDraft() {
  let tab = state.tabs.find(t => t.kind === 'chan' && t.draft);
  if (!tab) {
    tab = newDraft();
    state.tabs.push(tab);
    api.setState('app.story_tabs', state.tabs.length);
    saveTabs();
  }
  // Suggestions: the Telegram channels already set up as sources.
  $('tg-channels').replaceChildren(...[...new Set(state.sources.filter(s => s.type === 'telegram').map(s => s.config?.channel).filter(Boolean))]
    .map(c => h('option', { value: c })));
  activateTab(tab);
  $('tg-channel').focus();
}

function newDraft() {
  return { ...newTab({ id: nextChanId--, title: 'New Telegram tab', url: '', sourceName: 'Telegram' }), kind: 'chan', site: 'telegram', draft: true, home: false };
}

function connectDraft(tab, name) {
  const url = telegramUrl(name);
  const existing = state.tabs.find(t => t.kind === 'chan' && t !== tab && t.item.url === url);
  if (existing) { closeTab(tab); return activateTab(existing); }     // that channel is already open
  tab.draft = false;
  tab.item.url = url;
  tab.item.title = chanTitle(url);
  saveTabs();
  renderStory();                                                     // the field goes away; the page loads
}

/** A tab for this page (4chan or Telegram); in the background it's only added to the strip. */
export function openChanTab(url, { background = false, home = false } = {}) {
  const existing = state.tabs.find(t => t.kind === 'chan' && t.item.url === url);
  if (existing) return background ? undefined : activateTab(existing);
  const site = siteOf(url);
  const tab = { ...newTab({ id: nextChanId--, title: chanTitle(url), url, sourceName: SITE_LABEL[site] }), kind: 'chan', site, home };
  state.tabs.push(tab);
  api.setState('app.story_tabs', state.tabs.length);
  saveTabs();
  if (background) renderTabs();
  else activateTab(tab);
}

const newTab = it => ({ id: it.id, item: it, view: null, ready: false, failed: null, lastUsed: 0, pinned: false,
                       mode: 'live', snap: null, captureTimer: null, capturing: null, notice: null });

export function openInBrowser(it) {
  if (!it.url) return;
  api.openExternal(it.url);
  api.recordOpen(it.id, 'browser');
}

export function closeTab(tab) {
  const idx = state.tabs.indexOf(tab);
  if (idx < 0) return;
  if (tab.kind === 'scratch') flushScratch();
  state.tabs.splice(idx, 1);
  clearTimeout(tab.captureTimer);
  tab.view?.remove();
  saveTabs();
  api.setState('app.story_tabs', state.tabs.length);
  if (state.activeTabId === tab.id) {
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
    state.activeTabId = null;
    if (next) return activateTab(next);
  }
  renderTabs();
  renderStory();
}

/** Close several tabs at once (context menu); pinned tabs are kept. */
function closeTabs(list) {
  for (const t of list.filter(t => !t.pinned)) closeTab(t);
}

// Pinning, and keeping the tabs between sessions
// Pinned tabs sit at the left and can't be closed by middle-click or Ctrl+W. Every open tab
// (pinned or not) comes back, in order and with its view mode, when the app is reopened, and
// so does the tab that was selected — like the chat and stream tabs.

export function setPinned(tab, on) {
  if (tab.pinned === on) return;
  state.tabs.splice(state.tabs.indexOf(tab), 1);
  tab.pinned = on;
  // Pinning appends to the pinned group; unpinning puts it first after the group.
  state.tabs.splice(state.tabs.filter(t => t.pinned).length, 0, tab);
  saveTabs();
  renderTabs();
  if (tab.id === state.activeTabId) renderInfobar();
}

let tabsReady = false;          // nothing is written until last session's tabs have been put back
let saveTimer = null;

/** Remember the open tabs (soon: a burst of changes is written once). */
function saveTabs() {
  if (!tabsReady) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeTabs, 300);
}

const tabEntries = () => state.tabs.map(t => ({
  ...(isApp(t) ? { id: t.id, mode: 'live', app: t.kind }                                  // the shortcut list, the Scratchpad
    : t.kind === 'chan'
      ? { id: t.id, mode: 'live', chan: true, ...(t.draft ? { draft: true } : {}), url: t.item.url, title: t.item.title }   // no database item: remember the page itself
      : { id: t.id, mode: t.mode }),
  pinned: !!t.pinned,
  ...(t.id === state.activeTabId ? { active: true } : {}),
}));

function writeTabs(sync = false) {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (sync) { try { api.savePinnedSync(tabEntries()); } catch { /* closing anyway */ } }
  else api.savePinned(tabEntries());
}

window.addEventListener('beforeunload', () => { if (tabsReady) writeTabs(true); });   // the window is closing: write now

/** Reopen last session's tabs, in order, and select the one that was selected (the map stays if none was). */
export async function restoreTabs(saved) {
  try { await restoreSaved(saved ?? []); }
  finally { tabsReady = true; }
  saveTabs();
}

async function restoreSaved(saved) {
  if (!saved.length) return;
  const storyIds = saved.filter(p => !p.chan && !p.app).map(p => p.id);
  const items = new Map((storyIds.length ? await api.items(storyIds) : []).map(it => [it.id, it]));
  const restored = [];
  let selected = null;                                      // the tab that was selected when the app closed
  const mark = (p, tab) => { if (p.active) selected = tab; };
  for (const p of saved) {
    if (p.app) {                                             // the shortcut list or the Scratchpad
      if (state.tabs.some(t => t.id === APP_TABS[p.app].id) || restored.some(t => t.kind === p.app)) continue;
      const tab = appTab(p.app);
      tab.pinned = p.pinned;
      mark(p, tab);
      restored.push(tab);
      continue;
    }
    if (p.chan && p.draft) {                                 // a new Telegram tab that was never connected
      if (state.tabs.some(t => t.draft) || restored.some(t => t.draft)) continue;
      const tab = newDraft();
      tab.pinned = p.pinned;
      mark(p, tab);
      restored.push(tab);
      continue;
    }
    if (p.chan) {                                            // a 4chan / Telegram page
      if (!/^https?:\/\//i.test(p.url) || state.tabs.some(t => t.kind === 'chan' && t.item.url === p.url)) continue;
      const site = siteOf(p.url);
      const tab = { ...newTab({ id: nextChanId--, title: p.title || chanTitle(p.url), url: p.url, sourceName: SITE_LABEL[site] }), kind: 'chan', site, home: false };
      tab.pinned = p.pinned;
      mark(p, tab);
      restored.push(tab);
      continue;
    }
    const it = items.get(p.id);
    if (!it?.url || state.tabs.some(t => !t.kind && t.item.url === it.url)) continue;
    const tab = newTab(it);
    tab.pinned = p.pinned;
    mark(p, tab);
    tab.mode = p.mode === 'page' || p.mode === 'reader' ? p.mode : 'live';
    restored.push(tab);
  }
  await Promise.all(restored.filter(t => !t.kind).map(async tab => {
    tab.snap = await api.snapshot(tab.id);
    const can = { live: true, page: !!tab.snap.pageUrl, reader: !!tab.snap.hasText };
    if (!can[tab.mode]) tab.mode = 'live';
    if (!navigator.onLine && tab.mode === 'live') tab.mode = can.page ? 'page' : can.reader ? 'reader' : 'live';
  }));
  state.tabs.unshift(...restored);
  api.setState('app.story_tabs', state.tabs.length);
  renderTabs();
  if (selected && state.activeTabId == null) activateTab(selected);   // unless a tab was opened meanwhile
  if (restored.length) api.log('info', `Tabs: restored ${restored.length} tab(s)`);
}

export function activateTab(tab) {
  if (tab.id !== state.activeTabId) flushScratch();          // leaving the Scratchpad saves it
  document.dispatchEvent(new Event('story:activate'));       // e.g. leaves the map view
  state.activeTabId = tab.id;
  saveTabs();
  tab.lastUsed = Date.now();
  renderTabs();
  renderStory();
  evictIdleViews();
  document.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Ctrl+PgDown / Ctrl+PgUp: the next or previous tab, pinned ones included, wrapping around. */
export function cycleTab(step) {
  const n = state.tabs.length;
  if (!n) return;
  const i = state.tabs.findIndex(t => t.id === state.activeTabId);
  activateTab(state.tabs[i < 0 ? (step > 0 ? 0 : n - 1) : (i + step + n) % n]);
}

/** The tabs for tab search (Ctrl+Shift+A): the current one, then the most recently used. */
export function storyTabList() {
  const host = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const detail = tab => tab.kind === 'help' ? 'Keyboard shortcuts' : tab.kind === 'scratch' ? 'Scratchpad'
    : [tab.item.sourceName, host(tab.item.url)].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' · ');
  const tabIcon = tab => tab.kind === 'chan' ? h('span', { class: 'tab-mode' }, icon(SITE_ICON[tab.site]))
    : tab.kind === 'scratch' ? h('span', { class: 'tab-mode' }, icon('scratchpad'))
    : tab.kind === 'help' ? h('span', { class: 'tab-mode' }, icon('keyboard'))
    : siteIcon(tab.item);
  const rank = t => (t.id === state.activeTabId ? Infinity : t.lastUsed ?? 0);
  return [...state.tabs].sort((a, b) => rank(b) - rank(a)).map(tab => ({
    key: tab.id, label: tab.item.title, detail: detail(tab), icon: tabIcon(tab), pinned: tab.pinned, active: tab.id === state.activeTabId,
  }));
}

export function selectTabById(id) {
  const tab = state.tabs.find(t => t.id === id);
  if (tab) activateTab(tab);
}

export function closeTabById(id) {
  const tab = state.tabs.find(t => t.id === id);
  if (tab && !tab.pinned) closeTab(tab);
}

/** Alt+1…9: the Nth tab after the pinned ones. */
export function selectUnpinnedTab(n) {
  const tab = state.tabs.filter(t => !t.pinned)[n - 1];
  if (tab) activateTab(tab);
}

function evictIdleViews() {
  const idle = state.tabs.filter(t => t.view && t.id !== state.activeTabId).sort((a, b) => b.lastUsed - a.lastUsed);
  for (const t of idle.slice(MAX_LIVE_VIEWS - 1)) dropView(t);
}

function dropView(tab) {
  clearTimeout(tab.captureTimer);
  tab.view?.remove();
  tab.view = null;
  tab.ready = false;
}

function setMode(tab, mode, notice = null) {
  if (tab.mode === mode && tab.view) return;
  tab.mode = mode;
  tab.failed = null;
  tab.notice = notice;
  dropView(tab);
  saveTabs();
  renderStory();
}

// Snapshots

function scheduleCapture(tab) {
  if (tab.kind || tab.mode !== 'live' || tab.snap?.saved || tab.capturing) return;
  clearTimeout(tab.captureTimer);
  tab.captureTimer = setTimeout(() => capture(tab), CAPTURE_DELAY_MS);
}

/** Saves the tab's live page. A save already under way is waited for, not started twice. */
function capture(tab, { force = false } = {}) {
  if (tab.capturing) return tab.capturing;
  if (tab.kind || !tab.view || !tab.ready || tab.mode !== 'live') return Promise.resolve();
  if (tab.snap?.saved && !force) return Promise.resolve();
  tab.capturing = (async () => {
    await null;                      // so the cleanup below always runs after this is stored
    try {
      const info = await api.captureTab(tab.id, tab.view.getWebContentsId());
      if (info) tab.snap = info;
    } catch (e) {
      api.log('warn', `Capture failed for '${tab.item.title}': ${e.message}`);
    } finally {
      tab.capturing = null;
      renderInfobar();
    }
  })();
  renderInfobar();
  return tab.capturing;
}

/** Main process finished saving an item (from a tab or a background capture). */
export function onSnapshotSaved(info) {
  markSaved(info.itemId);
  const tab = state.tabs.find(t => t.id === info.itemId);
  if (tab) { tab.snap = info; if (tab.id === state.activeTabId) renderInfobar(); }
}

/** All saved articles were deleted (Settings → Storage). */
export function onSnapshotsCleared() {
  unmarkAllSaved();
  for (const tab of state.tabs) if (tab.snap) tab.snap = { itemId: tab.id, saved: false };
  renderInfobar();
}

// Rendering

export function renderTabs() {
  if (reorder?.dragging) return;                           // don't yank the strip out from under a drag
  $('tabs').replaceChildren(...state.tabs.map(tab =>
    h('div', {
      class: `tab${tab.id === state.activeTabId ? ' active' : ''}${tab.pinned ? ' pinned' : ''}`,
      title: tab.pinned ? `${tab.item.title}\n(pinned)` : tab.item.title,
      dataset: { id: tab.id },
      onclick: () => activateTab(tab),
      onmousedown: e => { if (e.button === 1) { e.preventDefault(); if (!tab.pinned) closeTab(tab); } },
      oncontextmenu: e => { e.preventDefault(); tabMenu(tab, e.clientX, e.clientY); },
    },
      tab.pinned && pinIcon(),
      tab.mode !== 'live' && h('span', { class: 'tab-mode', title: MODE_LABEL[tab.mode] }, icon(tab.mode === 'page' ? 'saved-page' : 'reader')),
      tab.kind === 'chan' && h('span', { class: 'tab-mode', title: SITE_LABEL[tab.site] }, icon(SITE_ICON[tab.site])),
      tab.kind === 'scratch' && h('span', { class: 'tab-mode', title: 'Scratchpad' }, icon('scratchpad')),
      !tab.kind && siteIcon(tab.item),                          // the source's icon, as in the feed
      h('span', { class: 'label' }, tab.item.title),
      !tab.pinned && h('button', { class: 'icon-btn close', title: 'Close tab (Ctrl+W)',
        onclick: e => { e.stopPropagation(); closeTab(tab); } }, icon('close')))));
}

const pinIcon = () => h('span', { class: 'pin' }, icon('pin'));

function tabMenu(tab, x, y) {
  const idx = state.tabs.indexOf(tab);
  const others = state.tabs.filter(t => t !== tab && !t.pinned);
  const right = state.tabs.slice(idx + 1).filter(t => !t.pinned);
  showMenu(x, y, [
    { label: tab.pinned ? 'Unpin tab' : 'Pin tab', onClick: () => setPinned(tab, !tab.pinned) },
    ...(isApp(tab) || tab.draft ? [] : [
      { label: 'Open in browser', onClick: () => openInBrowser(tab.item) },
      { label: 'Copy link', onClick: () => api.copy(tab.item.url) },
    ]),
    'sep',
    { label: 'Close tab', hint: tab.pinned ? '' : 'Ctrl+W', onClick: () => closeTab(tab) },
    { label: 'Close other tabs', disabled: !others.length, onClick: () => closeTabs(others) },
    { label: 'Close tabs to the right', disabled: !right.length, onClick: () => closeTabs(right) },
  ]);
}

// Reordering by drag
// See reorder.js; state.tabs follows the strip's order on release.

let reorder = null;

export function bindTabDrag() {
  reorder = makeReorderable($('tabs'), {
    selector: '.tab', ignore: '.close',
    onRebuilt: () => renderTabs(),
    onDrop: (ids, draggedId) => {
      const order = new Map(ids.map((id, i) => [+id, i]));
      state.tabs.sort((a, b) => (order.get(a.id) ?? 1e6) - (order.get(b.id) ?? 1e6));
      saveTabs();
      renderTabs();                                          // moving a tab doesn't select it
    },
  });
}

function srcFor(tab) {
  if (tab.mode === 'page')   return tab.snap?.pageUrl;
  if (tab.mode === 'reader') return `polyopticon-reader://item/${tab.id}${tab.translated ? '?lang=en' : ''}`;
  return tab.item.url;
}

function createView(tab) {
  const wv = document.createElement('webview');
  wv.setAttribute('partition', tab.kind === 'chan' ? 'chan' : 'persist:articles');
  wv.setAttribute('src', srcFor(tab));
  wv.addEventListener('dom-ready', () => {
    tab.ready = true;
    if (tab.id === state.activeTabId) renderInfobar();         // e.g. Translate becomes available
    wv.setZoomFactor(state.settings.WebViewZoom);
    wv.setAudioMuted(tab.id !== state.activeTabId);
  });
  // Back / Forward follow the page's own history.
  const navChanged = () => { if (tab.id === state.activeTabId) renderNav(); };
  wv.addEventListener('did-navigate', navChanged);
  wv.addEventListener('did-navigate-in-page', navChanged);
  if (tab.kind === 'chan') {
    // A 4chan / Telegram tab follows its page: name, and the link that Copy / Open in browser use.
    const follow = (e, title) => {
      if (e.isMainFrame === false) return;
      if (e.url) tab.item.url = e.url;
      if (title) tab.item.title = title;
      saveTabs();
      renderTabs();
      if (tab.id === state.activeTabId) { $('story-title').textContent = $('story-title').title = tab.item.title; }
    };
    wv.addEventListener('did-navigate', e => follow(e));
    wv.addEventListener('did-navigate-in-page', e => follow(e));
    wv.addEventListener('page-title-updated', e => follow({}, e.title));
  }
  wv.addEventListener('did-start-loading', () => {
    clearTimeout(tab.captureTimer);
    if (tab.id === state.activeTabId) setLoading(true);
  });
  wv.addEventListener('did-stop-loading', () => {
    if (tab.id === state.activeTabId) setLoading(false);
    scheduleCapture(tab);
  });
  wv.addEventListener('did-fail-load', e => {
    if (!e.isMainFrame || e.errorCode === -3) return;      // -3 = aborted (redirects etc.)
    if (tab.mode === 'live' && OFFLINE_ERRORS.has(e.errorCode) && (tab.snap?.pageUrl || tab.snap?.hasText)) {
      api.log('info', `Tab: '${tab.item.title}' unreachable (${e.errorDescription}) — showing saved copy`);
      return setMode(tab, tab.snap.pageUrl ? 'page' : 'reader', `Couldn't reach the site (${e.errorDescription}); showing the saved copy.`);
    }
    tab.failed = `${e.errorDescription || 'Load failed'} (${e.errorCode})`;
    api.log('warn', `StoryViewer: load failed for '${tab.item.title}': ${tab.failed}`);
    if (tab.id === state.activeTabId) renderStory();
  });
  tab.view = wv;
  $('webviews').append(wv);
}

function setLoading(on) {
  const bar = $('load-bar');
  bar.classList.toggle('loading', on);
  bar.classList.toggle('done', !on);
}

function showFallback(text, err) {
  $('fallback').hidden = false;
  $('summary').replaceChildren(...(err ? [h('div', { class: 'err' }, err)] : []), text);
}

// Back / Forward

const canNav = (tab, dir) => {
  try { return !!(tab?.ready && tab.view && (dir < 0 ? tab.view.canGoBack() : tab.view.canGoForward())); }
  catch { return false; }                                    // view not attached yet
};

function renderNav() {
  const tab = activeTab();
  $('btn-back').disabled = !canNav(tab, -1);
  $('btn-forward').disabled = !canNav(tab, 1);
}

/** Back (-1) or forward (1) in the current tab's page. */
export function navigate(dir) {
  const tab = activeTab();
  if (!canNav(tab, dir)) return;
  if (dir < 0) tab.view.goBack(); else tab.view.goForward();
}

/**
 * Ctrl+L / Ctrl+S: the current tab's live page or saved page. A live page that
 * isn't saved yet is saved first. Story tabs only (not 4chan or the shortcut list).
 */
export async function showMode(mode) {
  const tab = activeTab();
  if (!tab || tab.kind) return;
  if (mode === 'page' && !tab.snap?.pageUrl) {
    // Still loading: wait for the page (up to 15 s), then save it.
    for (let waited = 0; tab.mode === 'live' && !tab.ready && waited < 15_000; waited += 200) await new Promise(r => setTimeout(r, 200));
    await capture(tab, { force: true });
    if (!tab.snap?.pageUrl) { tab.notice = 'This page isn’t saved yet; try again once it has loaded.'; return renderStory(); }
  }
  setMode(tab, mode);
}

/** Reload the current tab's page; after a failed load, start it over. */
export function reload() {
  const tab = activeTab();
  if (!tab || isApp(tab) || tab.draft) return;
  if (tab.failed || !tab.ready) {
    tab.failed = null;
    dropView(tab);
    renderStory();
  } else tab.view.reload();
}

function paintPin(tab) {
  const pin = $('btn-pin');
  pin.classList.toggle('on', tab.pinned);
  pin.title = tab.pinned ? 'Unpin tab (Ctrl+P)' : 'Pin tab (Ctrl+P): keeps it at the left and reopens it next time';
  pin.onclick = () => setPinned(tab, !tab.pinned);
}

/**
 * The link to the page the tab is showing: where its live page has navigated to (an article's
 * own links followed), else the story's link. Null for the app's own pages and unconnected drafts.
 */
function pageLink(tab) {
  if (!tab || isApp(tab) || tab.draft) return null;
  let url = tab.item.url, title = tab.item.title;
  if (tab.mode === 'live' && tab.ready && tab.view) {
    const live = tab.view.getURL();
    if (/^https?:\/\//i.test(live) && live !== url) { url = live; title = tab.view.getTitle() || live; }
  }
  return url ? { url, title: (title || url).replace(/\s+/g, ' ').trim() } : null;
}

function renderInfobar() {
  const tab = activeTab();
  if (!tab) return;
  renderNav();
  // 4chan / Telegram tabs are live only: no view modes, translation or saving — but they can be pinned.
  // The app's own pages have just the title and the pin; every tab can be pinned.
  const app = isApp(tab), chan = tab.kind === 'chan';
  document.querySelector('.nav-btns').style.display = app ? 'none' : '';
  for (const id of ['view-modes', 'btn-translate', 'btn-translate-stop', 'save-state']) $(id).hidden = chan || app;
  $('btn-pin').hidden = false;
  for (const id of ['btn-copy', 'btn-open', 'btn-scratch-link']) $(id).hidden = !!tab.draft || app;   // no link until it's connected
  const shot = $('btn-screenshot');
  shot.hidden = !!tab.draft || app;
  shot.disabled = !canShoot(tab) || !!tab.shooting;
  shot.classList.toggle('busy', !!tab.shooting);
  if (chan || app) return paintPin(tab);
  const snap = tab.snap;
  const can = { live: true, page: !!snap?.pageUrl, reader: !!snap?.hasText };

  $('view-modes').replaceChildren(...['live', 'page', 'reader'].map(m =>
    h('button', {
      class: tab.mode === m ? 'on' : '', disabled: !can[m],
      title: m === 'live' ? 'The live page' : can[m] ? `Saved ${new Date(snap.capturedAt).toLocaleString()}` : 'Not saved yet',
      onclick: () => setMode(tab, m),
    }, MODE_LABEL[m])));

  // Translate: the saved text of a foreign-language article, shown in the reader
  // (offline, on your computer). Always visible, so it's clear when it applies.
  const tr = $('btn-translate');
  const stop = $('btn-translate-stop');
  stop.hidden = !tab.translatingArticle;
  stop.onclick = () => api.stopTranslation();
  const lang = snap?.hasText ? (snap.lang || tab.item.lang) : null;
  const canSaveNow = tab.mode === 'live' && tab.ready && !tab.capturing;
  tr.hidden = false;
  tr.classList.toggle('on', !!tab.translated && tab.mode === 'reader');
  tr.onclick = () => toggleTranslation(tab);
  if (tab.translatingArticle) {
    const t = tab.translateProgress;
    Object.assign(tr, { disabled: true, textContent: t?.label ? `Translating · ${t.label}` : 'Translating…',
      title: t?.detail ?? 'Translating the article on your computer…' });
  } else if (tab.translated && tab.mode === 'reader') {
    Object.assign(tr, { disabled: false, textContent: 'Translated', title: 'Translated to English: click to show the article in its original language' });
  } else if (lang && lang !== 'en') {
    Object.assign(tr, { disabled: false, textContent: `Translate (${lang.toUpperCase()})`, title: 'Translate this article to English (machine translation on your computer); opens in Reader view' });
  } else if (lang === 'en') {
    Object.assign(tr, { disabled: true, textContent: 'Translate', title: 'This article is already in English' });
  } else if (canSaveNow) {
    Object.assign(tr, { disabled: false, textContent: 'Translate', title: 'Save the page now and translate it to English if it isn’t in English' });
  } else {
    Object.assign(tr, { disabled: true, textContent: 'Translate', title: tab.mode === 'live' ? 'Available once the page has loaded' : 'No saved text for this article' });
  }

  paintPin(tab);

  const chip = $('save-state');
  chip.className = 'save-state';
  if (tab.capturing) { chip.textContent = 'Saving…'; chip.classList.add('busy'); chip.title = ''; }
  else if (snap?.saved) {
    chip.textContent = `Saved ${relTime(snap.capturedAt)}${snap.partial ? ' · partial' : ''}`;
    chip.classList.add('ok');
    chip.title = [
      snap.partial && 'The site only sent part of the article (subscriber/registration wall). Logging in to the site in this tab lets the next save keep the full text.',
      tab.mode === 'live' && 'Click to save again (e.g. after the page finished updating or after logging in).',
    ].filter(Boolean).join('\n');
  } else { chip.textContent = tab.mode === 'live' ? 'Not saved' : ''; chip.title = ''; }
  chip.onclick = tab.mode === 'live' && !tab.capturing ? () => capture(tab, { force: true }) : null;
}

/** Translator progress for the article being translated, shown on its Translate button. */
export function onArticleTranslateProgress(p) {
  const tab = state.tabs.find(t => t.translatingArticle && t.id === p.tag);
  if (!tab) return;
  const first = 'one-time download for this language';
  if (p.stage === 'download') tab.translateProgress = { label: `downloading model ${p.pct}%`, detail: `Downloading the translation model (${first}): ${p.pct}%` };
  else if (p.stage === 'loading') tab.translateProgress = { label: 'loading model…', detail: 'Loading the translation model into memory; this can take a minute for the large one' };
  else if (p.stage === 'translating') {
    const pct = p.total ? Math.floor(100 * p.done / p.total) : 0;
    tab.translateProgress = { label: `${pct}%`, detail: `Translated ${p.done} of ${p.total} parts of the article` };
  } else return;
  if (tab === activeTab()) renderInfobar();
}

async function toggleTranslation(tab) {
  if (tab.translated && tab.mode === 'reader') {
    tab.translated = false;
    return reloadView(tab);
  }
  // Not saved yet: save it now; the saved text tells us its language.
  if (!tab.snap?.hasText) {
    await capture(tab, { force: true });
    if (!tab.snap?.hasText) { tab.notice = 'Couldn’t get the article text from this page, so it can’t be translated.'; renderStory(); return; }
  }
  const lang = tab.snap.lang || tab.item.lang;
  if (!lang || lang === 'en') { tab.notice = 'This article is already in English.'; renderStory(); return; }
  if (!tab.snap.hasTranslation) {
    tab.translatingArticle = true;
    tab.translateProgress = null;
    renderInfobar();
    const res = await api.translateSnapshot(tab.id);
    tab.translatingArticle = false;
    tab.translateProgress = null;
    if (!res.ok) { tab.notice = res.cancelled ? 'Translation stopped.' : `Translation failed: ${res.error}`; renderStory(); return; }
    tab.snap.hasTranslation = true;
  }
  tab.translated = true;
  tab.mode = 'reader';
  reloadView(tab);
}

function reloadView(tab) {
  dropView(tab);
  tab.notice = null;
  renderStory();
}

export function renderStory() {
  const tab = activeTab();
  for (const t of state.tabs) {
    t.view?.classList.toggle('inactive', t !== tab);
    if (t.ready) t.view.setAudioMuted(t !== tab);
  }
  $('fallback').hidden = true;
  $('story-notice').hidden = true;
  $('story-notice').classList.remove('shot-notice');
  $('help-view').hidden = tab?.kind !== 'help';
  $('scratch-view').hidden = tab?.kind !== 'scratch';

  if (!tab) {
    $('story-empty').hidden = false;
    $('infobar').hidden = true;
    setLoading(false);
    return;
  }

  if (isApp(tab)) {
    $('story-empty').hidden = true;
    $('infobar').hidden = false;
    $('story-source').textContent = tab.item.sourceName;
    $('story-title').textContent = $('story-title').title = tab.item.title;
    $('story-title').hidden = false;
    $('tg-draft').hidden = true;
    setLoading(false);
    renderInfobar();
    if (tab.kind === 'scratch') initScratch();
    else renderShortcutList($('help-view'), tab.id);
    renderTabs();
    return;
  }

  const it = tab.item;
  $('story-empty').hidden = true;
  $('infobar').hidden = false;
  $('story-source').textContent = it.sourceName;
  $('story-title').textContent = it.title;
  $('story-title').title = it.title;
  $('story-title').hidden = !!tab.draft;                    // a new Telegram tab has its channel field here instead
  $('tg-draft').hidden = !tab.draft;
  renderInfobar();
  renderTabs();

  if (tab.draft) {
    setLoading(false);
    showFallback('Enter the name or link of a public Telegram channel above, then press Enter.');
    return;
  }

  if (tab.notice) { $('story-notice').hidden = false; $('story-notice').textContent = tab.notice; }

  if (tab.mode === 'live' && !tab.kind && state.settings.AlwaysOpenInBrowser) {
    tab.view?.classList.add('inactive');
    showFallback(it.summary || 'Opening in browser…');
    api.openExternal(it.url);
    return;
  }

  if (tab.failed) {
    tab.view?.classList.add('inactive');
    const saved = tab.snap?.pageUrl || tab.snap?.hasText;
    showFallback(it.summary || 'No article preview available from this feed.',
      `Couldn't load the article: ${tab.failed}${saved ? '. Use “Saved page” or “Reader” above for the offline copy.' : ''}`);
    return;
  }

  if (!tab.view) createView(tab);
  else setLoading(tab.view.isLoading?.() ?? false);
}

// Screenshots
// 📸 / Ctrl+Shift+S: the whole page the tab shows — a story in any view (Live, Saved page,
// Reader), 4chan or Telegram — copied to the clipboard and saved as a PNG (src/main/screenshot.js).

const canShoot = tab => !!(tab?.view && tab.ready && !tab.failed && !tab.draft && !isApp(tab)
  && !(tab.mode === 'live' && !tab.kind && state.settings.AlwaysOpenInBrowser));   // that page is in the browser, not here

let shotNoticeTimer = null;

export async function takeScreenshot() {
  const tab = activeTab();
  if (!canShoot(tab) || tab.shooting) return;
  tab.shooting = true;
  renderInfobar();
  try {
    const res = await api.screenshot(tab.view.getWebContentsId(), pageLink(tab)?.title ?? tab.item.title);
    if (tab !== activeTab()) return;
    const notice = $('story-notice');
    clearTimeout(shotNoticeTimer);
    if (res.ok) {
      flash($('btn-screenshot'), icon('done'));
      notice.replaceChildren(`Screenshot copied to the clipboard and saved as ${res.file}${res.truncated ? ' (the page was too long, so its bottom is cut off)' : ''} `,
        h('button', { class: 'link-btn', onclick: () => api.showScreenshot(res.file) }, 'Show in folder'));
    } else notice.textContent = `Couldn’t take a screenshot: ${res.error}`;
    notice.hidden = false;
    notice.classList.add('shot-notice');
    shotNoticeTimer = setTimeout(() => { if (notice.classList.contains('shot-notice')) notice.hidden = true; }, 8000);
  } finally {
    tab.shooting = false;
    if (tab === activeTab()) renderInfobar();
  }
}

export function applyZoom() {
  for (const t of state.tabs) if (t.ready) t.view.setZoomFactor(state.settings.WebViewZoom);
}

export function bindStoryButtons() {
  const input = $('tg-channel');
  $('tg-draft').addEventListener('submit', e => {
    e.preventDefault();
    const tab = activeTab();
    if (!tab?.draft) return;
    const name = parseTelegramChannel(input.value);
    input.classList.toggle('invalid', !name);
    if (!name) { input.title = 'A channel name (letters, numbers, underscores) or a t.me link'; return; }
    input.value = '';
    input.title = '';
    connectDraft(tab, name);
  });
  input.addEventListener('input', () => input.classList.remove('invalid'));
  $('btn-back').addEventListener('click', () => navigate(-1));
  $('btn-forward').addEventListener('click', () => navigate(1));
  $('btn-reload').addEventListener('click', () => reload());
  $('btn-copy').addEventListener('click', () => {
    const url = activeTab()?.item.url;
    if (url) { api.copy(url); flash($('btn-copy'), icon('done')); }
  });
  $('btn-open').addEventListener('click', () => { const t = activeTab(); if (t) openInBrowser(t.item); });
  $('btn-screenshot').addEventListener('click', () => takeScreenshot());
  $('btn-scratch-link').addEventListener('click', async () => {
    const link = pageLink(activeTab());
    if (!link) return;
    await appendToScratch(`[${link.title.replace(/[[\]]/g, '')}](${link.url})`);
    flash($('btn-scratch-link'), icon('done'));
  });
}
