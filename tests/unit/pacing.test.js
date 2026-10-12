'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pacer, freshnessMs, jitter, MAX_MS, CACHE_CAP_MS } = require('../../src/main/adapters/pacing');
const { RssAdapter } = require('../../src/main/adapters/rss');

const BASE = 5000;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

// Pacer

test('Pacer: a feed with something new stays on the interval', () => {
  const p = new Pacer();
  for (let i = 0; i < 20; i++) p.observe({ now: T0 + i * BASE, changed: true });
  assert.equal(p.delayMs(BASE, T0 + 20 * BASE), BASE);
});

test('Pacer: the first idle polls stay on the interval, then the wait grows, up to the ceiling', () => {
  const p = new Pacer();
  p.observe({ now: T0, changed: true });
  const waits = [];
  for (let i = 1; i <= 14; i++) { p.observe({ now: T0 + i * BASE, changed: false }); waits.push(p.delayMs(BASE, T0 + i * BASE)); }
  assert.deepEqual(waits.slice(0, 3), [BASE, 7500, 11250]);       // 1 idle: interval; then x1.5 each time
  assert.ok(waits.every((w, i) => i === 0 || w >= waits[i - 1]));  // never speeds up on its own
  assert.equal(Math.max(...waits), MAX_MS);                        // and stops at the ceiling
});

test('Pacer: something new puts a slowed feed straight back on the interval', () => {
  const p = new Pacer();
  for (let i = 0; i < 12; i++) p.observe({ now: T0 + i * BASE, changed: false });
  assert.ok(p.delayMs(BASE, T0 + 12 * BASE) > 15_000);
  p.observe({ now: T0 + 12 * BASE, changed: true });
  assert.equal(p.delayMs(BASE, T0 + 12 * BASE), BASE);
});

test('Pacer: the wait is limited by how often the feed usually publishes', () => {
  const p = new Pacer();
  for (let i = 0; i < 6; i++) p.observe({ now: T0 + i * 30_000, changed: true });       // a story every 30 s
  for (let i = 1; i <= 10; i++) p.observe({ now: T0 + 150_000 + i * BASE, changed: false });
  assert.equal(p.delayMs(BASE, T0 + 200_000), BASE);                                      // 30 s / 20 = 1.5 s: the interval

  const slow = new Pacer();
  for (let i = 0; i < 4; i++) slow.observe({ now: T0 + i * 600_000, changed: true });    // a story every 10 min
  for (let i = 1; i <= 12; i++) slow.observe({ now: T0 + 1_800_000 + i * BASE, changed: false });
  assert.equal(slow.delayMs(BASE, T0 + 1_900_000), MAX_MS);                               // 10 min / 20 = 30 s: the ceiling applies
});

test('Pacer: when enabled, the servers freshness hint is obeyed for quiet feeds, capped, and ignored for busy ones', () => {
  const CACHE = { cacheCapMs: 60_000 };
  const quiet = new Pacer(CACHE);
  quiet.observe({ now: T0, changed: true });
  for (let i = 1; i <= 2; i++) quiet.observe({ now: T0 + i * BASE, changed: false, freshMs: 600_000 });   // fresh for 10 min
  assert.equal(quiet.delayMs(BASE, T0 + 2 * BASE), 60_000);                         // obeyed, but only up to the cap

  const shortHint = new Pacer(CACHE);
  shortHint.observe({ now: T0, changed: true });
  for (let i = 1; i <= 2; i++) shortHint.observe({ now: T0 + i * BASE, changed: false, freshMs: 30_000 });
  assert.equal(shortHint.delayMs(BASE, T0 + 2 * BASE), 30_000);                           // a shorter hint is obeyed as given

  const busy = new Pacer(CACHE);
  for (let i = 0; i < 5; i++) busy.observe({ now: T0 + i * BASE, changed: true, freshMs: 300_000 });
  assert.equal(busy.delayMs(BASE, T0 + 5 * BASE), BASE);                                  // new stories every poll: the hint is not trusted
});

test('Pacer: a base interval above the ceiling is never shortened', () => {
  const p = new Pacer();
  for (let i = 0; i < 10; i++) p.observe({ now: T0 + i * 120_000, changed: false });
  assert.equal(p.delayMs(120_000, T0 + 1_200_000), 120_000);
});

// Headers

const H = obj => new Headers(obj);

test('freshnessMs: max-age less Age; Expires as the fallback; no-cache and nothing at all mean 0', () => {
  assert.equal(freshnessMs(H({ 'cache-control': 'public, max-age=300' })), 300_000);
  assert.equal(freshnessMs(H({ 'cache-control': 'max-age=300', age: '120' })), 180_000);
  assert.equal(freshnessMs(H({ 'cache-control': 'max-age=60', age: '600' })), 0);
  assert.equal(freshnessMs(H({ 'cache-control': 'max-age=300, no-cache' })), 0);
  assert.equal(freshnessMs(H({ 'cache-control': 'no-store' })), 0);
  assert.equal(freshnessMs(H({ 'cache-control': 's-maxage=300' })), 0);          // for shared caches, not for us
  assert.equal(freshnessMs(H({})), 0);
  assert.equal(freshnessMs(H({ 'cache-control': 'max-age=0' })), 0);
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  assert.equal(freshnessMs(H({ expires: new Date(now + 90_000).toUTCString(), date: new Date(now).toUTCString() }), now), 90_000);
  assert.equal(freshnessMs(H({ expires: '0' }), now), 0);
  assert.equal(freshnessMs(H({ expires: new Date(now - 1000).toUTCString() }), now), 0);
});

test('jitter stays within 10 percent', () => {
  assert.equal(jitter(10_000, () => 0), 9000);
  assert.equal(jitter(10_000, () => 1), 11_000);
});

// The adapter uses them

function adapter() {
  const ctx = { log: { info() {}, warn() {}, debug() {}, set() {}, onError() {} }, ingest: () => [], status() {}, intervalMs: () => BASE };
  return new RssAdapter({ id: 1, name: 'T', type: 'rss', config: { url: 'http://x/' } }, ctx);
}

test('RssAdapter slows down while its feed is quiet and is back on the interval when something new arrives', () => {
  const a = adapter();
  a.observePoll(true);
  assert.equal(a.nextDelayMs(), BASE);
  for (let i = 0; i < 10; i++) a.observePoll(false);
  assert.ok(a.nextDelayMs() > BASE * 3);
  assert.match(a.pacingLine(), /idle 10/);
  a.observePoll(true);
  assert.equal(a.nextDelayMs(), BASE);
});

test('RssAdapter takes the server freshness hint from the response', () => {
  const a = adapter();
  a.observePoll(true);
  a.freshMs = 600_000;
  a.observePoll(false);
  a.observePoll(false);
  assert.ok(a.nextDelayMs() >= CACHE_CAP_MS * 0.9);                  // capped, with jitter
});

test('Pacer: hints are ignored by default, and item dates seed the usual gap', () => {
  const p = new Pacer();
  p.observe({ now: T0, changed: true });
  for (let i = 1; i <= 2; i++) p.observe({ now: T0 + i * BASE, changed: false, freshMs: 600_000 });
  assert.ok(p.delayMs(BASE, T0 + 2 * BASE) < 20_000);
  const s = new Pacer();
  s.seed([T0, T0 + 60_000, T0 + 120_000]);
  assert.equal(s.meanGapMs, 60_000);
});
