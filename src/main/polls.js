'use strict';

// Opinion polls: a wrapper around the poll tables Wikipedia's editors keep, one country at a time. For Canada that
// is federal voting intention (national, by province, by riding, with another party leader), preferred prime
// minister, government approval, each province's next election, and the standing questions (Quebec independence,
// Alberta separation, joining the United States). No polling firm or agency publishes an open feed of every poll,
// so this is the most complete public source: each row cites the firm's own release, and the text is CC BY-SA 4.0
// (credited in the view). The pages are read through the MediaWiki API, no key or login.
//
// A country's pages are checked when its view asks, at most once every REFRESH_MS, and kept under <data>/polls so
// they show at once next time and while offline. A check is one small request for every page's revision id, then
// one for the text of the pages that changed (usually one or none). Wikimedia asks for a User-Agent naming the app
// and a contact; a 429 or 503 waits for Retry-After, a 403 an hour, and a failure is retried later on its own
// (longer each time) while the view is still wanted. Nothing here ever needs the user.
//
// The parser is generic over Wikipedia's poll-table layouts: a column is the firm, the date, the link, the margin
// of error, the sample, the method or the lead by its heading, and every other column is an answer (a party, a
// leader, Yes / No). So another question is a new entry in a country's `sets`, and another country a new COUNTRIES
// entry.

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
const FORMAT = 2;                             // of the saved copy; a copy in another format is fetched again

// A set is one question: { id, group, label, kind?, page, under, … }.
//   page     the page's title (a redirect such as "Next … election" follows the current one), or
//            { after, suffix }: the title another page resolved to, plus a suffix
//   under    the headings its table sits under, outermost first (text or pattern); not all the levels are needed
//   skip     tables whose own heading matches are left out
//   merge    every table under the headings is one series (a table per period)
//   variant  every table under the headings is one choice of this name ("Province"), named by its heading;
//            `base` names the table directly under the headings. A table with a column of its own for the
//            choice (a riding, a hypothetical leader) needs neither.
//   kind     'parties' for voting intention; 'breakdown' where the columns are groups of voters and the variant
//            the answer, so no column leads another
//   names    full names for the answers, where the table's own links don't give good ones
const CA_FEDERAL = 'Opinion polling for the next Canadian federal election';   // a redirect to the current election's page
const PROVINCES = {
  ab: 'Alberta', bc: 'British Columbia', mb: 'Manitoba', nb: 'New Brunswick', nl: 'Newfoundland and Labrador',
  ns: 'Nova Scotia', on: 'Ontario', pe: 'Prince Edward Island', qc: 'Quebec', sk: 'Saskatchewan',
};

