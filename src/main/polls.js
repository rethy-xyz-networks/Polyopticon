'use strict';

// Opinion polls: national voting intention, one country at a time, from the poll tables Wikipedia's editors keep
// ("Opinion polling for the next Canadian federal election"). No polling firm or agency publishes an open feed of
// every poll, so this is the most complete public source: each row cites the firm's own release, and the text is
// CC BY-SA 4.0 (credited in the view). The page is read through the MediaWiki API, no key or login.
//
// A country's page is fetched when its view asks, at most once every REFRESH_MS, and kept under <data>/polls so it
// shows at once next time and while offline. Wikimedia asks for a User-Agent naming the app and a contact; a 429 or
// 503 waits for Retry-After, a 403 an hour, and a failure is retried later on its own (longer each time) while the
// view is still wanted. Nothing here ever needs the user.
//
// The parser is generic over Wikipedia's poll-table layout: firm, last date, link, one column per party, margin of
// error, sample, method, lead. Party columns are whatever sits between the link and the margin of error, so another
// country is mostly a new COUNTRIES entry.

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');
const { parseRetryAfter, request } = require('./adapters/util');

const API = 'https://en.wikipedia.org/w/api.php';
const REFRESH_MS = 30 * 60e3;                 // the tables change a few times a week
const MIN_GAP_MS = 60e3;                      // Refresh, pressed again and again, still asks at most once a minute
const RETRY_MS = [60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 30 * 60e3];
const BLOCK_MS = 60 * 60e3;
const WANTED_MS = 35 * 60e3;                  // retry on our own only while the view asked recently

const COUNTRIES = {
  ca: {
    name: 'Canada',
    page: 'Opinion polling for the next Canadian federal election',   // a redirect to the current election's page
    table: 'Table of polls',                                         // the heading the national table sits under
    parties: {
      LPC: 'Liberal', CPC: 'Conservative', BQ: 'Bloc Québécois', NDP: 'New Democratic',
      GPC: 'Green', PPC: "People's Party", Others: 'Other parties',
    },
  },
};

// Wikitext

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad2 = n => String(n).padStart(2, '0');

/** "November 7, 2026", "7 November 2026", "2026-11-07" or "2026-11-7" -> "2026-11-07"; null if it isn't a date. */
function parseDate(s) {
  const t = String(s ?? '').replace(/[,\s]+/g, ' ').trim();
  let m = /^(\d{4})[-| ](\d{1,2})[-| ](\d{1,2})$/.exec(t);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^([A-Za-z]+)\.? (\d{1,2}) (\d{4})$/.exec(t);
  if (m) return valid(+m[3], month(m[1]), +m[2]);
  m = /^(\d{1,2}) ([A-Za-z]+)\.? (\d{4})$/.exec(t);
  if (m) return valid(+m[3], month(m[2]), +m[1]);
  return null;
}
const month = name => { const n = name.toLowerCase(); const i = MONTHS.findIndex(x => x.startsWith(n.slice(0, 3))); return i < 0 ? 0 : i + 1; };
function valid(y, mo, d) {
  if (!mo || d < 1 || d > 31 || y < 1900) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 ? `${y}-${pad2(mo)}-${pad2(d)}` : null;
}

/** Templates, innermost first: dates keep their text, party shading and footnotes go, the rest keep nothing. */
function expandTemplates(s) {
  for (let i = 0; i < 20; i++) {
    const next = s.replace(/\{\{([^{}]*)\}\}/g, (_, body) => {
      const [name, ...args] = body.split('|');
      const n = name.trim().toLowerCase();
      if (n === 'dts' || n === 'date table sorting' || n === 'sort date') {
        const plain = args.filter(a => !a.includes('='));
        return plain.length >= 3 && plain.slice(0, 3).every(a => /^\s*\d+\s*$/.test(a)) ? plain.slice(0, 3).map(a => a.trim()).join('-') : (plain[0] ?? '');
      }
      if (n === 'nowrap' || n === 'nobr' || n === 'small') return args.join('|');
      return '';
    });
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Index of the first `|` outside [[links]] (attributes | value), or -1. */
function topLevelPipe(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '[' && s[i + 1] === '[') { depth++; i++; }
    else if (s[i] === ']' && s[i + 1] === ']') { depth = Math.max(0, depth - 1); i++; }
    else if (s[i] === '|' && depth === 0) return i;
  }
  return -1;
}

