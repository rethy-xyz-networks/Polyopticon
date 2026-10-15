'use strict';

// Live quotes for the Global Markets view, from Yahoo Finance's unofficial quote endpoint.
//
// One batch request returns every symbol (price, change since the previous close, market state), so
// polling stays at one request per tick however many tiles there are. Measured with 27 symbols: one
// request per second for five minutes, and two per second for a minute, went through with no 429.
// There is no documented limit, so on a 429 (or any failure) the poller backs off and says so.
//
// The endpoint wants a session cookie (from fc.yahoo.com) and a crumb (from /v1/test/getcrumb) sent
// with every request. Both are fetched lazily and again after a 401.

const HOST   = 'https://query1.finance.yahoo.com';
const COOKIE = 'https://fc.yahoo.com';
const UA     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BACKOFF_MS = [5_000, 10_000, 30_000, 60_000];
const MAX_SYMBOLS = 100;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A Yahoo quote object -> the fields the tiles show. Null when it has no price. */
function parseQuote(q) {
  if (!q || typeof q.symbol !== 'string' || typeof q.regularMarketPrice !== 'number') return null;
  return {
    symbol: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    price: q.regularMarketPrice,
    change: typeof q.regularMarketChange === 'number' ? q.regularMarketChange : null,
    pct: typeof q.regularMarketChangePercent === 'number' ? q.regularMarketChangePercent : null,
    state: normaliseState(q.marketState),
    decimals: Number.isInteger(q.priceHint) ? q.priceHint : null,
    currency: q.currency || null,
    time: typeof q.regularMarketTime === 'number' ? q.regularMarketTime * 1000 : null,
  };
}

/** Yahoo's PRE, PREPRE, REGULAR, POST, POSTPOST, CLOSED -> open | pre | closed. */
function normaliseState(s) {
  if (s === 'REGULAR') return 'open';
  if (s === 'PRE') return 'pre';
  return 'closed';
}

/** "name=value" pairs of a response's Set-Cookie headers, joined for a Cookie header. */
function cookiesOf(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return list.map(c => c.split(';')[0]).filter(Boolean).join('; ');
}

/**
 * Fetches quotes. `fetchFn` is fetch (injected for tests). One instance keeps the cookie and crumb.
 * quotes(symbols) resolves to a Map symbol -> parsed quote (symbols Yahoo doesn't know are missing)
 * and rejects with an Error whose `.status` is the HTTP status, when there was one.
 */
function createClient(fetchFn = fetch, { timeoutMs = 10_000 } = {}) {
  let cookie = '', crumb = '';

  const get = async (url, headers = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try { return await fetchFn(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: '*/*', ...headers } }); }
    finally { clearTimeout(timer); }
  };

  async function login() {
    cookie = ''; crumb = '';
    const first = await get(COOKIE);                         // answers 404, but sets the cookie
    cookie = cookiesOf(first);
    const res = await get(`${HOST}/v1/test/getcrumb`, { Cookie: cookie });
    if (!res.ok) throw Object.assign(new Error(`crumb: HTTP ${res.status}`), { status: res.status });
    crumb = (await res.text()).trim();
    if (!crumb || crumb.length > 40 || /[<\s]/.test(crumb)) { crumb = ''; throw new Error('crumb: unexpected answer'); }
  }

  async function quotes(symbols, retried = false) {
    if (!symbols.length) return new Map();
    if (!crumb) await login();
    const url = `${HOST}/v7/finance/quote?symbols=${symbols.map(encodeURIComponent).join(',')}&crumb=${encodeURIComponent(crumb)}`;
    const res = await get(url, { Cookie: cookie });
    if (res.status === 401 && !retried) { crumb = ''; return quotes(symbols, true); }
    if (!res.ok) throw Object.assign(new Error(`quote: HTTP ${res.status}`), { status: res.status, retryAfter: Number(res.headers.get('retry-after')) || 0 });
    const body = await res.json();
    const out = new Map();
    for (const raw of body?.quoteResponse?.result ?? []) {
      const q = parseQuote(raw);
      if (q) out.set(q.symbol, q);
    }
    return out;
  }

  return { quotes };
}

/** A symbol as typed: letters, digits and . - = ^ _ only, upper-cased. Null when it can't be one. */
function cleanSymbol(s) {
  const t = String(s ?? '').trim().toUpperCase();
  return /^[\^A-Z0-9][A-Z0-9.\-=^_]{0,19}$/.test(t) ? t : null;
}

/**
 * The poller. start(symbols) polls every `intervalMs` until stop(); a request that fails delays the
 * next one by BACKOFF_MS (longer each time in a row). Requests never overlap.
 * Calls onQuotes({ quotes: [..], at }) with each answer and onStatus({ state, retryIn?, error? }) when
 * the state ('ok' | 'limited' | 'error') changes.
 */
function createPoller({ client, onQuotes, onStatus, log = { info() {}, warn() {} }, intervalMs = 1000, wait = sleep }) {
  let symbols = [], running = false, run = 0, status = null;

  const setStatus = s => {
    if (status && status.state === s.state && s.state === 'ok') return;
    status = s;
    onStatus?.(s);
  };

  async function loop(id) {
    let failures = 0;
    while (running && id === run) {
      const began = Date.now();
      let delay = intervalMs;
      try {
        const map = await client.quotes(symbols);
        if (id !== run) return;
        failures = 0;
        setStatus({ state: 'ok' });
        onQuotes?.({ quotes: [...map.values()], at: Date.now() });
      } catch (e) {
        if (id !== run) return;
        delay = Math.max(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)], (e.retryAfter || 0) * 1000);
        failures++;
        if (failures === 1) log.warn(`Markets: ${e.message}; backing off`);
        setStatus({ state: e.status === 429 ? 'limited' : 'error', retryIn: Math.round(delay / 1000), error: e.message });
      }
      await wait(Math.max(0, delay - (Date.now() - began)));
    }
  }

  return {
    start(list) {
      symbols = [...new Set(list.map(cleanSymbol).filter(Boolean))].slice(0, MAX_SYMBOLS);
      if (running) return;
      running = true; status = null;
      loop(++run);
    },
    setSymbols(list) { symbols = [...new Set(list.map(cleanSymbol).filter(Boolean))].slice(0, MAX_SYMBOLS); },
    stop() { running = false; run++; },
    get running() { return running; },
  };
}

module.exports = { parseQuote, normaliseState, cleanSymbol, createClient, createPoller, BACKOFF_MS };