const COUNTRIES = {
  ca: {
    name: 'Canada',
    sets: [
      { id: 'vote', group: 'Federal', label: 'Voting intention', kind: 'parties', page: CA_FEDERAL, under: ['National polls', 'Table of polls'],
        names: { LPC: 'Liberal', CPC: 'Conservative', BQ: 'Bloc Québécois', NDP: 'New Democratic', GPC: 'Green', PPC: "People's Party", Others: 'Other parties' } },
      { id: 'pm', group: 'Federal', label: 'Preferred prime minister', page: CA_FEDERAL, under: [/^Leadership polls/i], merge: true },
      { id: 'approval', group: 'Federal', label: 'Government approval', page: CA_FEDERAL, under: [/approval polls/i] },
      { id: 'regional', group: 'Federal', label: 'Voting intention by province', kind: 'parties', page: CA_FEDERAL, under: ['Regional polls'], variant: 'Province' },
      { id: 'ridings', group: 'Federal', label: 'Voting intention by riding', kind: 'parties', page: { after: CA_FEDERAL, suffix: ' by constituency' }, under: [], variant: 'Riding' },
      { id: 'leader', group: 'Federal', label: 'Voting intention with another party leader', kind: 'parties', page: CA_FEDERAL, under: [/^Voting intention with/i] },
      ...Object.entries(PROVINCES).map(([code, name]) => (
        { id: `prov-${code}`, group: 'Provincial voting intention', label: name, kind: 'parties', page: `Next ${name} general election`, under: [/^Opinion poll/i] })),
      { id: 'qc-independence', group: 'Questions', label: 'Quebec independence', page: 'Quebec sovereignty movement', under: [/^Opinion poll/i],
        skip: /by party/i, variant: 'Voters', base: 'All voters' },
      { id: 'qc-independence-party', group: 'Questions', label: 'Quebec independence, by party supported', kind: 'breakdown', page: 'Quebec sovereignty movement', under: [/^Opinion poll/i, /by party/i] },
      { id: 'ab-referendum', group: 'Questions', label: 'Alberta: the 2026 referendum question', page: 'Alberta separatist movement', under: [/referendum question/i] },
      { id: 'ab-separation', group: 'Questions', label: 'Alberta: separating from Canada', page: 'Alberta separatist movement', under: [/hypothetical separation/i] },
      { id: 'us-join', group: 'Questions', label: 'Joining the United States (asked of Canadians)', page: 'Movements for the United States annexation of Canada', under: [/^Canadian polling/i] },
      { id: 'us-join-us', group: 'Questions', label: 'Canada joining the United States (asked of Americans)', page: 'Movements for the United States annexation of Canada', under: [/^American polling/i], merge: true },
    ],
  },
};

// Wikitext

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad2 = n => String(n).padStart(2, '0');
const month = name => { const n = name.toLowerCase(); return n.length < 3 ? 0 : MONTHS.findIndex(x => x.startsWith(n)) + 1; };
function valid(y, mo, d) {
  if (!mo || d < 1 || d > 31 || y < 1900) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 ? `${y}-${pad2(mo)}-${pad2(d)}` : null;
}

/**
 * The date in a cell, as "2026-11-07"; null if there is none. A cell holding a range gives its last day, the day
 * the poll ended: "November 7, 2026", "7 November 2026", "2026-11-7", "October 16–18, 2026", "Oct 30 – Nov 2,
 * 2026", "16–28 Sep 2026", "Sep 17, 2025–20, 2025". With no day ("August 2026", "July–August 2025") it is the month's last.
 */
function parseDate(s) {
  const t = String(s ?? '').replace(/[,\s]+/g, ' ').trim();
  let m = /^(\d{4})[-| ](\d{1,2})[-| ](\d{1,2})$/.exec(t);
  if (m) return valid(+m[1], +m[2], +m[3]);
  const found = [];
  for (m of t.matchAll(/([A-Za-z]{3,9})\.? (\d{1,2})(?: ?[–—-] ?(\d{1,2}))? (\d{4})(?: ?[–—-] ?(\d{1,2}) (\d{4}))?/g)) {
    found.push(valid(+(m[6] ?? m[4]), month(m[1]), +(m[5] ?? m[3] ?? m[2])));
  }
  for (m of t.matchAll(/(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})/g)) found.push(valid(+m[3], month(m[2]), +m[1]));
  const last = found.filter(Boolean).sort().at(-1);
  if (last) return last;
  m = [...t.matchAll(/([A-Za-z]{3,9})\.? (\d{4})/g)].findLast(x => month(x[1]));          // "August 2026", "July–August 2025"
  return m ? valid(+m[2], month(m[1]), new Date(Date.UTC(+m[2], month(m[1]), 0)).getUTCDate()) : null;
}

/**
 * Templates, innermost first: dates and wrapped text keep their text, a party's colour becomes a marker its cell
 * is read for (@@pc:Liberal@@), shading and footnotes go, the rest keep nothing.
 */
