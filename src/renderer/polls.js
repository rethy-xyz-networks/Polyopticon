// Opinion polls view: national voting intention for one country, as a polling average, the polls behind it and
// the table they come from. An app tab like the map and Global Markets (tabs.js): it fills the article area while
// its tab is selected.
//
// The polls come from the main process (src/main/polls.js), which reads Wikipedia's poll table for the country and
// keeps a copy. Opening the view shows the copy at once and asks main for a newer one; main fetches at most every
// 30 minutes, so asking is cheap. The average on each day is a weighted mean of the polls that ended in the 21 days
// up to it: each firm's latest poll counts once, so a firm that publishes every week (a rolling tracker) doesn't
// outweigh one that publishes every month, and a poll counts less as it ages, so the line moves smoothly instead of
// jumping when a poll leaves the window.

import { api, $, h } from './dom.js';
import { ui, saveUi } from './ui.js';

const WINDOW_DAYS = 21;
const CHANGE_DAYS = 30;
const DAY = 86400e3;
const RANGES = { '3m': 92, '6m': 183, '1y': 366, all: Infinity };
const MARGIN = { top: 14, right: 92, bottom: 26, left: 36 };
const LABEL_GAP = 13;                             // the least vertical room between two direct labels

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  el.append(...kids.flat().filter(Boolean));
  return el;
};

let open = false;
let countries = [{ id: 'ca', name: 'Canada' }];
const data = new Map();                           // country -> the latest copy from main
const status = new Map();                         // country -> { state, retryIn?, error? }
let model = null;                                 // what the chart shows: { days, avg, polls, ... } for the current range
let drawTimer = null, askTimer = null;

const country = () => (countries.some(c => c.id === ui.pollsCountry) ? ui.pollsCountry : countries[0].id);
const range = () => (ui.pollsRange in RANGES ? ui.pollsRange : '1y');
const colour = (c, party) => `var(--party-${c}-${String(party).replace(/[^A-Za-z0-9]/g, '')}, var(--text-2))`;
const toMs = iso => Date.parse(`${iso}T12:00:00Z`);
const fmt1 = v => (v == null ? '—' : v.toFixed(1));
const dateText = (ms, opts = { year: 'numeric', month: 'short', day: 'numeric' }) => new Date(ms).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });

// Lifecycle

export function initPolls() {
  document.addEventListener('story:view', e => (e.detail === 'polls' ? openPolls() : closePolls()));   // its tab was selected, or another
  new ResizeObserver(() => { if (open) drawSoon(); }).observe($('polls-chart'));
  $('polls-refresh').addEventListener('click', () => ask(true));
  $('polls-country').addEventListener('change', e => { saveUi({ pollsCountry: e.target.value }); ask(); render(); });
  for (const b of $('polls-range').querySelectorAll('button')) b.addEventListener('click', () => { saveUi({ pollsRange: b.dataset.r }); render(); });
  const chart = $('polls-chart');
  chart.addEventListener('pointermove', hover);
  chart.addEventListener('pointerleave', unhover);
  document.addEventListener('visibilitychange', () => { if (open && !document.hidden) ask(); });
  api.onPollData(applyPolls);
  api.onPollStatus(s => { status.set(s.country, s); paintStatus(); });
  api.pollCountries?.().then(list => { if (Array.isArray(list) && list.length) { countries = list; fillCountries(); } }).catch(() => {});
  fillCountries();
}

function openPolls() {
  if (open) return;
  open = true;
  document.querySelector('.story').classList.add('polls-open');
  $('btn-polls').classList.add('on');
  ask();
  clearInterval(askTimer);
  askTimer = setInterval(() => { if (!document.hidden) ask(); }, 5 * 60e3);   // main fetches only when its copy is stale
  render();
}

function closePolls() {
  if (!open) return;
  open = false;
  clearInterval(askTimer);
  document.querySelector('.story').classList.remove('polls-open');
  $('btn-polls').classList.remove('on');
  unhover();
}