const ENTITIES = { amp: '&', nbsp: ' ', ndash: '–', mdash: '—', minus: '−', plusmn: '±', lt: '<', gt: '>', quot: '"' };

/** A cell's wikitext as plain text: links become their label, tags and bold/italic quotes go. */
function plain(s) {
  return s
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/'{2,}/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(+e.slice(1)) : ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** One cell: { text, colspan }. "style=… | value" keeps the value; colspan is read off the attributes. */
function cell(raw) {
  const p = topLevelPipe(raw);
  const attrs = p < 0 ? '' : raw.slice(0, p);
  const value = p < 0 ? raw : raw.slice(p + 1);
  const span = /colspan\s*=\s*"?(\d+)/i.exec(attrs);
  return { text: plain(value), colspan: span ? +span[1] : 1 };
}

/** The table under a heading ("=== Table of polls ==="), as wikitext from {| to its |}; null if there's none. */
function findTable(wikitext, heading) {
  const re = new RegExp(`^=+\\s*${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=+\\s*$`, 'mi');
  const h = re.exec(wikitext);
  if (!h) return null;
  const start = wikitext.indexOf('\n{|', h.index);
  const nextHeading = /^=+[^=\n]+=+\s*$/m;
  const between = wikitext.slice(h.index + h[0].length, start < 0 ? undefined : start);
  if (start < 0 || nextHeading.test(between)) return null;
  let depth = 0;
  const lines = wikitext.slice(start + 1).split('\n');
  const out = [];
  for (const line of lines) {
    out.push(line);
    if (/^\s*\{\|/.test(line)) depth++;
    else if (/^\s*\|\}/.test(line) && --depth === 0) return out.join('\n');
  }
  return null;
}

/**
 * The table's rows as { header, cells: [{ text, colspan }], url, style }. A row's first cited URL (its poll's
 * release) is kept before the references are dropped; a reference can span lines, so it goes before the split.
 */
function tableRows(table) {
  const rows = [];
  for (const chunk of table.replace(/<!--[\s\S]*?-->/g, '').split(/\n\|-/)) {               // the first is the {| line (and any header before a |-)
    const url = /<ref[^>/]*>[\s\S]*?\burl\s*=\s*(https?:\/\/[^\s|}<]+)/i.exec(chunk)?.[1] ?? null;
    let body = chunk.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
    body = expandTemplates(body);
    const [first, ...lines] = body.split('\n');
    const cells = [];
    let header = false;
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('|}')) break;
      if (t.startsWith('!')) { header = true; for (const c of t.slice(1).split('!!')) cells.push(cell(c)); }
      else if (t.startsWith('|') && !t.startsWith('|+')) for (const c of t.slice(1).split('||')) cells.push(cell(c));
      else if (cells.length && t) cells[cells.length - 1].text = plain(`${cells[cells.length - 1].text} ${t}`);   // a cell's text on a second line
    }
    rows.push({ header, cells, url, style: first.trim() });
  }
  return rows;
}

/** "44.2" -> 44.2, "±3.1 pp" -> 3.1, "1,027 (1/4)" -> 1027; "—", "N/A", "" -> null. */
const number = s => { const m = /\d[\d,]*(?:\.\d+)?/.exec(String(s ?? '')); return m ? Number(m[0].replace(/,/g, '')) : null; };

