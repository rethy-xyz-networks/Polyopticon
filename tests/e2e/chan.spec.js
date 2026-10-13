'use strict';

// 4chan tabs (the 🍀 button). A local server stands in for 4chan, so the tests
// don't depend on the internet.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { test, expect } = require('./fixtures');

let server, base;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head><title>Page ${req.url}</title></head><body style="margin:0">
      <a id="thread" href="/pol/thread/123/test-thread" style="display:block;height:40px">Thread</a>
      <a id="other" href="/elsewhere" style="display:block;height:40px">Somewhere else</a></body></html>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => server?.close());

const tabs = window => window.locator('#tabs .tab');
const activeLabel = window => window.locator('#tabs .tab.active .label');
const activeView = window => window.locator('#webviews webview:not(.inactive)');
const openChan = (window, url) => window.evaluate(url => import('./tabs.js').then(m => m.openChanTab(url)), url);

/** A real middle-click on a link in the visible page. */
async function middleClick(app, window, linkId) {
  const id = await activeView(window).evaluate(v => v.getWebContentsId());
  await app.evaluate(async ({ webContents }, [id, linkId]) => {
    const wc = webContents.fromId(id);
    const r = await wc.executeJavaScript(`(r => ({ x: r.left + 5, y: r.top + 5 }))(document.getElementById('${linkId}').getBoundingClientRect())`);
    const at = { x: Math.round(r.x), y: Math.round(r.y), button: 'middle', clickCount: 1 };
    wc.sendInputEvent({ type: 'mouseDown', ...at });
    wc.sendInputEvent({ type: 'mouseUp', ...at });
  }, [id, linkId]);
}

test('the 🍀 button sits left of the theme button and opens /pol/ as one tab', async ({ window }) => {
  expect(await window.locator('.tool-buttons > #btn-chan + #btn-theme').count()).toBe(1);
  await expect(window.locator('#btn-chan').locator('svg')).toHaveAttribute('data-icon', 'chan');

  await window.locator('#btn-chan').click();
  await expect(tabs(window)).toHaveCount(1);
  await expect(window.locator('#tabs .tab.active .tab-mode').locator('svg')).toHaveAttribute('data-icon', 'chan');
  await expect(activeView(window)).toHaveAttribute('src', 'https://boards.4chan.org/pol/');
  await expect(activeView(window)).toHaveAttribute('partition', 'chan');

  // Live only: Back / Reload / Forward, no saving, view modes or translation — but it can be pinned.
  await expect(window.locator('#btn-reload')).toBeVisible();
  for (const id of ['#save-state', '#view-modes', '#btn-translate']) await expect(window.locator(id)).toBeHidden();
  await expect(window.locator('#btn-pin')).toBeVisible();

  await window.locator('#btn-chan').click();                        // same tab again, not a second one
  await expect(tabs(window)).toHaveCount(1);
});

test('middle-clicking any link in a 4chan tab opens it as a new background tab', async ({ app, window }) => {
  await openChan(window, `${base}/pol/`);
  await expect(activeLabel(window)).toHaveText('Page /pol/');        // named after the page title

  await middleClick(app, window, 'thread');
  await expect(tabs(window)).toHaveCount(2);
  await expect(tabs(window).nth(1)).toContainText('/pol/ 123');
  await expect(activeLabel(window)).toHaveText('Page /pol/');        // stayed on the board

  await middleClick(app, window, 'other');
  await expect(tabs(window)).toHaveCount(3);
  await middleClick(app, window, 'thread');                           // already open: no duplicate
  await window.waitForTimeout(500);
  await expect(tabs(window)).toHaveCount(3);

  await tabs(window).nth(1).click();
  await expect(activeView(window)).toHaveAttribute('partition', 'chan');
  await expect(activeLabel(window)).toHaveText('Page /pol/thread/123/test-thread');
});

test('4chan pages are never saved', async ({ window, dataDir }) => {
  await openChan(window, `${base}/pol/`);
  await expect(activeLabel(window)).toHaveText('Page /pol/');
  await window.waitForTimeout(4500);                                  // longer than the article save delay
  const dir = path.join(dataDir, 'snapshots');
  expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);

  // Even a direct request to save the page is refused.
  const id = await activeView(window).evaluate(v => v.getWebContentsId());
  expect(await window.evaluate(id => window.polyopticon.captureTab(-2, id), id)).toBeNull();
});

test('4chan tabs run on a memory-only session (no cookies or cache on disk)', async ({ app, window }) => {
  await openChan(window, `${base}/pol/`);
  await expect(activeLabel(window)).toHaveText('Page /pol/');
  const opened = await app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().filter(w => w.getType() === 'webview').map(w => w.session.getStoragePath()));
  expect(opened).toEqual([null]);
});

test('the 🍀 button can be turned off in Settings -> General, and the choice is saved', async ({ window, dataDir }) => {
  const btn = window.locator('#btn-chan');
  await expect(btn).toBeVisible();
  await window.locator('#btn-settings').click();
  const toggle = window.locator('[data-setting="ShowChanButton"]');
  await expect(toggle).toBeChecked();
  await toggle.locator('xpath=..').click();                             // the switch's label
  await expect(toggle).not.toBeChecked();
  await expect(btn).toBeHidden();
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).ShowChanButton).toBe(false);

  await toggle.locator('xpath=..').click();
  await expect(btn).toBeVisible();
});
