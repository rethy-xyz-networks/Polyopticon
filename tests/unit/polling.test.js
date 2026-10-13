'use strict';

// Keeping the polling traffic down: back-off after repeated failures, Retry-After, and dropping
// feed bodies that haven't changed (for feeds that never answer 304).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { backoffMs, BACKOFF_CAP_MS } = require('../../src/main/adapters/base');
const { parseRetryAfter, SourceError } = require('../../src/main/adapters/util');
const { RssAdapter } = require('../../src/main/adapters/rss');

test('backoffMs: normal interval until the second failure in a row, then doubling up to the cap', () => {
  assert.equal(backoffMs(5000, 0), 5000);
  assert.equal(backoffMs(5000, 1), 5000);
  assert.equal(backoffMs(5000, 2), 10000);
  assert.equal(backoffMs(5000, 3), 20000);
  assert.equal(backoffMs(5000, 5), 80000);
  assert.equal(backoffMs(5000, 50), BACKOFF_CAP_MS);
  assert.equal(backoffMs(900_000, 4), 900_000);                  // an interval above the cap is never shortened
});

test('parseRetryAfter: seconds, HTTP dates, junk, and a one hour ceiling', () => {
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.equal(parseRetryAfter(new Date(now + 90_000).toUTCString(), now), 90_000);
  assert.equal(parseRetryAfter(new Date(now - 5_000).toUTCString(), now), 0);   // already past
  assert.equal(parseRetryAfter('soon'), 0);
  assert.equal(parseRetryAfter(null), 0);
  assert.equal(parseRetryAfter('999999'), 3600e3);
  assert.equal(new SourceError('LIMIT', 'x', { retryAfterMs: 7 }).retryAfterMs, 7);
});

// A feed that sends no validators

const rss = (...titles) => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${titles.map((t, i) => `
  <item><title>${t}</title><link>http://x/${t}</link><guid>${t}</guid><pubDate>Mon, 05 Oct 2026 09:3${i}:00 GMT</pubDate></item>`).join('')}</channel></rss>`;

function feedServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/feed` }));
  });
}

const ctx = { log: { info() {}, warn() {}, debug() {}, set() {}, onError() {} }, ingest: () => [], status() {}, intervalMs: () => 5000 };
const adapterFor = url => new RssAdapter({ id: 1, name: 'Test', type: 'rss', config: { url } }, ctx);

test('RssAdapter: an identical body is dropped before parsing; a changed one is read', async () => {
  let body = rss('one', 'two'), hits = 0;
  const { server, url } = await feedServer((req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'application/rss+xml' }); res.end(body); });
  try {
    const a = adapterFor(url);
    const first = await a.fetchItems();
    assert.deepEqual(first.map(i => i.title), ['one', 'two']);
    assert.equal(await a.fetchItems(), null);                     // same bytes -> "not modified", nothing to ingest
    assert.equal(a.net.sameBody, 1);

    body = rss('three', 'one', 'two');
    const changed = await a.fetchItems();
    assert.deepEqual(changed.map(i => i.title), ['three', 'one', 'two']);
    assert.equal(await a.fetchItems(), null);
    assert.deepEqual({ polls: a.net.polls, full: a.net.full, sameBody: a.net.sameBody }, { polls: 4, full: 2, sameBody: 2 });
    assert.equal(hits, 4);
  } finally { server.close(); }
});

test('RssAdapter: a feed that answers 304 is counted and skipped; 429 carries Retry-After', async () => {
  let mode = 'ok';
  const { server, url } = await feedServer((req, res) => {
    if (mode === 'limit') { res.writeHead(429, { 'Retry-After': '90' }); return res.end('slow down'); }
    if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304); return res.end(); }
    res.writeHead(200, { ETag: '"v1"' });
    res.end(rss('only'));
  });
  try {
    const a = adapterFor(url);
    assert.equal((await a.fetchItems()).length, 1);
    assert.equal(await a.fetchItems(), null);
    assert.equal(a.net.notModified, 1);
    mode = 'limit';
    await assert.rejects(a.fetchItems(), e => e.label === 'LIMIT' && e.retryAfterMs === 90_000);
  } finally { server.close(); }
});

test('RssAdapter: a body that fails to parse is not remembered, so it is tried again', async () => {
  let body = '<html><body>captcha</body></html>';
  const { server, url } = await feedServer((req, res) => { res.writeHead(200); res.end(body); });
  try {
    const a = adapterFor(url);
    await assert.rejects(a.fetchItems(), e => e.label === 'BLOCKED');
    await assert.rejects(a.fetchItems(), e => e.label === 'BLOCKED');         // still an error, not a silent "same body"
    body = rss('fine');
    assert.equal((await a.fetchItems())[0].title, 'fine');
  } finally { server.close(); }
});
