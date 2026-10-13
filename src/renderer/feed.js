// Live feed: ingestion, filtering, minimal-diff rendering, and list interaction
// (shared with the History list).

import { api, $, h, formatStamp } from './dom.js';
import { toggleSearchSource } from './sourcesearch.js';
import { state, sourceColor } from './state.js';
import { openTab, openInBrowser } from './tabs.js';
import { measure } from './perfwatch.js';

let onCountsChanged = () => {};
export const setCountsListener = fn => { onCountsChanged = fn; };

const nodes = new Map();                      // item id -> row element
const memberNodes = new Map();                // item id -> row element when shown inside an expanded group
const expanded = new Set();                   // cluster ids the user expanded

let onVisibleChanged = () => {};
export const setVisibleListener = fn => { onVisibleChanged = fn; };

const KIND_LABEL = { post: 'POST', message: 'MSG' };

// Rows (also used by history.js)

/**
 * The short description under a headline: an article's summary from its feed, or the
 * rest of a post/message after its first line (which is the title). Cut at a word to
 * the Story descriptions setting (characters; 0 = none). Feeds often repeat the
 * headline as the description, so that part is dropped.
 */
export function descriptionOf(it, max = state.settings.DescriptionLength) {
  if (!max || !it.summary) return null;
  let text = (it.kind === 'article' ? it.summary : it.summary.split('\n').slice(1).join(' ')).replace(/\s+/g, ' ').trim();
  const title = it.title.trim();
  if (it.kind === 'article' && text.toLowerCase().startsWith(title.toLowerCase()))
    text = text.slice(title.length).replace(/^[\s.:,;|—–-]+/, '');
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:—–-]+$/, '')}…`;
}

/** Rebuilds every row (e.g. the description length changed). */
export function refreshRows() {
  for (const map of [nodes, memberNodes]) { for (const row of map.values()) row.remove(); map.clear(); }
  scheduleRender();
}

export function buildRow(it, { extraMeta = null } = {}) {
  const snippet = descriptionOf(it);
  const row = h('div', { class: 'item', role: 'option', dataset: { id: it.id },
                         title: it.summary && it.kind === 'article' ? it.summary.slice(0, 400) : null },
    h('div', { class: 'meta' },
      siteIcon(it),
      h('span', { class: 'badge', style: `background:${sourceColor(it.sourceId)}` }, it.sourceName),
      KIND_LABEL[it.kind] && h('span', { class: 'kind' }, KIND_LABEL[it.kind]),
      h('span', { class: 'time' }, formatStamp(it.publishedAt)),
      langTag(it),
      it.author && h('span', { class: 'author' }, it.author),
      extraMeta,
      h('span', { class: 'group-chip', hidden: true }),
      h('span', { class: 'saved-dot', title: 'Saved for offline reading', hidden: !it.saved }, '⤓')),
    h('div', { class: 'title' }, it.title),
    snippet && h('div', { class: 'snippet' }, snippet));
  return row;
}

/** The publisher's icon (a Telegram channel's avatar for its messages); hidden if none. */
export function siteIcon(it) {
  const src = iconUrl(it);
  if (!src) return null;
  const img = h('img', { class: 'fav', src, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
  img.addEventListener('error', () => img.remove(), { once: true });
  return img;
}

const iconCache = new Map();      // url -> icon URL (most rows share a handful of hosts)
export function iconUrl(it) {
  const key = it.site || it.url;
  if (!key) return null;
  if (iconCache.has(key)) return iconCache.get(key);
  let out = null;
  try {
    const u = new URL(/^https?:/i.test(key) ? key : `https://${key}`);
    const host = u.hostname.toLowerCase().replace(/^(www|m|amp|mobile)\./, '');
    const channel = host === 't.me' && u.pathname.split('/').filter(Boolean).find(p => p !== 's');
    out = channel ? `polyopticon-icon://tg/${channel.toLowerCase()}` : host.includes('.') ? `polyopticon-icon://site/${host}` : null;
  } catch { /* not a URL */ }
  if (iconCache.size > 5000) iconCache.clear();
  iconCache.set(key, out);
  return out;
}

