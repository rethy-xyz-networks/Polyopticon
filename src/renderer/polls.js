// Opinion polls view: one question's polls for one country (voting intention, preferred prime minister, government
// approval, a province's next election, Quebec independence…), as a polling average, the polls behind it and the
// table they come from. An app tab like the map and Global Markets (tabs.js): it fills the article area while its
// tab is selected.
//
// The polls come from the main process (src/main/polls.js), which reads Wikipedia's poll tables for the country
// and keeps a copy: a list of sets, one per question, each with its answers (parties, leaders, Yes / No) and its
// polls. A set made of several tables, or of a table split by a column, has variants (a province, a riding, a
// hypothetical leader) and shows one at a time. Opening the view shows the copy at once and asks main for a newer
// one; main checks at most every 30 minutes, so asking is cheap.
//
// The average on each day is a weighted mean of the polls that ended in the window up to it: each firm's latest
// poll counts once, so a firm that publishes every week (a rolling tracker) doesn't outweigh one that publishes
// every month, and a poll counts less as it ages, so the line moves smoothly instead of jumping when a poll leaves
// the window. The window is 21 days where polls are frequent and longer where they are rare (three times the usual
// gap between them, up to 120 days), so a province polled every other month still gets a line.

import { api, $, h, wikipediaUrl } from './dom.js';
import { openChanTab } from './tabs.js';
import { ui, saveUi } from './ui.js';

const MIN_WINDOW = 21, MAX_WINDOW = 120;          // days
const CHANGE_DAYS = 30;
const DAY = 86400e3;
const RANGES = { '3m': 92, '6m': 183, '1y': 366, all: Infinity };
const MARGIN = { top: 14, right: 92, bottom: 26, left: 36 };
const LABEL_GAP = 13;                             // the least vertical room between two direct labels
const LABEL_MAX = 24;                             // characters of an answer's name in its direct label

