'use strict';

// A narrow story list keeps each row's group chip (+N) whole: the source name shortens and the
// date drops out (the day headings show it) instead of the chip running off the edge.

const { test, expect } = require('./fixtures');

test.use({ settings: { GroupStories: true } });

test('in the narrowest list the group chip stays inside the row', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.evaluate(async () => {
    const feed = await import('./feed.js');
    const { state } = await import('./state.js');
    const [a, b] = state.sources;
    feed.ingest([
      { id: 9e8, sourceId: a.id, sourceName: 'A Very Long Source Name World Service', kind: 'article', title: 'Narrow row lead', summary: '', url: 'https://example.com/n1', publishedAt: Date.now(), places: [], clusterId: 77 },
      { id: 9e8 + 1, sourceId: b.id, sourceName: b.name, kind: 'article', title: 'Narrow row member', summary: '', url: 'https://example.com/n2', publishedAt: Date.now() - 60_000, places: [], clusterId: 77 },
    ], { fresh: false });
  });
  const row = window.locator('#feed-list .item', { hasText: 'Narrow row lead' });
  for (const w of [260, 420]) {
    await window.evaluate(w => document.documentElement.style.setProperty('--w-feed', `${w}px`), w);
    await expect(row.locator('.group-chip')).toBeVisible();
    const { chip, edge, badge, full, date } = await row.evaluate(el => {
      const b = el.querySelector('.badge');
      return { chip: el.querySelector('.group-chip').getBoundingClientRect().right, edge: el.getBoundingClientRect().right,
               badge: b.clientWidth, full: b.scrollWidth, date: !!el.querySelector('.time .date').offsetParent };
    });
    expect(chip, `${w}px: chip inside the row`).toBeLessThanOrEqual(edge);
    if (w === 260) { expect(badge).toBeLessThan(full); expect(date).toBe(false); }   // the name is cut, the date gone
    else expect(date).toBe(true);
  }
  await expect(row.locator('.badge')).toHaveAttribute('title', 'A Very Long Source Name World Service');
});