/** Asks main for the country's polls: its saved copy comes back now, a newer one later as polls:data. */
async function ask(force = false) {
  const c = country();
  try {
    const d = await api.getPolls(c, force);
    if (d && (!data.get(c) || (d.fetchedAt || 0) >= (data.get(c).fetchedAt || 0))) applyPolls(d);
  } catch { /* main logs fetch problems; the status line shows them */ }
  paintStatus();
}

/** A copy of a country's polls (from main, or a test). */
export function applyPolls(d) {
  if (!d?.country || !Array.isArray(d.polls)) return;
  data.set(d.country, d);
  if (d.country === country()) render();
}

function fillCountries() {
  const sel = $('polls-country');
  sel.replaceChildren(...countries.map(c => h('option', { value: c.id, selected: c.id === country() }, c.name)));
  sel.disabled = countries.length < 2;
}

// The model

/** Polls in date order, oldest first, with the election row apart. */
function prepare(d) {
  const polls = d.polls.filter(p => !p.election).map(p => ({ ...p, t: toMs(p.date) })).sort((a, b) => a.t - b.t);
  const election = d.polls.find(p => p.election);
  return { polls, election: election && { ...election, t: toMs(election.date) } };
}

/**
 * The average for each day from `from` to the last poll: per party, the mean of each firm's latest poll that
 * ended in the WINDOW_DAYS up to the day, weighted 1 on the day falling to 0 at the window's start. Null for a
 * party no poll in the window measured.
 */
function averages(polls, parties, from, to) {
  const days = [], avg = Object.fromEntries(parties.map(p => [p, []]));
  let lo = 0;
  for (let t = from; t <= to; t += DAY) {
    while (lo < polls.length && polls[lo].t <= t - WINDOW_DAYS * DAY) lo++;
    const latest = new Map();
    for (let i = lo; i < polls.length && polls[i].t <= t; i++) latest.set(polls[i].firm, polls[i]);
    days.push({ t, n: latest.size });
    for (const p of parties) {
      let sum = 0, weight = 0;
      for (const x of latest.values()) {
        if (x.values[p] == null) continue;
        const w = 1 - (t - x.t) / (WINDOW_DAYS * DAY);
        sum += w * x.values[p]; weight += w;
      }
      avg[p].push(weight ? sum / weight : null);
    }
  }
  return { days, avg };
}

function build() {
  const c = country(), d = data.get(c);
  if (!d) return null;
  const { polls, election } = prepare(d);
  if (!polls.length) return null;
  const parties = d.parties;
  const last = polls.at(-1).t;
  const first = Math.min(polls[0].t, election?.t ?? Infinity);   // All starts at the election
  const days = RANGES[range()];
  const from = Math.max(first, Number.isFinite(days) ? last - days * DAY : first);
  // The average starts WINDOW_DAYS before the range, so its first days aren't one or two polls.
  const series = averages(polls, parties, from - (from > first ? WINDOW_DAYS * DAY : 0), last);
  const skip = series.days.findIndex(x => x.t >= from);
  for (const p of parties) series.avg[p] = series.avg[p].slice(skip);
  series.days = series.days.slice(skip);
  const allAvg = averages(polls, parties, Math.max(first, last - (CHANGE_DAYS + WINDOW_DAYS) * DAY), last);
  const back = allAvg.days.findIndex(x => x.t >= last - CHANGE_DAYS * DAY);
  const now = Object.fromEntries(parties.map(p => [p, allAvg.avg[p].at(-1)]));
  const before = Object.fromEntries(parties.map(p => [p, back >= 0 ? allAvg.avg[p][back] : null]));
  return {
    c, d, parties, from, to: last, election,
    polls: polls.filter(p => p.t >= from),
    days: series.days, avg: series.avg, now, before,
    events: (d.events ?? []).map(e => ({ ...e, t: toMs(e.date) })).filter(e => e.t >= from && e.t <= last),
  };
}

// Rendering

function render() {
  if (!open) return;
  for (const b of $('polls-range').querySelectorAll('button')) b.classList.toggle('on', b.dataset.r === range());
  $('polls-country').value = country();
  model = build();
  $('polls-empty').hidden = !!model;
  $('polls-body').hidden = !model;
  if (!model) { $('polls-empty').textContent = emptyText(); paintStatus(); return; }
  paintSummary();
  paintTable();
  paintFoot();
  paintStatus();
  drawSoon();
}

