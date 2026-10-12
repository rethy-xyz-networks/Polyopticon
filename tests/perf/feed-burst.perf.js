'use strict';

// The start-up burst: thousands of stories already listed, then new ones arriving in
// many small batches (one per source poll) with auto-scroll on. Measures how long the
// window is blocked. Not part of `npm test` — run with `npm run test:perf`.

const { test, expect } = require('../e2e/fixtures');

test.use({ settings: { MaxFeedItems: 5000 } });

test('4000 stories, then 60 batches of new ones with auto-scroll', async ({ window }) => {
  const result = await window.evaluate(async () => {
    const feed = await import('./feed.js');
    const { state } = await import('./state.js');
    state.autoScroll = true;
    const src = state.sources;
    let next = 9e8;
    const make = (n, ageMin) => Array.from({ length: n }, (_, i) => {
      const s = src[(next + i) % src.length];
      return { id: next + i, sourceId: s.id, sourceName: s.name, kind: 'article',
        title: `Story ${next + i}: officials said the talks would continue next week amid pressure`,
        summary: 'Government officials said the talks would continue next week amid growing pressure from allies and rising prices across the region. '.repeat(2),
        url: `https://example.com/burst/${next++ + 0 * i}`, publishedAt: Date.now() - (ageMin + i) * 60e3, places: [] };
    });
    const frame = () => new Promise(r => requestAnimationFrame(() => r()));
    feed.ingest(make(4000, 120), { fresh: false });
    await frame(); await frame();
    await new Promise(r => setTimeout(r, 500));

    const long = [];
    const obs = new PerformanceObserver(l => { for (const e of l.getEntries()) long.push(e.duration); });
    obs.observe({ type: 'longtask' });
    const t0 = performance.now();
    for (let b = 0; b < 60; b++) {
      feed.ingest(make(6, 0));
      await new Promise(r => setTimeout(r, 300));
    }
    await frame(); await frame();
    await new Promise(r => setTimeout(r, 300));
    obs.disconnect();
    return {
      seconds: Math.round((performance.now() - t0) / 100) / 10,
      blockedMs: Math.round(long.reduce((a, b) => a + b, 0)),
      longTasks: long.length,
      worstMs: Math.round(Math.max(0, ...long)),
      rows: document.querySelectorAll('#feed-list .item').length,
      count: document.getElementById('feed-count').textContent,
      scrollTop: document.getElementById('feed-list').scrollTop,
    };
  });
  console.log('PERF burst', JSON.stringify(result));
  expect(result.rows).toBeLessThanOrEqual(300);                       // only the first rows are in the page
  expect(Number(result.count.split(' / ').pop())).toBeGreaterThan(4000);
  expect(result.scrollTop).toBe(0);
});
