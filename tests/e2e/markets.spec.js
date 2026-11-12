'use strict';

// Global Markets: a special view (like the map and the bias chart, not a tab) of live price tiles.
// Tests never go online, so the quotes are fed in the way main's poller would.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

const quote = (symbol, price, pct, state = 'open', extra = {}) =>
  ({ symbol, name: symbol, price, change: price * pct / 100, pct, state, decimals: 2, currency: 'USD', time: 1, ...extra });

const feed = (window, list) => window.evaluate(async list => (await import('./markets.js')).applyQuotes({ quotes: list, at: Date.now() }), list);

test('the Global Markets button opens its view as a tab beside the map and bias chart, once', async ({ window }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await expect(window.locator('.toolbar .tool-buttons #btn-markets')).toBeVisible();
  await window.locator('#btn-markets').click();
  await expect(window.locator('#markets-view')).toBeVisible();
  await expect(window.locator('#map-view')).toBeHidden();
  await expect(window.locator('#btn-markets')).toHaveClass(/\bon\b/);
  await expect(window.locator('#tabs .tab .label')).toHaveText(['Map', 'Global Markets']);

  await window.locator('#btn-bias').click();                             // another view's tab is selected
  await expect(window.locator('#markets-view')).toBeHidden();
  await expect(window.locator('#bias-view')).toBeVisible();
  await window.keyboard.press('Control+g');                              // back to the open tab
  await expect(window.locator('#markets-view')).toBeVisible();
  await expect(window.locator('#bias-view')).toBeHidden();
  await expect(window.locator('#tabs .tab')).toHaveCount(3);
  await window.keyboard.press('Control+w');                              // closing the tab hides it
  await expect(window.locator('#markets-view')).toBeHidden();
  await expect(window.locator('#btn-markets')).not.toHaveClass(/\bon\b/);
  expect(window.pageErrors).toEqual([]);
});

// Groups as a user might make them. They're saved before the view is first opened, which is when it's built.
const GROUPS = [
  { id: 'us', name: 'United States', items: [['^GSPC', 'S&P 500'], ['^IXIC', 'Nasdaq Composite'], ['^DJI', 'Dow Jones'], ['^RUT', 'Russell 2000'], ['^VIX', 'VIX']] },
  { id: 'ca', name: 'Canada', items: [['^GSPTSE', 'S&P/TSX Composite']] },
  { id: 'apac', name: 'Asia-Pacific', items: [['^N225', 'Nikkei 225'], ['^HSI', 'Hang Seng'], ['^KS11', 'KOSPI']] },
  { id: 'crypto', name: 'Crypto', items: [['BTC-USD', 'Bitcoin'], ['ETH-USD', 'Ethereum'], ['XRP-USD', 'XRP'], ['CAD=X', 'USD / CAD']] },
].map(g => ({ ...g, items: g.items.map(([symbol, name]) => ({ symbol, name })) }));

const seed = (window, groups = GROUPS) => window.evaluate(async groups => (await import('./ui.js')).saveUi({ marketsGroups: groups }), groups);

const openWith = async (window, groups) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await seed(window, groups);
  await window.locator('#btn-markets').click();
};

const savedGroups = dataDir => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'ui.json'), 'utf8')).marketsGroups; } catch { return null; } };

test('there are no groups at first; groups can be made and removed, and are remembered', async ({ window, dataDir }) => {
  await expect(window.locator('#source-groups .source').first()).toBeVisible();
  await window.locator('#btn-markets').click();
  await expect(window.locator('.mk-group')).toHaveCount(0);
  await expect(window.locator('.mk-new-hint')).toBeVisible();
  await expect(window.locator('#markets-empty')).toBeHidden();

  for (const name of ['Tech', 'Energy']) {
    await window.locator('.mk-new-btn').click();
    await window.locator('.mk-new-input').fill(name);
    await window.locator('.mk-new-input').press('Enter');
  }
  await expect(window.locator('.mk-group-name')).toHaveText(['Tech', 'Energy']);
  await expect(window.locator('.mk-new-hint')).toHaveCount(0);
  await expect(window.locator('.mk-group .mk-add')).toHaveCount(2);
  await expect.poll(() => savedGroups(dataDir)?.map(g => g.name)).toEqual(['Tech', 'Energy']);

  await window.locator('.mk-new-btn').click();                           // Escape, or an empty name, makes nothing
  await window.locator('.mk-new-input').press('Escape');
  await expect(window.locator('.mk-new-btn')).toBeVisible();
  await expect(window.locator('.mk-group')).toHaveCount(2);

  const tech = window.locator('.mk-group', { has: window.locator('.mk-group-name', { hasText: 'Tech' }) });
  await tech.locator('.mk-head').hover();
  await tech.locator('.mk-group-remove').click();                        // empty: goes at once
  await expect(window.locator('.mk-group-name')).toHaveText(['Energy']);
  await expect.poll(() => savedGroups(dataDir)?.map(g => g.name)).toEqual(['Energy']);
  expect(window.pageErrors).toEqual([]);
});