function langTag(it) {
  if (!it.lang || it.lang === 'en') return null;
  const code = it.lang.toUpperCase();
  if (it.translating) return h('span', { class: 'xl pending', title: 'Translating on your computer…' }, `${code} -> EN…`);
  if (it.origTitle) return h('span', { class: 'xl', title: `Machine-translated from ${code}. Original:\n${it.origTitle}` }, `${code} -> EN`);
  return h('span', { class: 'xl raw', title: 'Not translated (translation off or no model for this language)' }, code);
}

export function markSaved(itemId) {
  const it = state.itemsById.get(itemId);
  if (it) it.saved = true;
  for (const row of document.querySelectorAll(`.item[data-id="${itemId}"] .saved-dot`)) row.hidden = false;
}

/** After all saved articles were deleted. */
export function unmarkAllSaved() {
  for (const it of state.itemsById.values()) it.saved = false;
  for (const dot of document.querySelectorAll('.item .saved-dot')) dot.hidden = true;
}

function rowFor(it) {
  let row = nodes.get(it.id);
  if (row) return row;
  row = buildRow(it);
  if (it.fresh) {
    row.classList.add('fresh');
    row.addEventListener('animationend', () => row.classList.remove('fresh'), { once: true });
  }
  if (it.id === state.selectedId) row.classList.add('selected');
  nodes.set(it.id, row);
  return row;
}

// Filtering

export function rebuildTagCache() {
  const pick = list => list.filter(t => t.IsActive).map(t => ({ text: t.Text.toLowerCase(), scope: t.Scope }));
  state.activeTags = { inc: pick(state.tags.Inclusions), exc: pick(state.tags.Exclusions) };
}

const hitScope = (t, it) =>
  t.scope === 1 ? it.titleLower.includes(t.text)
: t.scope === 2 ? it.summaryLower.includes(t.text)
: it.titleLower.includes(t.text) || it.summaryLower.includes(t.text);

function visibleSource(id) {
  const s = state.sourcesById.get(id);
  return !!s && s.enabled && !state.hiddenSources.has(id);
}

// Filter results are remembered per item until a filter changes (the signature below),
// so a render only checks new or changed items instead of every stored story. The
// max-age cutoff moves with time, so it's checked separately and isn't cached.
let filterSig = '';
function currentFilterSig() {
  return JSON.stringify([
    [...state.searchSources], [...state.hiddenSources],
    [...state.sourcesById.values()].map(s => s.enabled ? s.id : -s.id),
    state.placeFilter?.keys.join() ?? null, state.activeTags, state.search, state.caseSensitive,
  ]);
}

function passes(it) {
  if (it._filterSig !== filterSig) { it._passes = matches(it); it._filterSig = filterSig; }
  return it._passes;
}

function matches(it) {
  // Source chips in the search bar override the sidebar ticks: show exactly those sources.
  if (state.searchSources.size) {
    if (!state.searchSources.has(it.sourceId) || !state.sourcesById.get(it.sourceId)?.enabled) return false;
  } else if (!visibleSource(it.sourceId)) return false;
  if (state.placeFilter && !it.places?.some(p => state.placeFilter.keys.includes(p[0]))) return false;
  const { inc, exc } = state.activeTags;
  if (inc.length && !inc.some(t => hitScope(t, it))) return false;
  if (exc.length && exc.some(t => hitScope(t, it))) return false;
  if (state.search) {
    if (state.caseSensitive ? !it.title.includes(state.search) : !it.titleLower.includes(state.searchLower)) return false;
  }
  return true;
}

// Rendering

let renderQueued = false;
let scrollTopQueued = false;
let batchTimer = null;
let lastRenderAt = 0;
// New stories arrive one source poll at a time (dozens of small batches at start-up).
// Those renders are spaced at least this far apart; changes the user makes render at once.
const BATCH_RENDER_GAP_MS = 350;

