'use strict';

// The Scratchpad's table of contents: a fixed column listing the note's Markdown headings,
// kept up to date as you type; clicking one scrolls the note to it.

const { test, expect } = require('./fixtures');

const filler = n => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
const NOTE = [
  '# Intro', filler(5),
  '## Details', filler(80),
  '```', '# not a heading (code)', '```',
  '### Deep part', filler(80),
  '#not a heading either',
  '# Last section ##', filler(60),
].join('\n');

test('the table of contents lists headings, updates as you type, and jumps to a heading', async ({ window }) => {
  await window.locator('#btn-scratch').click();
  const ta = window.locator('#scratch-view .scratch-text').last();
  const items = window.locator('.scratch-toc-item');
  const doc = window.locator('.scratch-doc');

  // Empty note: a hint, no entries.
  await expect(window.locator('.scratch-toc')).toBeVisible();
  await expect(window.locator('.scratch-toc-empty')).toBeVisible();
  await expect(items).toHaveCount(0);

  await ta.fill(NOTE);
  await expect(items).toHaveText(['Intro', 'Details', 'Deep part', 'Last section']);
  await expect(window.locator('.scratch-toc-empty')).toBeHidden();
  await expect(items.nth(0)).toHaveClass(/\bl1\b/);
  await expect(items.nth(1)).toHaveClass(/\bl2\b/);
  await expect(items.nth(2)).toHaveClass(/\bl3\b/);

  // Clicking scrolls the note so the heading is at the top, with the caret on it.
  const headingTop = name => window.evaluate(n => {
    const span = [...document.querySelectorAll('.scratch-mirror > .md-h')].find(s => s.textContent.includes(n));
    return span.getBoundingClientRect().top - document.querySelector('.scratch-doc').getBoundingClientRect().top;
  }, name);
  await items.filter({ hasText: 'Deep part' }).click();
  await expect.poll(() => headingTop('Deep part')).toBeLessThan(40);
  await expect.poll(() => headingTop('Deep part')).toBeGreaterThanOrEqual(0);
  const caretLine = await ta.evaluate(t => t.value.slice(t.selectionStart).split('\n')[0]);
  expect(caretLine).toBe('### Deep part');

  // The contents column stays put while the note scrolls.
  const tocBox = await window.locator('.scratch-toc').boundingBox();
  await doc.evaluate(d => { d.scrollTop = 0; });
  expect(await window.locator('.scratch-toc').boundingBox()).toEqual(tocBox);
  await items.filter({ hasText: 'Last section' }).click();
  await expect.poll(() => headingTop('Last section')).toBeLessThan(40);
  await items.filter({ hasText: 'Intro' }).click();
  await expect.poll(() => headingTop('Intro')).toBeLessThan(40);
  await expect.poll(() => headingTop('Intro')).toBeGreaterThanOrEqual(0);

  // Editing a heading updates the list.
  await ta.evaluate(t => {
    t.value = t.value.replace('## Details', '## Renamed details');
    t.dispatchEvent(new Event('input'));
  });
  await expect(items).toHaveText(['Intro', 'Renamed details', 'Deep part', 'Last section']);
  expect(window.pageErrors).toEqual([]);
});

test('a very long heading does not widen the table of contents', async ({ window }) => {
  await window.locator('#btn-scratch').click();
  const ta = window.locator('#scratch-view .scratch-text').last();
  const toc = window.locator('.scratch-toc');
  await ta.fill('# Short');
  await expect(window.locator('.scratch-toc-item')).toHaveText(['Short']);
  const { width } = await toc.boundingBox();

  await ta.fill(`# ${'Very long heading '.repeat(40)}\n## ${'x'.repeat(500)}`);
  await expect(window.locator('.scratch-toc-item')).toHaveCount(2);
  expect((await toc.boundingBox()).width).toBe(width);
  // The note keeps the rest of the row.
  expect((await window.locator('.scratch-doc').boundingBox()).width).toBeGreaterThan(width);
  expect(window.pageErrors).toEqual([]);
});
