'use strict';

// Ad blocking in article and 4chan pages: the filter lists (EasyList etc.) block
// ad scripts by URL and hide ad slots on the page. The lists are downloaded on
// first launch (then shared between tests, see fixtures.js).
//
// Pages are served as http://adtest.example/ through the local server acting as
// the page sessions' proxy: the lists carry no page rules for bare IPs/localhost.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { test, expect } = require('./fixtures');

const SITE = 'http://adtest.example';
let server, base, hits;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, base).pathname;       // proxied requests carry the full URL
    hits.push(url);
    if (url === '/feed') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Local</title>
        <item><title>Ad test story</title><link>${SITE}/article</link><guid>${SITE}/article</guid>
        <pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`);
    }
    if (url.endsWith('.js')) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(''); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head><title>Ad test</title><script src="/gpt.js"></script></head><body>
      <p id="text">Article text</p>
      <ins id="ad" class="adsbygoogle" data-ad-client="ca-pub-1" style="display:block;height:90px"></ins></body></html>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => server?.close());
test.beforeEach(() => { hits = []; });

/** Waits until the filter lists are on disk (downloaded or copied in), then lets the app load them. */
async function listsReady(app, window, dataDir) {
  await app.evaluate(({ session }, proxy) => Promise.all(['persist:articles', 'chan'].map(p =>
    session.fromPartition(p).setProxy({ proxyRules: proxy }))), `http=${base.replace('http://', '')}`);
  const file = path.join(dataDir, 'adblock-lists.bin');
  try { await expect.poll(() => fs.existsSync(file), { timeout: 60_000 }).toBe(true); }
  catch { test.skip(true, 'filter lists could not be downloaded (offline?)'); }
  await window.waitForTimeout(1000);
}

const pageCheck = (app, window) => async js => {
  const id = await window.locator('#webviews webview:not(.inactive)').evaluate(v => v.getWebContentsId());
  return app.evaluate(({ webContents }, [id, js]) => webContents.fromId(id).executeJavaScript(js), [id, js]);
};

async function expectBlocked(app, window) {
  const run = pageCheck(app, window);
  await expect.poll(() => run(`document.getElementById('text')?.textContent ?? null`)).toBe('Article text');
  await expect.poll(() => run(`getComputedStyle(document.getElementById('ad')).display`)).toBe('none');
  expect(hits.filter(u => u === '/gpt.js')).toEqual([]);
}

test('ads are blocked in article pages', async ({ app, window, dataDir }) => {
  await listsReady(app, window, dataDir);
  const saved = await window.evaluate(url => window.polyopticon.saveSource({
    type: 'rss', name: 'Local Feed', grp: 'Test', category: 'T', color: '#555555', enabled: true, config: { url },
  }), `${base}/feed`);
  expect(saved.ok, saved.error).toBe(true);
  const row = window.locator('#feed-list .item', { hasText: 'Ad test story' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.dblclick();
  await expectBlocked(app, window);
});

test('ads are blocked in 4chan pages', async ({ app, window, dataDir }) => {
  await listsReady(app, window, dataDir);
  await window.evaluate(url => import('./tabs.js').then(m => m.openChanTab(url)), `${SITE}/pol/`);
  await expectBlocked(app, window);
});
