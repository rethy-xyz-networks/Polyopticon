// Global Markets view: a tile per instrument with its current price and today's change.
// A special view like the map and the bias chart, not a tab: it replaces the article area while open.
//
// Quotes come from the main process (src/main/markets.js), which polls Yahoo Finance once a second,
// but only while this view is open and the window is visible. Nothing is stored: the tiles show the
// latest price and the change since the previous close, nothing historical.
//
// The tiles are built once and updated in place on each quote, so a one-second feed costs a few text
// writes. The user's changes are kept in ui.json: marketsAdded [{ symbol, name, group }] and
// marketsRemoved [symbol] (a default tile they hid).

import { api, $, h } from './dom.js';
import { ui, saveUi } from './ui.js';

// [symbol, label]. Yahoo's own names ("S&P 500", "Crude Oil Jun 26") are inconsistent, so defaults carry theirs.
export const GROUPS = [
  { id: 'us', name: 'United States', words: 'usa us america', items: [['^GSPC', 'S&P 500'], ['^IXIC', 'Nasdaq Composite'], ['^DJI', 'Dow Jones'], ['^RUT', 'Russell 2000'], ['^VIX', 'VIX']] },
  { id: 'ca', name: 'Canada', words: 'tsx toronto', items: [['^GSPTSE', 'S&P/TSX Composite']] },
  { id: 'apac', name: 'Asia-Pacific', words: 'asia pacific japan china hong kong korea south australia india', items: [['^N225', 'Nikkei 225'], ['^HSI', 'Hang Seng'], ['000001.SS', 'Shanghai Composite'], ['399001.SZ', 'Shenzhen Component'], ['^KS11', 'KOSPI'], ['^AXJO', 'ASX 200'], ['^NSEI', 'Nifty 50']] },
  { id: 'eu', name: 'Europe', words: 'uk united kingdom britain germany france eurozone', items: [['^FTSE', 'FTSE 100'], ['^GDAXI', 'DAX'], ['^FCHI', 'CAC 40'], ['^STOXX50E', 'Euro Stoxx 50']] },
  { id: 'energy', name: 'Energy', words: 'oil gas commodities', items: [['CL=F', 'WTI crude'], ['BZ=F', 'Brent crude'], ['NG=F', 'Natural gas']] },
  { id: 'other', name: 'Metals & currencies', words: 'gold forex fx dollar yen yuan', items: [['GC=F', 'Gold'], ['DX-Y.NYB', 'US dollar index'], ['CAD=X', 'USD / CAD'], ['JPY=X', 'USD / JPY'], ['CNY=X', 'USD / CNY']] },
  { id: 'crypto', name: 'Crypto', words: 'cryptocurrency coins bitcoin ethereum', items: [['BTC-USD', 'Bitcoin'], ['ETH-USD', 'Ethereum'], ['XRP-USD', 'XRP']] },
];

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

const removed = () => new Set(ui.marketsRemoved ?? []);
const added   = () => (Array.isArray(ui.marketsAdded) ? ui.marketsAdded : []);

/** The tiles of one group, in order: defaults the user hasn't hidden, then what they added. */
function itemsOf(group) {
  const gone = removed();
  return [
    ...group.items.filter(([s]) => !gone.has(s)).map(([symbol, name]) => ({ symbol, name, custom: false })),
    ...added().filter(a => a.group === group.id).map(a => ({ symbol: a.symbol, name: a.name, custom: true })),
  ];
}

export const allSymbols = () => GROUPS.flatMap(g => itemsOf(g).map(i => i.symbol));

const isShown = symbol => allSymbols().includes(symbol);

// Lifecycle

export function initMarkets() {
  reduceMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  $('btn-markets').addEventListener('click', () => (open ? closeMarkets() : openMarkets()));
  $('markets-search').addEventListener('input', e => { query = e.target.value; applyFilter(); });
  $('markets-search').addEventListener('keydown', e => { if (e.key === 'Escape' && query) { e.stopPropagation(); e.target.value = ''; query = ''; applyFilter(); } });
  $('markets-refresh').addEventListener('click', () => { if (open) { api.stopMarkets(); api.startMarkets(allSymbols()); } });
  $('markets-restore').addEventListener('click', () => { saveUi({ marketsRemoved: [] }); rebuild(); });
  document.addEventListener('story:activate', () => closeMarkets());
  document.addEventListener('special-view', e => { if (e.detail !== 'markets') closeMarkets(); });   // the map or the bias chart opened
  // A hidden or minimised window stops polling; it picks up again on return.
  document.addEventListener('visibilitychange', () => {
    if (!open) return;
    if (document.hidden) api.stopMarkets(); else api.startMarkets(allSymbols());
  });
  api.onMarketQuotes(applyQuotes);
  api.onMarketStatus(s => { status = s; paintStatus(); });
}

export function toggleMarkets() { return open ? closeMarkets() : openMarkets(); }

export function openMarkets() {
  if (open) return;
  open = true;
  document.dispatchEvent(new CustomEvent('special-view', { detail: 'markets' }));
  document.querySelector('.story').classList.add('markets-open');
  $('btn-markets').classList.add('on');
  if (!built) rebuild();
  paintStatus();
  if (!document.hidden) api.startMarkets(allSymbols());
}

export function closeMarkets() {
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
  const root = $('markets-groups');
  root.replaceChildren(...GROUPS.map(buildGroup));
  $('markets-restore').hidden = !(ui.marketsRemoved ?? []).length;
  for (const q of quotes.values()) paintTile(q, false);
  paintGroups();
  applyFilter();
  if (open) api.setMarkets(allSymbols());
}

function buildGroup(group) {
  const items = itemsOf(group);
  const count = h('span', { class: 'mk-count' });
  const grid = h('div', { class: 'mk-grid' }, items.map(buildTile), buildAddTile(group));
  const el = h('section', { class: 'mk-group', dataset: { group: group.id } },
    h('h3', { class: 'mk-head' }, group.name, count), grid);
  groupEls.set(group.id, { el, count, symbols: items.map(i => i.symbol), text: `${group.name} ${group.words ?? ''}`.toLowerCase(), addTile: grid.lastChild });
  return el;
}

function buildTile({ symbol, name, custom }) {
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
    h('button', { class: 'mk-remove', title: `Remove ${name}`, 'aria-label': `Remove ${name}`, onclick: () => removeSymbol(symbol, custom) }, '×'));
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
    saveUi({
      marketsAdded: [...added(), { symbol, name, group: group.id }],
      marketsRemoved: (ui.marketsRemoved ?? []).filter(s => s !== symbol),
    });
    quotes.set(symbol, res.quote);
    rebuild();
  });
  return h('div', { class: 'mk-add' }, btn, form);
}

function removeSymbol(symbol, custom) {
  if (custom) saveUi({ marketsAdded: added().filter(a => a.symbol !== symbol) });
  else saveUi({ marketsRemoved: [...removed(), symbol] });
  rebuild();
}

// Search

/**
 * Every word typed must match the tile's name or symbol, or its group's name or country words, so "asia" shows
 * the whole Asia-Pacific group and "nikkei" shows one tile. Groups with nothing to show are hidden, as are the
 * + Add tiles, so a search never offers to add to a list it is narrowing.
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
  $('markets-empty').hidden = !!shown;
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