// Colours (styles.css, --poll-*): an answer wears its party's usual hue where it has one, and Yes / No their own;
// the rest take the hues left over, in this order, and grey when none is left. A set's colours depend only on its
// answers, so a line keeps its colour whatever the range or variant.
const HUES = ['red', 'blue', 'teal', 'orange', 'green', 'purple', 'pink', 'lime'];
const APPROVE = /^(approve|pos\.?|positive|favou?rable|in favou?r|right direction|satisfied)\b/i;
const DISAPPROVE = /^(disapprove|neg\.?|negative|unfavou?rable|oppose|wrong direction|dissatisfied)\b/i;
// First match wins, so the specific comes before the general ("Social Democratic" before "Democratic",
// "Liberal Democrats" before "Liberal", Australia's Liberals before Canada's).
const FAMILY = [
  ['grey', /^(others?|none|neither|independent|ind\.?|oth\.?)\b|unsure|undecided|don't know|not sure|no answer|^d\/k|^und\b|no party|^none\b|^neither\b/i],
  ['green', APPROVE],
  ['red', DISAPPROVE],
  ['orange', /ndp|new democrat|liberal democrat|^ld$|lib dems|free democratic|\bfdp\b|\bd66\b|renew|^nzf$|new zealand first/i],
  ['teal', /reform uk|^ref$|^bq$|bloc|^pq$|parti qu|\bafd\b|alternative for germany|^onp$|one nation|^pvv$|party for freedom|\bact\b|^esn$|sovereign nations|^snp$/i],
  ['blue', /\(d\)|democratic party \(united states\)|^democrat/i],
  ['red', /\(r\)|republican party \(united states\)|^republican$/i],
  ['red', /social democrat|socialist|labou?r|^lab$|\bspd\b|\balp\b|\bpsoe\b|^s&d$|lewica|the left \(poland\)|^pd$/i],
  ['blue', /liberal party of australia|liberal–national|^l\/np$|^lib$|coalition \(australia\)/i],
  ['red', /liberal|^lpc$|^no$|^remain|stay out/i],
  ['blue', /conservative|^cpc$|^pc$|^ucp$|^con$|^cons\b|^saskatchewan$|^sk party$|tory|christian democrat|\bcdu\b|\bcsu\b|^union$|cdu\/csu|^epp$|people's party group|law and justice|^pis$|^nat$|national party|^vvd$|^ldp$|liberal democratic party \(japan\)|^fg$|fine gael|republicans \(france\)|^lr\b/i],
  ['green', /green|^gpc$|^grn$|grüne|^gp$|^yes$|^rejoin|in favou?r|^separate|separation|^g\/efa$/i],
  ['purple', /^ppc$|people's party of canada|linke|the left|^sf$|sinn féin|^bsw$|wagenknecht|^ecr$|^tpm$|te pāti māori|^pfe$|patriots for europe|^rn\b|national rally|^konfederacja/i],
  ['pink', /^ff$|fianna fáil|^volt$|^ko$|civic coalition/i],
];

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  el.append(...kids.flat().filter(Boolean));
  return el;
};

let open = false;
let countries = [{ id: 'ca', name: 'Canada' }];
const data = new Map();                           // country -> the latest copy from main: { sets: [...] }
const status = new Map();                         // country -> { state, retryIn?, error? }
let model = null;                                 // what the chart shows: { set, days, avg, polls, ... } for the current range
const colours = new WeakMap();                    // set -> { answer: CSS colour }
let drawTimer = null, askTimer = null;

const country = () => (countries.some(c => c.id === ui.pollsCountry) ? ui.pollsCountry : countries[0].id);
const range = () => (ui.pollsRange in RANGES ? ui.pollsRange : '1y');
const sets = () => data.get(country())?.sets ?? [];
const currentSet = () => sets().find(s => s.id === ui.pollsSet) ?? sets()[0] ?? null;
const variantOf = s => (!s?.variants?.length ? null : s.variants.includes(ui.pollsVariants?.[s.id]) ? ui.pollsVariants[s.id] : s.variants[0]);
const nameOf = (s, o) => s.names?.[o] ?? o;
const articleOf = (s, o) => s.pages?.[o] ?? null;                 // the Wikipedia article an answer's heading links to
/** An answer's article attributes: the tile, table heading and line label open it as a tab, as the map's place card does. */
const linkAttrs = (s, o) => (articleOf(s, o) ? { 'data-article': articleOf(s, o) } : {});

/** A set's colour per answer (see HUES). Answers of one party (a leader and their successor) share its colour. */
function coloursOf(s) {
  if (colours.has(s)) return colours.get(s);
  const family = o => { for (const text of [s.partyOf?.[o], o]) { const f = text && FAMILY.find(([, re]) => re.test(text))?.[0]; if (f) return f; } return null; };
  const byKey = new Map(), free = new Set(HUES), waiting = [];
  // An answer asked in more polls picks first, so Australia's Coalition (in every poll) takes blue before the
  // Liberals alone (asked only in some).
  const asked = o => s.polls.reduce((n, p) => n + (p.values?.[o] != null), 0);
  const counts = new Map(s.options.map(o => [o, asked(o)]));
  for (const o of [...s.options].sort((a, b) => counts.get(b) - counts.get(a))) {
    const key = s.partyOf?.[o] ?? o;
    if (byKey.has(key)) continue;
    const f = family(o);
    if (f === 'grey') byKey.set(key, 'grey');
    else if (f && free.has(f)) { byKey.set(key, f); free.delete(f); }
    else waiting.push(key);
  }
  for (const key of waiting) { const hue = free.values().next().value ?? 'grey'; byKey.set(key, hue); free.delete(hue); }
  const out = Object.fromEntries(s.options.map(o => [o, `var(--poll-${byKey.get(s.partyOf?.[o] ?? o)})`]));
  colours.set(s, out);
  return out;
}
const toMs = iso => Date.parse(`${iso}T12:00:00Z`);
const fmt1 = v => (v == null ? '—' : v.toFixed(1));
const pct = () => (model?.set.unit === 'seats' ? '' : '%');                   // seat counts have no percent sign
const fmtU = v => `${fmt1(v)}${v == null ? '' : pct()}`;
const dateText = (ms, opts = { year: 'numeric', month: 'short', day: 'numeric' }) => new Date(ms).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });

// Lifecycle

