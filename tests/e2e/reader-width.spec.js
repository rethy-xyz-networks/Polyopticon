'use strict';

// The Reader text width setting: a readable column, or the full width of the tab.
// Applies to Reader tabs already open (in place) and to ones opened afterwards.

const http = require('http');
const { test, expect } = require('./fixtures');

let server, base;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/feed') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Reader</title>
        <item><title>Long read for the reader</title><link>${base}/article</link><guid>${base}/article</guid>
        <description>Summary</description><pubDate>${new Date().toUTCString()}</pubDate></item>
      </channel></rss>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const para = 'The article text goes on with enough detail for the reader view to pick it up and lay it out in paragraphs. ';
    res.end(`<html><head><title>Long read</title></head><body><article><h1>Long read for the reader</h1>
      ${Array.from({ length: 8 }, () => `<p>${para.repeat(3)}</p>`).join('')}</article></body></html>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => server?.close());

/** Widths of the reader page's text column and of the page, from inside the Reader tab. */
const readerWidths = app => app.evaluate(async ({ webContents }) => {
  const view = webContents.getAllWebContents().find(w => w.getURL().startsWith('polyopticon-reader://'));
  return view ? view.executeJavaScript('({ main: document.querySelector("main").getBoundingClientRect().width, page: innerWidth })').catch(() => null) : null;
});

test('Reader text is a column by default, fills the tab when set to Full width, and switches back', async ({ app, window }) => {
  const saved = await window.evaluate(url => window.polyopticon.saveSource({
    type: 'rss', name: 'Reader Feed', grp: 'Test', category: 'T', color: '#1F3A5F', enabled: true, config: { url },
  }), `${base}/feed`);
  expect(saved.ok, saved.error).toBe(true);
  const row = window.locator('#feed-list .item', { hasText: 'Long read for the reader' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.dblclick();
  await expect(window.locator('#save-state')).toHaveText(/^Saved/, { timeout: 30_000 });
  await window.locator('#view-modes button', { hasText: 'Reader' }).click();

  const set = v => window.evaluate(async v => (await import('./settings.js')).setSetting('ReaderWidth', v), v);
  await expect.poll(async () => (await readerWidths(app))?.main ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  let w = await readerWidths(app);
  expect(w.page).toBeGreaterThan(900);                               // room for the difference to show
  expect(w.main).toBeLessThanOrEqual(42 * 16 + 48 + 1);              // the 42rem column, plus its side padding

  await set(1);                                                       // open tab changes in place
  await expect.poll(async () => (await readerWidths(app)).main).toBeGreaterThan(w.page - 20);

  // A Reader tab opened afterwards starts at the setting's width.
  await window.locator('#view-modes button', { hasText: 'Live' }).click();
  await window.locator('#view-modes button', { hasText: 'Reader' }).click();
  await expect.poll(async () => (await readerWidths(app))?.main ?? 0, { timeout: 15_000 }).toBeGreaterThan(w.page - 20);

  await set(0);
  await expect.poll(async () => (await readerWidths(app)).main).toBeLessThanOrEqual(42 * 16 + 48 + 1);
  expect(window.pageErrors).toEqual([]);
});
