// Entry point: boot, toolbar, mode switch, countdown, keyboard, splitters.

import { api, $, maxAgeLabel } from './dom.js';
import { state, setSources } from './state.js';
import { ingest, refreshRows, scheduleRender, bindFeedScroll, trimToMax, rebuildTagCache, bindList, pruneSources, setCountsListener, updateItems, setVisibleListener } from './feed.js';
import { initMap, openMap, closeMap, onVisibleItems, applyMapAppearance, refreshMapFilter } from './map.js';
import { renderSources, renderTags, bindTagForms, bindSourceFilter, setStatus, repaintCounts } from './sidebar.js';
import { renderStory, renderTabs, activeTab, closeTab, setPinned, cycleTab, selectUnpinnedTab, openHelpTab, openScratchTab, openChanHome, openChanTab, openTelegramDraft, navigate, reload as reloadTab, showMode, onSnapshotSaved, applyZoom, bindStoryButtons, bindTabDrag, restoreTabs, storyTabList, selectTabById, closeTabById, onArticleTranslateProgress, takeScreenshot } from './tabs.js';
import { initHistory, reload as reloadHistory, setHistoryQuery } from './history.js';
import { ui, loadUi, saveUi } from './ui.js';
import { initChat, renderChat, toggleChat, toggleVideo, applyChatTheme, chatOpen, cycleChatTab, selectChatTab, closeChatTab, reloadChatTab, pinChatTab, chatTabList } from './chat.js';
import { openTabSearch } from './tabsearch.js';
import { initSourceSearch, renderSourceChips, clearSearchSources, pruneSearchSources } from './sourcesearch.js';
import { initSettings, openSettings, toggleSettings, closeSettings, setSetting, syncSettingControl, refreshSettingsPage, renderScreenshotFolder } from './settings.js';
import { comboName, runShortcut, registerShortcuts, pageCombos } from './shortcuts.js';
import { bindTabScroll } from './tabscroll.js';
import { startPerfWatch } from './perfwatch.js';
import { applyIcons, setIcon } from './icons.js';

const DENSITY_PAD = ['5px', '9px', '14px'];

// Settings → UI

function applySetting(key) {
  const s = state.settings;
  const root = document.documentElement.style;
  switch (key) {
    case 'FontFamily':  root.setProperty('--font', `"${s.FontFamily}", system-ui, sans-serif`); break;
    case 'FontSize':    root.setProperty('--scale', s.FontSize / 13); break;
    case 'FeedDensity': root.setProperty('--item-pad-y', DENSITY_PAD[s.FeedDensity] ?? DENSITY_PAD[1]); break;
    case 'ShowSourceBadge': document.body.classList.toggle('no-badges', !s.ShowSourceBadge); break;
    case 'DescriptionLength': refreshRows(); break;
    case 'IsDarkTheme':
      document.documentElement.dataset.theme = s.IsDarkTheme ? 'dark' : 'light';
      setIcon($('btn-theme'), s.IsDarkTheme ? 'moon' : 'sun');
      applyMapAppearance();
      applyChatTheme();
      break;
    case 'MaxArticleAgeHours': $('age-label').textContent = maxAgeLabel(s.MaxArticleAgeHours); scheduleRender(); break;
    case 'MaxFeedItems': trimToMax(); scheduleRender(); break;
    case 'RefreshIntervalSeconds': resetCountdown(); break;
    case 'WebViewZoom': applyZoom(); break;
    case 'GroupStories': $('btn-group').classList.toggle('on', s.GroupStories); scheduleRender(); break;
    case 'ChatTwitchChannels':
    case 'ChatKickChannels':
    case 'ChatIrc':
    case 'ChatDestiny': renderChat(); break;
    case 'ScrollableTabs': document.body.classList.toggle('tabs-scroll', s.ScrollableTabs); break;
    case 'ScreenshotFolder': renderScreenshotFolder(); break;
    case 'ShowChanButton': $('btn-chan').hidden = !s.ShowChanButton; break;   // open 4chan tabs stay open
  }
}

/** Page zoom (the Zoom setting) one 10% step in (+1) or out (-1), within the slider's 50–200%. */
function zoomStep(dir) {
  setSetting('WebViewZoom', Math.min(2, Math.max(0.5, Math.round((state.settings.WebViewZoom + dir * 0.1) * 100) / 100)));
}