export function scheduleRender({ scrollTop = false, batch = false } = {}) {
  scrollTopQueued ||= scrollTop;
  if (batch) {
    const wait = lastRenderAt + BATCH_RENDER_GAP_MS - performance.now();
    if (wait > 0) { batchTimer ??= setTimeout(() => { batchTimer = null; scheduleRender(); }, wait); return; }
  }
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    clearTimeout(batchTimer);
    batchTimer = null;
    renderFeed();
    lastRenderAt = performance.now();
    if (scrollTopQueued) scrollToTop();
    scrollTopQueued = false;
  });
}

// Whether the list is scrolled to the top, kept from scroll events: reading or setting
// scrollTop right after the list changed would force a layout of every row.
let atTop = true;
function scrollToTop() {
  if (!atTop) $('feed-list').scrollTop = 0;
  atTop = true;
}

// Only the first rows are in the page; more are added while scrolling down. Thousands
// of rows in the page made every update re-lay-out all of them (seconds of freezing
// while a burst of stories arrived). Back at the top, the list shrinks again.
const ROWS_STEP = 300;
let rowLimit = ROWS_STEP;
let moreQueued = false;

export function bindFeedScroll() {
  const list = $('feed-list');
  list.addEventListener('scroll', () => {
    atTop = list.scrollTop < 1;
    const nearEnd = list.scrollTop + list.clientHeight > list.scrollHeight - 1500;
    if (nearEnd && rowLimit < (state.visible?.length ?? 0) && !moreQueued) {
      moreQueued = true;
      requestAnimationFrame(() => { moreQueued = false; rowLimit += ROWS_STEP; renderFeed(); });
    }
  }, { passive: true });
}

/** Rows for items shown inside an expanded group (separate from lead rows). */
function memberRowFor(it) {
  let row = memberNodes.get(it.id);
  if (!row) {
    row = buildRow(it);
    row.classList.add('member');
    memberNodes.set(it.id, row);
  }
  return row;
}

/** Shows "+N" on a group's lead row, listing the other sources in the tooltip. */
function setGroupChip(row, clusterId, members) {
  const chip = row.querySelector('.group-chip');
  const sig = members && members.length > 1 ? `${clusterId}:${members.length}:${expanded.has(clusterId)}` : '';
  if (row._groupSig === sig) return;
  row._groupSig = sig;
  row.classList.toggle('grouped', !!sig);
  if (!sig) { chip.hidden = true; return; }
  const others = members.slice(1);
  const sources = [...new Set(others.map(m => m.sourceName))];
  chip.hidden = false;
  chip.dataset.cluster = clusterId;
  chip.classList.toggle('open', expanded.has(clusterId));
  chip.title = `${others.length} more report${others.length > 1 ? 's' : ''} of this story: ${sources.join(', ')}\nClick to ${expanded.has(clusterId) ? 'collapse' : 'expand'}`;
  chip.replaceChildren(
    ...[...new Set(others.map(m => m.sourceId))].slice(0, 5).map(id => h('i', { style: `background:${sourceColor(id)}` })),
    `+${others.length}`);
}

export function toggleGroup(clusterId) {
  if (expanded.has(clusterId)) expanded.delete(clusterId); else expanded.add(clusterId);
  scheduleRender();
}

