'use strict';

// Feeds behind HTTP Basic auth (login in the URL, like Canadian Press syndication):
// the feed must load, and its article links — on the same protected site — must
// open with the same login. Runs against a local server with dummy credentials.

const http = require('http');
const { test, expect } = require('./fixtures');

const USER = 'tester', PASS = 'not-a-real-password';

let server, base;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const expected = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Login Required"', 'Content-Type': 'text/html' });
      return res.end('Could not verify your access');
    }
    if (req.url === '/feed' || req.url === '/feed-broken') {
      const link = req.url === '/feed' ? `${base}/article/1` : `${base}/missing/1`;
      const title = req.url === '/feed' ? 'Protected wire story' : 'Story with a dead link';
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Protected</title>
        <item><title>${title}</title><link>${link}</link><guid>${link}</guid>
        <description>Summary</description><pubDate>${new Date().toUTCString()}</pubDate></item>
      </channel></rss>`);
    }
    if (req.url.startsWith('/missing')) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<p>Not found</p>'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const para = 'The full protected article text continues with enough detail for the reader view to pick it up. ';
    res.end(`<html><head><title>Full protected article</title></head><body><article><h1>Full protected article</h1>
      ${Array.from({ length: 8 }, () => `<p>${para.repeat(3)}</p>`).join('')}</article></body></html>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => server?.close());

const addSource = (window, name, path) => window.evaluate(([name, url]) => window.polyopticon.saveSource({
  type: 'rss', name, grp: 'Canada', category: 'CA', color: '#1F3A5F', enabled: true, config: { url },
}), [name, base.replace('//', `//${USER}:${PASS}@`) + path]);

const modeButton = (window, label) => window.locator('#view-modes button', { hasText: label });

test('login in a feed URL is used for the feed and for its article pages', async ({ app, window }) => {
  const saved = await addSource(window, 'Protected Wire', '/feed');
  expect(saved.ok, saved.error).toBe(true);

  // The feed loads (credentials moved from the URL into an Authorization header).
  const row = window.locator('.item', { hasText: 'Protected wire story' });
  await expect(row).toBeVisible({ timeout: 30_000 });

  // The article opens in the viewer with the same login, not the 401 page.
  await row.dblclick();
  await expect.poll(() => app.evaluate(async ({ webContents }) => {
    const view = webContents.getAllWebContents().find(w => w.getType() === 'webview' && w.getURL().includes('/article/1'));
    return view ? view.executeJavaScript('document.body?.innerText ?? ""').catch(() => '') : '';
  }), { timeout: 20_000 }).toContain('Full protected article');

  // The offline copy is the real article: Reader is available and shows its text.
  await expect(window.locator('#save-state')).toHaveText(/^Saved/, { timeout: 20_000 });
  await expect(modeButton(window, 'Reader')).toBeEnabled();
  await expect(modeButton(window, 'Saved page')).toBeEnabled();
});

test('an error page (HTTP 4xx) is never kept as the saved copy', async ({ window }) => {
  const saved = await addSource(window, 'Broken Wire', '/feed-broken');
  expect(saved.ok, saved.error).toBe(true);
  const row = window.locator('.item', { hasText: 'Story with a dead link' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.dblclick();

  // Give the save a fair chance to happen (it runs a few seconds after load), then check it didn't.
  await window.waitForTimeout(8_000);
  await expect(window.locator('#save-state')).toHaveText('Not saved');
  await expect(modeButton(window, 'Reader')).toBeDisabled();
  await expect(modeButton(window, 'Saved page')).toBeDisabled();
});
