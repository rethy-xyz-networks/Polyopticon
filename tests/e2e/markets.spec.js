'use strict';

// Global Markets: a special view (like the map and the bias chart, not a tab) of live price tiles.
// Tests never go online, so the quotes are fed in the way main's poller would.

const { test, expect } = require('./fixtures');

const quote = (symbol, price, pct, state = 'open', extra = {}) =>
  ({ symbol, name: symbol, price, change: price * pct / 100, pct, state, decimals: 2, currency: 'USD', time: 1, ...extra });

const feed = (window, list) => window.evaluate(async list => (await import('./markets.js')).applyQuotes({ quotes: list, at: Date.now() }), list);

test('the Global Markets button opens a special view beside the map and bias chart, not a tab', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await expect(window.locator('.toolbar .tool-buttons #btn-markets')).toBeVisible();
  await window.locator('#btn-markets').click();
  await expect(window.locator('#markets-view')).toBeVisible();
  await expect(window.locator('#map-view')).toBeHidden();
  await expect(window.locator('#btn-markets')).toHaveClass(/\bon\b/);
  await expect(window.locator('#tabs .tab')).toHaveCount(0);

  await window.locator('#btn-bias').click();                             // another special view replaces it
  await expect(window.locator('#markets-view')).toBeHidden();
  await expect(window.locator('#bias-view')).toBeVisible();
  await window.keyboard.press('Control+g');
  await expect(window.locator('#markets-view')).toBeVisible();
  await expect(window.locator('#bias-view')).toBeHidden();
  await window.keyboard.press('Control+g');
  await expect(window.locator('#markets-view')).toBeHidden();
  expect(window.pageErrors).toEqual([]);
});

test('every default instrument has a tile, grouped, including crypto', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.locator('#btn-markets').click();
  const groups = await window.locator('.mk-head').evaluateAll(els => els.map(e => e.firstChild.textContent));
  expect(groups).toEqual(['United States', 'Canada', 'Asia-Pacific', 'Europe', 'Energy', 'Metals & currencies', 'Crypto']);
  for (const s of ['^GSPC', '^IXIC', '^GSPTSE', '^N225', '000001.SS', 'BZ=F', 'NG=F', 'BTC-USD', 'ETH-USD', 'XRP-USD'])
    await expect(window.locator(`.mk-tile[data-symbol="${s}"]`)).toHaveCount(1);
});

test('a tile shows the exact price and the change today, up or down', async ({ window }, info) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.locator('#btn-markets').click();
  await feed(window, [quote('^GSPC', 5123.456, 0.62), quote('^N225', 64489.06, -4.81, 'closed'), quote('BTC-USD', 81000.01, 0, 'open', { decimals: 2 }), quote('CAD=X', 1.42029, -0.21, 'open', { decimals: 4 })]);

  const sp = window.locator('.mk-tile[data-symbol="^GSPC"]');
  await expect(sp.locator('.mk-price')).toHaveText('5,123.46');
  await expect(sp.locator('.mk-change')).toHaveText('▲ +0.62%');
  await expect(sp).toHaveAttribute('data-dir', 'up');
  await expect(sp.locator('.mk-badge')).toHaveText('OPEN');

  const nk = window.locator('.mk-tile[data-symbol="^N225"]');
  await expect(nk.locator('.mk-price')).toHaveText('64,489.06');
  await expect(nk.locator('.mk-change')).toHaveText('▼ −4.81%');
  await expect(nk).toHaveAttribute('data-dir', 'down');
  await expect(nk.locator('.mk-badge')).toHaveText('CLOSED');

  await expect(window.locator('.mk-tile[data-symbol="BTC-USD"] .mk-change')).toHaveText('■ 0.00%');
  await expect(window.locator('.mk-tile[data-symbol="CAD=X"] .mk-price')).toHaveText('1.4203');
  await expect(window.locator('.mk-group[data-group="apac"] .mk-count')).toHaveText('0 of 7 open');
  await expect(window.locator('.mk-group[data-group="us"] .mk-count')).toHaveText('1 of 5 open');
  await window.locator('#markets-view').screenshot({ path: info.outputPath('markets.png') });
  expect(window.pageErrors).toEqual([]);
});

test('tiles can be removed and restored, and the choice survives a rebuild', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.locator('#btn-markets').click();
  const tile = window.locator('.mk-tile[data-symbol="^RUT"]');
  await expect(window.locator('#markets-restore')).toBeHidden();
  await tile.hover();
  await tile.locator('.mk-remove').click();
  await expect(tile).toHaveCount(0);
  await expect(window.locator('#markets-restore')).toBeVisible();
  await window.locator('#markets-restore').click();
  await expect(tile).toHaveCount(1);
});

test('adding a symbol that cannot be looked up says why and adds nothing', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.locator('#btn-markets').click();
  const group = window.locator('.mk-group[data-group="crypto"]');
  const before = await group.locator('.mk-tile').count();
  await group.locator('.mk-add-btn').click();
  await group.locator('.mk-add-input').fill('not a symbol!');
  await group.locator('.mk-add-input').press('Enter');
  await expect(group.locator('.mk-add-msg')).toContainText('not a symbol');
  await group.locator('.mk-add-input').fill('SOL-USD');
  await group.locator('.mk-add-input').press('Enter');
  await expect(group.locator('.mk-add-msg')).toContainText('Offline');       // tests don't go online
  await expect(group.locator('.mk-tile')).toHaveCount(before);
});

test('the search bar filters by group, country and ticker name, and says when nothing matches', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.locator('#btn-markets').click();
  const search = window.locator('#markets-search');
  const visibleGroups = () => window.locator('.mk-group:not([hidden])').evaluateAll(els => els.map(e => e.dataset.group));
  const visibleTiles = () => window.locator('.mk-tile:not([hidden])').evaluateAll(els => els.map(e => e.dataset.symbol));

  await search.fill('japan');                                            // a country: its whole group
  expect(await visibleGroups()).toEqual(['apac']);
  expect(await visibleTiles()).toContain('^HSI');
  await expect(window.locator('.mk-add:not([hidden])')).toHaveCount(0);  // no + Add while searching

  await search.fill('nikkei');                                           // a ticker name: just that tile
  expect(await visibleTiles()).toEqual(['^N225']);
  await search.fill('btc');                                              // a symbol
  expect(await visibleTiles()).toEqual(['BTC-USD']);
  await search.fill('asia kospi');                                       // words combine across group and tile
  expect(await visibleTiles()).toEqual(['^KS11']);
  await search.fill('canada');
  expect(await visibleGroups()).toEqual(['ca']);

  await search.fill('zzzz');
  await expect(window.locator('#markets-empty')).toBeVisible();
  await search.press('Escape');                                          // clears, and keeps the view open
  await expect(search).toHaveValue('');
  await expect(window.locator('#markets-empty')).toBeHidden();
  await expect(window.locator('#markets-view')).toBeVisible();
  expect((await visibleGroups()).length).toBe(7);
  await expect(window.locator('.mk-add:not([hidden])')).toHaveCount(7);
  expect(window.pageErrors).toEqual([]);
});