/**
 * The poll table as { parties: ['LPC', …], polls: [{ firm, date, values: { LPC: 44, … }, moe, sample, method, url,
 * election? }], events: [{ date, text }] }, newest first. Rows that aren't a poll (sub-headers, notes) are skipped;
 * a row spanning the party columns with a date is an event (a by-election, a new leader); the election row is
 * kept, marked, as the starting point.
 */
function parsePollTable(table) {
  const rows = tableRows(table);
  const head = rows.find(r => r.header && r.cells.length >= 6);
  if (!head) return null;
  const labels = head.cells.map(c => c.text);
  const col = re => labels.findIndex(l => re.test(l));
  const firmCol = col(/polling firm|pollster/i), dateCol = col(/last date|date/i);
  const linkCol = col(/^(link|source|ref)/i), moeCol = col(/margin/i);
  const sampleCol = col(/sample/i), methodCol = col(/method/i), leadCol = col(/^lead/i);
  if (firmCol < 0 || dateCol < 0 || moeCol < 0) return null;
  const firstParty = Math.max(dateCol, linkCol) + 1;
  const parties = labels.slice(firstParty, moeCol).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (parties.length < 2) return null;

  const polls = [], events = [];
  for (const r of rows) {
    if (r.header || !r.cells.length) continue;
    const spanning = r.cells.find(c => c.colspan >= parties.length);
    if (spanning) {
      const date = r.cells.map(c => parseDate(c.text)).find(Boolean);
      if (date && spanning.text) events.push({ date, text: spanning.text });
      continue;
    }
    if (r.cells.length < moeCol) continue;
    const date = parseDate(r.cells[dateCol]?.text);
    const firm = r.cells[firmCol]?.text;
    if (!date || !firm) continue;
    const values = {};
    parties.forEach((p, i) => { const v = number(r.cells[firstParty + i]?.text); if (v != null && v <= 100) values[p] = v; });
    if (Object.keys(values).length < 2) continue;
    const sample = sampleCol >= 0 ? number(r.cells[sampleCol]?.text) : null;
    const poll = {
      firm, date, values,
      moe: moeCol >= 0 ? number(r.cells[moeCol]?.text) : null,
      sample,
      method: methodCol >= 0 ? (r.cells[methodCol]?.text || null) : null,
      lead: leadCol >= 0 ? number(r.cells[leadCol]?.text) : null,
      url: r.url,
    };
    if (/\belection\b/i.test(firm)) { poll.election = true; poll.moe = null; }
    polls.push(poll);
  }
  polls.sort((a, b) => b.date.localeCompare(a.date));
  events.sort((a, b) => b.date.localeCompare(a.date));
  return { parties, polls, events };
}

/** The API's answer (action=query, revisions, formatversion=2) -> the page's { title, revid, edited, wikitext }. */
function pageOf(body) {
  const page = body?.query?.pages?.[0];
  const rev = page?.revisions?.[0];
  const wikitext = rev?.slots?.main?.content ?? rev?.content;
  if (!page || page.missing || typeof wikitext !== 'string') return null;
  return { title: page.title, revid: rev.revid, edited: rev.timestamp ? Date.parse(rev.timestamp) : null, wikitext };
}

/** A country's polls from its page, or throws. */
function pollsFromPage(country, page) {
  const cfg = COUNTRIES[country];
  const table = findTable(page.wikitext, cfg.table);
  if (!table) throw new Error(`no "${cfg.table}" table on ${page.title}`);
  const parsed = parsePollTable(table);
  if (!parsed || !parsed.polls.length) throw new Error(`could not read the polls on ${page.title}`);
  return {
    country, name: cfg.name, title: page.title, revid: page.revid, edited: page.edited,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    partyNames: cfg.parties,
    ...parsed,
  };
}

// Fetching

/**
 * The fetcher. get(country, { force }) answers at once with the saved copy (or null) and, if it's older than
 * REFRESH_MS (or forced, at most once a minute), fetches the page in the background. onData(data) is called with
 * each new copy, onStatus({ country, state: 'loading' | 'ok' | 'error' | 'limited', retryIn?, error? }) as it goes.
 * `fetchFn(url, opts)` is the HTTP request (injected for tests); `now` and the timers likewise.
 */
