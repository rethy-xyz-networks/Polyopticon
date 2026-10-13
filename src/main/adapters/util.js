'use strict';

// Shared helpers for source adapters: text cleanup, date parsing, HTTP.

const USER_AGENT  = 'Mozilla/5.0 (compatible; Polyopticon/2.0; news monitor)';
const BROWSER_UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const TIMEOUT_MS  = 15000;

// Errors

/** An error with a short label for the sidebar status (e.g. "HTTP 403", "NO KEY"). */
class SourceError extends Error {
  /** @param extra.retryAfterMs  how long the server asked us to wait before trying again (Retry-After) */
  constructor(label, message, { retryAfterMs = 0 } = {}) {
    super(message || label);
    this.name = 'SourceError';
    this.label = label;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A Retry-After header (seconds, or an HTTP date) -> ms to wait; 0 if absent or unreadable. Capped at an hour. */
function parseRetryAfter(value, now = Date.now()) {
  const v = String(value ?? '').trim();
  if (!v) return 0;
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - now;
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, 3600e3)) : 0;
}

// HTTP

/** Moves a login in the URL (https://user:pass@host/…) into an Authorization header — fetch refuses such URLs. */
function splitCredentials(url, headers) {
  const u = new URL(url);
  if (!u.username && !u.password) return [url, headers];
  const login = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
  u.username = u.password = '';
  return [u.href, { Authorization: `Basic ${Buffer.from(login).toString('base64')}`, ...headers }];
}

async function request(url, { signal, headers = {}, method = 'GET', body, timeout = TIMEOUT_MS, browser = false } = {}) {
  const sig = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeout)]);
  [url, headers] = splitCredentials(url, headers);
  const resp = await fetch(url, {
    method, body, signal: sig, redirect: 'follow',
    headers: { 'User-Agent': browser ? BROWSER_UA : USER_AGENT, ...headers },
  });
  return resp;
}

async function getJson(url, opts) {
  const resp = await request(url, { ...opts, headers: { Accept: 'application/json', ...opts?.headers } });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!resp.ok) {
    const msg = json?.message || json?.error || text.slice(0, 200);
    throw new SourceError(resp.status === 401 || resp.status === 403 ? 'AUTH' : resp.status === 429 ? 'LIMIT' : `HTTP ${resp.status}`,
      `HTTP ${resp.status}: ${msg}`, { retryAfterMs: parseRetryAfter(resp.headers.get('retry-after')) });
  }
  if (json === null) throw new SourceError('PARSE', `Expected JSON, got: ${text.slice(0, 120)}`);
  return json;
}

// Text

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', hellip: '…',
  bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', deg: '°', euro: '€', pound: '£',
  yen: '¥', cent: '¢', sect: '§', para: '¶', laquo: '«', raquo: '»', times: '×', divide: '÷',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', aacute: 'á', agrave: 'à', acirc: 'â',
  auml: 'ä', atilde: 'ã', aring: 'å', iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
  oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö', otilde: 'õ', oslash: 'ø', uacute: 'ú',
  ugrave: 'ù', ucirc: 'û', uuml: 'ü', ntilde: 'ñ', ccedil: 'ç', szlig: 'ß', Eacute: 'É',
  Aacute: 'Á', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Ccedil: 'Ç', Ouml: 'Ö', Uuml: 'Ü', Auml: 'Ä',
  zwj: '‍', zwnj: '‌', shy: '­', thinsp: ' ', ensp: ' ', emsp: ' ',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return NAMED_ENTITIES[e] ?? m;
  });
}

/** Value -> string, unwrapping fast-xml-parser text nodes and arrays. */
function text(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return text(v['#text']);
  return String(v);
}

function cleanText(s) {
  const t = decodeEntities(text(s)).replace(/\s+/g, ' ').trim();
  return t || null;
}

/** HTML -> plain text. Keeps line breaks for <br>/<p> when keepLines is set. */
function cleanHtml(s, { keepLines = false } = {}) {
  let html = text(s);
  if (!html.trim()) return null;
  if (keepLines) html = html.replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n');
  let plain = decodeEntities(html.replace(/<[^>]+>/g, keepLines ? '' : ' '));
  plain = keepLines
    ? plain.split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
    : plain.replace(/\s{2,}/g, ' ').trim();
  return plain || null;
}

const trunc = (s, max) => (!s ? '' : s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…');

/** First meaningful line of a post/message, used as its title. */
function headline(body, max = 160) {
  const line = (body || '').split('\n').map(l => l.trim()).find(l => l.length > 0) || '';
  return trunc(line, max);
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(36)}`;
}

// Dates

// Named timezone abbreviations V8's Date.parse doesn't know about.
const NAMED_ZONES = {
  GMT: '+0000', UTC: '+0000', UT: '+0000', Z: '+0000',
  EST: '-0500', EDT: '-0400', CST: '-0600', CDT: '-0500',
  MST: '-0700', MDT: '-0600', PST: '-0800', PDT: '-0700',
  AST: '-0400', ADT: '-0300', NST: '-0330', NDT: '-0230',
  BST: '+0100', IST: '+0100', CET: '+0100', CEST: '+0200',
  EET: '+0200', EEST: '+0300', MSK: '+0300', GST: '+0400', PKT: '+0500',
  ICT: '+0700', JST: '+0900', KST: '+0900',
  AEST: '+1000', AEDT: '+1100', NZST: '+1200', NZDT: '+1300',
};

/** Returns epoch ms (UTC) or null if no real date could be determined. */
function parseDate(raw) {
  let s = text(raw).trim();
  if (!s) return null;
  s = s.replace(/\s*\([^)]*\)\s*$/, '').trim();
  s = s.replace(/\b([A-Z]{1,5})$/, (m, z) => NAMED_ZONES[z.toUpperCase()] ?? m);

  // No zone at all -> assume UTC (Date.parse would otherwise assume local time).
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += 'Z';
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  else if (/^\d{14}$/.test(s)) s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`;
  else if (/^\d{8}T\d{6}Z$/.test(s)) s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 11)}:${s.slice(11, 13)}:${s.slice(13)}`;
  else if (/\d{1,2}:\d{2}(:\d{2})?$/.test(s) && /[A-Za-z]{3}/.test(s)) s += ' +0000';

  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

// Feeds with clock or time-zone mistakes (e.g. Taipei Times, ~1h ahead) would otherwise
// pin their stories to the top of the list: never date a story later than its arrival.
const sanePublished = ms => Math.min(ms, Date.now());

module.exports = {
  USER_AGENT, BROWSER_UA, SourceError, parseRetryAfter, request, getJson, splitCredentials,
  decodeEntities, text, cleanText, cleanHtml, trunc, headline, hash, parseDate, sanePublished,
};
