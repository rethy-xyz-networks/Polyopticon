'use strict';

// 📸 screenshots: the whole page shown in the article area — a story in Live, Saved page and
// Reader view, and a 4chan / Telegram tab — copied to the clipboard and saved as a PNG in the
// screenshot folder (Settings -> Article viewer). A local server supplies a tall article.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { test, expect } = require('./fixtures');

const PAGE_HEIGHT = 9000;           // taller than one capture slice (4000 px), so slices get joined
const PARAS = Array.from({ length: 60 }, (_, i) =>
  `<p>Paragraph ${i}: the council met again on Tuesday to discuss the bridge, the budget and the long list of repairs that residents have been asking about for several years now, and no decision was reached.</p>`).join('');

let server, base;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/feed') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Local</title>
        <item><title>Tall story</title><link>${base}/a/tall</link><guid>${base}/a/tall</guid><pubDate>${new Date().toUTCString()}</pubDate></item>
      </channel></rss>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Tall story page</title></head><body style="margin:0">
      <div style="height:200px;background:#ff0000"></div>
      <article><h1>Tall story</h1>${PARAS}</article>
      <div style="height:${PAGE_HEIGHT}px"></div>
      <div id="bottom" style="height:300px;background:#0000ff"></div></body></html>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => server?.close());

const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyopticon-shots-'));
test.use({ settings: { ScreenshotFolder: shotDir } });
test.beforeEach(() => { for (const f of fs.readdirSync(shotDir)) fs.rmSync(path.join(shotDir, f)); });
test.afterAll(() => fs.rmSync(shotDir, { recursive: true, force: true }));

/** Size of the image on the clipboard. */
const clipboardSize = app => app.evaluate(async ({ clipboard }) => {
  const item = (await clipboard.read()).find(i => i.types.includes('image/png'));
  if (!item) return null;
  const b = Buffer.from(await (await item.getType('image/png')).arrayBuffer());
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
});

const pngs = () => fs.readdirSync(shotDir).filter(f => f.endsWith('.png'));
const pngSize = file => { const b = fs.readFileSync(file); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; };

/** RGB of the pixel at the middle of the given row ('top' | 'bottom') of a saved PNG. */
const pixel = (app, file, where) => app.evaluate(({ nativeImage }, [file, where]) => {
  const img = nativeImage.createFromPath(file);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();                                   // BGRA
  const y = where === 'top' ? 20 : height - 20;
  const i = (y * width + Math.floor(width / 2)) * 4;
  return [bmp[i + 2], bmp[i + 1], bmp[i]];
}, [file, where]);

async function openStory(window) {
  const saved = await window.evaluate(url => window.polyopticon.saveSource({
    type: 'rss', name: 'Local Feed', grp: 'Test', category: 'T', color: '#555555', enabled: true, config: { url },
  }), `${base}/feed`);
  expect(saved.ok, saved.error).toBe(true);
  const row = window.locator('#feed-list .item', { hasText: 'Tall story' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.dblclick();
  await expect(window.locator('#btn-screenshot')).toBeEnabled({ timeout: 15_000 });
}

/** Takes a screenshot with the button; -> the new file's path. */
async function shoot(window) {
  const before = new Set(pngs());
  const added = () => pngs().filter(f => !before.has(f));
  await window.locator('#btn-screenshot').click();
  await expect.poll(added, { timeout: 30_000 }).toHaveLength(1);
  const file = path.join(shotDir, added()[0]);
  await expect(window.locator('#story-notice')).toContainText(`Screenshot copied to the clipboard and saved as ${file}`);
  await expect(window.locator('#btn-screenshot')).toBeEnabled();      // finished (the clipboard is written before the file)
  return file;
}

test('a story is captured whole in Live, Saved page and Reader view', async ({ app, window }) => {
  await openStory(window);

  // Live: the whole page, top to bottom, in the folder and on the clipboard.
  const live = await shoot(window);
  expect(path.basename(live)).toMatch(/^Tall story \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.png$/);
  const size = pngSize(live);
  expect(size.height).toBeGreaterThan(PAGE_HEIGHT);
  expect(size.height).toBeGreaterThan(size.width * 4);
  expect(await pixel(app, live, 'top')).toEqual([255, 0, 0]);
  expect(await pixel(app, live, 'bottom')).toEqual([0, 0, 255]);   // the last slice made it in
  expect(await clipboardSize(app)).toEqual(size);

  // Saved page (the MHTML copy, once the live page has been saved).
  await expect(window.locator('#save-state')).toHaveText(/^Saved/, { timeout: 30_000 });
  await window.locator('#view-modes button', { hasText: 'Saved page' }).click();
  await expect(window.locator('#btn-screenshot')).toBeEnabled({ timeout: 15_000 });
  const page = await shoot(window);
  expect(pngSize(page).height).toBeGreaterThan(PAGE_HEIGHT);
  expect(await pixel(app, page, 'bottom')).toEqual([0, 0, 255]);

  // Reader: the extracted text, all of it.
  await window.locator('#view-modes button', { hasText: 'Reader' }).click();
  await expect(window.locator('#btn-screenshot')).toBeEnabled({ timeout: 15_000 });
  const reader = await shoot(window);
  const r = pngSize(reader);
  const viewH = await window.locator('#webviews webview:not(.inactive)').evaluate(v => v.getBoundingClientRect().height);
  expect(r.height).toBeGreaterThan(viewH * 1.5);                   // more than what fits on screen
  expect(await clipboardSize(app)).toEqual(r);
  expect(window.pageErrors).toEqual([]);
});

test('Ctrl+Shift+S takes one too, and 4chan / Telegram tabs can be captured', async ({ window }) => {
  await window.evaluate(url => import('./tabs.js').then(m => m.openChanTab(url)), `${base}/pol/`);
  await expect(window.locator('#btn-screenshot')).toBeVisible();
  await expect(window.locator('#btn-screenshot')).toBeEnabled({ timeout: 15_000 });
  await window.locator('#search').focus();
  await window.keyboard.press('Control+Shift+S');
  await expect(window.locator('#story-notice')).toContainText('Screenshot copied', { timeout: 30_000 });
  await expect.poll(pngs).toHaveLength(1);
  expect(pngSize(path.join(shotDir, pngs()[0])).height).toBeGreaterThan(PAGE_HEIGHT);
});

test('no screenshot button on the app’s own pages', async ({ window }) => {
  await window.locator('#btn-scratch').click();
  await expect(window.locator('#btn-screenshot')).toBeHidden();
});

test('the screenshot folder is chosen with a folder picker and can go back to Pictures', async ({ app, window }) => {
  const other = path.join(shotDir, 'elsewhere');
  await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, other);
  await window.locator('#btn-settings').click();
  await expect(window.locator('#screenshot-folder')).toHaveText(shotDir);
  await window.locator('#btn-screenshot-folder').click();
  await expect(window.locator('#screenshot-folder')).toHaveText(other);

  await window.locator('#btn-screenshot-folder-reset').click();
  const pictures = await app.evaluate(({ app }) => app.getPath('pictures'));
  await expect(window.locator('#screenshot-folder')).toHaveText(pictures);
  await expect(window.locator('#btn-screenshot-folder-reset')).toBeHidden();
  expect(await window.evaluate(() => import('./state.js').then(m => m.state.settings.ScreenshotFolder))).toBe('');
});
