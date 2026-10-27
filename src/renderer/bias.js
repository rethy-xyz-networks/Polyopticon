// Bias view: where each news feed's outlet sits politically (across) and how reliable it is (up).
// An app tab like the map (tabs.js): it fills the article area while its tab is selected.
//
// Positions come from the lookup in the main process (src/main/bias.js): x is the mean of the
// raters' verdicts (-2 left … 2 right), y the mean of their factuality ratings (1 low … 4 very high).
// Feeds of one outlet (five SCMP feeds) are one dot. Outlets with no rating, and feeds no outlet was
// found for, are listed below the chart.

import { api, $, h } from './dom.js';
import { state } from './state.js';

const X_MIN = -2.45, X_MAX = 2.45;                // a little beyond Left and Right, so their dots aren't on the edge
const Y_MIN = 0.55, Y_MAX = 4.45;
const X_TICKS = [[-2, 'Left'], [-1, 'Lean left'], [0, 'Center'], [1, 'Lean right'], [2, 'Right']];
const Y_TICKS = [[4, 'Very high'], [3, 'High'], [2, 'Mixed'], [1, 'Low']];
const MARGIN = { top: 12, right: 18, bottom: 30, left: 74 };
const NO_FACT_H = 46;                             // the band below the chart for outlets with no factuality rating
const DOT = 7;
const AXIS_TITLE = 'Reliability ▲';

const LEAN = { left: 'Left', leanLeft: 'Lean left', center: 'Center', centre: 'Center', leanRight: 'Lean right', right: 'Right' };
const FACT = { veryHigh: 'Very high', high: 'High', mostlyFactual: 'Mostly factual', mixed: 'Mixed', low: 'Low', veryLow: 'Very low' };
const label = (table, v) => table[v] ?? v;

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  el.append(...kids.flat().filter(Boolean));
  return el;
};

let open = false;
let drawTimer = null;
let measure = null;                               // canvas context, for the width of labels

// Lifecycle

export function initBias() {
  document.addEventListener('story:view', e => (e.detail === 'bias' ? openBias() : closeBias()));   // its tab was selected, or another
  new ResizeObserver(() => { if (open) drawSoon(); }).observe($('bias-chart'));
  $('bias-chart').addEventListener('pointerleave', hideTip);
}

function openBias() {
  if (open) return;
  open = true;
  document.querySelector('.story').classList.add('bias-open');
  $('btn-bias').classList.add('on');
  requestAnimationFrame(draw);
}

function closeBias() {
  if (!open) return;
  open = false;
  document.querySelector('.story').classList.remove('bias-open');
  $('btn-bias').classList.remove('on');
  hideTip();
}

/** The lookups or the sources changed. */
export function refreshBias() { if (open) drawSoon(); }

function drawSoon() {
  clearTimeout(drawTimer);
  drawTimer = setTimeout(draw, 60);
}

// Data

/** Enabled feeds -> dots (one per outlet), feeds with an outlet but no rating, feeds with no outlet, feeds not looked up yet. */
function collect() {
  const dots = new Map(), unrated = [], unknown = [];
  let pending = 0;
  for (const s of state.sources) {
    if (s.type !== 'rss' || !s.enabled) continue;
    const row = state.bias.get(s.id);
    if (!row) { pending++; continue; }
    const o = row.outlet;
    if (!o) unknown.push(s);
    else if (o.x == null) unrated.push({ source: s, outlet: o });
    else {
      let d = dots.get(o.slug);
      if (!d) dots.set(o.slug, d = { outlet: o, feeds: [] });
      d.feeds.push(s);
    }
  }
  return { dots: [...dots.values()], unrated, unknown, pending };
}

// Drawing

const textWidth = (text, font) => {
  measure ??= document.createElement('canvas').getContext('2d');
  measure.font = font;
  return measure.measureText(text).width;
};

/** Dots at the same spot fan out along a spiral until they don't overlap. */
function spread(dots, r) {
  const placed = [];
  const gap = (2 * r + 1.5) ** 2;
  for (const d of dots) {
    d.cx = d.px; d.cy = d.py;
    for (let k = 0; k < 400; k++) {
      const a = k * 2.39996, dist = k ? r * 1.15 * Math.sqrt(k) : 0;
      const x = d.px + dist * Math.cos(a), y = d.py + dist * Math.sin(a);
      if (placed.every(q => (q.cx - x) ** 2 + (q.cy - y) ** 2 >= gap)) { d.cx = x; d.cy = y; break; }
    }
    placed.push(d);
  }
}