function emptyText() {
  const s = status.get(country());
  if (s?.state === 'error' || s?.state === 'limited') return `No polls yet: Wikipedia didn't answer (${s.error}). Trying again in ${s.retryIn} s.`;
  return 'Fetching the polls from Wikipedia…';
}

/** A tile per party: its average now, and how much it moved in the last 30 days. */
function paintSummary() {
  const { c, d, parties, now, before } = model;
  const order = parties.filter(p => now[p] != null).sort((a, b) => now[b] - now[a]);
  const [lead, second] = order;
  const tiles = order.map(p => {
    const delta = now[p] != null && before[p] != null ? now[p] - before[p] : null;
    const dir = delta == null || Math.abs(delta) < 0.05 ? 'flat' : delta > 0 ? 'up' : 'down';
    return h('div', { class: 'pl-tile', dataset: { party: p }, title: `${d.partyNames?.[p] ?? p}: ${fmt1(now[p])}% in the polling average` },
      h('span', { class: 'pl-swatch', style: `background:${colour(c, p)}` }),
      h('span', { class: 'pl-abbr' }, p),
      h('span', { class: 'pl-full' }, d.partyNames?.[p] ?? ''),
      h('span', { class: 'pl-value' }, `${fmt1(now[p])}%`),
      h('span', { class: 'pl-delta', dataset: { dir }, title: `Change over the last ${CHANGE_DAYS} days` },
        delta == null ? '' : `${dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'} ${Math.abs(delta).toFixed(1)} in ${CHANGE_DAYS} d`));
  });
  const leadText = lead && second ? `${d.partyNames?.[lead] ?? lead} lead by ${(now[lead] - now[second]).toFixed(1)} points over ${d.partyNames?.[second] ?? second}` : '';
  $('polls-summary').replaceChildren(h('div', { class: 'pl-lead' }, leadText), h('div', { class: 'pl-tiles' }, tiles));
}

/** The polls in the range, newest first, with the events between them. */
function paintTable() {
  const { c, d, parties } = model;
  const rows = [
    ...model.polls.map(p => ({ t: p.t, poll: p })),
    ...model.events.map(e => ({ t: e.t, event: e })),
    ...(model.election && model.election.t >= model.from ? [{ t: model.election.t, poll: model.election }] : []),
  ].sort((a, b) => b.t - a.t || (a.event ? -1 : 1));
  const head = h('tr', {},
    h('th', { class: 'pl-firm' }, 'Polling firm'), h('th', {}, 'Ended'),
    parties.map(p => h('th', { class: 'pl-num', title: d.partyNames?.[p] ?? p }, h('span', { class: 'pl-key', style: `background:${colour(c, p)}` }), p)),
    h('th', { class: 'pl-num' }, 'Lead'), h('th', { class: 'pl-num' }, 'Sample'), h('th', {}, 'Method'), h('th', {}, 'Source'));
  const body = rows.map(r => {
    if (r.event) return h('tr', { class: 'pl-event' }, h('td', { colspan: String(parties.length + 6) }, h('b', {}, dateText(r.t)), ' · ', r.event.text));
    const p = r.poll;
    const top = Math.max(...parties.map(x => p.values[x] ?? -1));
    return h('tr', { class: p.election ? 'pl-election' : null },
      h('td', { class: 'pl-firm' }, p.firm),
      h('td', {}, dateText(p.t)),
      parties.map(x => h('td', { class: `pl-num${p.values[x] === top ? ' pl-top' : ''}` }, p.values[x] == null ? '—' : String(p.values[x]))),
      h('td', { class: 'pl-num' }, p.lead == null ? '' : String(p.lead)),
      h('td', { class: 'pl-num' }, p.sample == null ? '' : p.sample.toLocaleString()),
      h('td', {}, p.method ?? ''),
      h('td', {}, p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener', title: p.url }, hostOf(p.url)) : ''));
  });
  $('polls-table').replaceChildren(h('table', {}, h('thead', {}, head), h('tbody', {}, body)));
}

const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'link'; } };