export function initPolls() {
  document.addEventListener('story:view', e => (e.detail === 'polls' ? openPolls() : closePolls()));   // its tab was selected, or another
  new ResizeObserver(() => { if (open) drawSoon(); }).observe($('polls-chart'));
  $('polls-refresh').addEventListener('click', () => ask(true));
  $('polls-country').addEventListener('change', e => { saveUi({ pollsCountry: e.target.value }); ask(); render(); });
  $('polls-set').addEventListener('change', e => { saveUi({ pollsSet: e.target.value }); render(); });
  $('polls-variant').addEventListener('change', e => { const s = currentSet(); if (s) saveUi({ pollsVariants: { ...ui.pollsVariants, [s.id]: e.target.value } }); render(); });
  for (const b of $('polls-range').querySelectorAll('button')) b.addEventListener('click', () => { saveUi({ pollsRange: b.dataset.r }); render(); });
  const chart = $('polls-chart');
  chart.addEventListener('pointermove', hover);
  chart.addEventListener('pointerleave', unhover);
  // A party's (or a person's) tile, table heading or line label opens its Wikipedia article as a tab
  const view = $('polls-view');
  const openArticle = e => { const el = e.target.closest?.('[data-article]'); if (el) { e.preventDefault(); openChanTab(wikipediaUrl(el.dataset.article)); } };
  view.addEventListener('click', openArticle);
  view.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') openArticle(e); });
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
  if (!d?.country || !Array.isArray(d.sets)) return;
  data.set(d.country, d);
  if (d.country === country()) render();
}

function fillCountries() {
  const sel = $('polls-country');
  sel.replaceChildren(...countries.map(c => h('option', { value: c.id, selected: c.id === country() }, c.name)));
  sel.disabled = countries.length < 2;
}

/** The question picker (grouped as main groups the sets) and, for a set with variants, theirs. */
function fillSets() {
  const s = currentSet();
  const groups = new Map();
  for (const x of sets()) groups.set(x.group, [...(groups.get(x.group) ?? []), x]);
  const sel = $('polls-set');
  sel.replaceChildren(...[...groups].map(([group, list]) => h('optgroup', { label: group }, list.map(x => h('option', { value: x.id, selected: x === s }, x.label)))));
  sel.hidden = !s;
  const v = variantOf(s), vs = $('polls-variant');
  vs.replaceChildren(...(s?.variants ?? []).map(x => h('option', { value: x, selected: x === v }, x)));
  vs.hidden = !v;
  if (v) { vs.title = s.variantLabel; vs.setAttribute('aria-label', s.variantLabel); }
}

// The model

/** Polls in date order, oldest first, with the election row apart. */
function prepare(all) {
  const polls = all.filter(p => !p.election).map(p => ({ ...p, t: toMs(p.date) })).sort((a, b) => a.t - b.t);
  const election = all.find(p => p.election);
  return { polls, election: election && { ...election, t: toMs(election.date) } };
}

/** The averaging window for these polls, in days: three times the usual gap between them, 21 to 120. */
function windowDays(polls) {
  const days = [...new Set(polls.map(p => p.t))];
  const gaps = days.slice(1).map((t, i) => (t - days[i]) / DAY).sort((a, b) => a - b);
  return gaps.length ? Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, Math.round(3 * gaps[gaps.length >> 1]))) : MIN_WINDOW;
}

/**
 * The average for each day from `from` to the last poll: per answer, the mean of each firm's latest poll that
 * measured it in the `win` days up to the day, weighted 1 on the day falling to 0 at the window's start. A poll
 * that asked several line-ups at once (France's first round: one row per set of candidates) is one poll, its
 * rows averaged. Null for an answer no poll in the window measured.
 */
