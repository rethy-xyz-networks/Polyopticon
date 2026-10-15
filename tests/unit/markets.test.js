'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuote, normaliseState, cleanSymbol, createClient, createPoller, BACKOFF_MS } = require('../../src/main/markets');

const raw = (symbol, price, extra = {}) => ({ symbol, shortName: symbol + ' name', regularMarketPrice: price, regularMarketChange: 1, regularMarketChangePercent: 0.5, marketState: 'REGULAR', priceHint: 2, regularMarketTime: 1_700_000_000, ...extra });

/** A fake Yahoo: cookie page, crumb, quotes. `quoteStatus` is the list of statuses to answer quotes with, in turn. */
function fakeYahoo({ quoteStatus = [], quotes = [raw('^GSPC', 5000)] } = {}) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, cookie: opts.headers?.Cookie });
    if (url.includes('fc.yahoo.com')) return { ok: false, status: 404, headers: { getSetCookie: () => ['A3=abc; Domain=.yahoo.com; Path=/', 'B=x; Path=/'], get: () => null } };
    if (url.includes('getcrumb')) return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'CRUMB1' };
    const status = quoteStatus.shift() ?? 200;
    return { ok: status === 200, status, headers: { get: h => (h === 'retry-after' && status === 429 ? '7' : null) }, json: async () => ({ quoteResponse: { result: quotes } }) };
  };
  return { fetchFn, calls };
}

test('parseQuote keeps the fields the tiles show and drops unpriced quotes', () => {
  const q = parseQuote(raw('BTC-USD', 81000.01));
  assert.deepEqual(q, { symbol: 'BTC-USD', name: 'BTC-USD name', price: 81000.01, change: 1, pct: 0.5, state: 'open', decimals: 2, currency: null, time: 1_700_000_000_000 });
  assert.equal(parseQuote({ symbol: 'X' }), null);
  assert.equal(parseQuote(null), null);
});

test('market states collapse to open / pre / closed', () => {
  assert.deepEqual(['REGULAR', 'PRE', 'PREPRE', 'POST', 'POSTPOST', 'CLOSED', undefined].map(normaliseState),
    ['open', 'pre', 'closed', 'closed', 'closed', 'closed', 'closed']);
});

test('cleanSymbol accepts Yahoo symbols and rejects anything else', () => {
  for (const [input, want] of [['btc-usd', 'BTC-USD'], [' ^gspc ', '^GSPC'], ['CL=F', 'CL=F'], ['000001.SS', '000001.SS'], ['DX-Y.NYB', 'DX-Y.NYB']])
    assert.equal(cleanSymbol(input), want);
  for (const bad of ['', '  ', 'a b', 'x&crumb=1', 'a,b', '-x', '../x', 'A'.repeat(30), null]) assert.equal(cleanSymbol(bad), null, String(bad));
});

test('the client logs in once, sends cookie and crumb, and batches symbols in one request', async () => {
  const { fetchFn, calls } = fakeYahoo({ quotes: [raw('^GSPC', 5000), raw('BTC-USD', 81000), { symbol: 'NOPE' }] });
  const client = createClient(fetchFn);
  const a = await client.quotes(['^GSPC', 'BTC-USD', 'NOPE']);
  assert.deepEqual([...a.keys()], ['^GSPC', 'BTC-USD']);                       // the unpriced one is missing
  await client.quotes(['^GSPC']);
  const quoteCalls = calls.filter(c => c.url.includes('/v7/'));
  assert.equal(quoteCalls.length, 2);
  assert.equal(calls.filter(c => c.url.includes('getcrumb')).length, 1);       // logged in once
  assert.match(quoteCalls[0].url, /symbols=%5EGSPC,BTC-USD,NOPE&crumb=CRUMB1/);
  assert.equal(quoteCalls[0].cookie, 'A3=abc; B=x');
});

test('a 401 gets a fresh crumb and one retry; a 429 rejects with its status and Retry-After', async () => {
  const { fetchFn, calls } = fakeYahoo({ quoteStatus: [401, 200, 429] });
  const client = createClient(fetchFn);
  assert.equal((await client.quotes(['^GSPC'])).size, 1);
  assert.equal(calls.filter(c => c.url.includes('getcrumb')).length, 2);
  await assert.rejects(client.quotes(['^GSPC']), e => e.status === 429 && e.retryAfter === 7);
});

test('the poller delivers quotes, backs off on failure (at least Retry-After), recovers, and stops', async () => {
  const waits = [], got = [], states = [];
  let n = 0;
  const client = { quotes: async () => {
    n++;
    if (n === 1) throw Object.assign(new Error('quote: HTTP 429'), { status: 429, retryAfter: 40 });
    if (n === 2) throw new Error('offline');
    return new Map([['^GSPC', parseQuote(raw('^GSPC', 5000))]]);
  } };
  let poller;
  const wait = async ms => { waits.push(ms); if (got.length >= 2) poller.stop(); };
  poller = createPoller({ client, wait, onQuotes: q => got.push(q), onStatus: s => states.push(s.state), intervalMs: 1000 });
  poller.start(['^gspc', '^GSPC', 'bad symbol']);
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(waits.slice(0, 2), [40_000, BACKOFF_MS[1]]);                // Retry-After wins over 5 s; then 10 s
  assert.ok(waits[2] > 900 && waits[2] <= 1000);                               // then the normal pace, less the request's own time
  assert.deepEqual(states.slice(0, 3), ['limited', 'error', 'ok']);
  assert.equal(got[0].quotes[0].symbol, '^GSPC');
  assert.equal(poller.running, false);
  const calls = n;
  await new Promise(r => setTimeout(r, 20));
  assert.equal(n, calls);                                                      // no polling after stop
});
