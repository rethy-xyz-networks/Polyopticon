'use strict';

// Tab keyboard shortcuts and the start view. A local feed supplies the stories,
// so the tabs don't depend on the internet.

const http = require('http');
const { test, expect } = require('./fixtures');

const TITLES = ['Alpha story', 'Bravo story', 'Charlie story', 'Delta story'];

let server, base;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/feed') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Local</title>${TITLES.map((t, i) => `
        <item><title>${t}</title><link>${base}/a/${i}</link><guid>${base}/a/${i}</guid>
        <pubDate>${new Date(Date.now() - i * 60e3).toUTCString()}</pubDate></item>`).join('')}
      </channel></rss>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body><p>Article ${req.url}</p><a id="next" href="/next${req.url}">Next page</a> <a id="more" href="#more">More</a></body></html>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => server?.close());

const activeLabel = window => window.locator('#tabs .tab.active .label');

async function openAll(window) {
  const saved = await window.evaluate(url => window.polyopticon.saveSource({
    type: 'rss', name: 'Local Feed', grp: 'Test', category: 'T', color: '#555555', enabled: true, config: { url },
  }), `${base}/feed`);
  expect(saved.ok, saved.error).toBe(true);
  for (const t of TITLES) {
    const row = window.locator('#feed-list .item', { hasText: t });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.dblclick();
    await expect(activeLabel(window)).toHaveText(t);
  }
  await expect(window.locator('#tabs .tab')).toHaveCount(TITLES.length);
}

test('opens on the map, with no "Story" label in the tab strip', async ({ window }) => {
  await expect(window.locator('#map-view')).toBeVisible();
  await expect(window.locator('#btn-map')).toHaveClass(/\bon\b/);
  await expect(window.locator('.tabstrip')).not.toContainText('Story');
});

test('Ctrl+PgDown / Ctrl+PgUp move through tabs and wrap around', async ({ window }) => {
  await openAll(window);
  await window.locator('#feed-list').focus();
  await expect(activeLabel(window)).toHaveText('Delta story');

  await window.keyboard.press('Control+PageDown');
  await expect(activeLabel(window)).toHaveText('Alpha story');      // wrapped past the end
  await window.keyboard.press('Control+PageDown');
  await expect(activeLabel(window)).toHaveText('Bravo story');
  await window.keyboard.press('Control+PageUp');
  await window.keyboard.press('Control+PageUp');
  await expect(activeLabel(window)).toHaveText('Delta story');      // wrapped past the start
});

test('Alt+N picks the Nth tab after the pinned ones', async ({ window }) => {
  await openAll(window);
  // Pin Charlie: tab order becomes Charlie (pinned), Alpha, Bravo, Delta.
  await window.locator('#tabs .tab', { hasText: 'Charlie story' }).click();
  await window.locator('#btn-pin').click();
  await expect(window.locator('#tabs .tab.pinned')).toHaveText(/Charlie story/);
  await window.locator('#feed-list').focus();

  await window.keyboard.press('Alt+1');
  await expect(activeLabel(window)).toHaveText('Alpha story');
  await window.keyboard.press('Alt+3');
  await expect(activeLabel(window)).toHaveText('Delta story');
  await window.keyboard.press('Alt+9');                              // no 9th tab: nothing changes
  await expect(activeLabel(window)).toHaveText('Delta story');

  // Ctrl+PgUp from the first unpinned tab reaches the pinned one.
  await window.keyboard.press('Alt+1');
  await window.keyboard.press('Control+PageUp');
  await expect(activeLabel(window)).toHaveText('Charlie story');
});

// Keys typed inside an article never reach the app window; main catches and forwards them.
// They're sent straight to the article's web contents, the way a real keystroke in the page arrives.
test('tab shortcuts also work while an article page has focus', async ({ app, window }) => {
  await openAll(window);
  const press = async (keyCode, modifiers) => {
    const id = await window.locator('#webviews webview:not(.inactive)').evaluate(v => v.getWebContentsId());
    await app.evaluate(({ webContents }, [id, keyCode, modifiers]) => {
      const wc = webContents.fromId(id);
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    }, [id, keyCode, modifiers]);
  };
  await press('2', ['alt']);
  await expect(activeLabel(window)).toHaveText('Bravo story');
  await press('PageDown', ['control']);
  await expect(activeLabel(window)).toHaveText('Charlie story');
});

// Keyboard shortcut list

test('Ctrl+? and the ? button open the shortcut list as one tab', async ({ window }) => {
  // The ? button sits right after the theme button.
  expect(await window.locator('#btn-theme + #btn-help').count()).toBe(1);

  await window.keyboard.press('Control+Shift+Slash');               // Ctrl+? on a US layout
  await expect(activeLabel(window)).toHaveText('Keyboard shortcuts');
  await expect(window.locator('#help-view')).toBeVisible();
  await expect(window.locator('#map-view')).toBeHidden();
  await expect(window.locator('#infobar')).toBeVisible();            // just the title and the pin
  await expect(window.locator('#btn-pin')).toBeVisible();
  await expect(window.locator('#btn-reload')).toBeHidden();

  await window.locator('#btn-help').click();                        // same tab, not a second one
  await expect(window.locator('#tabs .tab')).toHaveCount(1);

  // Every registry entry is listed, with its description.
  const { SHORTCUTS } = await window.evaluate(() => import('./shortcuts.js').then(m => ({ SHORTCUTS: m.SHORTCUTS })));
  const entries = SHORTCUTS.flatMap(g => g.items);
  await expect(window.locator('.shortcut-table tr')).toHaveCount(entries.length);
  for (const e of entries) await expect(window.locator('.shortcut-table', { hasText: e.does }).first()).toBeVisible();

  // The search box filters by description and by keys; sections with nothing left are hidden.
  const search = window.locator('.shortcut-search'), rows = window.locator('.shortcut-table tr:visible');
  await search.fill('zoom');
  await expect(rows).toHaveCount(4);                                 // 3 zoom keys and Ctrl + Wheel
  await search.fill('ctrl w');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Close the current tab');
  await search.fill('ctrl+shift+s');
  await expect(rows).toHaveText([/Screenshot/]);
  await expect(window.locator('.shortcut-page section:visible')).toHaveCount(1);
  await search.fill('nothing like this');
  await expect(rows).toHaveCount(0);
  await expect(window.locator('.shortcut-none')).toBeVisible();
  await search.press('Escape');                                      // clears it, without closing anything
  await expect(search).toHaveValue('');
  await expect(window.locator('.shortcut-table tr:visible')).toHaveCount(entries.length);
  await search.fill('zoom');

  await window.keyboard.press('Control+w');
  await expect(window.locator('#tabs .tab')).toHaveCount(0);
  await expect(window.locator('#help-view')).toBeHidden();
});

test('every shortcut with keys has a handler', async ({ window }) => {
  const errors = [];
  window.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await window.reload();
  await expect(window.locator('#status-text')).not.toHaveText('Connecting…');
  expect(errors.filter(t => t.includes('Shortcuts without a handler'))).toEqual([]);
});

test('Shift+R types in the search box instead of refreshing', async ({ window }) => {
  await window.locator('#search').click();
  await window.keyboard.press('Shift+KeyR');                       // a real Shift+R, as a person types it
  await window.keyboard.type('ome');
  await expect(window.locator('#search')).toHaveValue('Rome');
});

test('Ctrl+? works while an article page has focus', async ({ app, window }) => {
  await openAll(window);
  const id = await window.locator('#webviews webview:not(.inactive)').evaluate(v => v.getWebContentsId());
  await app.evaluate(({ webContents }, id) => {
    const wc = webContents.fromId(id);
    for (const type of ['keyDown', 'char', 'keyUp']) wc.sendInputEvent({ type, keyCode: '?', modifiers: ['control', 'shift'] });
  }, id);
  await expect(activeLabel(window)).toHaveText('Keyboard shortcuts');
});

// Back / Forward

/** Runs JavaScript in the visible article page. */
const guestOf = (app, window) => async js => {
  const id = await window.locator('#webviews webview:not(.inactive)').evaluate(v => v.getWebContentsId());
  return app.evaluate(({ webContents }, [id, js]) => webContents.fromId(id).executeJavaScript(js), [id, js]);
};

// A real mouse click on a link in the article: Chromium leaves a page out of Back
// history when it's left without any user interaction (e.g. a scripted click).
async function realClick(app, window, linkId) {
  const { x, y } = await guestOf(app, window)(`(r => ({ x: r.left + 5, y: r.top + 5 }))(document.getElementById('${linkId}').getBoundingClientRect())`);
  const id = await window.locator('#webviews webview:not(.inactive)').evaluate(v => v.getWebContentsId());
  await app.evaluate(({ webContents }, [id, x, y]) => {
    const wc = webContents.fromId(id);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }, [id, Math.round(x), Math.round(y)]);
}

test('Back / Forward follow the page history, per tab', async ({ app, window }) => {
  await openAll(window);
  await window.locator('#tabs .tab', { hasText: 'Alpha story' }).click();
  const back = window.locator('#btn-back'), forward = window.locator('#btn-forward');
  const path = () => guestOf(app, window)('location.pathname');

  await expect.poll(path).toBe('/a/0');
  await expect(back).toBeDisabled();
  await expect(forward).toBeDisabled();

  await realClick(app, window, 'next');                               // follow a link inside the article
  await expect.poll(path).toBe('/next/a/0');
  await expect(back).toBeEnabled();
  await expect(forward).toBeDisabled();

  await back.click();
  await expect.poll(path).toBe('/a/0');
  await expect(forward).toBeEnabled();
  await expect(back).toBeDisabled();

  await window.locator('#feed-list').focus();
  await window.keyboard.press('Alt+ArrowRight');
  await expect.poll(path).toBe('/next/a/0');
  await window.keyboard.press('Alt+ArrowLeft');
  await expect.poll(path).toBe('/a/0');

  // Each tab has its own history: another tab starts with nothing to go back to.
  await window.locator('#tabs .tab', { hasText: 'Bravo story' }).click();
  await expect(back).toBeDisabled();
  await expect(forward).toBeDisabled();
  await window.locator('#tabs .tab', { hasText: 'Alpha story' }).click();
  await expect(forward).toBeEnabled();
});

test('Back / Reload / Forward sit at the start of the story bar', async ({ window }) => {
  await openAll(window);
  expect(await window.locator('#infobar > .nav-btns:first-child > #btn-back + #btn-reload + #btn-forward').count()).toBe(1);
});

test('Reload reloads the current tab’s page', async ({ app, window }) => {
  await openAll(window);
  const guest = guestOf(app, window);
  await expect.poll(() => guest('document.readyState')).toBe('complete');
  await guest('window.__marker = 1');
  await window.locator('#btn-reload').click();
  await expect.poll(() => guest('typeof window.__marker')).toBe('undefined');
});

test('Back works for in-page links too (#anchors, no page reload)', async ({ app, window }) => {
  await openAll(window);
  const back = window.locator('#btn-back');
  const hash = () => guestOf(app, window)('location.hash');
  await expect(back).toBeDisabled();
  // Let the offline save finish first: it redraws the story bar, which would hide a
  // missing navigation listener.
  await expect(window.locator('#save-state')).toHaveText(/^Saved/, { timeout: 20_000 });
  await realClick(app, window, 'more');
  await expect.poll(hash).toBe('#more');
  await expect(back).toBeEnabled();
  await back.click();
  await expect.poll(hash).toBe('');
});

// Live / Saved page

test('Ctrl+S shows the saved page (saving it first), Ctrl+L the live page', async ({ app, window }) => {
  await openAll(window);
  const modeOn = () => window.locator('#view-modes button.on');
  const view = () => window.locator('#webviews webview:not(.inactive)');
  await expect(modeOn()).toHaveText('Live');

  await window.locator('#feed-list').focus();
  await window.keyboard.press('Control+s');                           // may not be saved yet: saves, then switches
  await expect(modeOn()).toHaveText('Saved page', { timeout: 20_000 });
  await expect(view()).toHaveAttribute('src', /^file:.*\.mhtml$/);
  await expect(window.locator('#tabs .tab.active .tab-mode').locator('svg')).toHaveAttribute('data-icon', 'saved-page');

  // Also from inside the page.
  const id = await view().evaluate(v => v.getWebContentsId());
  await app.evaluate(({ webContents }, id) => {
    const wc = webContents.fromId(id);
    for (const type of ['keyDown', 'keyUp']) wc.sendInputEvent({ type, keyCode: 'L', modifiers: ['control'] });
  }, id);
  await expect(modeOn()).toHaveText('Live');
  await expect(view()).toHaveAttribute('src', /^http:\/\/127\.0\.0\.1:\d+\/a\/3$/);
});

test('Ctrl+Shift+A searches the open tabs: type to filter, ↑ ↓ and Enter or a click switch, × closes, Esc leaves', async ({ window }) => {
  await openAll(window);
  await window.locator('#feed-list').focus();
  const box = window.locator('.tab-search');
  const rows = box.locator('.tab-search-list li');

  // The current tab first, then the most recently used; the highlight starts on the previous one.
  await window.keyboard.press('Control+Shift+a');
  await expect(window.locator('.tab-search-input')).toBeFocused();
  await expect(box.locator('.tab-search-head')).toContainText('Article tabs');
  await expect(rows.locator('.tab-search-label')).toHaveText(['Delta story', 'Charlie story', 'Bravo story', 'Alpha story']);
  await expect(rows.nth(0)).toContainText('current');
  await expect(rows.nth(1)).toHaveClass(/\bon\b/);
  await window.keyboard.press('Enter');
  await expect(box).toHaveCount(0);
  await expect(activeLabel(window)).toHaveText('Charlie story');

  // Typing filters and marks the match
  await window.keyboard.press('Control+Shift+a');
  await window.keyboard.type('bra');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('mark')).toHaveText('Bra');
  await window.keyboard.press('Enter');
  await expect(activeLabel(window)).toHaveText('Bravo story');

  // Arrows wrap around; Esc closes without switching
  await window.keyboard.press('Control+Shift+a');
  await window.keyboard.press('ArrowUp');                          // from the second row to the first…
  await window.keyboard.press('ArrowUp');                          // …and round to the last
  await expect(rows.nth(3)).toHaveClass(/\bon\b/);
  await window.keyboard.press('Escape');
  await expect(box).toHaveCount(0);
  await expect(activeLabel(window)).toHaveText('Bravo story');

  // × closes a tab and keeps the box open; a click switches
  await window.keyboard.press('Control+Shift+a');
  await rows.filter({ hasText: 'Delta story' }).hover();
  await rows.filter({ hasText: 'Delta story' }).locator('.close').click();
  await expect(rows).toHaveCount(3);
  await expect(window.locator('#tabs .tab')).toHaveCount(3);
  await rows.filter({ hasText: 'Alpha story' }).click();
  await expect(box).toHaveCount(0);
  await expect(activeLabel(window)).toHaveText('Alpha story');

  // The shortcut again closes it
  await window.keyboard.press('Control+Shift+a');
  await expect(box).toBeVisible();
  await window.keyboard.press('Control+Shift+a');
  await expect(box).toHaveCount(0);
  expect(window.pageErrors).toEqual([]);
});
