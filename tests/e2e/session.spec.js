'use strict';

// Every open tab in the article area (articles, 4chan and Telegram pages, the Scratchpad, the shortcut
// list) is remembered when the app closes and comes back at the next start, in order, pinned or not,
// with the tab that was selected selected again. A local feed supplies the article.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { test, expect, _electron: electron } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..', '..');

let server, base;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/feed') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Local</title>
        <item><title>Alpha story</title><link>${base}/a/1</link><guid>${base}/a/1</guid><pubDate>${new Date().toUTCString()}</pubDate></item>
      </channel></rss>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body><p>Article ${req.url}</p></body></html>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => server?.close());

const launch = dir => electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, POLYOPTICON_DATA_DIR: dir, POLYOPTICON_OFFSCREEN: '1' } });

test('open tabs are saved on close and resumed on open, with the selected one selected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyopticon-session-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ TranslateEnabled: false, ChatDestiny: false, ChatTwitchChannels: '', ChatIrc: '' }));
  const labels = window => window.locator('#tabs .tab .label');
  try {
    // First session: an article, a Telegram channel, the Scratchpad, the shortcut list (pinned)
    let app = await launch(dir);
    let window = await app.firstWindow();
    await expect(window.locator('#status-text')).not.toHaveText('Connecting…');
    const saved = await window.evaluate(url => window.polyopticon.saveSource({
      type: 'rss', name: 'Local Feed', grp: 'Test', category: 'T', color: '#555555', enabled: true, config: { url },
    }), `${base}/feed`);
    expect(saved.ok, saved.error).toBe(true);
    const row = window.locator('#feed-list .item', { hasText: 'Alpha story' });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.dblclick();
    await window.locator('#btn-telegram').click();
    await window.locator('#tg-channel').fill('@durov');
    await window.locator('#tg-channel').press('Enter');
    await window.locator('#btn-scratch').click();
    await window.locator('#btn-help').click();
    await window.locator('#btn-pin').click();                              // pins the shortcut list
    await window.locator('#tabs .tab', { hasText: 'Scratchpad' }).click();  // the selected tab at close
    await expect(labels(window)).toHaveText(['Keyboard shortcuts', 'Alpha story', /durov/i, 'Scratchpad']);
    await app.close();

    // Second session: all of them are back
    app = await launch(dir);
    window = await app.firstWindow();
    await expect(labels(window)).toHaveText(['Keyboard shortcuts', 'Alpha story', /durov/i, 'Scratchpad'], { timeout: 30_000 });
    await expect(window.locator('#tabs .tab.pinned')).toHaveCount(1);
    await expect(window.locator('#tabs .tab.pinned .label')).toHaveText('Keyboard shortcuts');
    await expect(window.locator('#tabs .tab.active .label')).toHaveText('Scratchpad');
    await expect(window.locator('#scratch-view')).toBeVisible();

    // Closing a tab is remembered too.
    await window.locator('#tabs .tab', { hasText: 'Alpha story' }).click();
    await window.keyboard.press('Control+w');
    await expect(labels(window)).toHaveCount(3);
    await app.close();

    app = await launch(dir);
    window = await app.firstWindow();
    await expect(labels(window)).toHaveText(['Keyboard shortcuts', /durov/i, 'Scratchpad'], { timeout: 30_000 });
    await app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