// Live / History

function setMode(mode) {
  state.mode = mode;
  saveUi({ mode });
  for (const b of document.querySelectorAll('#mode-switch button')) b.classList.toggle('on', b.dataset.mode === mode);
  const live = mode === 'live';
  $('feed-list').hidden = !live;
  $('feed-empty').hidden = !live || state.items.length > 0;
  $('history-list').hidden = live;
  $('history-empty').hidden = true;
  $('history-scope').hidden = live;
  $('btn-autoscroll').hidden = !live;
  $('btn-case').hidden = !live;
  const search = $('search');
  search.value = live ? state.search : '';
  renderSourceChips();                      // placeholder depends on mode and chips
  if (live) scheduleRender(); else reloadHistory();
}

// Place filter (set from the map)

function setPlaceFilter(f) {
  state.placeFilter = f;
  $('place-chip').hidden = !f;
  $('place-chip-name').textContent = f?.name ?? '';
  if (f && state.mode !== 'live') setMode('live');
  scheduleRender({ scrollTop: true });
  refreshMapFilter();
}

// Background task indicator (model downloads)

const modelSetup = new Map();           // model → download % (a number) or 'loading'
const modelLabel = m => m.startsWith('nllb') ? 'large (NLLB)' : m.replace('opus-mt-', '').replace('-en', '→en');
function onTranslateProgress(p) {
  onArticleTranslateProgress(p);
  if (p.stage === 'download') modelSetup.set(p.model, p.pct);
  else if (p.stage === 'loading') modelSetup.set(p.model, 'loading');
  else if (p.stage === 'ready') modelSetup.delete(p.model);
  else if (p.stage === 'stopped') modelSetup.clear();
  else return;                           // per-chunk progress is for the article button only
  const el = $('bg-task');
  el.hidden = modelSetup.size === 0;
  el.textContent = [...modelSetup].map(([m, s]) =>
    s === 'loading' ? `Loading ${modelLabel(m)} model…` : `Downloading ${modelLabel(m)} model ${s}%`).join(' · ') + '  ✕';
  const sp = $('translate-progress');
  sp.hidden = el.hidden;
  sp.textContent = el.textContent;
}

function bindStopTranslation() {
  const stop = () => api.stopTranslation();
  const bg = $('bg-task');
  bg.title = 'Click to stop translating';
  bg.style.cursor = 'pointer';
  bg.addEventListener('click', stop);
  $('btn-translate-stop-all').addEventListener('click', stop);
}

// Countdown / refresh

function renderStatus() {
  const n = state.countdown;
  $('status-text').textContent = n === 0 ? 'Refreshing…' : 'Live  ·  ↻';
  $('countdown').textContent = n === 0 ? '' : `${n}s`;
  $('btn-refresh').disabled = n === 0;
  $('btn-refresh').classList.toggle('spin', state.refreshing);
}

function resetCountdown() {
  state.countdown = state.settings.RefreshIntervalSeconds;
  renderStatus();
}

function tickCountdown() {
  if (state.refreshing) return;
  state.countdown = state.countdown === 0 ? state.settings.RefreshIntervalSeconds : state.countdown - 1;
  renderStatus();
}

async function manualRefresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  state.countdown = 0;
  renderStatus();
  try { await api.refresh(); }
  finally { state.refreshing = false; resetCountdown(); }
}

function renderOnline() {
  $('offline-badge').hidden = navigator.onLine;
}

// Toolbar & keyboard

// The area last clicked or focused: the chat tabs, the stream tabs below them, or (any other
// pane) the article tabs. The tab shortcuts act on that area's tabs. Clicks outside the panes
// (toolbar, menus, settings) leave it as it was.
let focusArea = 'story';

function areaOf(el) {
  if (el?.closest?.('#video-pane')) return 'stream';
  if (el?.closest?.('#chat-pane')) return 'chat';
  return el?.closest?.('#panes .pane') ? 'story' : null;
}

/** 'chat' / 'stream' while that area has focus and is showing, else 'story'. */
function tabArea() {
  if (focusArea === 'stream' && chatOpen() && !$('video-pane').hidden) return 'stream';
  if (focusArea === 'chat' && chatOpen()) return 'chat';
  return 'story';
}