function averages(polls, parties, from, to, win) {
  const days = [], avg = Object.fromEntries(parties.map(p => [p, []]));
  let lo = 0;
  for (let t = from; t <= to; t += DAY) {
    while (lo < polls.length && polls[lo].t <= t - win * DAY) lo++;
    const firms = new Set();
    const latest = Object.fromEntries(parties.map(p => [p, new Map()]));   // answer -> firm -> { t, sum, n }
    for (let i = lo; i < polls.length && polls[i].t <= t; i++) {
      const x = polls[i];
      firms.add(x.firm);
      for (const p of parties) {
        const v = x.values[p];
        if (v == null) continue;
        const had = latest[p].get(x.firm);
        if (had && had.t === x.t) { had.sum += v; had.n++; } else latest[p].set(x.firm, { t: x.t, sum: v, n: 1 });
      }
    }
    days.push({ t, n: firms.size });
    for (const p of parties) {
      let sum = 0, weight = 0;
      for (const x of latest[p].values()) {
        const w = 1 - (t - x.t) / (win * DAY);
        sum += w * x.sum / x.n; weight += w;
      }
      avg[p].push(weight ? sum / weight : null);
    }
  }
  return { days, avg };
}

function build() {
  const c = country(), set = currentSet();
  if (!set) return null;
  const variant = variantOf(set);
  const mine = x => !variant || x.variant == null || x.variant === variant;
  const { polls, election } = prepare(set.polls.filter(mine));
  if (!polls.length) return null;
  const parties = set.options.filter(o => polls.some(p => p.values[o] != null));   // a variant's own answers (no Bloc in Ontario)
  const win = windowDays(polls);
  const last = polls.at(-1).t;
  const first = Math.min(polls[0].t, election?.t ?? Infinity);   // All starts at the election
  const days = RANGES[range()];
  const from = Math.max(first, Number.isFinite(days) ? last - days * DAY : first);
  // The average starts a window before the range, so its first days aren't one or two polls.
  const series = averages(polls, parties, from - (from > first ? win * DAY : 0), last, win);
  const skip = series.days.findIndex(x => x.t >= from);
  for (const p of parties) series.avg[p] = series.avg[p].slice(skip);
  series.days = series.days.slice(skip);
  const allAvg = averages(polls, parties, Math.max(first, last - (CHANGE_DAYS + win) * DAY), last, win);
  const back = allAvg.days.findIndex(x => x.t >= last - CHANGE_DAYS * DAY);
  const now = Object.fromEntries(parties.map(p => [p, allAvg.avg[p].at(-1)]));
  const before = Object.fromEntries(parties.map(p => [p, back >= 0 && back < allAvg.days.length - 1 ? allAvg.avg[p][back] : null]));   // none with nothing earlier to compare
  return {
    c, set, variant, win, col: coloursOf(set), parties, from, to: last, election,
    polls: polls.filter(p => p.t >= from),
    days: series.days, avg: series.avg, now, before,
    events: (set.events ?? []).filter(mine).map(e => ({ ...e, t: toMs(e.date) })).filter(e => e.t >= from && e.t <= last),
  };
}

// Rendering

function render() {
  if (!open) return;
  for (const b of $('polls-range').querySelectorAll('button')) b.classList.toggle('on', b.dataset.r === range());
  $('polls-country').value = country();
  fillSets();
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
  if (sets().length) return 'Wikipedia lists no polls for this yet.';
  return 'Fetching the polls from Wikipedia…';
}

