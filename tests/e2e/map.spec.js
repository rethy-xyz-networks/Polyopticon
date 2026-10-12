'use strict';

// The map: stories as pins in their site's colour, gathered into clusters by place.

const { test, expect } = require('./fixtures');

const JERUSALEM = ['g:281184', 'Jerusalem', 31.769, 35.216];
const TEL_AVIV  = ['g:293397', 'Tel Aviv', 32.081, 34.781];
const FRANCE    = ['c:FR', 'France', 46.696, 2.552];

/** Adds synthetic stories at three places from two sources; returns the sources' colours. */
const addStories = window => window.evaluate(async ([J, T, F]) => {
  const feed = await import('./feed.js');
  const { state, sourceColor } = await import('./state.js');
  const [a, b] = state.sources.filter(s => s.enabled);
  const story = (i, s, place, what) => ({
    id: 9e8 + i, sourceId: s.id, sourceName: s.name, kind: 'article', title: `Mapsynth ${what} ${i}`, summary: '',
    url: `https://example.com/mapsynth/${i}`, publishedAt: Date.now() - i * 60e3, places: [place],
  });
  feed.ingest([
    ...[0, 1, 2, 3, 4].map(i => story(i, a, J, 'protest in Jerusalem')),
    ...[5, 6, 7].map(i => story(i, b, T, 'strike in Tel Aviv')),
    story(8, a, F, 'election in France'),
  ], { fresh: false });
  return [sourceColor(a.id), sourceColor(b.id)];
}, [JERUSALEM, TEL_AVIV, FRANCE]);

test('stories are pins in their site\'s colour; nearby places share a cluster that lists and searches its stories', async ({ window }) => {
  await expect(window.locator('#map-view')).toBeVisible();
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  const [colorA, colorB] = await addStories(window);
  await window.locator('#search').fill('mapsynth');          // only the synthetic stories, whatever the feeds bring in

  // Jerusalem and Tel Aviv overlap at world zoom, so they share a cluster; France is its own.
  const clusters = window.locator('.map-cluster');
  await expect(clusters).toHaveCount(2);
  const levant = clusters.filter({ has: window.locator('.map-count', { hasText: /^8$/ }) });
  await expect(levant.locator('path')).toHaveCount(8);       // a pin per story
  const fills = await levant.locator('path').evaluateAll(ps => ps.map(p => p.getAttribute('fill')));
  expect(fills.filter(f => f === colorA)).toHaveLength(5);
  expect(fills.filter(f => f === colorB)).toHaveLength(3);
  await expect(clusters.filter({ hasNot: window.locator('.map-count') }).locator('path')).toHaveCount(1);   // France: one story, no number

  // The list, with a search box that has the focus
  await levant.click();
  const list = window.locator('.map-pop-list li');
  await expect(list).toHaveCount(8);
  await expect(window.locator('.map-pop-head')).toContainText('+1 nearby');
  const search = window.locator('.map-pop-search');
  await expect(search).toBeFocused();
  await search.pressSequentially('tel aviv');                 // matches the place too
  await expect(list).toHaveCount(3);
  await search.fill('nothing like this');
  await expect(window.locator('.map-pop-more')).toHaveText('No stories match');
  await search.press('Escape');
  await expect(window.locator('.map-pop')).toHaveCount(0);

  // "Show these places in the feed" filters the list to both places
  await levant.click();
  await window.locator('.map-pop .primary-btn').click();
  await expect(window.locator('#place-chip')).toBeVisible();
  await expect(window.locator('#place-chip-name')).toHaveText('Jerusalem, Tel Aviv');
  await expect(window.locator('#feed-list .item')).toHaveCount(8);
  await expect(levant).toHaveClass(/\bon\b/);
  expect(window.pageErrors).toEqual([]);
});

test('zooming in splits a cluster into its places', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await addStories(window);
  await window.locator('#search').fill('mapsynth');
  const clusters = window.locator('.map-cluster');
  await expect(clusters).toHaveCount(2);
  const zoomIn = window.locator('.leaflet-control-zoom-in');
  for (let i = 0; i < 6; i++) { await zoomIn.click(); await window.waitForTimeout(350); }
  // The Levant may now be off-screen, but Jerusalem and Tel Aviv are separate markers.
  await expect.poll(() => clusters.count()).toBe(3);
  expect(window.pageErrors).toEqual([]);
});

test('a cluster\'s tooltip wraps a long list of places and stays inside the map', async ({ window }, info) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.evaluate(async () => {                         // 30 places close together in Western Europe: one cluster
    const feed = await import('./feed.js');
    const { state } = await import('./state.js');
    const s = state.sources.find(x => x.enabled);
    feed.ingest(Array.from({ length: 30 }, (_, i) => ({
      id: 8e8 + i, sourceId: s.id, sourceName: s.name, kind: 'article', title: `Tipsynth ${i}`, summary: '',
      url: `https://example.com/tipsynth/${i}`, publishedAt: Date.now() - i * 60e3,
      places: [[`g:tip${i}`, `Longplacename${i}-sur-Mer`, 48 + (i % 5) * 0.4, 2 + Math.floor(i / 5) * 0.4]],
    })), { fresh: false });
  });
  await window.locator('#search').fill('tipsynth');
  // A narrow map, with the cluster near its left edge
  await window.evaluate(() => document.documentElement.style.setProperty('--w-feed', `${innerWidth - 640}px`));
  const cluster = window.locator('.map-cluster');
  await expect(cluster).toHaveCount(1);
  await cluster.hover();
  const tip = window.locator('.leaflet-tooltip');
  await expect(tip).toContainText('Longplacename29-sur-Mer');
  await window.waitForTimeout(250);                           // the tooltip fades in
  await window.locator('#map-view').screenshot({ path: info.outputPath('tooltip.png') });
  const [t, m] = await Promise.all([tip.boundingBox(), window.locator('#map-canvas').boundingBox()]);
  expect(t.height).toBeGreaterThan(40);                        // wrapped onto several lines
  expect(t.x).toBeGreaterThanOrEqual(m.x);
  expect(t.x + t.width).toBeLessThanOrEqual(m.x + m.width);
  expect(t.y).toBeGreaterThanOrEqual(m.y);                     // too tall for above the cluster: below it
  expect(t.y + t.height).toBeLessThanOrEqual(m.y + m.height);
  expect(window.pageErrors).toEqual([]);
});
