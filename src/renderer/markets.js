// Global Markets view: a tile per instrument with its current price and today's change.
// A special view like the map and the bias chart, not a tab: it replaces the article area while open.
//
// Quotes come from the main process (src/main/markets.js), which polls Yahoo Finance once a second,
// but only while this view is open and the window is visible. Nothing is stored: the tiles show the
// latest price and the change since the previous close, nothing historical.
//
// The tiles are built once and updated in place on each quote, so a one-second feed costs a few text
// writes. The groups are the user's own: none at first, each made with + New group, filled with + Add and
// removed from its header. They're kept in ui.json as marketsGroups [{ id, name, items: [{ symbol, name }] }],
// in the order shown; dragging a tile rewrites its group's items (and the one it left).

import { api, $, h } from './dom.js';
import { ui, saveUi } from './ui.js';

const STATE_LABEL = { open: 'OPEN', pre: 'PRE-MARKET', closed: 'CLOSED' };
const TICK = { up: '▲', down: '▼', flat: '■' };

let open = false;
let built = false;
let reduceMotion = false;
const quotes = new Map();                          // symbol -> latest parsed quote (main/markets.js parseQuote)
const tiles = new Map();                           // symbol -> { el, price, change, badge, name }
const groupEls = new Map();                        // group id -> { head count, symbols }
const formats = new Map();                         // decimals -> Intl.NumberFormat
let query = '';
let lastAt = 0, status = { state: 'ok' };

// What's shown

/** The user's groups, in order. A symbol is in at most one group (see isShown). */
export const groups = () => (Array.isArray(ui.marketsGroups) ? ui.marketsGroups : [])
  .filter(g => g && typeof g.id === 'string')
  .map(g => ({ id: g.id, name: String(g.name ?? ''), items: Array.isArray(g.items) ? g.items.filter(i => i && typeof i.symbol === 'string') : [] }));

const saveGroups = list => { saveUi({ marketsGroups: list }); rebuild(); };

export const allSymbols = () => groups().flatMap(g => g.items.map(i => i.symbol));

const isShown = symbol => allSymbols().includes(symbol);

// Lifecycle

export function initMarkets() {
  reduceMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  $('markets-search').addEventListener('input', e => { query = e.target.value; applyFilter(); });
  $('markets-search').addEventListener('keydown', e => { if (e.key === 'Escape' && query) { e.stopPropagation(); e.target.value = ''; query = ''; applyFilter(); } });
  $('markets-refresh').addEventListener('click', () => { if (open) { api.stopMarkets(); api.startMarkets(allSymbols()); } });
  document.addEventListener('story:view', e => (e.detail === 'markets' ? openMarkets() : closeMarkets()));   // its tab was selected, or another
  // A hidden or minimised window stops polling; it picks up again on return.
  document.addEventListener('visibilitychange', () => {
    if (!open) return;
    if (document.hidden) api.stopMarkets(); else api.startMarkets(allSymbols());
  });
  makeTilesMovable($('markets-groups'));
  api.onMarketQuotes(applyQuotes);
  api.onMarketStatus(s => { status = s; paintStatus(); });
}

function openMarkets() {
  if (open) return;
  open = true;
  document.querySelector('.story').classList.add('markets-open');
  $('btn-markets').classList.add('on');
  if (!built) rebuild();
  paintStatus();
  if (!document.hidden) api.startMarkets(allSymbols());
}

function closeMarkets() {
  if (!open) return;
  open = false;
  document.querySelector('.story').classList.remove('markets-open');
  $('btn-markets').classList.remove('on');
  api.stopMarkets();
}

// Building

function rebuild() {
  built = true;
  tiles.clear(); groupEls.clear();
  const list = groups();
  $('markets-groups').replaceChildren(...list.map(buildGroup), buildNewGroup(!list.length));
  for (const q of quotes.values()) paintTile(q, false);
  paintGroups();
  applyFilter();
  if (open) api.setMarkets(allSymbols());
}