/** Names beside the dots, where there is room; the others show on hover. */
function placeLabels(dots, box, font) {
  const taken = dots.map(d => ({ x: d.cx - DOT, y: d.cy - DOT, w: 2 * DOT, h: 2 * DOT }));
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const d of [...dots].sort((a, b) => b.outlet.stories - a.outlet.stories)) {
    const w = textWidth(d.name, font) + 4, hgt = 14;
    const spots = [
      { x: d.cx + DOT + 3, y: d.cy - hgt / 2, anchor: 'start' },
      { x: d.cx - DOT - 3 - w, y: d.cy - hgt / 2, anchor: 'end' },
      { x: d.cx - w / 2, y: d.cy - DOT - hgt - 1, anchor: 'middle' },
      { x: d.cx - w / 2, y: d.cy + DOT + 1, anchor: 'middle' },
    ];
    for (const s of spots) {
      const r = { x: s.x, y: s.y, w, h: hgt };
      if (r.x < box.x || r.x + r.w > box.x + box.w || r.y < box.y || r.y + r.h > box.y + box.h) continue;
      if (taken.some(t => hit(r, t))) continue;
      taken.push(r);
      d.label = { x: s.anchor === 'start' ? r.x + 2 : s.anchor === 'end' ? r.x + r.w - 2 : r.x + r.w / 2, y: r.y + hgt - 3, anchor: s.anchor };
      break;
    }
  }
}

function draw() {
  if (!open) return;
  const host = $('bias-chart');
  const W = host.clientWidth, H = host.clientHeight;
  if (W < 120 || H < 120) return;

  const { dots, unrated, unknown, pending } = collect();
  const noFact = dots.some(d => d.outlet.y == null);
  const cs = getComputedStyle(host);
  const font = `${cs.fontSize} ${cs.fontFamily}`;                     // what the names and ticks are drawn in (they inherit it)
  // The left margin holds the reliability labels, which grow with the font size setting.
  const left = Math.ceil(Math.max(...[...Y_TICKS.map(t => t[1]), 'Not rated', AXIS_TITLE].map(t => textWidth(t, font)))) + 16;
  const plot = { x: Math.max(MARGIN.left, left), y: MARGIN.top, w: W - Math.max(MARGIN.left, left) - MARGIN.right, h: H - MARGIN.top - MARGIN.bottom - (noFact ? NO_FACT_H : 0) };
  const px = x => plot.x + (x - X_MIN) / (X_MAX - X_MIN) * plot.w;
  const py = y => plot.y + (Y_MAX - y) / (Y_MAX - Y_MIN) * plot.h;
  const bandY = plot.y + plot.h + NO_FACT_H / 2 + 2;

  const items = dots.map(d => ({
    ...d, name: d.outlet.name,
    px: px(d.outlet.x), py: d.outlet.y == null ? bandY : py(d.outlet.y),
  })).sort((a, b) => a.py - b.py || a.px - b.px);
  spread(items, DOT);
  placeLabels(items, { x: plot.x, y: plot.y, w: plot.w, h: plot.h + (noFact ? NO_FACT_H : 0) }, font);

  const grid = [
    ...X_TICKS.map(([v, t]) => svg('g', {},
      svg('line', { class: v === 0 ? 'bias-axis' : 'bias-grid', x1: px(v), x2: px(v), y1: plot.y, y2: plot.y + plot.h + (noFact ? NO_FACT_H : 0) }),
      svg('text', { class: 'bias-tick', x: px(v), y: H - 10, 'text-anchor': 'middle' }, t))),
    ...Y_TICKS.map(([v, t]) => svg('g', {},
      svg('line', { class: 'bias-grid', x1: plot.x, x2: plot.x + plot.w, y1: py(v), y2: py(v) }),
      svg('text', { class: 'bias-tick', x: plot.x - 8, y: py(v) + 4, 'text-anchor': 'end' }, t))),
    noFact && svg('line', { class: 'bias-axis', x1: plot.x, x2: plot.x + plot.w, y1: plot.y + plot.h, y2: plot.y + plot.h }),
    noFact && svg('text', { class: 'bias-tick', x: plot.x - 8, y: bandY + 4, 'text-anchor': 'end' }, 'Not rated'),
    svg('text', { class: 'bias-tick', x: 8, y: plot.y + 12 }, AXIS_TITLE),
    svg('text', { class: 'bias-side bias-side-left', x: plot.x + 8, y: plot.y + 16 }, '◀ Left'),
    svg('text', { class: 'bias-side bias-side-right', x: plot.x + plot.w - 8, y: plot.y + 16, 'text-anchor': 'end' }, 'Right ▶'),
  ];

  const marks = items.map(d => {
    const g = svg('g', { class: 'bias-dot', tabindex: 0, role: 'img', 'aria-label': ariaFor(d), transform: `translate(${d.cx.toFixed(1)} ${d.cy.toFixed(1)})` },
      svg('circle', { r: DOT, fill: d.feeds[0].color || '#4A4A4A' }));
    g.addEventListener('pointerenter', () => showTip(d, g));
    g.addEventListener('focus', () => showTip(d, g));
    g.addEventListener('blur', hideTip);
    g.addEventListener('click', () => api.openExternal(d.outlet.url));
    g.addEventListener('keydown', e => { if (e.key === 'Enter') api.openExternal(d.outlet.url); });
    return g;
  });
  const names = items.filter(d => d.label).map(d =>
    svg('text', { class: 'bias-name', x: d.label.x.toFixed(1), y: d.label.y.toFixed(1), 'text-anchor': d.label.anchor }, d.name));

  const chart = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Political lean against reliability' },
    svg('defs', {}, svg('linearGradient', { id: 'bias-wash', x1: 0, x2: 1, y1: 0, y2: 0 },
      svg('stop', { offset: 0, class: 'bias-wash-left' }), svg('stop', { offset: 0.5, class: 'bias-wash-mid' }), svg('stop', { offset: 1, class: 'bias-wash-right' }))),
    svg('rect', { x: plot.x, y: plot.y, width: plot.w, height: plot.h + (noFact ? NO_FACT_H : 0), fill: 'url(#bias-wash)' }),
    ...grid, ...marks, ...names);
  host.replaceChildren(chart);
  hideTip();

  // Summary and the feeds without a place on the chart
  const feedCount = items.reduce((n, d) => n + d.feeds.length, 0);
  const parts = [`${items.length} outlet${items.length === 1 ? '' : 's'} · ${feedCount} feed${feedCount === 1 ? '' : 's'} plotted`];
  if (unrated.length + unknown.length) parts.push(`${unrated.length + unknown.length} not rated`);
  if (pending) parts.push(state.biasProgress ? `looking up ${state.biasProgress.done + 1} of ${state.biasProgress.total}…` : `${pending} not looked up yet`);
  $('bias-summary').textContent = ` · ${parts.join(' · ')}`;
  $('bias-unrated').replaceChildren(...unratedLines(unrated, unknown));
}