function paintFoot() {
  const { d } = model;
  $('polls-foot').replaceChildren(
    `The line is the average of the polls that ended in the previous ${WINDOW_DAYS} days: each firm's latest once, newer polls counting more. The dots are the polls, the dashed lines events. `,
    'From Wikipedia: ', h('a', { href: d.url, target: '_blank', rel: 'noopener' }, d.title),
    ', compiled by its editors from each firm\'s published release (CC BY-SA 4.0).',
    d.edited ? ` Last edited ${dateText(d.edited)}.` : '');
}

function paintStatus() {
  const el = $('polls-status');
  if (!el) return;
  const s = status.get(country()), d = data.get(country());
  el.dataset.state = s?.state ?? 'ok';
  const copy = d?.fetchedAt ? `checked ${new Date(d.fetchedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '';
  el.textContent = s?.state === 'loading' ? 'Checking Wikipedia…'
    : s?.state === 'limited' ? `Wikipedia asked us to slow down; trying again in ${s.retryIn} s${copy ? ` · showing the copy ${copy}` : ''}`
    : s?.state === 'error' ? `Can't reach Wikipedia (${s.error}); trying again in ${s.retryIn} s${copy ? ` · showing the copy ${copy}` : ''}`
    : d ? `${d.polls.filter(p => !p.election).length} polls · ${copy}` : '';
}

// The chart

function drawSoon() {
  clearTimeout(drawTimer);
  drawTimer = setTimeout(draw, 30);
}

function draw() {
  const box = $('polls-chart');
  if (!open || !model) return;
  const W = box.clientWidth, H = box.clientHeight;
  if (W < 120 || H < 80) return;
  const { c, parties, from, to, days, avg, polls, events, election } = model;
  const x0 = MARGIN.left, x1 = W - MARGIN.right, y0 = H - MARGIN.bottom, y1 = MARGIN.top;
  const span = Math.max(to - from, DAY);
  const x = t => x0 + (t - from) / span * (x1 - x0);
  const max = Math.max(10, ...polls.flatMap(p => parties.map(q => p.values[q] ?? 0)));
  const top = Math.ceil(max / 10) * 10;
  const y = v => y0 - v / top * (y0 - y1);

  const grid = [];
  for (let v = 0; v <= top; v += 10) {
    grid.push(svg('line', { class: v ? 'pl-grid' : 'pl-axis', x1: x0, x2: x1, y1: y(v), y2: y(v) }));
    grid.push(svg('text', { class: 'pl-tick', x: x0 - 6, y: y(v) + 4, 'text-anchor': 'end' }, `${v}%`));
  }
  // Month ticks, as many as fit
  const months = [];
  const d0 = new Date(from);
  for (let m = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1)); m.getTime() <= to; m.setUTCMonth(m.getUTCMonth() + 1)) months.push(m.getTime());
  const every = Math.max(1, Math.ceil(months.length / Math.max(1, Math.floor((x1 - x0) / 70))));
  months.forEach((t, i) => {
    if (i % every) return;
    const jan = new Date(t).getUTCMonth() === 0;
    grid.push(svg('line', { class: 'pl-mtick', x1: x(t), x2: x(t), y1: y0, y2: y0 + 4 }));
    grid.push(svg('text', { class: 'pl-tick', x: x(t), y: y0 + 16, 'text-anchor': 'middle' }, dateText(t, jan || i === 0 ? { month: 'short', year: 'numeric' } : { month: 'short' })));
  });

  const eventMarks = events.map(e => svg('g', { class: 'pl-event-mark' },
    svg('line', { x1: x(e.t), x2: x(e.t), y1: y1, y2: y0 }),
    svg('title', {}, `${dateText(e.t)}: ${e.text}`)));

  const dots = [], lines = [], ends = [];
  for (const p of parties) {
    const col = colour(c, p);
    for (const poll of polls) if (poll.values[p] != null) dots.push(svg('circle', { class: 'pl-dot', cx: x(poll.t), cy: y(poll.values[p]), r: 2.4, fill: col }));
    let d = '', pen = false, last = null;
    avg[p].forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(days[i].t).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true; last = v;
    });
    if (d) lines.push(svg('path', { class: 'pl-line', d, stroke: col }));
    if (last != null) ends.push({ p, v: last, y: y(last), col });
  }
  // Direct labels at the right end, nudged apart so none overlap
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + LABEL_GAP);
  for (let i = ends.length - 2; i >= 0; i--) ends[i].y = Math.min(ends[i].y, ends[i + 1].y - LABEL_GAP);
  const labels = ends.map(e => svg('g', { class: 'pl-end' },
    svg('circle', { cx: x1 + 8, cy: e.y, r: 4, fill: e.col }),
    svg('text', { x: x1 + 16, y: e.y + 4 }, `${e.p} ${fmt1(e.v)}`)));

  const elect = election && election.t >= from ? parties.filter(p => election.values[p] != null).map(p =>
    svg('rect', { class: 'pl-elect', x: x(election.t) - 4, y: y(election.values[p]) - 4, width: 8, height: 8, fill: colour(c, p), transform: `rotate(45 ${x(election.t)} ${y(election.values[p])})` },
      svg('title', {}, `${election.firm}: ${p} ${election.values[p]}%`))) : [];

  const cross = svg('g', { id: 'polls-cross', visibility: 'hidden' }, svg('line', { y1: y1, y2: y0 }));
  box.replaceChildren(svg('svg', { width: W, height: H, role: 'img', 'aria-label': `Polling average, ${dateText(from)} to ${dateText(to)}` },
    grid, eventMarks, dots, lines, elect, labels, cross));
  model.geom = { x0, x1, from, span };
}