/** A shortcut forwarded from a page: that page's <webview> is where the focus is. */
function webviewOf(webContentsId) {
  return [...document.querySelectorAll('webview')].find(wv => {
    try { return wv.getWebContentsId() === webContentsId; } catch { return false; }   // not attached yet
  });
}

/** What each shortcut in shortcuts.js does (keys, descriptions and the list live there). */
function bindShortcuts() {
  const inChat = (chatFn, storyFn) => (...args) => { const a = tabArea(); return a === 'story' ? storyFn(...args) : chatFn(a, ...args); };
  registerShortcuts({
    help:     () => openHelpTab(),
    refresh:  () => manualRefresh(),
    search:   () => { const search = $('search'); search.focus(); search.select(); },
    mode:     () => setMode(state.mode === 'live' ? 'history' : 'live'),
    map:      () => (document.querySelector('.story.map-open') ? closeMap() : openMap()),
    chat:     () => toggleChat(),
    video:    () => toggleVideo(),
    settings: () => toggleSettings(),
    fullscreen: () => api.toggleFullScreen(),
    nextTab:  inChat(a => cycleChatTab(a, 1), () => cycleTab(1)),
    prevTab:  inChat(a => cycleChatTab(a, -1), () => cycleTab(-1)),
    tabN:     inChat((a, combo) => selectChatTab(a, +combo.slice(-1)), combo => selectUnpinnedTab(+combo.slice(-1))),
    closeTab: inChat(closeChatTab, () => { const t = activeTab(); if (t && !t.pinned) closeTab(t); }),
    back:     () => navigate(-1),
    reload:   inChat(reloadChatTab, () => reloadTab()),
    pinTab:   inChat(pinChatTab, () => { const t = activeTab(); if (t) setPinned(t, !t.pinned); }),
    searchTabs: () => searchTabs(tabArea()),
    forward:  () => navigate(1),
    livePage: () => showMode('live'),
    savedPage: () => showMode('page'),
    screenshot: () => takeScreenshot(),
    zoomIn:    () => zoomStep(1),
    zoomOut:   () => zoomStep(-1),
    zoomReset: () => setSetting('WebViewZoom', 1),
  });
  api.setPageShortcuts(pageCombos());     // main catches these inside article and chat pages
}

/** Ctrl+Shift+A: search the tabs of the area last clicked (tabsearch.js). */
function searchTabs(area) {
  if (area === 'story') {
    openTabSearch({ anchor: $('tabs').closest('.pane-header'), title: 'Article tabs', tabs: storyTabList, select: selectTabById, close: closeTabById });
    return;
  }
  openTabSearch({
    anchor: $(area === 'stream' ? 'video-tabs' : 'chat-tabs').closest('.pane-header'),
    title: area === 'stream' ? 'Stream tabs' : 'Chat tabs',
    tabs: () => chatTabList(area).entries,
    select: key => chatTabList(area).select(key),
    close: key => chatTabList(area).close(key),
  });
}

function paintToggles() {
  $('btn-autoscroll').classList.toggle('on', state.autoScroll);
  $('btn-case').classList.toggle('on', state.caseSensitive);
  $('btn-case').textContent = state.caseSensitive ? 'Aa' : 'aa';
}