function buildGroup(group) {
  const count = h('span', { class: 'mk-count' });
  const grid = h('div', { class: 'mk-grid' }, group.items.map(buildTile), buildAddTile(group));
  const el = h('section', { class: 'mk-group', dataset: { group: group.id } },
    h('h3', { class: 'mk-head' }, h('span', { class: 'mk-group-name' }, group.name), count, buildRemoveGroup(group)), grid);
  groupEls.set(group.id, { el, count, symbols: group.items.map(i => i.symbol), text: group.name.toLowerCase(), addTile: grid.lastChild });
  return el;
}

/** The header's Remove group. A group with tiles asks once more ("Remove group and its 3 tiles?") before it goes. */
function buildRemoveGroup(group) {
  const n = group.items.length;
  const label = `Remove group ${group.name}`;
  const btn = h('button', { class: 'mk-group-remove', type: 'button', title: label, 'aria-label': label }, 'Remove');
  const disarm = () => { delete btn.dataset.armed; btn.textContent = 'Remove'; };
  btn.addEventListener('click', () => {
    if (n && !btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = `Remove group and its ${n} tile${n === 1 ? '' : 's'}?`; return; }
    saveGroups(groups().filter(g => g.id !== group.id));
  });
  btn.addEventListener('blur', disarm);
  btn.addEventListener('keydown', e => { if (e.key === 'Escape' && btn.dataset.armed) { e.stopPropagation(); disarm(); } });
  return btn;
}

/** + New group, after the last group: type a name and press Enter. With no groups yet it says how to start. */
function buildNewGroup(empty) {
  const input = h('input', { type: 'text', class: 'mk-new-input', placeholder: 'Group name, e.g. Tech stocks', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'New group name', maxlength: '40' });
  const form = h('form', { class: 'mk-new-form', hidden: true }, input);
  const btn = h('button', { class: 'mk-new-btn toggle-btn', type: 'button' }, '+ New group');
  const show = on => { form.hidden = !on; btn.hidden = on; if (on) { input.value = ''; input.focus(); } };
  btn.addEventListener('click', () => show(true));
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); show(false); } });
  input.addEventListener('blur', () => setTimeout(() => { if (!input.value && !form.hidden) show(false); }, 150));
  form.addEventListener('submit', e => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return show(false);
    saveGroups([...groups(), { id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, items: [] }]);
  });
  return h('div', { class: 'mk-new' },
    empty && h('p', { class: 'mk-new-hint' }, 'No groups yet. Make one, then add the tickers you want to follow to it.'),
    btn, form);
}

function buildTile({ symbol, name }) {
  const t = {
    name:   h('span', { class: 'mk-name', title: name }, name),
    badge:  h('span', { class: 'mk-badge' }),
    price:  h('span', { class: 'mk-price' }, '—'),
    change: h('span', { class: 'mk-change' }, ''),
  };
  t.text = `${name} ${symbol}`.toLowerCase();
  t.el = h('div', { class: 'mk-tile', dataset: { symbol }, title: `${name} (${symbol})` },
    h('div', { class: 'mk-top' }, t.name, t.badge),
    t.price,
    h('div', { class: 'mk-bottom' }, t.change, h('span', { class: 'mk-symbol' }, symbol)),
    h('button', { class: 'mk-remove', title: `Remove ${name}`, 'aria-label': `Remove ${name}`, onclick: () => removeSymbol(symbol) }, '×'));
  tiles.set(symbol, t);
  return t.el;
}

/** The last tile of a group: type a Yahoo symbol (SOL-USD, ^GSPC, AAPL …) to track it. */
function buildAddTile(group) {
  const msg = h('div', { class: 'mk-add-msg', role: 'status' });
  const input = h('input', { type: 'text', class: 'mk-add-input', placeholder: 'Symbol, e.g. SOL-USD', spellcheck: 'false', autocomplete: 'off', 'aria-label': `Add a symbol to ${group.name}`, maxlength: '20' });
  const form = h('form', { class: 'mk-add-form', hidden: true }, input, msg);
  const btn = h('button', { class: 'mk-add-btn', type: 'button', 'aria-label': `Add to ${group.name}` }, '+ Add');
  const show = on => { form.hidden = !on; btn.hidden = on; msg.textContent = ''; if (on) { input.value = ''; input.focus(); } };
  btn.addEventListener('click', () => show(true));
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); show(false); } });
  input.addEventListener('blur', () => setTimeout(() => { if (!input.value && !form.hidden && !form.dataset.busy) show(false); }, 150));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return show(false);
    form.dataset.busy = '1'; input.disabled = true; msg.textContent = 'Looking up…';
    const res = await api.lookupMarket(text);
    delete form.dataset.busy; input.disabled = false;
    if (!res.ok) { msg.textContent = res.error; input.focus(); return; }
    const { symbol, name } = res.quote;
    if (isShown(symbol)) { msg.textContent = `${symbol} is already on the page.`; input.focus(); return; }
    const list = groups();
    const g = list.find(g => g.id === group.id);
    if (!g) return;                                // removed meanwhile
    g.items.push({ symbol, name });
    quotes.set(symbol, res.quote);
    saveGroups(list);
  });
  return h('div', { class: 'mk-add' }, btn, form);
}

