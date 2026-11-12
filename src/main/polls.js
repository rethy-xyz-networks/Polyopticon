'use strict';

// Opinion polls: a wrapper around the poll tables Wikipedia's editors keep, one country at a time (the countries,
// and which tables on which pages, are in poll-countries.js). For Canada, for example, that is federal voting
// intention (national, by province, by riding, with another party leader), preferred prime minister, government
// approval, each province's next election, and the standing questions (Quebec independence, Alberta separation,
// joining the United States). No polling firm or agency publishes an open feed of every poll, so this is the most
// complete public source: each row cites the firm's own release, and the text is CC BY-SA 4.0 (credited in the
// view). The pages are read through the MediaWiki API, no key or login.
//
// A country's pages are checked when its view asks, at most once every REFRESH_MS, and kept under <data>/polls so
// they show at once next time and while offline. A check is one small request for every page's revision id, then
// one for the text of the pages that changed (usually one or none). Only the country on screen is checked: the
// pages are large (up to about 700 KB) and Wikimedia slows down a client that asks for many at once. Wikimedia
// asks for a User-Agent naming the app and a contact; a 429 or 503 waits for Retry-After, a 403 an hour, and a
// failure is retried later on its own (longer each time) while the view is still wanted. Nothing here ever needs
// the user.
//
// The parser is generic over Wikipedia's poll-table layouts: a column is the firm, the date, the link, the margin
// of error, the sample, the method or the lead by its heading, and every other column is an answer (a party, a
// leader, Yes / No), alone or in groups (each leader's Positive / Negative). So another question is a new set in
// poll-countries.js, and another country a new entry there.

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
const FORMAT = 3;                             // of the saved copy; a copy in another format is fetched again
const { COUNTRIES } = require('./poll-countries');

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
      const [name, ...args] = body.split(/\|(?![^[]*\]\])/);           // not the pipe inside a [[link|label]]
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
      if (/^(n\/a|na|n\.a\.|n\/d|nd|tba|tbd|unknown|dunno|nil)$/.test(n)) return `@@na:${plainArgs[0] ?? 'N/A'}@@`;   // a table cell of its own: see cell()
      if (n === 'nowrap' || n === 'nobr' || n === 'small' || n === 'nobold') return args.join('|');
      if (n === 'vert header' || n === 'vertical header' || n === 'verth') return plainArgs.at(-1) ?? '';
      if (n === '!') return '|';
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
    .replace(/@@na:([^@]*)@@/g, '$1')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1')
    .replace(/\[https?:\/\/[^\s\]]+\]/g, '')
    .replace(/\s*([/–-])\s*<br\s*\/?>\s*/gi, '$1')                  // "Unsure/<br>Other" reads Unsure/Other
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/'{2,}/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(+e.slice(1)) : ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

