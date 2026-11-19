'use strict';

// Right-click inside an article page shows the app's own menu (.ctx-menu, like the IRC chat's),
// not a native one, at the click, and its items act on the page.

const http = require('http');
const { test, expect } = require('./fixtures');

let server, base;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/feed') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Local</title>
        <item><title>Menu story</title><link>${base}/a</link><guid>${base}/a</guid><pubDate>${new Date().toUTCString()}</pubDate></item>
      </channel></rss>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body style="margin:0"><p style="margin:40px">Article body text</p></body></html>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => server?.close());

test('right-click in an article shows the app menu at the click; Select all and Copy work', async ({ window, app }) => {
  await window.evaluate(url => window.polyopticon.saveSource({
    type: 'rss', name: 'Local Feed', grp: 'Test', category: 'T', color: '#555555', enabled: true, config: { url },
  }), `${base}/feed`);
  await window.locator('#feed-list .item', { hasText: 'Menu story' }).dblclick({ timeout: 30_000 });
  const wv = window.locator('#webviews webview').first();
  await expect(wv).toBeVisible();
  await expect.poll(() => wv.evaluate(el => { try { return !el.isLoading() && el.getURL(); } catch { return false; } })).toBeTruthy();

  const rightClick = async (x, y) => {                           // a real right-click, through the window like a mouse
    const box = await wv.boundingBox();
    await window.mouse.click(box.x + x, box.y + y, { button: 'right' });
  };
  const menu = window.locator('.ctx-menu:not(.closing)');

  await expect(async () => {                                      // the page takes input once it's fully attached
    await rightClick(60, 50);
    await expect(menu.locator('button')).toHaveText(['Copy', 'Select all'], { timeout: 1_000 });
  }).toPass();
  await expect(menu.locator('button', { hasText: 'Copy' })).toBeDisabled();   // nothing selected yet, like the IRC menu
  await expect(menu).not.toHaveClass(/closing/);
  await window.waitForTimeout(400);                               // its slide-in is over
  const box = await wv.boundingBox(), at = await menu.boundingBox();
  expect(Math.abs(at.x - (box.x + 60))).toBeLessThan(4);          // drawn where the click was
  expect(Math.abs(at.y - (box.y + 50))).toBeLessThan(4);
  await menu.locator('button', { hasText: 'Select all' }).click();
  await expect(menu).toHaveCount(0);
  await expect.poll(() => wv.evaluate(el => el.executeJavaScript('getSelection().toString().trim()'))).toBe('Article body text');

  await rightClick(60, 50);
  await expect(menu.locator('button')).toHaveText(['Copy', 'Select all']);
  await expect(menu.locator('button', { hasText: 'Copy' })).toBeEnabled();
  await expect(menu.locator('.sep')).toHaveCount(0);              // no line between them, like the IRC menu
  await menu.locator('button', { hasText: 'Copy' }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()).then(t => t.trim())).toBe('Article body text');

  await rightClick(60, 50);
  await expect(menu).toHaveCount(1);
  await window.waitForTimeout(100);                               // its key handler is set up on the next tick
  await window.keyboard.press('Escape');                          // the menu has the focus
  await expect(menu).toHaveCount(0);
  expect(window.pageErrors).toEqual([]);
});
