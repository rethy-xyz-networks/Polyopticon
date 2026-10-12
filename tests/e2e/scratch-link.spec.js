'use strict';

// The 📝 button on any page's bar adds a Markdown link to that page at the end of the
// Scratchpad and saves it. It follows the page as you navigate; the app's own tabs don't have it.

const http = require('http');
const { test, expect } = require('./fixtures');

let server, base;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/feed') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Local</title>
        <item><title>Linked [story]</title><link>${base}/a</link><guid>${base}/a</guid><pubDate>${new Date().toUTCString()}</pubDate></item>
      </channel></rss>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(req.url === '/next'
      ? '<html><head><title>Next page</title></head><body><p>Next</p></body></html>'
      : '<html><head><title>Article</title></head><body><a id="next" href="/next">Next page</a></body></html>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => server?.close());

const note = window => window.evaluate(() => window.polyopticon.loadScratch()).then(n => n.text);

test('📝 adds the page\'s link to the Scratchpad, following navigation; app tabs have no button', async ({ window }) => {
  // The note already has text: the link goes on a line of its own after it.
  await window.locator('#btn-scratch').click();
  await window.locator('#scratch-view .scratch-text').last().fill('My notes');
  await expect.poll(() => note(window)).toBe('My notes');
  await expect(window.locator('#btn-scratch-link')).toBeHidden();             // not on the Scratchpad itself

  await window.evaluate(url => window.polyopticon.saveSource({
    type: 'rss', name: 'Local Feed', grp: 'Test', category: 'T', color: '#555555', enabled: true, config: { url },
  }), `${base}/feed`);
  await window.locator('#feed-list .item', { hasText: 'Linked [story]' }).dblclick({ timeout: 30_000 });
  const btn = window.locator('#btn-scratch-link');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('title', 'Add link to Scratchpad');

  await btn.click();                                                         // brackets dropped from the title
  await expect.poll(() => note(window)).toBe(`My notes\n[Linked story](${base}/a)`);

  // Follow a link in the page: the button adds where the page now is.
  const wv = window.locator('#webviews webview:not(.inactive)');
  await expect.poll(() => wv.evaluate(v => { try { return v.getURL(); } catch { return ''; } })).toBe(`${base}/a`);
  await wv.evaluate(v => v.executeJavaScript('document.getElementById("next").click()'));
  await expect.poll(() => wv.evaluate(v => v.getURL())).toBe(`${base}/next`);
  await btn.click();
  await expect.poll(() => note(window)).toBe(`My notes\n[Linked story](${base}/a)\n[Next page](${base}/next)`);

  // The open Scratchpad shows the added lines.
  await window.locator('#btn-scratch').click();
  await expect(window.locator('#scratch-view .scratch-text').last()).toHaveValue(`My notes\n[Linked story](${base}/a)\n[Next page](${base}/next)`);
  expect(window.pageErrors).toEqual([]);
});