function ariaFor(d) {
  const o = d.outlet;
  return `${o.name}: ${label(LEAN, o.rating) ?? 'unrated'}${o.factuality ? `, reliability ${label(FACT, o.factuality).toLowerCase()}` : ''}`;
}

function unratedLines(unrated, unknown) {
  const chip = (name, why) => h('span', { class: 'bias-chip', title: why }, name);
  const out = [];
  if (unrated.length) out.push(h('div', {}, h('b', {}, 'No rater has rated: '),
    ...unrated.map(({ source, outlet }) => chip(source.name, `${outlet.name} is in the MediaBias News database, but none of AllSides, Ad Fontes Media or Media Bias/Fact Check has rated it`))));
  if (unknown.length) out.push(h('div', {}, h('b', {}, 'Not in the database: '),
    ...unknown.map(s => chip(s.name, 'MediaBias News has no outlet for this feed\'s website'))));
  return out;
}

// Tooltip

function showTip(d, el) {
  const o = d.outlet, tip = $('bias-tip');
  const raters = (list, names) => list.map(([who, v]) => h('div', { class: 'bias-rater' }, h('span', {}, who), h('b', {}, label(names, v))));
  const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2);
  tip.replaceChildren(
    h('div', { class: 'bias-tip-name' }, o.name),
    h('div', { class: 'muted' }, d.feeds.map(s => s.name).join(', ')),
    h('div', { class: 'bias-tip-h' }, `Lean: ${label(LEAN, o.rating)}`),
    ...raters(o.bias, LEAN),
    h('div', { class: 'muted' }, `Average ${signed(o.x)} on a scale of −2 (left) to +2 (right)`),
    h('div', { class: 'bias-tip-h' }, o.fact.length ? `Reliability: ${label(FACT, o.factuality)}` : 'Reliability: not rated'),
    ...raters(o.fact, FACT),
    h('div', { class: 'muted bias-tip-link' }, 'Click for the full rating on mediabias.news'));
  tip.hidden = false;
  const box = $('bias-view').getBoundingClientRect(), r = el.getBoundingClientRect();
  const w = tip.offsetWidth, hgt = tip.offsetHeight;
  let x = r.left - box.left + r.width / 2 - w / 2;
  let y = r.top - box.top - hgt - 8;
  if (y < 4) y = r.bottom - box.top + 8;                        // no room above: below
  tip.style.left = `${Math.max(4, Math.min(box.width - w - 4, x))}px`;
  tip.style.top = `${Math.max(4, Math.min(box.height - hgt - 4, y))}px`;
}

function hideTip() { $('bias-tip').hidden = true; }