function expandTemplates(s) {
  for (let i = 0; i < 20; i++) {
    const next = s.replace(/\{\{([^{}]*)\}\}/g, (_, body) => {
      const [name, ...args] = body.split('|');
      const n = name.trim().toLowerCase();
      const plainArgs = args.filter(a => !/^\s*[\w-]+\s*=/.test(a)).map(a => a.trim());
      if (n === 'dts' || n === 'date table sorting' || n === 'sort date') {
        if (args.some(a => /^\s*format\s*=\s*hide\s*$/i.test(a))) return '';       // a sort key; the date follows as text
        return plainArgs.length >= 3 && plainArgs.slice(0, 3).every(a => /^\d+$/.test(a)) ? plainArgs.slice(0, 3).join('-') : (plainArgs[0] ?? '');
      }
      if (/^opm?drts$/.test(n) || n === 'opinion poll date range table sorting') {  // start day | end day | month | year, or day | month | day | month | year
        const y = plainArgs.findLastIndex(a => /^\d{4}$/.test(a));
        if (y < 0) return '';
        const before = plainArgs.slice(0, y), nums = before.filter(a => /^\d{1,2}$/.test(a));
        const mon = before.findLast(a => /^[A-Za-z]+$/.test(a));
        return mon ? [nums.at(-1), mon, plainArgs[y]].filter(Boolean).join(' ') : nums.length >= 2 ? `${plainArgs[y]}-${nums.at(-1)}-${nums.at(-2)}` : '';   // the month as a number
      }
      if (/party colou?r$/.test(n)) return `@@pc:${plainArgs.at(-1) ?? ''}@@`;
      if (n === 'nowrap' || n === 'nobr' || n === 'small' || n === 'nobold') return args.join('|');
      if (n === 'white' || n === 'color' || n === 'font color' || n === 'colored text') return plainArgs.at(-1) ?? '';
      if (n === 'abbr' || n === 'tooltip' || n === 'nts' || n === 'val') return plainArgs[0] ?? '';
      if (n === 'sort' || n === 'sortname') return plainArgs[1] ?? plainArgs[0] ?? '';
      if (n === 'snd' || n === 'spaced ndash' || n === 'ndash' || n === 'en dash') return ' – ';
      if (n.startsWith('formatnum:')) return name.trim().slice(10);
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
    .replace(/@@pc:[^@]*@@/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1')
    .replace(/\[https?:\/\/[^\s\]]+\]/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/'{2,}/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(+e.slice(1)) : ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One cell: { text, colspan, rowspan, party, name, sort }. "style=… | value" keeps the value; the spans, the
 * party whose colour the cell wears and its sort key are read off the attributes; `name` is the article a cell
 * that is one link points at ("Liberal Party of Canada" for [[Liberal Party of Canada|LPC]]).
 */
function cell(raw) {
  const p = topLevelPipe(raw);
  const attrs = p < 0 ? '' : raw.slice(0, p);
  const value = p < 0 ? raw : raw.slice(p + 1);
  const span = re => { const m = re.exec(attrs); return m ? Math.max(1, Math.min(+m[1], 200)) : 1; };
  const link = /^\s*(?:'{2,})?\[\[([^\]|#]+)(?:#[^\]|]*)?\|[^\]]*\]\](?:'{2,})?s?\s*$/.exec(value);
  return {
    text: plain(value),
    colspan: span(/colspan\s*=\s*"?(\d+)/i),
    rowspan: span(/rowspan\s*=\s*"?(\d+)/i),
    party: /@@pc:([^@]*)@@/.exec(raw)?.[1].trim() || null,
    name: link ? link[1].replace(/\s*\([^)]*\)\s*$/, '').trim() : null,
    sort: /data-sort-value\s*=\s*"?([^"|]+)/i.exec(attrs)?.[1].trim() ?? null,
  };
}

/** Every table on a page with the headings it sits under, outermost first: [{ path: ['National polls', …], text }]. */
function tablesOf(wikitext) {
  const lines = wikitext.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out = [];
  let heads = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^(=+)\s*(.*?)\s*=+\s*$/.exec(lines[i]);
    if (h) { heads = [...heads.filter(x => x.level < h[1].length), { level: h[1].length, text: plain(expandTemplates(h[2])) }]; continue; }
    if (!/^\s*:*\{\|/.test(lines[i])) continue;
    let depth = 0, j = i;
    for (; j < lines.length; j++) {
      if (/^\s*:*\{\|/.test(lines[j])) depth++;
      else if (/^\s*\|\}/.test(lines[j]) && --depth === 0) break;
    }
    if (j === lines.length) break;                                    // never closed
    out.push({ path: heads.map(x => x.text), text: lines.slice(i, j + 1).join('\n').replace(/^\s*:*/, '') });
    i = j;
  }
  return out;
}

/** The table directly under a heading ("=== Table of polls ==="), as wikitext from {| to its |}; null if there's none. */
function findTable(wikitext, heading) {
  const want = heading.toLowerCase();
  return tablesOf(wikitext).find(t => t.path.at(-1)?.toLowerCase() === want)?.text ?? null;
}

const refKey = s => s.replace(/^["']|["']$/g, '').trim();

/** A page's named references that cite a URL: name -> URL. A row often cites one defined in another row. */
function refsOf(wikitext) {
  const refs = new Map();
  for (const m of wikitext.matchAll(/<ref\s+name\s*=\s*("[^"]*"|'[^']*'|[^\s/>]+)[^>/]*>([\s\S]*?)<\/ref>/gi)) {
    const url = /\burl\s*=\s*(https?:\/\/[^\s|}<]+)/i.exec(m[2])?.[1] ?? /(https?:\/\/[^\s|}<\]]+)/.exec(m[2])?.[1];
    if (url && !refs.has(refKey(m[1]))) refs.set(refKey(m[1]), url);
  }
  return refs;
}

/** A row's source: the URL its own reference cites, or the reference it names, or its first plain link. */
function rowUrl(chunk, refs) {
  const cited = /<ref[^>/]*>[\s\S]*?\burl\s*=\s*(https?:\/\/[^\s|}<]+)/i.exec(chunk)?.[1];
  if (cited) return cited;
  if (refs) for (const m of chunk.matchAll(/<ref\s+name\s*=\s*("[^"]*"|'[^']*'|[^\s/>]+)\s*\/>/gi)) if (refs.has(refKey(m[1]))) return refs.get(refKey(m[1]));
  return /\[(https?:\/\/[^\s\]<]+)/.exec(chunk)?.[1] ?? null;
}

/**
 * The table's rows as { header, cells, cols, url }. `cols` is the row as the reader sees it: the cell in each
 * column, with a cell that spans columns or rows (a firm's name beside its three questions) repeated in each
 * place it covers. A row's source is kept before the references are dropped; a reference can span lines, so it
 * goes before the split.
 */
function tableRows(table, refs) {
  const rows = [];
  for (const chunk of table.replace(/<!--[\s\S]*?-->/g, '').split(/\n\|-/)) {               // the first is the {| line (and any header before a |-)
    const url = rowUrl(chunk, refs);
    let body = chunk.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
    body = expandTemplates(body);
    const [, ...lines] = body.split('\n');
    const cells = [];
    let heads = 0;
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('|}')) break;
      if (t.startsWith('!')) for (const c of t.slice(1).split(/!!|\|\|/)) { cells.push(cell(c)); heads++; }
      else if (t.startsWith('|') && !t.startsWith('|+')) for (const c of t.slice(1).split('||')) cells.push(cell(c));
      else if (cells.length && t) cells[cells.length - 1].text = plain(`${cells[cells.length - 1].text} ${t}`);   // a cell's text on a second line
    }
    if (cells.length) rows.push({ header: heads === cells.length, cells, url });
  }
  // Lay the cells out in columns. A header's row spans stop at the header, as they do on the page.
  let carry = [];                                                      // column -> { cell, url, left }
  rows.forEach((r, i) => {
    if (i && rows[i - 1].header !== r.header) carry = [];
    const cols = [];
    let c = 0, inherited = null;
    const held = () => { while (carry[c]?.left > 0) { cols[c] = carry[c].cell; inherited ??= carry[c].url; carry[c].left--; c++; } };
    for (const x of r.cells) {
      held();
      for (let k = 0; k < x.colspan; k++, c++) {
        cols[c] = x;
        carry[c] = x.rowspan > 1 ? { cell: x, url: r.url, left: x.rowspan - 1 } : null;
      }
    }
    held();
    r.cols = cols;
    r.url ??= inherited;
  });
  return rows;
}

/** "44.2" -> 44.2, "±3.1 pp" -> 3.1, "1,027 (1/4)" -> 1027; "—", "N/A", "" -> null. */
const number = s => { const m = /\d[\d,]*(?:\.\d+)?/.exec(String(s ?? '')); return m ? Number(m[0].replace(/,/g, '')) : null; };
/** A lead or a net rating: "+37%" -> 37, "−5" -> -5. */
const signed = s => { const n = number(s); return n != null && /[−-]\s*\d/.test(String(s)) ? -n : n; };
/** A margin of error: "±3.1 pp" -> 3.1, and "3,0%" (a decimal comma) -> 3. */
const margin = s => number(String(s ?? '').replace(/(\d),(\d{1,2})(?!\d)/, '$1.$2'));

const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

// What a column holds, by its heading. Every other column with a heading is an answer.
const ROLES = [
  ['firm', /polling firm|pollster|polling organi[sz]ation|conducted by|poll source|^firm$/i],
  ['date', /\bdates?\b/i],
  ['link', /^(link|sources?|refs?\.?|references?)$/i],
  ['moe', /margin|^moe$/i],
  ['sample', /^sample/i],
  ['method', /method|^(polling )?type$/i],
  ['lead', /^lead\b|^net\b/i],
  ['skip', /^(client|notes?|remarks?)$/i],
  ['variant', /^hypothetical|^(riding|constituency|district|language|position|region)$/i],
];

/**
 * A poll table as { options: ['LPC', …], names: { LPC: 'Liberal Party of Canada' }, partyOf: { LPC: 'Liberal' },
 * variantLabel, polls: [{ firm, date, values: { LPC: 44, … }, moe, sample, method, lead, url, variant?,
 * election? }], events: [{ date, text }] }, newest first; null if it isn't one. `options` are the answers (parties,
 * leaders, Yes / No) in the table's order; `partyOf` is the party whose colour the table gives an answer;
 * `variant` is the row's value in a column that splits the table (a riding, a hypothetical leader), named by
 * `variantLabel`. Rows that aren't a poll (sub-headers, notes) are skipped; a row with a date and a sentence
 * across the columns is an event (a by-election, a new leader); the election's own row is kept, marked, as the
 * starting point. `refs` (refsOf) finds the source of a row that names a reference defined elsewhere.
 */
function parsePollTable(table, { refs } = {}) {
  const rows = tableRows(table, refs);
  const distinct = r => new Set(r.cols.filter(Boolean)).size;
  const hi = rows.findIndex(r => r.header && distinct(r) >= 4);
  if (hi < 0) return null;
  let depth = 1;
  const deepest = Math.max(...rows[hi].cells.map(c => c.rowspan));
  while (depth < deepest && rows[hi + depth]?.header) depth++;
  const head = rows.slice(hi, hi + depth);

  // A column's heading is the lowest cell with text ("Yes" under "Should Quebec be…?"); its party colour is
  // whichever of its cells wears one (the swatch row under the party's name).
  const role = {}, options = [], names = {}, partyOf = {}, optionCol = {};
  for (let c = 0; c < rows[hi].cols.length; c++) {
    const cells = head.map(r => r.cols[c]).filter(Boolean);
    const labelled = cells.findLast(x => x.text);
    if (!labelled || (c && cells.every(x => head.some(r => r.cols[c - 1] === x)))) continue;   // no heading, or a wide heading's second column
    const label = labelled.text;
    const kind = ROLES.find(([, re]) => re.test(label))?.[0];
    if (kind === 'skip') continue;
    if (kind) { role[kind] ??= { c, label }; continue; }
    if (label in optionCol) continue;
    optionCol[label] = c;
    options.push(label);
    if (labelled.name && labelled.name !== label && !/^List of /i.test(labelled.name)) names[label] = labelled.name;
    const party = cells.find(x => x.party)?.party;
    if (party) partyOf[label] = party;
  }
  if (!role.firm || !role.date || options.length < 2) return null;

  const polls = [], events = [];
  const text = (r, kind) => (role[kind] ? r.cols[role[kind].c]?.text ?? '' : '');
  for (const r of rows.slice(hi + depth)) {
    if (r.header) continue;
    const wide = r.cells.filter(c => c.colspan >= Math.max(3, Math.min(options.length, 6)) && /[A-Za-z]{4}/.test(c.text)).sort((a, b) => b.colspan - a.colspan)[0];
    if (wide) {
      const date = r.cells.filter(c => c !== wide).map(c => parseDate(c.text)).find(Boolean) ?? parseDate(wide.text);
      if (date) events.push({ date, text: wide.text });
      continue;
    }
    let firm = text(r, 'firm');
    if (!firm || /^(html|pdf|link|source|\[?\d+\]?)$/i.test(firm)) firm = hostOf(r.url);   // a firm given only as a link to its release
    const date = parseDate(text(r, 'date')) ?? parseDate(r.cols[role.date.c]?.sort);
    if (!date || !firm) continue;
    const values = {};
    for (const o of options) { const v = number(r.cols[optionCol[o]]?.text); if (v != null && v <= 100) values[o] = v; }
    if (Object.keys(values).length < 2) continue;
    const poll = {
      firm, date, values,
      moe: role.moe ? margin(text(r, 'moe')) : null,
      sample: role.sample ? number(text(r, 'sample')) : null,
      method: text(r, 'method') || null,
      lead: role.lead ? signed(text(r, 'lead')) : null,
      url: r.url,
    };
    if (role.variant && text(r, 'variant')) poll.variant = text(r, 'variant');
    if (/\b(election|referendum)\b/i.test(firm) && !/\b(study|survey|poll)/i.test(firm)) { poll.election = true; poll.moe = null; }   // the result itself
    polls.push(poll);
  }
  const asked = options.filter(o => polls.some(p => o in p.values));   // a column no poll has a number in isn't an answer
  if (asked.length < 2) return null;
  polls.sort((a, b) => b.date.localeCompare(a.date));
  events.sort((a, b) => b.date.localeCompare(a.date));
  return { options: asked, names, partyOf, variantLabel: role.variant?.label ?? null, polls, events };
}

// Sets

const pageKey = page => (typeof page === 'string' ? page : `${page.after}${page.suffix}`);
const wikiUrl = (title, anchor) => `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}${anchor ? `#${encodeURIComponent(anchor.replace(/ /g, '_'))}` : ''}`;

/** Where `under` (headings, outermost first) ends in a table's path: the index of the last one, -1 for no headings asked, null for no match. */
function placeUnder(under, tablePath) {
  let at = -1;
  for (const term of under) {
    at = tablePath.findIndex((h, i) => i > at && (typeof term === 'string' ? h.toLowerCase() === term.toLowerCase() : term.test(h)));
    if (at < 0) return null;
  }
  return at;
}

/**
 * One set (a question) from its page { title, revid, edited, wikitext }: the config's id, group, label and kind,
 * the page it came from, and its table(s) as parsePollTable gives them, with `variants` when the set is several
 * tables or a table split by a column. Null if the page has no such table.
 */
function buildSet(cfg, page) {
  page.tables ??= tablesOf(page.wikitext);
  page.refs ??= refsOf(page.wikitext);
  const parts = [];
  let anchor = null;
  for (const t of page.tables) {
    const at = placeUnder(cfg.under ?? [], t.path);
    if (at == null || cfg.skip?.test(t.path.at(-1) ?? '')) continue;
    const parsed = parsePollTable(t.text, { refs: page.refs });
    if (!parsed?.polls.length) continue;
    if (cfg.variant) {
      const name = at < t.path.length - 1 ? t.path.at(-1) : cfg.base ?? cfg.label;
      for (const x of [...parsed.polls, ...parsed.events]) x.variant = name;
    }
    if (!parts.length) anchor = t.path[Math.max(at, 0)];             // the heading the config names: a table's own can repeat on the page
    parts.push(parsed);
    if (!cfg.merge && !cfg.variant) break;
  }
  if (!parts.length) return null;
  const options = [...new Set(parts.flatMap(p => p.options))];
  const polls = parts.flatMap(p => p.polls).sort((a, b) => b.date.localeCompare(a.date));
  const seen = new Set();
  const events = parts.flatMap(p => p.events).filter(e => { const k = `${e.date}|${e.variant ?? ''}|${e.text}`; return !seen.has(k) && seen.add(k); })
    .sort((a, b) => b.date.localeCompare(a.date));
  const variants = [...new Set(polls.map(p => p.variant).filter(Boolean))];
  const order = parts.flatMap(p => p.polls.map(x => x.variant)).filter(Boolean);     // the page's order, not the dates'
  variants.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return {
    id: cfg.id, group: cfg.group, label: cfg.label, kind: cfg.kind ?? 'question', page: pageKey(cfg.page),
    title: page.title, url: wikiUrl(page.title, anchor), revid: page.revid, edited: page.edited,
    options,
    names: { ...Object.assign({}, ...parts.map(p => p.names).reverse()), ...cfg.names },
    partyOf: Object.assign({}, ...parts.map(p => p.partyOf).reverse()),
    variantLabel: variants.length ? cfg.variant ?? parts[0].variantLabel ?? 'Group' : null,
    variants,
    polls, events,
  };
}

/**
 * The API's answers to one query (action=query, revisions, formatversion=2; more than one when it continues) ->
 * Map of each title asked for -> { title, revid, edited, wikitext? }, following renames and redirects. A page
 * that doesn't exist has no entry.
 */
function pagesOf(bodies, titles) {
  const moved = new Map(), pages = new Map();
  for (const body of bodies) {
    for (const x of [...(body?.query?.normalized ?? []), ...(body?.query?.redirects ?? [])]) moved.set(x.from, x.to);
    for (const p of body?.query?.pages ?? []) {
      const rev = p.revisions?.[0];
      if (p.missing || p.invalid || !rev) continue;
      const wikitext = rev.slots?.main?.content ?? rev.content;
      pages.set(p.title, { ...pages.get(p.title), title: p.title, revid: rev.revid, edited: rev.timestamp ? Date.parse(rev.timestamp) : null, ...(typeof wikitext === 'string' ? { wikitext } : {}) });
    }
  }
  const out = new Map();
  for (const asked of titles) {
    let t = asked;
    for (let i = 0; i < 5 && moved.has(t); i++) t = moved.get(t);
    if (pages.has(t)) out.set(asked, pages.get(t));
  }
  return out;
}

// Fetching

/**
 * The fetcher. get(country, { force }) answers at once with the saved copy (or null) and, if it's older than
 * REFRESH_MS (or forced, at most once a minute), checks the pages in the background. The copy is { country, name,
 * fetchedAt, sets: [buildSet's] }. onData(data) is called with each new copy, onStatus({ country, state:
 * 'loading' | 'ok' | 'error' | 'limited', retryIn?, error? }) as it goes. `fetchFn(url, opts)` is the HTTP request
 * (injected for tests); `now` and the timers likewise.
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
    if (data && (data.format !== FORMAT || !Array.isArray(data.sets))) data = null;
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

  /** One query for some titles: their revision ids, or their text too. */
  async function query(titles, content) {
    const out = new Map();
    for (let i = 0; i < titles.length; i += 50) {
      const batch = titles.slice(i, i + 50);
      const base = `${API}?action=query&format=json&formatversion=2&redirects=1&prop=revisions&rvprop=ids%7Ctimestamp${content ? '%7Ccontent' : ''}&rvslots=main&titles=${encodeURIComponent(batch.join('|'))}`;
      const bodies = [];
      for (let more = '', n = 0; more != null && n < 10; n++) {         // a long answer comes in parts
        const res = await fetchFn(base + more, { headers: { 'User-Agent': userAgent(), Accept: 'application/json' }, timeout: 30e3 });
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) });
        const body = await res.json();
        if (body?.error) throw new Error(`Wikipedia: ${body.error.code ?? 'error'}`);
        bodies.push(body);
        more = body?.continue ? Object.entries(body.continue).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('') : null;
      }
      for (const [k, v] of pagesOf(bodies, batch)) out.set(k, v);
    }
    return out;
  }

  /** A country's sets: the pages that changed since `prev` are read again, the rest keep their sets. */
  async function fetchCountry(country, prev) {
    const cfg = COUNTRIES[country];
    const fixed = [...new Set(cfg.sets.map(s => s.page).filter(p => typeof p === 'string'))];
    const derived = cfg.sets.map(s => s.page).filter(p => typeof p !== 'string');
    // A derived title needs its base's current title: last time's is tried along with the rest, and asked for
    // again only if the base has moved since (a new election's page).
    const title = new Map(fixed.map(t => [t, t]));
    for (const p of derived) if (prev?.pages?.[p.after]) title.set(pageKey(p), prev.pages[p.after].title + p.suffix);
    const ids = await query([...new Set(title.values())], false);
    const late = [];
    for (const p of derived) {
      const base = ids.get(p.after)?.title;
      if (base && title.get(pageKey(p)) !== base + p.suffix) { title.set(pageKey(p), base + p.suffix); late.push(base + p.suffix); }
    }
    if (late.length) for (const [k, v] of await query([...new Set(late)], false)) ids.set(k, v);

    const changed = [...title].filter(([key, t]) => ids.has(t) && prev?.pages?.[key]?.revid !== ids.get(t).revid).map(([, t]) => t);
    const texts = changed.length ? await query([...new Set(changed)], true) : new Map();

    const sets = [], pages = {};
    for (const s of cfg.sets) {
      const key = pageKey(s.page);
      const info = ids.get(title.get(key));
      if (!info) continue;                                             // no such page (yet)
      const page = texts.get(title.get(key));
      const before = prev?.sets?.find(x => x.id === s.id);
      let set = before;
      if (page?.wikitext) {
        try { set = buildSet(s, page) ?? before; }                     // a table broken by an edit keeps its last good copy
        catch (e) { log.warn(`Polls (${country}): ${s.id}: ${e.message}`); }
        pages[key] = { title: page.title, revid: page.revid, edited: page.edited };
      } else if (prev?.pages?.[key]) pages[key] = prev.pages[key];
      if (set) sets.push(set);
    }
    if (!sets.length) throw new Error('Wikipedia has no poll tables where they were expected');
    return { format: FORMAT, country, name: cfg.name, pages, sets };
  }

  function refresh(country) {
    const s = st(country);
    if (s.inflight) return s.inflight;
    s.lastTry = now();
    onStatus?.({ country, state: 'loading' });
    s.inflight = (async () => {
      try {
        const data = { ...(await fetchCountry(country, load(country))), fetchedAt: now() };
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

module.exports = { REFRESH_MS, COUNTRIES, parseDate, expandTemplates, findTable, tablesOf, refsOf, tableRows, parsePollTable, buildSet, pagesOf, createPolls };