/** The crosshair: the day under the pointer, with each party's average on it. */
function hover(e) {
  if (!model?.geom) return;
  const box = $('polls-chart');
  const r = box.getBoundingClientRect();
  const px = e.clientX - r.left;
  const { x0, x1, from, span } = model.geom;
  if (px < x0 || px > x1) return unhover();
  const t = from + (px - x0) / (x1 - x0) * span;
  const i = Math.max(0, Math.min(model.days.length - 1, Math.round((t - model.days[0].t) / DAY)));
  const day = model.days[i];
  if (!day) return unhover();
  const cx = x0 + (day.t - from) / span * (x1 - x0);
  const cross = $('polls-cross');
  cross.setAttribute('visibility', 'visible');
  cross.firstChild.setAttribute('x1', cx); cross.firstChild.setAttribute('x2', cx);
  const { c, d, parties, avg } = model;
  const rows = parties.filter(p => avg[p][i] != null).sort((a, b) => avg[b][i] - avg[a][i]);
  const ended = model.polls.filter(p => p.t === day.t);
  const tip = $('polls-tip');
  tip.replaceChildren(...[
    h('div', { class: 'pl-tip-date' }, dateText(day.t)),
    rows.map(p => h('div', { class: 'pl-tip-row' }, h('span', { class: 'pl-key', style: `background:${colour(c, p)}` }), h('span', {}, d.partyNames?.[p] ?? p), h('b', {}, `${fmt1(avg[p][i])}%`))),
    h('div', { class: 'pl-tip-n' }, `Average of ${day.n} firm${day.n === 1 ? '' : 's'} in the last ${WINDOW_DAYS} days`),
    ended.map(p => h('div', { class: 'pl-tip-poll' }, `${p.firm}: `, rows.slice(0, 3).map(q => `${q} ${p.values[q] ?? '—'}`).join(' · '))),
  ].flat());
  tip.hidden = false;
  const w = tip.offsetWidth, hgt = tip.offsetHeight;
  tip.style.left = `${Math.min(r.width - w - 4, cx + 12 > r.width - w ? cx - w - 12 : cx + 12)}px`;
  tip.style.top = `${Math.max(4, Math.min(r.height - hgt - 4, e.clientY - r.top - hgt / 2))}px`;
}

function unhover() {
  $('polls-cross')?.setAttribute('visibility', 'hidden');
  if ($('polls-tip')) $('polls-tip').hidden = true;
}