/** A tile per answer: its average now, and how much it moved in the last 30 days. */
function paintSummary() {
  const { set, col, parties, now, before } = model;
  const order = parties.filter(p => now[p] != null).sort((a, b) => now[b] - now[a]);
  const [lead, second] = order.filter(p => col[p] !== 'var(--poll-grey)');   // "Undecided" leads nothing
  const tiles = order.map(p => {
    const delta = now[p] != null && before[p] != null ? now[p] - before[p] : null;
    const dir = delta == null || Math.abs(delta) < 0.05 ? 'flat' : delta > 0 ? 'up' : 'down';
    const full = nameOf(set, p) !== p ? nameOf(set, p) : set.partyOf?.[p] && set.kind !== 'parties' ? set.partyOf[p] : '';
    const article = articleOf(set, p);
    return h('div', { class: 'pl-tile', dataset: { party: p }, ...linkAttrs(set, p), ...(article ? { tabindex: '0', role: 'link' } : {}),
      title: `${nameOf(set, p)}: ${fmtU(now[p])}${set.unit === 'seats' ? ' seats' : ''} in the polling average${article ? `\nClick for the Wikipedia article: ${article}` : ''}` },
      h('span', { class: 'pl-swatch', style: `background:${col[p]}` }),
      h('span', { class: 'pl-abbr' }, p),
      h('span', { class: 'pl-full' }, full),
      h('span', { class: 'pl-value' }, fmtU(now[p])),
      h('span', { class: 'pl-delta', dataset: { dir }, title: `Change over the last ${CHANGE_DAYS} days` },
        delta == null ? '' : `${dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'} ${Math.abs(delta).toFixed(1)} in ${CHANGE_DAYS} d`));
  });
  const gap = lead && second ? (now[lead] - now[second]).toFixed(1) : null;
  const units = set.unit === 'seats' ? 'seats' : 'points';
  // Approval: the net, approving less disapproving
  const yes = parties.find(p => APPROVE.test(p)), no = parties.find(p => DISAPPROVE.test(p));
  const net = set.kind === 'approval' && yes && no && now[yes] != null && now[no] != null ? now[yes] - now[no] : null;
  const leadText = set.kind === 'breakdown' ? `Answering “${model.variant}”, among each party's supporters`
    : net != null ? `Net approval ${net >= 0 ? '+' : '−'}${Math.abs(net).toFixed(1)}${model.variant ? ` · ${model.variant}` : ''}`
    : gap == null ? ''
    : set.kind === 'parties' ? `${nameOf(set, lead)} lead by ${gap} ${units} over ${nameOf(set, second)}`
    : `${nameOf(set, lead)} leads ${nameOf(set, second)} by ${gap} ${units}`;
  $('polls-summary').replaceChildren(h('div', { class: 'pl-lead' }, leadText), h('div', { class: 'pl-tiles' }, tiles));
}

/** The polls in the range, newest first, with the events between them. */
function paintTable() {
  const { set, col, parties } = model;
  const rows = [
    ...model.polls.map(p => ({ t: p.t, poll: p })),
    ...model.events.map(e => ({ t: e.t, event: e })),
    ...(model.election && model.election.t >= model.from ? [{ t: model.election.t, poll: model.election }] : []),
  ].sort((a, b) => b.t - a.t || (a.event ? -1 : 1));
  // The table's own columns differ: one no poll here fills (no sample sizes, no method) is left out
  const has = k => rows.some(r => r.poll?.[k] != null);
  const extra = [['lead', 'Lead'], ['sample', 'Sample'], ['method', 'Method'], ['url', 'Source']].filter(([k]) => has(k)).map(([k]) => k);
  const head = h('tr', {},
    h('th', { class: 'pl-firm' }, 'Polling firm'), h('th', {}, 'Ended'),
    parties.map(p => {                                      // a long name wraps, its colour staying with its first word
      const [first, ...rest] = p.split(' ');
      return h('th', { class: 'pl-num', title: nameOf(set, p) + (articleOf(set, p) ? ' · click for its Wikipedia article' : ''), ...linkAttrs(set, p) }, h('span', { class: 'pl-nb' }, h('span', { class: 'pl-key', style: `background:${col[p]}` }), first), rest.length ? ` ${rest.join(' ')}` : '');
    }),
    extra.includes('lead') && h('th', { class: 'pl-num' }, 'Lead'), extra.includes('sample') && h('th', { class: 'pl-num' }, 'Sample'),
    extra.includes('method') && h('th', {}, 'Method'), extra.includes('url') && h('th', {}, 'Source'));
  const body = rows.map(r => {
    if (r.event) return h('tr', { class: 'pl-event' }, h('td', { colspan: String(parties.length + 2 + extra.length) }, h('b', {}, dateText(r.t)), ' · ', r.event.text));
    const p = r.poll;
    const top = Math.max(...parties.map(x => p.values[x] ?? -1));
    return h('tr', { class: p.election ? 'pl-election' : null },
      h('td', { class: 'pl-firm' }, p.firm),
      h('td', {}, dateText(p.t)),
      parties.map(x => h('td', { class: `pl-num${p.values[x] === top ? ' pl-top' : ''}` }, p.values[x] == null ? '—' : String(p.values[x]))),
      extra.includes('lead') && h('td', { class: 'pl-num' }, p.lead == null ? '' : String(p.lead)),
      extra.includes('sample') && h('td', { class: 'pl-num' }, p.sample == null ? '' : p.sample.toLocaleString()),
      extra.includes('method') && h('td', {}, p.method ?? ''),
      extra.includes('url') && h('td', {}, p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener', title: p.url }, hostOf(p.url)) : ''));
  });
  $('polls-table').replaceChildren(h('table', {}, h('thead', {}, head), h('tbody', {}, body)));
}

const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'link'; } };