test('a group with tiles asks once more before it is removed', async ({ window, dataDir }) => {
  await openWith(window);
  const ca = window.locator('.mk-group[data-group="ca"]');
  const remove = ca.locator('.mk-group-remove');
  await ca.locator('.mk-head').hover();
  await remove.click();
  await expect(remove).toHaveText('Remove group and its 1 tile?');
  await remove.press('Escape');                                          // changed their mind
  await expect(remove).toHaveText('Remove');
  await remove.click();
  await remove.click();
  await expect(ca).toHaveCount(0);
  await expect(window.locator('.mk-tile[data-symbol="^GSPTSE"]')).toHaveCount(0);
  await expect.poll(() => savedGroups(dataDir)?.map(g => g.id)).toEqual(['us', 'apac', 'crypto']);
  expect(window.pageErrors).toEqual([]);
});

test('a tile shows the exact price and the change today, up or down', async ({ window }, info) => {
  await openWith(window);
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
  await expect(window.locator('.mk-group[data-group="apac"] .mk-count')).toHaveText('0 of 3 open');
  await expect(window.locator('.mk-group[data-group="us"] .mk-count')).toHaveText('1 of 5 open');
  await window.locator('#markets-view').screenshot({ path: info.outputPath('markets.png') });
  expect(window.pageErrors).toEqual([]);
});

test('a tile can be removed, and stays removed', async ({ window, dataDir }) => {
  await openWith(window);
  const tile = window.locator('.mk-tile[data-symbol="^RUT"]');
  await tile.hover();
  await tile.locator('.mk-remove').click();
  await expect(tile).toHaveCount(0);
  await expect.poll(() => savedGroups(dataDir)?.find(g => g.id === 'us').items.map(i => i.symbol)).toEqual(['^GSPC', '^IXIC', '^DJI', '^VIX']);
});