function bindToolbar() {
  $('btn-refresh').addEventListener('click', manualRefresh);
  $('btn-theme').addEventListener('click', () => setSetting('IsDarkTheme', !state.settings.IsDarkTheme));
  $('btn-help').addEventListener('click', () => openHelpTab());
  $('btn-fullscreen').addEventListener('click', () => api.toggleFullScreen());
  api.onFullScreen(on => {
    $('btn-fullscreen').classList.toggle('on', on);
    $('btn-fullscreen').title = on ? 'Leave full screen (F11)' : 'Full screen (F11)';
  });
  $('btn-scratch').addEventListener('click', () => openScratchTab());
  $('btn-chan').addEventListener('click', () => openChanHome());
  $('btn-telegram').addEventListener('click', () => openTelegramDraft());
  $('btn-settings').addEventListener('click', () => toggleSettings());
  $('btn-sources').addEventListener('click', () => toggleSettings('sources'));
  $('btn-group').addEventListener('click', () => setSetting('GroupStories', !state.settings.GroupStories));
  $('place-chip-clear').addEventListener('click', () => setPlaceFilter(null));
  for (const b of document.querySelectorAll('#mode-switch button')) b.addEventListener('click', () => setMode(b.dataset.mode));

  const auto = $('btn-autoscroll');
  auto.addEventListener('click', () => {
    state.autoScroll = !state.autoScroll;
    saveUi({ autoScroll: state.autoScroll });
    paintToggles();
    if (state.autoScroll) $('feed-list').scrollTop = 0;
  });

  const caseBtn = $('btn-case');
  caseBtn.addEventListener('click', () => {
    state.caseSensitive = !state.caseSensitive;
    saveUi({ caseSensitive: state.caseSensitive });
    paintToggles();
    scheduleRender();
  });

  const search = $('search');
  search.addEventListener('input', () => {
    if (state.mode === 'history') return setHistoryQuery(search.value);
    state.search = search.value;
    state.searchLower = search.value.toLowerCase();
    api.setState('app.search_text', search.value ? `"${search.value}"` : '(empty)');
    scheduleRender();
  });

  bindStoryButtons();

  document.addEventListener('keydown', e => {
    const typing = e.target.matches('input, select, textarea') || e.target.isContentEditable;
    if (e.key === 'Escape') {
      if (!$('settings-overlay').hidden) closeSettings();
      else if (e.target === search && search.value) { search.value = ''; search.dispatchEvent(new Event('input')); }
      else if (e.target === search) clearSearchSources();     // second Esc drops the source chips
    } else if (runShortcut(comboName(e), { typing })) {
      e.preventDefault();
    }
  });
  // Which tabs the tab shortcuts act on follows the clicks and the focus (webviews included).
  for (const type of ['pointerdown', 'focusin']) document.addEventListener(type, e => { focusArea = areaOf(e.target) ?? focusArea; }, true);
  // The same shortcuts pressed while an article or chat page has focus (forwarded by main).
  api.onShortcut((combo, webContentsId) => {
    const wv = webviewOf(webContentsId);
    if (wv) focusArea = areaOf(wv) ?? focusArea;
    runShortcut(combo);
  });
  // Ctrl + wheel over a page zooms every page, like a browser.
  api.onZoom(dir => zoomStep(dir === 'in' ? 1 : -1));
  api.onChanOpen((url, background) => openChanTab(url, { background }));
  bindShortcuts();

  window.addEventListener('online', renderOnline);
  window.addEventListener('offline', renderOnline);
}

function bindSplitters() {
  const root = document.documentElement;
  const vars = { 1: ['--w-sidebar', 180], 3: ['--w-feed', 260], 5: ['--w-chat', 240] };
  for (const [v, w] of Object.entries(ui.panes ?? {}))
    if (v in { '--w-sidebar': 1, '--w-feed': 1, '--w-chat': 1 } && Number.isFinite(w)) root.style.setProperty(v, `${w}px`);

  for (const sp of document.querySelectorAll('.splitter')) {
    const [cssVar, min] = vars[sp.dataset.col];
    // The chat column sits right of its splitter, so dragging left widens it.
    const rightSide = sp.dataset.col === '5';
    const pane = rightSide ? sp.nextElementSibling : sp.previousElementSibling;
    sp.addEventListener('pointerdown', e => {
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('dragging');
      document.body.classList.add('resizing');
      const startX = e.clientX, startW = pane.getBoundingClientRect().width;
      // Any pane grows at the story pane's expense; keep that at its 260px minimum.
      const maxW = startW + document.querySelector('.pane.story').getBoundingClientRect().width - 260;
      const move = ev => {
        const dx = (ev.clientX - startX) * (rightSide ? -1 : 1);
        root.style.setProperty(cssVar, `${Math.round(Math.max(min, Math.min(maxW, startW + dx)))}px`);
      };
      const up = () => {
        sp.removeEventListener('pointermove', move);
        sp.classList.remove('dragging');
        document.body.classList.remove('resizing');
        saveUi({ panes: { ...ui.panes, [cssVar]: parseInt(getComputedStyle(root).getPropertyValue(cssVar), 10) } });
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up, { once: true });
    });
  }
}