function removeSymbol(symbol) {
  saveGroups(groups().map(g => ({ ...g, items: g.items.filter(i => i.symbol !== symbol) })));
}

// Moving tiles

/**
 * Drag a tile to move it within its group or into another. A copy follows the pointer while the tile itself,
 * dimmed, moves through the list to show where it will land; the others make room as it passes over them:
 * over a tile's left half it goes before it, over the right half after, over a group's + Add tile to the end
 * of that group. Every group's order is saved on release. The copy is position: fixed because a moved
 * (transformed) tile would stretch the list, and scrolling at its bottom edge would then never end.
 */
function makeTilesMovable(root) {
  let drag = null;

  root.addEventListener('pointerdown', e => {
    const el = e.target.closest('.mk-tile');
    if (!el || e.button !== 0 || e.target.closest('button, input')) return;
    drag = { el, pointerId: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moving: false };
  });
  window.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.moving) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
      const r = drag.el.getBoundingClientRect();
      drag.grabX = drag.startX - r.left; drag.grabY = drag.startY - r.top;
      drag.moving = true;
      drag.ghost = drag.el.cloneNode(true);
      drag.ghost.classList.add('mk-ghost');
      delete drag.ghost.dataset.symbol;
      drag.ghost.querySelector('.mk-remove')?.remove();
      drag.ghost.style.width = `${r.width}px`; drag.ghost.style.height = `${r.height}px`;
      root.after(drag.ghost);                        // inside the view, for its colours
      drag.el.classList.add('dragging');
      root.classList.add('moving');
      drag.raf = requestAnimationFrame(edgeScroll);
    }
    e.preventDefault();
    dragTo();
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    if (!d.moving) return;
    cancelAnimationFrame(d.raf);
    d.ghost.remove();
    d.el.classList.remove('dragging');
    root.classList.remove('moving');
    if (d.el.isConnected) saveOrder(root);
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);

  // Holding the tile near the top or bottom edge scrolls the list, even while the pointer is still.
  function edgeScroll() {
    if (!drag) return;
    const r = root.getBoundingClientRect();
    const dy = drag.y < r.top + 32 ? -10 : drag.y > r.bottom - 32 ? 10 : 0;
    if (dy) { root.scrollTop += dy; dragTo(); }
    drag.raf = requestAnimationFrame(edgeScroll);
  }

  function dragTo() {
    const { el, x, y } = drag;
    const where = placeAt(el, x, y);
    if (where && (where.before ? el.nextElementSibling !== where.before : el.parentNode !== where.grid || el.nextElementSibling !== where.grid.lastElementChild)) {
      // Slide the tiles that make room into their new places instead of jumping.
      const grids = new Set([el.parentNode, where.grid]);
      const others = [...grids].flatMap(g => [...g.children].filter(n => n !== el));
      const was = new Map(others.map(n => [n, n.getBoundingClientRect()]));
      if (where.before) where.before.before(el); else where.grid.lastElementChild.before(el);   // before the + Add tile
      if (!reduceMotion) for (const n of others) {
        const a = was.get(n), b = n.getBoundingClientRect();
        if (a.left !== b.left || a.top !== b.top)
          n.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: 'none' }], { duration: 140, easing: 'ease-out' });
      }
    }
    drag.ghost.style.transform = `translate(${x - drag.grabX}px, ${y - drag.grabY}px)`;
  }
}