function paintFoot() {
  const { set, win } = model;
  $('polls-foot').replaceChildren(
    `The line is the average of the polls that ended in the previous ${win} days: each firm's latest once, newer polls counting more. The dots are the polls, the dashed lines events. `,
    'From Wikipedia: ', h('a', { href: set.url, target: '_blank', rel: 'noopener' }, set.title),
    ', compiled by its editors from each firm\'s published release (CC BY-SA 4.0).',
    set.edited ? ` Last edited ${dateText(set.edited)}.` : '');
}

function paintStatus() {
  const el = $('polls-status');
  if (!el) return;
  const s = status.get(country()), d = data.get(country());
  el.dataset.state = s?.state ?? 'ok';
  const copy = d?.fetchedAt ? `checked ${new Date(d.fetchedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '';
  const n = model ? model.set.polls.filter(p => !p.election && (!model.variant || p.variant === model.variant)).length : 0;
  el.textContent = s?.state === 'loading' ? 'Checking Wikipedia…'
    : s?.state === 'limited' ? `Wikipedia asked us to slow down; trying again in ${s.retryIn} s${copy ? ` · showing the copy ${copy}` : ''}`
    : s?.state === 'error' ? `Can't reach Wikipedia (${s.error}); trying again in ${s.retryIn} s${copy ? ` · showing the copy ${copy}` : ''}`
    : d ? `${n} poll${n === 1 ? '' : 's'} · ${copy}` : '';
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
  const { set, col, parties, from, to, days, avg, polls, events, election } = model;
  const short = p => (p.length > LABEL_MAX ? `${p.slice(0, LABEL_MAX - 1)}…` : p);
  const right = Math.min(W * 0.4, Math.max(MARGIN.right, 58 + 6.6 * Math.max(...parties.map(p => short(p).length))));   // room for the longest direct label
  const x0 = MARGIN.left, x1 = W - right, y0 = H - MARGIN.bottom, y1 = MARGIN.top;
  const span = Math.max(to - from, DAY);
  const x = t => x0 + (t - from) / span * (x1 - x0);
  const max = Math.max(10, ...polls.flatMap(p => parties.map(q => p.values[q] ?? 0)));
  const step = max > 120 ? 50 : max > 60 && set.unit === 'seats' ? 20 : 10;     // seats can run to hundreds
  const top = Math.ceil(max / step) * step;
  const y = v => y0 - v / top * (y0 - y1);

  const grid = [];
  for (let v = 0; v <= top; v += step) {
    grid.push(svg('line', { class: v ? 'pl-grid' : 'pl-axis', x1: x0, x2: x1, y1: y(v), y2: y(v) }));
    grid.push(svg('text', { class: 'pl-tick', x: x0 - 6, y: y(v) + 4, 'text-anchor': 'end' }, `${v}${pct()}`));
  }
  // Month ticks, as many as fit; over more than three years, a tick per year
  const months = [];
  const d0 = new Date(from);
  for (let m = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1)); m.getTime() <= to; m.setUTCMonth(m.getUTCMonth() + 1)) months.push(m.getTime());
  const yearly = months.length > 36;
  const ticks = yearly ? months.filter(t => new Date(t).getUTCMonth() === 0) : months;
  const every = Math.max(1, Math.ceil(ticks.length / Math.max(1, Math.floor((x1 - x0) / (yearly ? 50 : 70)))));
  ticks.forEach((t, i) => {
    if (i % every) return;
    const jan = new Date(t).getUTCMonth() === 0;
    grid.push(svg('line', { class: 'pl-mtick', x1: x(t), x2: x(t), y1: y0, y2: y0 + 4 }));
    grid.push(svg('text', { class: 'pl-tick', x: x(t), y: y0 + 16, 'text-anchor': 'middle' },
      dateText(t, yearly ? { year: 'numeric' } : jan || i === 0 ? { month: 'short', year: 'numeric' } : { month: 'short' })));
  });

  const eventMarks = events.map(e => svg('g', { class: 'pl-event-mark' },
    svg('line', { x1: x(e.t), x2: x(e.t), y1: y1, y2: y0 }),
    svg('title', {}, `${dateText(e.t)}: ${e.text}`)));

  const few = polls.length <= 30;                     // each poll is worth seeing on its own: bigger, solid dots
  const dots = [], lines = [], ends = [];
  for (const p of parties) {
    for (const poll of polls) if (poll.values[p] != null) dots.push(svg('circle', { class: 'pl-dot', cx: x(poll.t), cy: y(poll.values[p]), r: few ? 3.5 : 2.4, fill: col[p] }));
    // A gap in the line is a stretch with no polls in the window. A stretch of a single day (a poll long after
    // the one before it) is a dash, so the average there doesn't vanish.
    let d = '', run = 0, last = null;
    avg[p].forEach((v, i) => {
      if (v == null) { run = 0; return; }
      const px = x(days[i].t), py = y(v).toFixed(1);
      d += `${run ? 'L' : 'M'}${px.toFixed(1)},${py}`;
      if (!run && avg[p][i + 1] == null) d += `M${(px - 4).toFixed(1)},${py}h8`;
      run++; last = v;
    });
    if (d) lines.push(svg('path', { class: 'pl-line', d, stroke: col[p] }));
    if (avg[p].at(-1) != null) ends.push({ p, v: last, y: y(last), col: col[p] });   // a line that ended earlier (a former leader) has no label at the edge
  }
  // Direct labels at the right end, nudged apart so none overlap
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + LABEL_GAP);
  if (ends.length) ends.at(-1).y = Math.min(ends.at(-1).y, y0 - 2);   // none below the axis
  for (let i = ends.length - 2; i >= 0; i--) ends[i].y = Math.min(ends[i].y, ends[i + 1].y - LABEL_GAP);
  const labels = ends.map(e => svg('g', { class: 'pl-end', ...linkAttrs(set, e.p) },
    svg('circle', { cx: x1 + 8, cy: e.y, r: 4, fill: e.col }),
    svg('text', { x: x1 + 16, y: e.y + 4 }, `${short(e.p)} ${fmt1(e.v)}`)));

  const elect = election && election.t >= from ? parties.filter(p => election.values[p] != null).map(p =>
    svg('rect', { class: 'pl-elect', x: x(election.t) - 4, y: y(election.values[p]) - 4, width: 8, height: 8, fill: col[p], transform: `rotate(45 ${x(election.t)} ${y(election.values[p])})` },
      svg('title', {}, `${election.firm}: ${p} ${election.values[p]}${pct()}`))) : [];

  const cross = svg('g', { id: 'polls-cross', visibility: 'hidden' }, svg('line', { y1: y1, y2: y0 }));
  box.replaceChildren(svg('svg', { width: W, height: H, class: few ? 'pl-few' : null, role: 'img', 'aria-label': `Polling average, ${dateText(from)} to ${dateText(to)}` },
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
  const { set, col, parties, avg, win } = model;
  const rows = parties.filter(p => avg[p][i] != null).sort((a, b) => avg[b][i] - avg[a][i]);
  const ended = model.polls.filter(p => p.t === day.t);
  const tip = $('polls-tip');
  tip.replaceChildren(...[
    h('div', { class: 'pl-tip-date' }, dateText(day.t)),
    rows.map(p => h('div', { class: 'pl-tip-row' }, h('span', { class: 'pl-key', style: `background:${col[p]}` }), h('span', {}, nameOf(set, p)), h('b', {}, fmtU(avg[p][i])))),
    h('div', { class: 'pl-tip-n' }, day.n ? `Average of ${day.n} firm${day.n === 1 ? '' : 's'} in the last ${win} days` : `No polls in the ${win} days up to this day`),
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
