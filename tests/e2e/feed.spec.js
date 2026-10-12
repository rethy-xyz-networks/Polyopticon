'use strict';

// The live story list with thousands of stories, and the performance log.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

test.use({ settings: { MaxFeedItems: 5000, GroupStories: false } });

/** Adds n synthetic stories to the live list. */
const addStories = (window, n) => window.evaluate(async n => {
  const feed = await import('./feed.js');
  const { state } = await import('./state.js');
  const s = state.sources[0];
  feed.ingest(Array.from({ length: n }, (_, i) => ({
    id: 8e8 + i, sourceId: s.id, sourceName: s.name, kind: 'article', title: `Synthetic story ${i}`,
    summary: 'A description long enough to take a couple of lines in the story list.',
    url: `https://example.com/synthetic/${i}`, publishedAt: Date.now() - i * 1000, places: [],
  })), { fresh: false });
}, n);

test('only the first rows are in the page; more are added while scrolling, and the top resets it', async ({ window }) => {
  // Sources hidden in a fresh profile would filter the synthetic stories out: show the first source only.
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await addStories(window, 2000);
  const rows = window.locator('#feed-list .item');
  await expect(rows.first()).toBeVisible();
  const first = await rows.count();
  expect(first).toBeLessThanOrEqual(400);                             // not all 2000+ stories

  const list = window.locator('#feed-list');
  for (let i = 0; i < 40 && await rows.count() <= first; i++) {
    await list.evaluate(l => { l.scrollTop = l.scrollHeight; });
    await window.waitForTimeout(100);
  }
  expect(await rows.count()).toBeGreaterThan(first);                  // scrolling added more

  await list.evaluate(l => { l.scrollTop = 0; });
  await window.waitForTimeout(100);
  await addStories(window, 1);                                         // any update at the top shrinks it again
  await window.evaluate(() => import('./feed.js').then(f => f.scheduleRender()));
  await expect.poll(() => rows.count()).toBeLessThanOrEqual(400);
});

test('a window freeze is written to the session log', async ({ window, dataDir }) => {
  // A real task in the page (Playwright's own evaluate calls aren't timed as frames).
  await window.evaluate(() => setTimeout(function busyLoop() { const end = performance.now() + 450; while (performance.now() < end); }, 0));
  const logs = path.join(dataDir, 'logs');
  const sessionLog = () => fs.readdirSync(logs).filter(f => f.startsWith('session_')).map(f => fs.readFileSync(path.join(logs, f), 'utf8')).join('');
  await expect.poll(sessionLog, { timeout: 10_000 }).toMatch(/Perf: window froze for (4[0-9]{2}|[5-9][0-9]{2}) ms — script .* via TimerHandler:setTimeout took 4[0-9]{2} ms/);
});