/** Where a tile dropped at (x, y) goes: { grid, before } (before null = the end of grid), or null to stay put. */
function placeAt(el, x, y) {
  const under = document.elementFromPoint(x, y);   // the copy and the dragged tile ignore the pointer
  const tile = under?.closest('.mk-tile');
  if (tile && tile !== el) {
    const r = tile.getBoundingClientRect(), next = tile.nextElementSibling;
    if (x < r.left + r.width / 2) return { grid: tile.parentNode, before: tile };
    return next === el ? null : { grid: tile.parentNode, before: next?.classList.contains('mk-tile') ? next : null };
  }
  const add = under?.closest('.mk-add');
  return add ? { grid: add.parentNode, before: null } : null;
}

function saveOrder(root) {
  const items = new Map(groups().flatMap(g => g.items.map(i => [i.symbol, i])));
  const order = new Map([...root.querySelectorAll('.mk-group')].map(g => [g.dataset.group, [...g.querySelectorAll('.mk-tile')].map(t => items.get(t.dataset.symbol)).filter(Boolean)]));
  saveGroups(groups().map(g => ({ ...g, items: order.get(g.id) ?? g.items })));
}

// Search

/**
 * Every word typed must match the tile's name or symbol, or its group's name, so a group's name shows the whole
 * group and "nikkei" shows one tile. Groups with nothing to show are hidden, as are the + Add tiles and
 * + New group, so a search never offers to add to a list it is narrowing.
 */
function applyFilter() {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const g of groupEls.values()) {
    let any = false;
    for (const symbol of g.symbols) {
      const t = tiles.get(symbol);
      const text = `${t.text} ${g.text}`;
      t.el.hidden = !words.every(w => text.includes(w));
      any ||= !t.el.hidden;
    }
    g.addTile.hidden = !!words.length;
    g.el.hidden = !any && !!words.length;
    if (!g.el.hidden) shown++;
  }
  $('markets-groups').querySelector('.mk-new').hidden = !!words.length;
  $('markets-empty').hidden = !!shown || !words.length;
}

// Painting

const format = decimals => {
  let f = formats.get(decimals);
  if (!f) formats.set(decimals, f = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
  return f;
};

const decimalsFor = q => q.decimals ?? (Math.abs(q.price) < 10 ? 4 : 2);

/** Percent as "+0.62%" (a real minus sign for losses). */
const pctText = pct => `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(2)}%`;

export function applyQuotes({ quotes: list, at }) {
  lastAt = at;
  for (const q of list) {
    const prev = quotes.get(q.symbol);
    quotes.set(q.symbol, q);
    paintTile(q, prev && prev.price !== q.price ? (q.price > prev.price ? 'up' : 'down') : false);
  }
  paintGroups();
  paintStatus();
}

function paintTile(q, flashDir) {
  const t = tiles.get(q.symbol);
  if (!t) return;
  const dir = q.pct == null || Math.abs(q.pct) < 0.005 ? 'flat' : q.pct > 0 ? 'up' : 'down';
  t.price.textContent = format(decimalsFor(q)).format(q.price);
  t.change.textContent = q.pct == null ? '' : `${TICK[dir]} ${pctText(q.pct)}`;
  t.badge.textContent = STATE_LABEL[q.state] ?? '';
  t.el.dataset.dir = dir;
  t.el.dataset.state = q.state;
  if (flashDir && !reduceMotion) {
    t.price.animate([{ color: flashDir === 'up' ? 'var(--mk-up)' : 'var(--mk-down)' }, { color: 'var(--text)' }], { duration: 700, easing: 'ease-out' });
  }
}

/** "3 of 5 open" on each group header. */
function paintGroups() {
  for (const { count, symbols } of groupEls.values()) {
    const known = symbols.map(s => quotes.get(s)).filter(Boolean);
    count.textContent = known.length ? `${known.filter(q => q.state === 'open').length} of ${symbols.length} open` : '';
  }
}

function paintStatus() {
  const el = $('markets-status');
  if (!el) return;
  el.dataset.state = status.state;
  el.textContent = status.state === 'limited' ? `Yahoo is rate limiting us; retrying in ${status.retryIn}s`
    : status.state === 'error' ? `Can't reach Yahoo (${status.error}); retrying in ${status.retryIn}s`
    : lastAt ? `Live · updated ${new Date(lastAt).toLocaleTimeString()}`
    : 'Connecting…';
}
