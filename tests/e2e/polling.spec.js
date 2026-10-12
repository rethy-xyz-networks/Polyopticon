'use strict';

// Adaptive polling: a feed that has nothing new is asked less and less often (never past 20 seconds),
// and something new puts it straight back on the refresh interval.
// A local feed counts the requests; it sends no validators, so every poll is a full download.

const http = require('http');
const { test, expect } = require('./fixtures');

let server, base, hits, items;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url !== '/feed') { res.writeHead(404); return res.end(); }
    hits.push(Date.now());
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Quiet</title>${items.map(t => `
      <item><title>${t}</title><link>${base}/a/${t}</link><guid>${t}</guid><pubDate>${new Date().toUTCString()}</pubDate></item>`).join('')}
    </channel></rss>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => server?.close());
test.beforeEach(() => { hits = []; items = ['First story']; });

const addFeed = (window, url) => window.evaluate(u => window.polyopticon.saveSource({
  type: 'rss', name: 'Quiet Feed', grp: 'Test', category: 'T', color: '#555555', enabled: true, config: { url: u },
}), url);

test('a quiet feed is polled less and less, and a new story brings it back to the interval', async ({ window }) => {
  test.setTimeout(120_000);
  const saved = await addFeed(window, `${base}/feed`);
  expect(saved.ok, saved.error).toBe(true);
  await expect.poll(() => hits.length, { timeout: 30_000 }).toBeGreaterThan(0);

  // At the 5 s interval a fixed scheme would ask 9-10 times in 45 s; adaptive waits 5, 5, 7.5, 11, 17 s...
  await window.waitForTimeout(45_000);
  expect(hits.length).toBeGreaterThanOrEqual(3);
  expect(hits.length).toBeLessThanOrEqual(7);
  const gaps = hits.slice(1).map((t, i) => t - hits[i]);
  expect(gaps.at(-1)).toBeGreaterThan(gaps[0]);                       // later gaps are longer than the first

  // Something new: the next poll still comes when it was due, and the one after that is back at the interval.
  items = ['Second story', 'First story'];
  await expect(window.locator('#feed-list .item', { hasText: 'Second story' })).toBeVisible({ timeout: 45_000 });
  const after = hits.length;
  await expect.poll(() => hits.length - after, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  const last = hits.slice(-2);
  expect(last[1] - last[0]).toBeLessThan(8000);
});
