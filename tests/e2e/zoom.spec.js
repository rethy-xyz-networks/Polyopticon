'use strict';

// Ctrl + mouse wheel over an article / 4chan page zooms all pages, like a browser, and moves the
// Zoom setting with it. Electron reports the gesture as the webview's 'zoom-changed' event; the
// test raises that event in the main process (a real wheel over an off-screen page is unreliable).

const http = require('http');
const { test, expect } = require('./fixtures');

let server, base;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/feed') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Local</title>
        <item><title>Zoom story</title><link>${base}/a</link><guid>${base}/a</guid><pubDate>${new Date().toUTCString()}</pubDate></item>
      </channel></rss>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><p>Article</p></body></html>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => server?.close());

test('Ctrl+wheel zooms the page in and out, within the setting\'s range, and the slider follows', async ({ window, app }) => {
  await window.evaluate(url => window.polyopticon.saveSource({
    type: 'rss', name: 'Local Feed', grp: 'Test', category: 'T', color: '#555555', enabled: true, config: { url },
  }), `${base}/feed`);
  await window.locator('#feed-list .item', { hasText: 'Zoom story' }).dblclick({ timeout: 30_000 });
  const wv = window.locator('#webviews webview').first();
  await expect(wv).toBeVisible();
  await expect.poll(() => wv.evaluate(el => el.getZoomFactor())).toBe(1);

  const wheel = dir => app.evaluate(async ({ webContents }, d) => {
    const c = webContents.getAllWebContents().find(w => w.getType() === 'webview');
    c.emit('zoom-changed', {}, d);
    await new Promise(r => setTimeout(r, 30));                 // main drops repeats inside 20 ms
  }, dir);
  const zoom = () => wv.evaluate(el => el.getZoomFactor());
  const setting = () => window.evaluate(() => +document.querySelector('[data-setting="WebViewZoom"]').value);

  await wheel('in');
  await expect.poll(zoom).toBeCloseTo(1.1, 2);
  await expect.poll(setting).toBeCloseTo(1.1, 2);
  await wheel('out'); await wheel('out');
  await expect.poll(zoom).toBeCloseTo(0.9, 2);

  for (let i = 0; i < 12; i++) await wheel('out');
  await expect.poll(zoom).toBeCloseTo(0.5, 2);                 // floor
  for (let i = 0; i < 20; i++) await wheel('in');
  await expect.poll(zoom).toBeCloseTo(2, 2);                   // ceiling
  expect(window.pageErrors).toEqual([]);
});

test('a real Ctrl+wheel input event on the page zooms it', async ({ window, app }) => {
  await window.evaluate(url => window.polyopticon.saveSource({
    type: 'rss', name: 'Local Feed', grp: 'Test', category: 'T', color: '#555555', enabled: true, config: { url },
  }), `${base}/feed`);
  await window.locator('#feed-list .item', { hasText: 'Zoom story' }).dblclick({ timeout: 30_000 });
  const wv = window.locator('#webviews webview').first();
  await expect(wv).toBeVisible();
  await expect.poll(() => wv.evaluate(el => el.getZoomFactor())).toBe(1);
  await app.evaluate(({ webContents }) => {
    const c = webContents.getAllWebContents().find(w => w.getType() === 'webview');
    c.sendInputEvent({ type: 'mouseWheel', x: 50, y: 50, deltaX: 0, deltaY: 120, wheelTicksY: 1, modifiers: ['control'], canScroll: true });
  });
  await expect.poll(() => wv.evaluate(el => el.getZoomFactor()), { timeout: 5_000 }).toBeCloseTo(1.1, 2);
});

test('Ctrl+= / Ctrl+- / Ctrl+0 zoom in, out and reset — from the app and from inside the page', async ({ window, app }) => {
  await window.evaluate(url => window.polyopticon.saveSource({
    type: 'rss', name: 'Local Feed', grp: 'Test', category: 'T', color: '#555555', enabled: true, config: { url },
  }), `${base}/feed`);
  await window.locator('#feed-list .item', { hasText: 'Zoom story' }).dblclick({ timeout: 30_000 });
  const wv = window.locator('#webviews webview').first();
  await expect(wv).toBeVisible();
  const zoom = () => wv.evaluate(el => el.getZoomFactor());
  await expect.poll(zoom).toBe(1);

  // With the app focused.
  await window.locator('#feed-list').focus();
  await window.keyboard.press('Control+Equal');
  await expect.poll(zoom).toBeCloseTo(1.1, 2);
  await window.keyboard.press('Control+Shift+Equal');          // Ctrl + "+"
  await expect.poll(zoom).toBeCloseTo(1.2, 2);
  await window.keyboard.press('Control+Minus');
  await window.keyboard.press('Control+Minus');
  await window.keyboard.press('Control+Minus');
  await expect.poll(zoom).toBeCloseTo(0.9, 2);
  await window.keyboard.press('Control+Digit0');
  await expect.poll(zoom).toBe(1);

  // With the article page focused (main forwards the keys).
  const press = keyCode => wv.evaluate(v => v.getWebContentsId()).then(id => app.evaluate(({ webContents }, [id, keyCode]) => {
    const wc = webContents.fromId(id);
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['control'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['control'] });
  }, [id, keyCode]));
  await press('=');
  await expect.poll(zoom).toBeCloseTo(1.1, 2);
  await press('-'); await press('-');
  await expect.poll(zoom).toBeCloseTo(0.9, 2);
  await press('0');
  await expect.poll(zoom).toBe(1);
  await expect.poll(() => window.evaluate(() => +document.querySelector('[data-setting="WebViewZoom"]').value)).toBe(1);
  expect(window.pageErrors).toEqual([]);
});
