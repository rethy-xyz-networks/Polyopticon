'use strict';

// The bias chart: a special view (like the map, not a tab) opened from the header.

const { test, expect } = require('./fixtures');

const outlet = (slug, name, bias, fact = []) => {
  const val = { left: -2, leanLeft: -1, center: 0, leanRight: 1, right: 2 };
  const fv = { low: 1, mixed: 2, high: 3, veryHigh: 4 };
  const mean = (l, t) => (l.length ? l.reduce((a, [, v]) => a + t[v], 0) / l.length : null);
  return { slug, name, url: `https://mediabias.news/sources/${slug}`, x: mean(bias, val), y: mean(fact, fv), rating: bias[0]?.[1] ?? null,
    factuality: fact[0]?.[1] ?? null, bias, fact, stories: 10, satire: false };
};

/** Looked-up answers for the first four RSS feeds: two of one outlet, a right-leaning one, an unrated one. */
const seedBias = (window, rows) => window.evaluate(async rows => {
  const { state, setBias } = await import('./state.js');
  const { refreshBias } = await import('./bias.js');
  const feeds = state.sources.filter(s => s.type === 'rss' && s.enabled).slice(0, 4);
  setBias(rows.map((r, i) => ({ sourceId: feeds[i].id, checkedAt: 1, outlet: r })));
  refreshBias();
  return feeds.map(f => f.name);
}, rows);

const LEFT = outlet('left-paper', 'Left Paper', [['AllSides', 'left'], ['Ad Fontes Media', 'leanLeft']], [['Ad Fontes Media', 'high']]);
const RIGHT = outlet('right-wire', 'Right Wire', [['AllSides', 'leanRight']], [['Ad Fontes Media', 'mixed']]);
const UNRATED = outlet('mystery', 'Mystery', []);

test('the map and bias buttons are in the header and open their views as tabs, once each', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  for (const id of ['btn-map', 'btn-bias']) {
    await expect(window.locator(`.toolbar .tool-buttons #${id}`)).toBeVisible();
    await expect(window.locator(`.tabstrip #${id}`)).toHaveCount(0);
  }
  const labels = window.locator('#tabs .tab .label');
  const active = window.locator('#tabs .tab.active .label');
  await expect(window.locator('#map-view')).toBeVisible();              // the map is the start page, in a tab
  await expect(labels).toHaveText(['Map']);
  await expect(active).toHaveText('Map');

  await window.locator('#btn-bias').click();
  await expect(window.locator('#bias-view')).toBeVisible();
  await expect(window.locator('#map-view')).toBeHidden();
  await expect(window.locator('#btn-bias')).toHaveClass(/\bon\b/);
  await expect(window.locator('#btn-map')).not.toHaveClass(/\bon\b/);
  await expect(labels).toHaveText(['Map', 'Political lean']);
  await expect(active).toHaveText('Political lean');

  await window.locator('#btn-map').click();                             // selects the open tab, no second one
  await expect(window.locator('#map-view')).toBeVisible();
  await expect(window.locator('#bias-view')).toBeHidden();
  await expect(active).toHaveText('Map');
  await window.keyboard.press('Control+b');
  await expect(window.locator('#bias-view')).toBeVisible();
  await window.keyboard.press('Control+b');                             // already selected: stays
  await expect(window.locator('#bias-view')).toBeVisible();
  await window.locator('#tabs .tab', { hasText: 'Map' }).click();       // its tab works like any other
  await expect(window.locator('#map-view')).toBeVisible();
  await expect(window.locator('#bias-view')).toBeHidden();
  await expect(labels).toHaveText(['Map', 'Political lean']);
  expect(window.pageErrors).toEqual([]);
});

test('outlets are plotted left to right by the raters\' average; feeds of one outlet share a dot', async ({ window }, info) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  const names = await seedBias(window, [LEFT, LEFT, RIGHT, UNRATED]);
  await window.locator('#btn-bias').click();

  const dots = window.locator('.bias-dot');
  await expect(dots).toHaveCount(2);                                    // three feeds, two outlets
  const cx = async name => (await dots.filter({ has: window.locator(`xpath=self::*[contains(@aria-label, "${name}")]`) }).getAttribute('transform')).match(/translate\(([\d.]+)/)[1];
  expect(Number(await cx('Left Paper'))).toBeLessThan(Number(await cx('Right Wire')));
  await expect(window.locator('.bias-tick', { hasText: /^Lean left$/ })).toBeVisible();
  await expect(window.locator('.bias-tick', { hasText: /^Center$/ })).toBeVisible();
  await expect(window.locator('.bias-tick', { hasText: /^Lean right$/ })).toBeVisible();

  // Hover: every rater's verdict, and which feeds are behind the dot
  await dots.first().hover();
  const tip = window.locator('#bias-tip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Left Paper');
  await expect(tip).toContainText(`${names[0]}, ${names[1]}`);
  await expect(tip).toContainText('AllSides');
  await expect(tip).toContainText('Lean left');

  // An outlet no rater has rated is listed, not plotted
  await expect(window.locator('.bias-unrated .bias-chip', { hasText: names[3] })).toBeVisible();
  await expect(window.locator('#bias-summary')).toContainText('2 outlets · 3 feeds plotted');
  await window.locator('#bias-view').screenshot({ path: info.outputPath('bias.png') });
  expect(window.pageErrors).toEqual([]);
});

test('Settings shows how far the lookups got and offers a recheck', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await seedBias(window, [LEFT, null]);
  await window.evaluate(async () => (await import('./settings.js')).renderBiasStatus());
  await window.locator('#btn-settings').click();
  await expect(window.locator('#btn-bias-recheck')).toBeEnabled();
  await expect(window.locator('#bias-status')).toContainText('2 of');
  await expect(window.locator('#bias-status')).toContainText('1 with a rating');
});
