'use strict';

// Rendering cost of the story list: 1000 stories with realistic descriptions.
// Not part of `npm test` (timings vary by machine) — run with `npm run test:perf`.

const { test, expect } = require('../e2e/fixtures');

const WORDS = 'government officials said the talks would continue next week amid growing pressure from allies and rising prices across the region'.split(' ');

test.use({ settings: { MaxFeedItems: 1000 } });

test('render 1000 stories and scroll through them', async ({ window }) => {
  await window.evaluate(([words]) => { window.__sentence = (n, seed) => Array.from({ length: n }, (_, i) => words[(i * 7 + seed) % words.length]).join(' '); }, [WORDS]);
  const result = await window.evaluate(async ({ n }) => {
    const feed = await import('./feed.js');
    const { state } = await import('./state.js');
    const sourceId = state.sources[0].id;
    const items = Array.from({ length: n }, (_, i) => ({
      id: 9e8 + i, sourceId, sourceName: state.sources[0].name, kind: 'article',
      title: `Story number ${i}: ${window.__sentence(9, i)}`,
      summary: window.__sentence(48, i + 3),                       // ≈ 300 characters
      url: `https://example.com/perf/${i}`, publishedAt: Date.now() - i * 60e3, places: [],
    }));
    const frame = () => new Promise(r => requestAnimationFrame(() => r()));
    await frame();
    const t0 = performance.now();
    feed.ingest(items, { fresh: false });
    await frame(); await frame();                                  // render + layout/paint
    const renderMs = performance.now() - t0;

    // Scroll the whole list in steps, measuring frame times.
    const list = document.getElementById('feed-list');
    const frames = [];
    let last = performance.now();
    for (let y = 0; y < list.scrollHeight; y += 600) {
      list.scrollTop = y;
      await frame();
      const now = performance.now(); frames.push(now - last); last = now;
    }
    frames.sort((a, b) => a - b);
    return {
      renderMs: Math.round(renderMs),
      scrollFrames: frames.length,
      p50: Math.round(frames[Math.floor(frames.length / 2)]),
      p95: Math.round(frames[Math.floor(frames.length * 0.95)]),
      rows: list.querySelectorAll('.item').length,
      snippets: list.querySelectorAll('.item .snippet').length,
      heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
    };
  }, { n: 1000 }).catch(e => { throw e; });
  console.log('PERF', JSON.stringify(result));
  expect(result.rows).toBeGreaterThan(900);
});