// Logo: still first frame when idle, animates on hover (if the image is animated). A random
// variant (any file listed by main) on launch and on each click, never repeating the previous one.
function bindLogo(logos) {
  const img = $('logo-anim'), canvas = $('logo-still');
  const drawStill = () => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 32, 32);
    ctx.drawImage(img, 0, 0, 32, 32);
  };
  img.addEventListener('load', drawStill);
  let last = ui.lastLogo ?? null;
  const next = () => {
    const pool = logos.length > 1 ? logos.filter(f => f !== last) : logos;
    if (!pool.length) return;                                  // keep the one in index.html
    last = pool[Math.floor(Math.random() * pool.length)];
    img.src = `assets/${last}`;
    saveUi({ lastLogo: last });
  };
  next();
  if (img.complete && img.naturalWidth) drawStill();
  img.parentElement.addEventListener('mouseenter', () => { img.src = img.src; });   // replay from the start
  img.parentElement.addEventListener('click', next);
}

// Boot

/** Run a non-essential startup step; a failure is logged instead of aborting startup. */
function guard(what, fn) {
  try { fn(); } catch (e) { api.log('error', `Renderer: ${what} failed at startup: ${e?.stack || e}`); }
}

// Renderer errors go to the session log (otherwise they're only visible in DevTools).
window.addEventListener('error', e => api.log('error', `Renderer error: ${e.error?.stack || e.message} (${e.filename}:${e.lineno})`));
window.addEventListener('unhandledrejection', e => api.log('error', `Renderer: unhandled rejection: ${e.reason?.stack || e.reason}`));

(async function boot() {
  applyIcons();                                               // before anything awaits, so no button shows up empty
  startPerfWatch();                                           // start-up freezes count too
  const init = await api.init();
  loadUi(init.ui);
  // Restore the last session's view: unticked sources, toggles.
  const known = new Set(init.sources.map(s => s.id));
  state.hiddenSources = new Set((ui.hiddenSources ?? []).filter(id => known.has(id)));
  state.autoScroll = !!ui.autoScroll;
  state.caseSensitive = !!ui.caseSensitive;
  state.settings = init.settings;
  state.picturesDir = init.picturesDir;
  state.types    = init.types;
  state.accounts = init.accounts;
  state.tags     = init.tags;
  setSources(init.sources);
  rebuildTagCache();

  initSettings(applySetting);
  // Optional panels and individual settings must never stop the feed from starting.
  guard('map', () => initMap({ onFilter: setPlaceFilter }));
  guard('chat', () => initChat({ openSettings: () => openSettings('general') }));
  setVisibleListener(onVisibleItems);
  for (const key of Object.keys(state.settings)) guard(`setting ${key}`, () => { applySetting(key); syncSettingControl(key); });
  $('log-path').textContent = init.logPath ? `Log: ${init.logPath}` : '';

  setCountsListener(repaintCounts);
  renderSources();
  renderTags();
  bindTagForms();
  bindSourceFilter();
  bindList($('feed-list'), id => state.itemsById.get(id));
  bindFeedScroll();
  initHistory();
  bindToolbar();
  bindSplitters();
  bindLogo(init.logos ?? []);
  guard('stop-translation button', bindStopTranslation);
  paintToggles();
  initSourceSearch({ changed: () => (state.mode === 'live' ? scheduleRender({ scrollTop: true }) : reloadHistory()) });
  renderOnline();

  // Everything stored from previous sessions shows immediately.
  ingest(init.recent, { fresh: false });
  renderSources();                      // again, now that source icons can use the stories' sites
  scheduleRender();
  bindTabDrag();
  bindTabScroll($('tabs'));
  renderTabs();
  renderStory();
  restoreTabs(init.pinned);
  if (ui.mode === 'history') setMode('history');
  openMap();                            // the map is the start page

  api.onItems(items => ingest(items));
  api.onItemsUpdated(updateItems);
  api.onTranslateProgress(onTranslateProgress);
  api.onStatus(setStatus);
  api.onSnapshot(onSnapshotSaved);
  api.onSourcesChanged(list => {
    setSources(list);
    renderSources();
    pruneSources();
    pruneSearchSources();
    scheduleRender();
    refreshSettingsPage();
  });
  api.onAccounts(acc => { state.accounts = acc; refreshSettingsPage(); });
  api.ready();

  resetCountdown();
  setInterval(tickCountdown, 1000);
  setInterval(() => scheduleRender(), 60_000);   // re-apply the max-age cutoff as time passes
  api.log('info', `Renderer ready — ${state.sources.filter(s => s.enabled).length} sources, ${state.items.length} stored items shown`);
})();