const ATTRS = /^\s*((?:(?:rowspan|colspan|style|class|align|valign|width|bgcolor|scope|data-[\w-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"']+)\s*)+)/i;

/**
 * One cell: { text, colspan, rowspan, party, name, sort }. "style=… | value" keeps the value; the spans, the
 * party whose colour the cell wears and its sort key are read off the attributes; `name` is the article a cell
 * that is one link points at ("Liberal Party of Canada" for [[Liberal Party of Canada|LPC]]).
 *
 * A cell template such as {{N/A}} brings its own attributes and `|` on the page, so `rowspan="2" {{N/A}}` is
 * N/A over two rows, not the text `rowspan="2"`: expandTemplates marks it, and attributes before the mark, or
 * before any value with no `|`, are read as attributes.
 */
function cell(raw) {
  const p = topLevelPipe(raw);
  let attrs = p < 0 ? '' : raw.slice(0, p);
  let value = p < 0 ? raw : raw.slice(p + 1);
  const lead = p < 0 && ATTRS.exec(value);
  if (lead && value.slice(lead[0].length).trim()) { attrs = lead[1]; value = value.slice(lead[0].length); }
  const span = re => { const m = re.exec(attrs); return m ? Math.max(1, Math.min(+m[1], 200)) : 1; };
  const link = /^\s*(?:'{2,})?\[\[([^\]|#]+)(?:#[^\]|]*)?(\|[^\]]*)?\]\](?:'{2,})?s?\s*$/.exec(value);
  // A heading of two links, the person then their party ("[[Nathalie Arthaud]] [[Lutte Ouvrière|(LO)]]"), is the
  // person: the party in brackets would set them apart from the same person in the next table
  const links = [...value.matchAll(/\[\[([^\]|#]+)/g)].map(m => m[1].replace(/_/g, ' ').trim()).filter(t => !/^(File|Image|Category):/i.test(t));
  let text = plain(value);
  if (links.length > 1 && /\[\[[^\]]*\|\s*\([^)\]]{1,8}\)\s*\]\]\s*$/.test(value)) text = text.replace(/\s*\([^)]*\)$/, '');
  return {
    text,
    colspan: span(/colspan\s*=\s*"?(\d+)/i),
    rowspan: span(/rowspan\s*=\s*"?(\d+)/i),
    party: /@@pc:([^@]*)@@/.exec(raw)?.[1].trim() || null,
    name: link?.[2] ? link[1].replace(/\s*\([^)]*\)\s*$/, '').trim() : null,
    page: links[0] ?? null,                                          // the article it links to (the first), as titled
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
const signed = s => { const n = number(s); return n != null && /[−–-]\s*\d/.test(String(s)) ? -n : n; };
/** A margin of error: "±3.1 pp" -> 3.1, and "3,0%" (a decimal comma) -> 3. */
const margin = s => number(String(s ?? '').replace(/(\d),(\d{1,2})(?!\d)/, '$1.$2'));

const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

// What a column holds, by its heading. Every other column with a heading is an answer.
const ROLES = [
  ['firm', /polling firm|pollster|polling organi[sz]ation|^organi[sz]ation$|conducted by|poll source|^aggregator$|^firm$/i],
  ['date', /\bdates?\b|^updated$/i],
  ['link', /^(link|sources?|refs?\.?|references?)$/i],
  ['moe', /margin|^moe$/i],
  ['sample', /^sample/i],
  ['method', /method|^(polling )?type$|^interview mode$/i],
  ['lead', /^lead\b|^net\b/i],
  ['skip', /^(client|notes?|remarks?|area|abs\.?|abstention)$/i],
  ['variant', /^hypothetical|^(riding|constituency|district|language|position|region)$/i],
];

/** A sample size: "2,004", or "2.004" where a dot groups the thousands. */
const sampleSize = s => number(String(s ?? '').replace(/(\d)\.(\d{3})(?!\d)/g, '$1$2'));
const numeric = s => /^[−-]?\d[\d,.]*\s*%?$/.test(String(s ?? '').trim());

/**
 * A poll table as { options: ['LPC', …], names: { LPC: 'Liberal Party of Canada' }, partyOf: { LPC: 'Liberal' },
 * variantLabel, polls: [{ firm, date, values: { LPC: 44, … }, moe, sample, method, lead, url, variant?,
 * election? }], events: [{ date, text }] }, newest first; null if it isn't one. `options` are the answers (parties,
 * leaders, Yes / No) in the table's order; `partyOf` is the party whose colour the table gives an answer, and
 * `pages` the Wikipedia article its heading links to ({ Lab: 'Labour Party (UK)' }).
 *
 * `variant` is what a row's numbers are about when the table holds several things side by side: the row's value
 * in a column that splits the table (a riding, a hypothetical leader), or the group heading above the answers
 * when they come in groups (each leader's Positive / Negative / Net; Primary vote and Two-party preferred), one
 * poll per group. `variantLabel` names it ('Group' for column groups). A heading over some of a group's answers
 * (L/NP over Lib and Nat) is an answer too: a firm that gives one number across them gives it, and a firm that
 * splits them gives the sum. In a group named by `matchups` (a pattern), a row answering only some of the
 * group's answers (Labor v One Nation) is a matchup of its own: each row is named after the answers it gives.
 *
 * Rows that aren't a poll (sub-headers, notes) are skipped; a row with a date and a sentence across the columns
 * is an event (a by-election, a new leader); the election's own row is kept, marked, as the starting point.
 * `refs` (refsOf) finds the source of a row that names a reference defined elsewhere; `year` completes dates
 * written without one ("September 24–28" in a table under "September 2026"); a number over `max` (100 for a
 * percentage) isn't an answer.
 */
function parsePollTable(table, { refs, year, matchups, max = 100 } = {}) {
  const rows = tableRows(table, refs);
  // The heading is the header rows at the top, less a title across the whole table ("Opinion polls")
  const hi = rows.findIndex(r => r.header);
  if (hi < 0) return null;
  let depth = 1;
  while (rows[hi + depth]?.header) depth++;
  const width = Math.max(...rows.map(r => r.cols.length));
  const title = new Set(rows.slice(hi, hi + depth).flatMap(r => r.cells.filter(c => c.colspan >= width - 1)));
  const head = rows.slice(hi, hi + depth).map(r => ({ ...r, cols: r.cols.map(c => (title.has(c) ? undefined : c)) }));
  if (new Set(head.flatMap(r => r.cols).filter(Boolean)).size < 4) return null;
  const data = rows.slice(hi + depth).filter(r => !r.header);

  // A column's heading is the lowest cell with text ("Yes" under "Should Quebec be…?"); its group, the highest
  // cell with text that spans it and others; its party colour, whichever of its cells wears one (the swatch row
  // under the party's name).
  const columns = [];
  for (let c = 0; c < width; c++) {
    const cells = [...new Set(head.map(r => r.cols[c]).filter(Boolean))];
    const labelled = cells.findLast(x => x.text);
    if (!labelled || (c && cells.every(x => head.some(r => r.cols[c - 1] === x)))) continue;   // no heading, or a wide heading's second column
    const spanning = cells.filter(x => x !== labelled && x.text && x.colspan > 1);
    let kind = ROLES.find(([, re]) => re.test(labelled.text))?.[0];
    // "Ref" is a reference column on one page and Reform UK on another: a column of numbers is an answer
    if (kind === 'link') {
      const filled = data.map(r => r.cols[c]?.text).filter(Boolean);
      if (filled.length && filled.filter(numeric).length > filled.length / 2) kind = undefined;
    }
    if (kind === 'skip') continue;
    columns.push({ c, label: labelled.text, kind, labelled, cells, group: spanning[0] ?? null, sub: spanning.length > 1 ? spanning.at(-1) : null });
  }
  const role = {};
  for (const col of columns) if (col.kind && (col.kind !== 'lead' || !col.group)) role[col.kind] ??= col;
  const answers = columns.filter(col => !col.kind);
  if (!role.firm || !role.date) return null;

  // Groups: answers under two or more headings are read group by group. A heading over every answer is the
  // question, not a group; one over only some of them (Konfederacja over its two parties) is an answer of its own.
  const grouped = new Set(answers.map(a => a.group).filter(Boolean)).size > 1;
  if (!grouped) for (const col of answers) if (col.group && answers.some(a => a.group !== col.group)) col.sub ??= col.group;
  const groups = new Map();                                            // group cell -> { name, answers, lead, subs }
  for (const col of answers) {
    const key = grouped ? col.group : null;
    if (!groups.has(key)) groups.set(key, { name: grouped ? col.group?.text ?? '' : null, answers: [], subs: new Map() });
    const g = groups.get(key);
    if (g.answers.some(a => a.label === col.label)) continue;
    g.answers.push(col);
    if (col.sub) { if (!g.subs.has(col.sub)) g.subs.set(col.sub, []); g.subs.get(col.sub).push(col); }
  }
  // The cell a row gives across exactly these answers, if any: one also over others is a wider joint list
  const whole = (r, parts) => {
    const cell = r.cols[parts[0].c];
    return cell && parts.every(p => r.cols[p.c] === cell) && answers.every(a => parts.includes(a) || r.cols[a.c] !== cell) ? cell : null;
  };
  // A heading over some answers is an answer itself only where a poll gives one number across all of them (L/NP
  // over Lib and Nat); otherwise it's a question over those answers ("In 2023" over Yes and No, not D/K)
  for (const g of groups.values()) for (const [sub, parts] of g.subs) {
    if (!data.some(r => whole(r, parts))) g.subs.delete(sub);
  }
  if (grouped) for (const col of columns) if (col.kind === 'lead' && col.group && groups.has(col.group)) groups.get(col.group).lead = col;

  const options = [], names = {}, partyOf = {}, pages = {};
  const addOption = (label, cell, cells) => {
    if (options.includes(label)) return;
    options.push(label);
    if (cell?.name && cell.name !== label && !/^List of /i.test(cell.name)) names[label] = cell.name;
    if (cell?.page && !/^(List of |Category:|File:|Image:)/i.test(cell.page)) pages[label] = cell.page;
    const party = cells.find(x => x.party && x.colspan === (cell?.colspan ?? 1))?.party;   // a colour across a group is the group's
    if (party) partyOf[label] = party;
  };
  for (const g of groups.values()) {
    for (const col of g.answers) addOption(col.label, col.labelled, col.cells);
    for (const [sub] of g.subs) addOption(sub.text, sub, head.map(r => r.cols[r.cols.indexOf(sub)]).filter(Boolean));
  }
  if (options.length < 2) return null;

  const polls = [], events = [];
  const text = (r, kind) => (role[kind] ? r.cols[role[kind].c]?.text ?? '' : '');
  const dateOf = s => parseDate(s) ?? (year && /[A-Za-z]{3}/.test(s ?? '') ? parseDate(`${s} ${year}`) : null);
  const answerCount = answers.length;
  for (const r of data) {
    const wide = r.cells.filter(c => c.colspan >= Math.max(3, Math.min(answerCount, 6)) && /[A-Za-z]{4}/.test(c.text) && !numeric(c.text)).sort((a, b) => b.colspan - a.colspan)[0];
    if (wide) {
      const date = r.cells.filter(c => c !== wide).map(c => dateOf(c.text)).find(Boolean) ?? dateOf(wide.text);
      if (date) events.push({ date, text: wide.text });
      continue;
    }
    let firm = text(r, 'firm');
    if (!firm || /^(html|pdf|link|source|\[?\d+\]?)$/i.test(firm)) firm = hostOf(r.url);   // a firm given only as a link to its release
    const date = dateOf(text(r, 'date')) ?? parseDate(r.cols[role.date.c]?.sort);
    if (!date || !firm) continue;
    const base = {
      firm, date,
      moe: role.moe ? margin(text(r, 'moe')) : null,
      sample: role.sample ? sampleSize(text(r, 'sample')) : null,
      method: text(r, 'method') || null,
      url: r.url,
    };
    for (const g of groups.values()) {
      const values = {}, used = new Set();
      for (const [sub, parts] of g.subs) {                               // one number across the parts is the whole
        const cell = whole(r, parts);
        if (cell) { const v = number(cell.text); if (v != null && v <= max) values[sub.text] = v; used.add(cell); }
      }
      for (const col of g.answers) {
        const cell = r.cols[col.c];
        if (!cell || used.has(cell)) continue;
        used.add(cell);
        const v = number(cell.text);
        if (v == null || v > max) continue;
        // A number across several answers (a joint list) is theirs together
        const across = g.answers.filter(a => r.cols[a.c] === cell);
        const label = across.length > 1 ? across.map(a => a.label).join(' + ') : col.label;
        if (across.length > 1 && !options.includes(label)) options.push(label);
        values[label] = v;
      }
      for (const [sub, parts] of g.subs) {                               // the parts given apart add up to the whole
        if (sub.text in values) continue;
        const vs = parts.map(p => values[p.label]);
        if (vs.every(v => v != null)) values[sub.text] = Math.round(vs.reduce((a, b) => a + b, 0) * 10) / 10;
      }
      if (Object.keys(values).length < 2) continue;
      const poll = { ...base, values, lead: g.lead ? signed(r.cols[g.lead.c]?.text) : role.lead ? signed(text(r, 'lead')) : null };
      if (grouped) {
        const all = [...g.answers.map(a => a.label), ...[...g.subs.keys()].map(s => s.text)];
        poll.variant = matchups?.test(g.name) ? `${g.name}: ${Object.keys(values).sort((a, b) => all.indexOf(a) - all.indexOf(b)).join(' v ')}` : g.name;
      } else if (role.variant && text(r, 'variant')) poll.variant = text(r, 'variant');
      if (/\b(election|referendum)\b/i.test(firm) && !/\b(study|survey|poll)/i.test(firm)) { poll.election = true; poll.moe = null; }   // the result itself
      polls.push(poll);
    }
  }
  const asked = options.filter(o => polls.some(p => o in p.values));   // a column no poll has a number in isn't an answer
  if (asked.length < 2) return null;
  polls.sort((a, b) => b.date.localeCompare(a.date));
  events.sort((a, b) => b.date.localeCompare(a.date));
  return { options: asked, names, partyOf, pages, variantLabel: grouped ? 'Group' : role.variant?.label ?? null, polls, events };
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
    if (at == null || cfg.skip?.test(t.path.slice(at + 1).join(' > '))) continue;
    const year = t.path.map(h => /\b(19|20)\d\d\b/.exec(h)?.[0]).filter(Boolean).at(-1);   // "September 24–28" under "2026 > September 2026"
    const parsed = parsePollTable(t.text, { refs: page.refs, year, matchups: cfg.matchups, max: cfg.unit === 'seats' ? 1000 : 100 });
    if (!parsed?.polls.length) continue;
    if (cfg.variant) {
      const below = t.path.slice(at + 1);
      const name = !below.length ? cfg.base ?? cfg.label : cfg.variantPath ? below.join(' · ') : below.at(-1);
      for (const x of [...parsed.polls, ...parsed.events]) x.variant = x.variant ? `${name} · ${x.variant}` : name;   // a table split by its own columns keeps its split
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
    id: cfg.id, group: cfg.group, label: cfg.label, kind: cfg.kind ?? 'question', unit: cfg.unit ?? '%', page: pageKey(cfg.page),
    title: page.title, url: wikiUrl(page.title, anchor), revid: page.revid, edited: page.edited,
    options,
    names: { ...Object.assign({}, ...parts.map(p => p.names).reverse()), ...cfg.names },
    partyOf: Object.assign({}, ...parts.map(p => p.partyOf).reverse()),
    pages: Object.assign({}, ...parts.map(p => p.pages).reverse()),
    variantLabel: variants.length ? cfg.variantLabel ?? cfg.variant ?? parts.find(p => p.variantLabel)?.variantLabel ?? 'Group' : null,
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