/** Reorders the list to match `rows` with the fewest DOM moves. */
function reconcile(list, rows) {
  const keep = new Set(rows);
  for (const child of [...list.children]) if (!keep.has(child)) child.remove();
  let cursor = list.firstElementChild;
  for (const row of rows) {
    if (row === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(row, cursor);
  }
}

const renderFeed = () => measure(
  () => `story list update (${$('feed-list').childElementCount} rows, ${state.items.length} stories)`, renderFeedNow);

function renderFeedNow() {
  const list = $('feed-list');
  const maxAge = state.settings.MaxArticleAgeHours;
  const cutoff = maxAge > 0 ? Date.now() - maxAge * 3600e3 : -Infinity;
  filterSig = currentFilterSig();
  const visible = state.items.filter(it => it.publishedAt >= cutoff && passes(it));
  state.visible = visible;

  if (atTop) rowLimit = ROWS_STEP;
  let rows, stories = visible.length;
  if (state.settings.GroupStories) {
    // One row per story (its newest report); expanded groups list the rest underneath.
    const groups = new Map();
    for (const it of visible) {
      const cid = it.clusterId ?? it.id;
      if (!groups.has(cid)) groups.set(cid, []);
      groups.get(cid).push(it);
    }
    rows = [];
    for (const [cid, list] of groups) {
      // The group sits where its newest report is, but its headline comes from a
      // direct source when there is one (GDELT copies carry crawl times, not
      // publish times, so they'd otherwise always win).
      const best = list.find(m => state.sourcesById.get(m.sourceId)?.type !== 'gdelt') ?? list[0];
      const members = best === list[0] ? list : [best, ...list.filter(m => m !== best)];
      if (rows.length >= rowLimit) continue;                 // still counted as a story
      const lead = rowFor(members[0]);
      setGroupChip(lead, cid, members);
      rows.push(lead);
      if (members.length > 1 && expanded.has(cid)) for (const m of members.slice(1)) rows.push(memberRowFor(m));
    }
    stories = groups.size;
  } else {
    rows = visible.slice(0, rowLimit).map(it => { const r = rowFor(it); setGroupChip(r, null, null); return r; });
  }
  reconcile(list, rows);

  if (state.mode === 'live') {
    const total = state.items.length;
    const shown = visible.length === total ? `${total}` : `${visible.length} / ${total}`;
    $('feed-count').textContent = state.settings.GroupStories && stories !== visible.length ? `${stories} stories · ${shown}` : shown;
    $('feed-empty').hidden = visible.length > 0;
    $('feed-empty').textContent = total ? 'No stories match the current filters.' : 'Waiting for stories…';
  }
  onVisibleChanged(visible);
}

// Ingestion

// Per-source item counts shown in the sidebar.
const countSource = (id, d) => state.sourceCounts.set(id, (state.sourceCounts.get(id) ?? 0) + d);

function insertSorted(it) {
  const arr = state.items;
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].publishedAt >= it.publishedAt) lo = mid + 1; else hi = mid;
  }
  arr.splice(lo, 0, it);
}

// Every source keeps at least its newest few stories in the live list, so slow
// sources (a daily feed, a blog) aren't pushed out by busy ones. Must match
// PER_SOURCE_MIN in db.recentItems.
const PER_SOURCE_MIN = 10;

export function trimToMax() {
  const max = state.settings.MaxFeedItems;
  if (state.items.length <= max) return;
  const perSource = new Map();
  for (const it of state.items) perSource.set(it.sourceId, (perSource.get(it.sourceId) ?? 0) + 1);
  // Oldest first; a story is kept if it's among its source's newest PER_SOURCE_MIN.
  for (let i = state.items.length - 1; i >= 0 && state.items.length > max; i--) {
    const old = state.items[i];
    if (perSource.get(old.sourceId) <= PER_SOURCE_MIN) continue;
    perSource.set(old.sourceId, perSource.get(old.sourceId) - 1);
    state.items.splice(i, 1);
    for (const map of [nodes, memberNodes]) { map.get(old.id)?.remove(); map.delete(old.id); }
    state.itemsById.delete(old.id);
    countSource(old.sourceId, -1);
  }
}

/** Adds items to the live list. `fresh` animates them in (new arrivals vs. history load). */
export function ingest(incoming, { fresh = true } = {}) {
  let added = 0;
  for (const raw of incoming) {
    // Cross-source de-dup on URL (or title for URL-less items).
    const key = (raw.url ?? `${raw.sourceId}|${raw.title}`).toLowerCase();
    if (state.seenKeys.has(key) || state.itemsById.has(raw.id)) continue;
    state.seenKeys.add(key);
    const it = { ...raw, saved: !!raw.saved, fresh,
                 titleLower: raw.title.toLowerCase(), summaryLower: (raw.summary ?? '').toLowerCase() };
    insertSorted(it);
    state.itemsById.set(it.id, it);
    countSource(it.sourceId, 1);
    added++;
  }
  if (!added) return;
  trimToMax();
  api.setState('app.items_total', state.items.length);
  scheduleRender({ scrollTop: fresh && state.autoScroll, batch: true });
  onCountsChanged();
}

