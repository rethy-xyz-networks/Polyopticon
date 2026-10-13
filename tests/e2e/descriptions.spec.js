'use strict';

// Story descriptions under the headlines, cut to the Story descriptions setting.

const { test, expect } = require('./fixtures');

const LONG = 'Officials said the talks would resume next week in Geneva, with both sides expected to bring new proposals on the ceasefire, prisoner exchanges and the reopening of border crossings that have been closed since the spring.';

async function addStories(window, stories) {
  await window.evaluate(async stories => {
    const feed = await import('./feed.js');
    const { state } = await import('./state.js');
    const s = state.sources[0];
    feed.ingest(stories.map((x, i) => ({ id: 8e8 + i, sourceId: s.id, sourceName: s.name, kind: 'article', places: [],
      url: `https://example.com/d/${i}`, publishedAt: Date.now() + 60e3 - i * 1000, ...x })), { fresh: false });
  }, stories);
}
const descOf = (window, title) => window.locator('#feed-list .item', { hasText: title }).locator('.snippet');

test('articles show their description, cut at a word to the set length', async ({ window }) => {
  await addStories(window, [{ title: 'Talks to resume', summary: LONG }]);
  const d = descOf(window, 'Talks to resume');
  await expect(d).toBeVisible();
  const text = await d.textContent();
  expect(text.endsWith('…')).toBe(true);
  expect(text.length).toBeLessThanOrEqual(160 + 1);                  // default 160 characters + …
  expect(LONG.startsWith(text.slice(0, -1))).toBe(true);             // a clean prefix, cut between words
  expect(LONG[text.length - 1]).toMatch(/[\s,]/);
});

test('short descriptions show in full; a repeated headline is dropped; empty ones show nothing', async ({ window }) => {
  await addStories(window, [
    { title: 'Short one', summary: 'Just a line.' },
    { title: 'Flooding in the north', summary: 'Flooding in the north. Rivers burst their banks overnight.' },
    { title: 'Same as title', summary: 'Same as title' },
    { title: 'No summary at all', summary: null },
  ]);
  await expect(descOf(window, 'Short one')).toHaveText('Just a line.');
  await expect(descOf(window, 'Flooding in the north')).toHaveText('Rivers burst their banks overnight.');
  await expect(descOf(window, 'Same as title')).toHaveCount(0);
  await expect(descOf(window, 'No summary at all')).toHaveCount(0);
});

test('posts keep showing the text after their first line, with the same limit', async ({ window }) => {
  await addStories(window, [{ kind: 'post', title: 'Breaking: explosion reported', summary: `Breaking: explosion reported\n${LONG}` }]);
  const text = await descOf(window, 'Breaking: explosion reported').textContent();
  expect(text.startsWith('Officials said')).toBe(true);
  expect(text.length).toBeLessThanOrEqual(161);
});

test('the setting changes the length of rows already shown, and 0 turns descriptions off', async ({ window }) => {
  await addStories(window, [{ title: 'Talks to resume', summary: LONG }]);
  const d = descOf(window, 'Talks to resume');
  await expect(d).toBeVisible();

  const set = v => window.evaluate(async v => (await import('./settings.js')).setSetting('DescriptionLength', v), v);
  await set(60);
  await expect.poll(async () => (await d.textContent()).length).toBeLessThanOrEqual(61);
  await set(400);
  await expect(d).toHaveText(LONG);                                   // fits entirely
  await set(0);
  await expect(d).toHaveCount(0);
  await expect(window.locator('#feed-list .item', { hasText: 'Talks to resume' })).toBeVisible();
});

test('the setting is in Settings -> Appearance and shows its value', async ({ window }) => {
  await window.locator('#btn-settings').click();
  const out = window.locator('output[data-for="DescriptionLength"]');
  await expect(out).toHaveText('160 characters');
  await window.locator('input[data-setting="DescriptionLength"]').fill('0');
  await expect(out).toHaveText('Off');
});
