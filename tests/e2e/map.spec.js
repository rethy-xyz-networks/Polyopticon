'use strict';

// The map: stories as pins in their site's colour, gathered into clusters by place; stories
// about a whole country shade it.

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

  // Jerusalem and Tel Aviv overlap at world zoom, so they share a cluster; France is shaded, not a pin.
  const clusters = window.locator('.map-cluster');
  await expect(clusters).toHaveCount(1);
  const levant = clusters.filter({ has: window.locator('.map-count', { hasText: /^8$/ }) });
  await expect(levant.locator('path')).toHaveCount(8);       // a pin per story
  const fills = await levant.locator('path').evaluateAll(ps => ps.map(p => p.getAttribute('fill')));
  expect(fills.filter(f => f === colorA)).toHaveLength(5);
  expect(fills.filter(f => f === colorB)).toHaveLength(3);

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

test('a country\'s stories shade it; hovering names it, clicking opens its card, and the card lists its stories', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await addStories(window);
  await window.locator('#search').fill('mapsynth');
  await expect(window.locator('.map-cluster')).toHaveCount(1);
  const at = await window.evaluate(async ([, , lat, lon]) => (await import('./map.js')).placePoint(lat, lon), FRANCE);
  const peek = window.locator('.map-peek');
  await expect(async () => {                                   // the outlines load in the background
    await window.mouse.move(at.x - 1, at.y); await window.mouse.move(at.x, at.y);
    await expect(peek).toContainText('France', { timeout: 500 });
  }).toPass();
  await expect(peek).toContainText('· 1 story');
  const card = window.locator('.map-card');
  await expect(async () => {                                   // France, and the region of France it's in once the states are in
    if (await card.isVisible()) await card.locator('.mc-x').click();   // an open card may cover the spot (Esc would clear the search)
    await window.mouse.click(at.x, at.y);
    await expect(card.locator('.mc-crumb')).toContainText('France ›', { timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  await expect(card.locator('.mc-pane').first().locator('.mc-name')).toContainText('France');
  await card.locator('.mc-stories', { hasText: 'Show 1 story' }).click();
  await expect(card).toBeHidden();
  await expect(window.locator('.map-pop-head')).toContainText('France');
  await expect(window.locator('.map-pop-list li')).toHaveCount(1);
  await expect(window.locator('.map-pop-search')).toBeFocused();
  expect(window.pageErrors).toEqual([]);
});

test('clicking a place opens its card with a pane per tier, and Esc or the sea closes it', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.evaluate(async () => (await import('./map.js')).showPlace(44.75, -63.3, 8));      // Nova Scotia, east of Halifax
  const card = window.locator('.map-card');
  await expect(async () => {                                   // counties and Canada's divisions load in the background
    const at = await window.evaluate(async () => (await import('./map.js')).placePoint(44.95, -63.2));
    if (await card.isVisible()) await card.locator('.mc-x').click();   // an open card may cover the spot (Esc would clear the search)
    await window.mouse.click(at.x, at.y);
    await expect(card.locator('.mc-crumb')).toHaveText('Canada › Nova Scotia › Halifax County', { timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  await expect(card.locator('.mc-pane')).toHaveCount(3);
  await expect(card.locator('.mc-eyebrow').nth(2)).toContainText('Census division');
  await window.locator('.map-card .mc-name').first().click();  // focus in the card, not a text box
  await window.keyboard.press('Escape');
  await expect(card).toBeHidden();
  const at = await window.evaluate(async () => (await import('./map.js')).placePoint(44.95, -63.2));
  await window.mouse.click(at.x, at.y);
  await expect(card).toBeVisible();
  const sea = await window.evaluate(async () => {                // open sea in the map that nothing covers
    const { isPlaceAt } = await import('./map.js'), m = document.getElementById('map-canvas').getBoundingClientRect();
    for (let y = m.top + 60; y < m.bottom - 60; y += 20) for (let x = m.left + 60; x < m.right - 20; x += 20)
      if (document.elementFromPoint(x, y)?.closest('#map-canvas') && !document.elementFromPoint(x, y).closest('.leaflet-control, .leaflet-marker-icon') && !isPlaceAt(x, y)) return { x, y };
  });
  await window.mouse.click(sea.x, sea.y);
  await expect(card).toBeHidden();
  expect(window.pageErrors).toEqual([]);
});

test('clicking a card\'s photo opens its Wikimedia Commons page as a tab', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.evaluate(async () => (await import('./map.js')).showPlace(44.75, -63.3, 8));
  const card = window.locator('.map-card');
  await expect(async () => {
    const at = await window.evaluate(async () => (await import('./map.js')).placePoint(44.95, -63.2));
    if (await card.isVisible()) await card.locator('.mc-x').click();
    await window.mouse.click(at.x, at.y);
    await expect(card.locator('.mc-crumb')).toContainText('Nova Scotia', { timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  const photo = card.locator('.mc-photo img').first();       // Canada's: downloaded from Commons by the app
  await expect(photo).toBeVisible({ timeout: 30_000 });
  const page = await card.locator('.mc-credit a').first().getAttribute('href');
  expect(page).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
  await photo.click();
  await expect(window.locator('#map-view')).toBeHidden();                         // the Article View, with the new tab
  const tab = await window.evaluate(async () => {
    const { state } = await import('./state.js'), t = state.tabs.find(x => x.id === state.activeTabId);
    return { kind: t.kind, site: t.site, url: t.item.url, sourceName: t.item.sourceName };
  });
  expect(tab).toEqual({ kind: 'chan', site: 'commons', url: page, sourceName: 'Wikimedia Commons' });
  expect(window.pageErrors).toEqual([]);
});

test('clicking a card\'s Wikipedia link opens the article as a tab', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.evaluate(async () => (await import('./map.js')).showPlace(44.75, -63.3, 8));
  const card = window.locator('.map-card');
  await expect(async () => {
    const at = await window.evaluate(async () => (await import('./map.js')).placePoint(44.95, -63.2));
    if (await card.isVisible()) await card.locator('.mc-x').click();
    await window.mouse.click(at.x, at.y);
    await expect(card.locator('.mc-crumb')).toContainText('Nova Scotia', { timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  const link = card.locator('.mc-wiki').first();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^https:\/\/en\.wikipedia\.org\/wiki\//);
  await link.click();
  await expect(window.locator('#map-view')).toBeHidden();                         // the Article View, with the new tab
  const tab = await window.evaluate(async () => {
    const { state } = await import('./state.js'), t = state.tabs.find(x => x.id === state.activeTabId);
    return { kind: t.kind, site: t.site, url: t.item.url, sourceName: t.item.sourceName };
  });
  expect(tab).toEqual({ kind: 'chan', site: 'wikipedia', url: href, sourceName: 'Wikipedia' });
  expect(window.pageErrors).toEqual([]);
});

test('zooming in splits a cluster into its places', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await addStories(window);
  await window.locator('#search').fill('mapsynth');
  const clusters = window.locator('.map-cluster');
  await expect(clusters).toHaveCount(1);
  const zoomIn = window.locator('.leaflet-control-zoom-in');
  for (let i = 0; i < 6; i++) { await zoomIn.click(); await window.waitForTimeout(350); }
  // The Levant may now be off-screen, but Jerusalem and Tel Aviv are separate markers.
  await expect.poll(() => clusters.count()).toBe(2);
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
