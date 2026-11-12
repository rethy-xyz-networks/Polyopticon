'use strict';

// Hiding and showing the Sources & Filters View and the Article List View (toolbar buttons,
// Ctrl+Shift+F / Ctrl+Shift+E). The Article View takes the room and its page isn't reloaded;
// Ctrl+F / Ctrl+H bring the list back; the choice is remembered at the next start.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { test, expect, _electron: electron } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..', '..');

let server, base, hits = 0;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/page') hits++;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head><title>Page ${req.url}</title></head><body>Hello</body></html>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => server?.close());

const launch = dir => electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, POLYOPTICON_DATA_DIR: dir, POLYOPTICON_OFFSCREEN: '1', POLYOPTICON_NO_PREFETCH: '1' } });
const width = (window, sel) => window.locator(sel).evaluate(el => Math.round(el.getBoundingClientRect().width));

async function started(app) {
  const window = await app.firstWindow();
  await expect(window.locator('#status-text')).not.toHaveText('Connecting…');
  return window;
}

test('the Sources & Filters and Article List views hide and show, and are remembered', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyopticon-layout-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ChatDestiny: false, ChatTwitchChannels: '', ChatIrc: '', TranslateLargeModel: false }));
  try {
    let app = await launch(dir);
    let window = await started(app);
    // The buttons sit between Refresh and Chat, both on.
    expect(await window.locator('#btn-refresh + #btn-sidebar + #btn-list + #btn-chat').count()).toBe(1);
    await expect(window.locator('#btn-sidebar')).toHaveClass(/\bon\b/);
    await expect(window.locator('#btn-list')).toHaveClass(/\bon\b/);
    await expect(window.locator('#btn-sidebar svg')).toHaveAttribute('data-icon', 'sidebar');
    await expect(window.locator('#btn-list svg')).toHaveAttribute('data-icon', 'article-list');

    // A page open in the Article View.
    await window.evaluate(url => import('./tabs.js').then(m => m.openChanTab(url)), `${base}/page`);
    await expect(window.locator('#tabs .tab.active .label')).toHaveText('Page /page');
    await expect.poll(() => hits).toBe(1);

    const side0 = await width(window, '.pane.sidebar');
    const feed0 = await width(window, '.pane.feed');
    const story0 = await width(window, '.pane.story');

    // Sources & Filters: hidden by its button, the Article View takes the room.
    await window.locator('#btn-sidebar').click();
    await expect(window.locator('#btn-sidebar')).not.toHaveClass(/\bon\b/);
    await expect(window.locator('.pane.sidebar')).toBeHidden();
    expect(await width(window, '.pane.sidebar')).toBe(0);
    expect(await width(window, '.pane.story')).toBeGreaterThanOrEqual(story0 + side0);
    await window.keyboard.press('Control+Shift+F');                           // and back by shortcut
    await expect(window.locator('.pane.sidebar')).toBeVisible();
    expect(await width(window, '.pane.story')).toBe(story0);

    // Article List: hidden by its shortcut, the Article View takes its width too.
    await window.locator('#feed-list').focus();
    await window.keyboard.press('Control+Shift+E');
    await expect(window.locator('#btn-list')).not.toHaveClass(/\bon\b/);
    await expect(window.locator('.pane.feed')).toBeHidden();
    expect(await width(window, '.pane.feed')).toBe(0);
    expect(await width(window, '.pane.story')).toBeGreaterThanOrEqual(story0 + feed0);
    expect(await window.evaluate(() => !!document.activeElement?.closest('.pane.feed'))).toBe(false);   // it let go of the keyboard
    // Both hidden at once: the Article View has the whole width (but for the one bar).
    await window.locator('#btn-sidebar').click();
    expect(await width(window, '.pane.story')).toBeGreaterThanOrEqual(story0 + feed0 + side0);
    await window.locator('#btn-sidebar').click();
    expect(hits).toBe(1);                                                     // the page never reloaded

    // Searching the stories brings the list back, with the search box focused.
    await window.keyboard.press('Control+f');
    await expect(window.locator('.pane.feed')).toBeVisible();
    await expect(window.locator('#search')).toBeFocused();
    expect(await width(window, '.pane.story')).toBe(story0);
    // As does switching Live / History.
    await window.locator('#btn-list').click();
    await window.keyboard.press('Control+h');
    await expect(window.locator('.pane.feed')).toBeVisible();
    await expect(window.locator('#history-list')).toBeVisible();

    // Hidden at close -> hidden at the next start.
    await window.locator('#btn-sidebar').click();
    await window.locator('#btn-list').click();
    await app.close();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'ui.json'), 'utf8'))).toMatchObject({ sidebarHidden: true, listHidden: true });

    app = await launch(dir);
    window = await started(app);
    await expect(window.locator('.pane.sidebar')).toBeHidden();
    await expect(window.locator('.pane.feed')).toBeHidden();
    await expect(window.locator('.pane.story')).toBeVisible();
    await expect(window.locator('#btn-sidebar')).toHaveAttribute('title', /Show the Sources & Filters/);
    await expect(window.locator('#btn-list')).toHaveAttribute('title', /Show the Article List/);
    await app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