test('adding a symbol that cannot be looked up says why and adds nothing', async ({ window }) => {
  await openWith(window);
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

test('the search bar filters by group and ticker name, and says when nothing matches', async ({ window }) => {
  await openWith(window);
  const search = window.locator('#markets-search');
  const visibleGroups = () => window.locator('.mk-group:not([hidden])').evaluateAll(els => els.map(e => e.dataset.group));
  const visibleTiles = () => window.locator('.mk-tile:not([hidden])').evaluateAll(els => els.map(e => e.dataset.symbol));

  await search.fill('asia');                                             // a group's name: the whole group
  expect(await visibleGroups()).toEqual(['apac']);
  expect(await visibleTiles()).toContain('^HSI');
  await expect(window.locator('.mk-add:not([hidden])')).toHaveCount(0);  // no + Add or + New group while searching
  await expect(window.locator('.mk-new')).toBeHidden();

  await search.fill('nikkei');                                           // a ticker name: just that tile
  expect(await visibleTiles()).toEqual(['^N225']);
  await search.fill('btc');                                              // a symbol
  expect(await visibleTiles()).toEqual(['BTC-USD']);
  await search.fill('asia kospi');                                       // words combine across group and tile
  expect(await visibleTiles()).toEqual(['^KS11']);
  await search.fill('canada');
  expect(await visibleGroups()).toEqual(['ca']);

  await window.locator('#source-groups .source').first().click();      // Ctrl+F goes to this search, not the stories'
  await window.keyboard.press('Control+f');
  await expect(search).toBeFocused();
  await expect(window.locator('#search')).not.toBeFocused();
  await search.fill('zzzz');
  await expect(window.locator('#markets-empty')).toBeVisible();
  await search.press('Escape');                                          // clears, and keeps the view open
  await expect(search).toHaveValue('');
  await expect(window.locator('#markets-empty')).toBeHidden();
  await expect(window.locator('#markets-view')).toBeVisible();
  expect((await visibleGroups()).length).toBe(4);
  await expect(window.locator('.mk-add:not([hidden])')).toHaveCount(4);
  await expect(window.locator('.mk-new')).toBeVisible();
  expect(window.pageErrors).toEqual([]);
});

test('tiles can be dragged into a new place or another group, and the layout is remembered', async ({ window, dataDir }) => {
  await openWith(window);
  const symbols = group => window.locator(`.mk-group[data-group="${group}"] .mk-tile`).evaluateAll(els => els.map(e => e.dataset.symbol));
  const drag = async (from, to, side = 'left') => {
    const a = await window.locator(`.mk-tile[data-symbol="${from}"]`).boundingBox();
    const b = await window.locator(to).boundingBox();
    await window.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await window.mouse.down();
    await window.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 2 });
    await window.mouse.move(b.x + b.width * (side === 'left' ? 0.2 : 0.8), b.y + b.height / 2, { steps: 8 });
    await window.mouse.up();
  };

  await drag('^VIX', '.mk-tile[data-symbol="^GSPC"]');                   // within a group: to the front
  expect(await symbols('us')).toEqual(['^VIX', '^GSPC', '^IXIC', '^DJI', '^RUT']);
  await drag('^GSPC', '.mk-tile[data-symbol="^DJI"]', 'right');          // to the right half: after it
  expect(await symbols('us')).toEqual(['^VIX', '^IXIC', '^DJI', '^GSPC', '^RUT']);
  await drag('^N225', '.mk-tile[data-symbol="^GSPTSE"]');               // into another group
  expect(await symbols('ca')).toEqual(['^N225', '^GSPTSE']);
  expect(await symbols('apac')).not.toContain('^N225');
  await drag('^GSPTSE', '.mk-group[data-group="us"] .mk-add');           // onto + Add: the end of that group
  expect(await symbols('us')).toEqual(['^VIX', '^IXIC', '^DJI', '^GSPC', '^RUT', '^GSPTSE']);
  await expect(window.locator('.mk-tile.dragging')).toHaveCount(0);
  await expect(window.locator('#tabs .tab .label')).toHaveText(['Map', 'Global Markets']);   // letting go after a drag opens no page

  // Held against the bottom edge, the list scrolls to the groups further down.
  await window.locator('#markets-groups').evaluate(el => { el.style.flex = '0 0 260px'; });   // short enough that the groups overflow
  const vix = await window.locator('.mk-tile[data-symbol="^VIX"]').boundingBox();
  const list = await window.locator('#markets-groups').boundingBox();
  await window.mouse.move(vix.x + 40, vix.y + 40);
  await window.mouse.down();
  await window.mouse.move(vix.x + 60, list.y + list.height - 8, { steps: 6 });
  await expect.poll(() => window.locator('#markets-groups').evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)).toBe(true);   // and stops there
  const add = await window.locator('.mk-group[data-group="crypto"] .mk-add').boundingBox();
  await window.mouse.move(add.x + add.width / 2, add.y + add.height / 2);   // straight there: a path across the tiles would place it on the way
  await window.mouse.up();
  expect(await symbols('crypto')).toEqual(['BTC-USD', 'ETH-USD', 'XRP-USD', 'CAD=X', '^VIX']);

  const saved = () => Object.fromEntries((savedGroups(dataDir) ?? []).map(g => [g.id, g.items.map(i => i.symbol)]));
  await expect.poll(saved).toEqual({
    us: ['^IXIC', '^DJI', '^GSPC', '^RUT', '^GSPTSE'], ca: ['^N225'], apac: ['^HSI', '^KS11'], crypto: ['BTC-USD', 'ETH-USD', 'XRP-USD', 'CAD=X', '^VIX'],
  });
  expect((savedGroups(dataDir) ?? []).find(g => g.id === 'crypto').items.at(-1)).toEqual({ symbol: '^VIX', name: 'VIX' });   // its name moves with it
  expect(window.pageErrors).toEqual([]);
});

test('clicking a tile, or Enter on it, opens its Yahoo Finance page as a tab; its × does not', async ({ window }) => {
  await openWith(window);
  const tabs = window.locator('#tabs .tab .label');
  await expect(tabs).toHaveCount(2);                                     // the Map and Global Markets
  await window.locator('.mk-tile[data-symbol="^GSPC"]').click();
  await expect(tabs).toHaveCount(3);
  expect(await window.evaluate(async () => (await import('./state.js')).state.tabs.at(-1).item.url)).toBe('https://finance.yahoo.com/quote/%5EGSPC/');
  await expect(window.locator('#tabs .tab').last().locator('img.fav')).toHaveAttribute('src', 'polyopticon-icon://site/finance.yahoo.com');

  await window.locator('#btn-markets').click();                          // back to the tiles
  await window.locator('.mk-tile[data-symbol="^GSPC"]').click();         // the same page: its tab again, not a second one
  await expect(tabs).toHaveCount(3);
  await window.locator('#btn-markets').click();
  await window.locator('.mk-tile[data-symbol="CAD=X"]').focus();
  await window.keyboard.press('Enter');
  await expect(tabs).toHaveCount(4);
  expect(await window.evaluate(async () => (await import('./state.js')).state.tabs.at(-1).item.url)).toBe('https://finance.yahoo.com/quote/CAD%3DX/');

  await window.locator('#btn-markets').click();
  await window.locator('.mk-tile[data-symbol="^VIX"]').hover();
  await window.locator('.mk-tile[data-symbol="^VIX"] .mk-remove').click();
  await expect(window.locator('.mk-tile[data-symbol="^VIX"]')).toHaveCount(0);
  await expect(tabs).toHaveCount(4);
  expect(window.pageErrors).toEqual([]);
});