/** Applies worker updates (translations finished, groups/places assigned). */
export function updateItems(updates) {
  for (const u of updates) {
    const it = state.itemsById.get(u.id);
    if (!it) continue;
    Object.assign(it, {
      title: u.title, summary: u.summary, clusterId: u.clusterId, places: u.places ?? [],
      lang: u.lang, origTitle: u.origTitle ?? null, translating: !!u.translating, fresh: false,
      titleLower: u.title.toLowerCase(), summaryLower: (u.summary ?? '').toLowerCase(),
      _filterSig: null,                                         // re-check filters (new title/places)
    });
    for (const map of [nodes, memberNodes]) { map.get(it.id)?.remove(); map.delete(it.id); }
  }
  scheduleRender({ batch: true });
}

/** Drops rows of sources that were deleted. */
export function pruneSources() {
  const before = state.items.length;
  state.items = state.items.filter(it => {
    if (state.sourcesById.has(it.sourceId)) return true;
    for (const map of [nodes, memberNodes]) { map.get(it.id)?.remove(); map.delete(it.id); }
    state.itemsById.delete(it.id);
    countSource(it.sourceId, -1);
    return false;
  });
  if (state.items.length !== before) scheduleRender();
}

// Selection & interaction (shared with History)

export function select(list, id, { scroll = false } = {}) {
  list.querySelector('.item.selected')?.classList.remove('selected');
  if (list.id === 'feed-list') state.selectedId = id;
  const row = id != null ? list.querySelector(`.item[data-id="${id}"]`) : null;
  if (row) {
    row.classList.add('selected');
    if (scroll) row.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * Wires mouse + keyboard on a list of .item rows.
 * lookup(id) -> item; opts.preferSaved opens the saved copy instead of the live page.
 */
export function bindList(list, lookup, { preferSaved = false } = {}) {
  const rowItem = e => { const row = e.target.closest('.item'); return row ? lookup(Number(row.dataset.id)) : null; };
  const open = it => openTab(it, { preferSaved: typeof preferSaved === 'function' ? preferSaved() : preferSaved });

  // Middle-click -> tab. Handled on mousedown so it feels instant and suppresses autoscroll.
  list.addEventListener('mousedown', e => {
    if (e.button !== 1) return;
    const it = rowItem(e);
    if (!it) return;
    e.preventDefault();
    select(list, it.id);
    open(it);
  });

  list.addEventListener('click', e => {
    const chip = e.target.closest('.group-chip');
    if (chip) return toggleGroup(Number(chip.dataset.cluster));
    const it = rowItem(e);
    if (!it) return;
    if (e.ctrlKey || e.metaKey) return openInBrowser(it);
    select(list, it.id);
  });

  list.addEventListener('dblclick', e => { const it = rowItem(e); if (it) open(it); });

  // Right-click a story's source badge: limit the search to that source (again to undo).
  list.addEventListener('contextmenu', e => {
    if (!e.target.closest('.badge')) return;
    const it = rowItem(e);
    if (!it) return;
    e.preventDefault();
    toggleSearchSource(it.sourceId);
  });

  // Keyboard: Up/Down/Home/End move selection, Enter opens, Ctrl+Enter opens in browser.
  list.addEventListener('keydown', e => {
    const rows = [...list.querySelectorAll('.item')];
    if (!rows.length) return;
    const cur = list.querySelector('.item.selected');
    const idx = cur ? rows.indexOf(cur) : -1;
    let next = null;
    if (e.key === 'ArrowDown') next = rows[Math.min(idx + 1, rows.length - 1)];
    else if (e.key === 'ArrowUp') next = rows[Math.max(idx - 1, 0)];
    else if (e.key === 'Home') next = rows[0];
    else if (e.key === 'End') next = rows[rows.length - 1];
    else if (e.key === 'Enter' && cur) {
      e.preventDefault();
      const it = lookup(Number(cur.dataset.id));
      if (it) { if (e.ctrlKey) openInBrowser(it); else open(it); }
      return;
    } else return;
    e.preventDefault();
    select(list, Number(next.dataset.id), { scroll: true });
  });
}