function createPolls({ dir, userAgent, onData, onStatus, fetchFn = request, now = Date.now, setTimer = setTimeout }) {
  const cache = new Map();          // country -> data
  const state = new Map();          // country -> { inflight, lastTry, failures, pausedUntil, wantedAt, timer }
  const st = c => { let s = state.get(c); if (!s) state.set(c, s = { inflight: null, lastTry: 0, failures: 0, pausedUntil: 0, wantedAt: 0, timer: null }); return s; };
  const file = c => path.join(dir, `${c}.json`);

  function load(country) {
    if (cache.has(country)) return cache.get(country);
    let data = null;
    try { data = JSON.parse(fs.readFileSync(file(country), 'utf8')); } catch { /* none yet */ }
    if (data && !Array.isArray(data.polls)) data = null;
    cache.set(country, data);
    return data;
  }

  function save(country, data) {
    cache.set(country, data);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${file(country)}.tmp`, JSON.stringify(data));
      fs.renameSync(`${file(country)}.tmp`, file(country));
    } catch (e) { log.warn(`Polls: could not save ${country}: ${e.message}`); }
  }

  async function fetchCountry(country) {
    const cfg = COUNTRIES[country];
    const url = `${API}?action=query&format=json&formatversion=2&redirects=1&prop=revisions&rvprop=ids%7Ctimestamp%7Ccontent&rvslots=main&titles=${encodeURIComponent(cfg.page)}`;
    const res = await fetchFn(url, { headers: { 'User-Agent': userAgent(), Accept: 'application/json' }, timeout: 30e3 });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) });
    const page = pageOf(await res.json());
    if (!page) throw new Error(`Wikipedia has no page "${cfg.page}"`);
    return pollsFromPage(country, page);
  }

  function refresh(country) {
    const s = st(country);
    if (s.inflight) return s.inflight;
    s.lastTry = now();
    onStatus?.({ country, state: 'loading' });
    s.inflight = (async () => {
      try {
        const data = { ...(await fetchCountry(country)), fetchedAt: now() };
        s.failures = 0;
        save(country, data);
        onData?.(data);
        onStatus?.({ country, state: 'ok' });
      } catch (e) {
        const wait = e.status === 403 ? BLOCK_MS
          : Math.max(RETRY_MS[Math.min(s.failures, RETRY_MS.length - 1)], e.retryAfterMs || 0);
        s.failures++;
        s.pausedUntil = now() + wait;
        if (s.failures === 1 || e.status === 403) log.warn(`Polls (${country}): ${e.message}; trying again in ${Math.round(wait / 1000)} s`);
        onStatus?.({ country, state: e.status === 429 || e.status === 503 ? 'limited' : 'error', retryIn: Math.round(wait / 1000), error: e.message });
        clearTimeout(s.timer);
        s.timer = setTimer(() => { if (now() - s.wantedAt < WANTED_MS) refresh(country); }, wait);
        s.timer?.unref?.();
      } finally { s.inflight = null; }
    })();
    return s.inflight;
  }

  return {
    get(country, { force = false, offline = false } = {}) {
      if (!COUNTRIES[country]) return null;
      const data = load(country);
      const s = st(country);
      s.wantedAt = now();
      const stale = !data || now() - (data.fetchedAt || 0) >= REFRESH_MS;
      const allowed = now() >= s.pausedUntil && now() - s.lastTry >= (force ? MIN_GAP_MS : 0);
      if (!offline && (stale || force) && allowed) refresh(country);
      return data;
    },
    countries: () => Object.entries(COUNTRIES).map(([id, c]) => ({ id, name: c.name })),
    refresh,
  };
}

module.exports = { REFRESH_MS, parseDate, expandTemplates, findTable, parsePollTable, pageOf, createPolls };
