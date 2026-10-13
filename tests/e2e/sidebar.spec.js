'use strict';

// Finding a source in Sources & Filters, against the default sources of a fresh profile.

const { test, expect } = require('./fixtures');

const visibleSources = window => window.locator('#source-groups .source:visible .name').allTextContents();
const visibleGroups = window => window.locator('#source-groups .group:visible .group-head span').allTextContents();

test('a country shows all of its sources', async ({ window }) => {
  await window.locator('#source-filter').fill('canada');
  expect(await visibleGroups(window)).toEqual(['Canada']);
  expect(await visibleSources(window)).toEqual(['CBC', 'CBC NS', 'Global News']);
});

test('matches source names, ignoring case and accents', async ({ window }) => {
  await window.locator('#source-filter').fill('BBC');
  expect(await visibleSources(window)).toEqual(['BBC']);
  await window.locator('#source-filter').fill('ruv');
  expect(await visibleSources(window)).toEqual(['RÚV']);
  expect(await visibleGroups(window)).toEqual(['Iceland']);
});

test('several words narrow it down (country + name)', async ({ window }) => {
  await window.locator('#source-filter').fill('uk sky');
  expect(await visibleSources(window)).toEqual(['Sky News']);
});

test('opens collapsed groups while searching, and restores them after', async ({ window }) => {
  const iceland = window.locator('#source-groups .group[data-grp="Iceland"]');
  await iceland.locator('.fold').click();
  await expect(iceland).toHaveClass(/\bcollapsed\b/);
  await expect(iceland.locator('.source').first()).toBeHidden();

  await window.locator('#source-filter').fill('iceland');
  await expect(iceland.locator('.source', { hasText: 'Iceland Review' })).toBeVisible();

  await window.locator('#source-filter').press('Escape');
  await expect(window.locator('#source-filter')).toHaveValue('');
  await expect(iceland.locator('.source').first()).toBeHidden();     // still collapsed
});

test('no match says so; Esc brings everything back', async ({ window }) => {
  const all = (await visibleSources(window)).length;
  await window.locator('#source-filter').fill('zzzz');
  await expect(window.locator('#source-filter-empty')).toBeVisible();
  expect(await visibleSources(window)).toEqual([]);

  await window.locator('#source-filter').press('Escape');
  await expect(window.locator('#source-filter-empty')).toBeHidden();
  expect((await visibleSources(window)).length).toBe(all);
});

test('the filter survives the sidebar being rebuilt', async ({ window }) => {
  await window.locator('#source-filter').fill('canada');
  await window.evaluate(() => import('./sidebar.js').then(m => m.renderSources()));
  expect(await visibleSources(window)).toEqual(['CBC', 'CBC NS', 'Global News']);
});

test('a fresh install lists the Truth Social archive under its current name', async ({ window }) => {
  await window.locator('#source-filter').fill('trump');
  expect(await visibleSources(window)).toEqual(['Trump-Truth Social']);
  expect(await visibleGroups(window)).toEqual(['USA']);
});

// Sections

const allGroups = window => window.locator('#source-groups .group-head span').allTextContents();

test('groups are in sections: countries A -> Z, then areas, then other', async ({ window }) => {
  await expect(window.locator('#source-groups .group').first()).toBeVisible();
  const sections = window.locator('#source-groups > .source-section');
  await expect(sections.locator('.section-title')).toHaveText(['Countries', 'Areas', 'Other']);
  // One line between neighbouring sections.
  expect(await window.locator('#source-groups > .source-section + hr + .source-section + hr + .source-section').count()).toBe(1);

  const countries = await sections.nth(0).locator('.group-head span').allTextContents();
  expect(countries).toEqual([...countries].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
  expect(countries).toEqual(expect.arrayContaining(['USA', 'Canada', 'Iceland']));
  expect(countries).not.toContain('EU');
  expect(await sections.nth(1).locator('.group-head span').allTextContents()).toEqual(['EU', 'Pacific Islands']);
  expect(await sections.nth(2).locator('.group-head span').allTextContents()).toEqual(['Telegram', 'Wires & Search']);
});

test('section titles sit a step below the pane title', async ({ window }) => {
  const size = sel => window.locator(sel).first().evaluate(e => parseFloat(getComputedStyle(e).fontSize));
  expect(await size('#source-groups .section-title')).toBeLessThan(await size('.sidebar .pane-header .caps'));
});

test('searching hides empty sections and their lines', async ({ window }) => {
  await window.locator('#source-filter').fill('telegram');
  await expect(window.locator('#source-groups .section-title:visible')).toHaveText(['Other']);
  await expect(window.locator('#source-groups hr:visible')).toHaveCount(0);
  await window.locator('#source-filter').fill('');
  await expect(window.locator('#source-groups hr:visible')).toHaveCount(2);
  expect((await allGroups(window)).length).toBeGreaterThan(10);
});
