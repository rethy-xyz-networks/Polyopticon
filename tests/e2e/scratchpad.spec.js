'use strict';

// The Scratchpad: a 📜 toolbar button opens one permanent note as a tab. Text and images are
// saved automatically, encrypted (scratchpad.bin), and come back after a restart.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { test, expect } = require('./fixtures');
const { test: base, expect: baseExpect, _electron: electron } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..', '..');

// 1×1 transparent PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('the 📜 button opens one Scratchpad tab with highlighted Markdown', async ({ window }) => {
  await window.locator('#btn-scratch').click();
  await expect(window.locator('#tabs .tab.active .label')).toHaveText('Scratchpad');
  await expect(window.locator('#scratch-view')).toBeVisible();
  await expect(window.locator('#infobar')).toBeVisible();           // title and pin
  await expect(window.locator('#btn-pin')).toBeVisible();

  await window.locator('#btn-scratch').click();                     // same tab, not a second one
  await expect(window.locator('#tabs .tab')).toHaveCount(1);

  const area = window.locator('.scratch-text');
  await expect(area).toBeEnabled();
  await area.fill('# Title\n- item with **bold** and `code`\n> quote');
  await expect(window.locator('.scratch-mirror .md-h')).toHaveText('# Title');
  await expect(window.locator('.scratch-mirror .md-b')).toHaveText('**bold**');
  await expect(window.locator('.scratch-mirror .md-code')).toHaveText('`code`');
  await expect(window.locator('.scratch-mirror .md-quote').first()).toBeVisible();
  expect(window.pageErrors).toEqual([]);
});

test('closing the tab saves the note, and encrypts it', async ({ app, window, dataDir }) => {
  await window.locator('#btn-scratch').click();
  const area = window.locator('.scratch-text');
  await expect(area).toBeEnabled();
  await area.fill('secret plans ![image](scratch-img:abc123)');
  await window.keyboard.press('Control+w');                          // leaving the tab flushes the save
  await expect(window.locator('#tabs .tab')).toHaveCount(0);

  const file = path.join(dataDir, 'scratchpad.bin');
  await expect.poll(() => fs.existsSync(file)).toBe(true);
  expect(fs.readFileSync(file).includes('secret plans')).toBe(false);   // not stored as plain text

  // What the next launch loads.
  const note = await window.evaluate(() => window.polyopticon.loadScratch());
  expect(note.text).toBe('secret plans ![image](scratch-img:abc123)');
});

test('inactivity saves automatically; only image data is kept with the note', async ({ window, dataDir }) => {
  await window.locator('#btn-scratch').click();
  const area = window.locator('.scratch-text');
  await expect(area).toBeEnabled();
  await area.fill('pic ![image](scratch-img:img1)');
  const res = await window.evaluate(png => window.polyopticon.saveScratch({
    text: 'pic ![image](scratch-img:img1)', images: { img1: `data:image/png;base64,${png}`, evil: 'javascript:alert(1)' },
  }), PNG);
  expect(res.ok).toBe(true);
  const note = await window.evaluate(() => window.polyopticon.loadScratch());
  expect(Object.keys(note.images)).toEqual(['img1']);                // anything but image data URLs is dropped
  await expect(window.locator('.scratch-status')).toHaveText(/Saved/, { timeout: 10_000 });   // the 1.5 s inactivity save
});

test('a pasted image sits inline at the caret; it resizes, enlarges and can be deleted', async ({ window }) => {
  await window.locator('#btn-scratch').click();
  const area = window.locator('.scratch-text').first();
  await expect(area).toBeEnabled();
  await area.fill('before after');
  await area.evaluate(el => el.setSelectionRange(7, 7));            // between the two words

  await window.evaluate(async () => {                               // a 300×200 picture, as if copied from elsewhere
    const canvas = document.createElement('canvas');
    canvas.width = 300; canvas.height = 200;
    canvas.getContext('2d').fillRect(0, 0, 300, 200);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'a.png', { type: 'image/png' }));
    const ta = document.querySelector('.scratch-text');
    ta.focus();
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });

  // text · image · text, in that order, with the text split at the caret
  const blocks = window.locator('.scratch-blocks > *');
  await expect(blocks).toHaveCount(3);
  await expect(blocks.nth(1)).toHaveClass(/scratch-image/);
  await expect(window.locator('.scratch-text').first()).toHaveValue('before ');
  await expect(window.locator('.scratch-text').nth(1)).toHaveValue('after');

  // Resize with the corner grip; the width is part of the saved note.
  const img = window.locator('.scratch-pic');
  await img.hover();
  const grip = window.locator('.scratch-grip');
  const box = await grip.boundingBox();
  await window.mouse.move(box.x + 8, box.y + 8);
  await window.mouse.down();
  await window.mouse.move(box.x + 8 + 160, box.y + 8, { steps: 4 });
  await window.mouse.up();
  const w = await img.evaluate(el => Math.round(el.getBoundingClientRect().width));
  expect(w).toBeGreaterThan(100);
  await window.keyboard.press('Control+w');
  const note = await window.evaluate(() => window.polyopticon.loadScratch());
  const [first, token, last] = note.text.split('\n');
  expect(first).toBe('before ');
  expect(token).toMatch(new RegExp(String.raw`^!\[image\]\(scratch-img:[\w-]+\?w=${w}\)$`));
  expect(last).toBe('after');
  expect(Object.keys(note.images)).toHaveLength(1);

  // Click to enlarge; Escape closes it.
  await window.locator('#btn-scratch').click();
  await window.locator('.scratch-pic').click();
  await expect(window.locator('.scratch-lightbox')).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(window.locator('.scratch-lightbox')).toBeHidden();

  // Delete: the text around it joins up again.
  await window.locator('.scratch-pic').hover();
  await window.locator('.scratch-bar button[title="Delete image"]').click();
  await expect(window.locator('.scratch-image')).toHaveCount(0);
  await expect(window.locator('.scratch-text')).toHaveCount(1);
  await expect(window.locator('.scratch-text')).toHaveValue('before \nafter');
  expect(window.pageErrors).toEqual([]);
});

test('Tab types a tab character in the Scratchpad instead of moving focus', async ({ window }) => {
  await window.locator('#btn-scratch').click();
  const area = window.locator('.scratch-text').first();
  await expect(area).toBeEnabled();
  await area.fill('a');
  await area.press('Tab');
  await window.keyboard.type('b');
  await expect(area).toHaveValue('a\tb');
  await expect(area).toBeFocused();
});

test('the Scratchpad and the shortcut list can be pinned like any tab', async ({ window, dataDir }) => {
  const pinned = () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'pinned.json'), 'utf8')); } catch { return []; } };
  await window.locator('#btn-scratch').click();
  await window.locator('#btn-help').click();

  // Pin the Scratchpad with the pin button, the shortcut list from the tab's right-click menu.
  await window.locator('#tabs .tab', { hasText: 'Scratchpad' }).click();
  await window.locator('#btn-pin').click();
  await expect(window.locator('#tabs .tab.pinned')).toHaveText(/Scratchpad/);
  await window.locator('#tabs .tab', { hasText: 'Keyboard shortcuts' }).click({ button: 'right' });
  await expect(window.locator('.ctx-menu button', { hasText: 'Open in browser' })).toHaveCount(0);   // no link to open
  await window.locator('.ctx-menu button', { hasText: 'Pin tab' }).click();
  await expect(window.locator('#tabs .tab.pinned')).toHaveCount(2);
  await expect.poll(() => pinned().map(p => p.app).sort()).toEqual(['help', 'scratch']);

  // Pinned: no ✕, and Ctrl+W leaves it open.
  await expect(window.locator('#tabs .tab.pinned .close')).toHaveCount(0);
  await window.keyboard.press('Control+w');
  await expect(window.locator('#tabs .tab')).toHaveCount(2);

  await window.locator('#btn-pin').click();                          // the pin button toggles it back
  await expect(window.locator('#tabs .tab.pinned')).toHaveCount(1);
  expect(window.pageErrors).toEqual([]);
});

base('pinned app tabs come back at the next start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyopticon-pin-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ TranslateEnabled: false, ChatDestiny: false, ChatTwitchChannels: '', ChatIrc: '' }));
  fs.writeFileSync(path.join(dir, 'pinned.json'), JSON.stringify([
    { id: -999999, mode: 'live', app: 'scratch' },
    { id: -1, mode: 'live', app: 'help' },
    { id: -7, mode: 'live', app: 'nonsense' },                       // ignored
  ]));
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, POLYOPTICON_DATA_DIR: dir, POLYOPTICON_OFFSCREEN: '1' } });
  try {
    const window = await app.firstWindow();
    await baseExpect(window.locator('#tabs .tab.pinned')).toHaveCount(2, { timeout: 30_000 });
    await baseExpect(window.locator('#tabs .tab.pinned .tab-mode').first().locator('svg')).toHaveAttribute('data-icon', 'scratchpad');
    await window.locator('#tabs .tab', { hasText: 'Scratchpad' }).click();
    await baseExpect(window.locator('.scratch-text').first()).toBeEnabled();
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('scrolling zooms an enlarged image about the pointer; Ctrl+scroll resizes it in the note', async ({ window }) => {
  await window.locator('#btn-scratch').click();
  const area = window.locator('.scratch-text').first();
  await expect(area).toBeEnabled();
  await window.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 300; canvas.height = 200;
    canvas.getContext('2d').fillRect(0, 0, 300, 200);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'a.png', { type: 'image/png' }));
    const ta = document.querySelector('.scratch-text');
    ta.focus();
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const pic = window.locator('.scratch-pic');
  await expect(pic).toBeVisible();

  // In the note: Ctrl+scroll up grows the picture, down shrinks it.
  const width = () => pic.evaluate(el => el.getBoundingClientRect().width);
  const w0 = await width();
  await pic.hover();
  await window.keyboard.down('Control');
  await window.mouse.wheel(0, -100);
  await expect.poll(width).toBeGreaterThan(w0);
  await window.mouse.wheel(0, 100);
  await window.mouse.wheel(0, 100);
  await expect.poll(width).toBeLessThan(w0);
  await window.keyboard.up('Control');

  // Enlarged: scrolling zooms in and out, double-click resets, clicking the picture keeps it open.
  await pic.click();
  const big = window.locator('.scratch-lightbox img');
  await expect(big).toBeVisible();
  const scale = () => big.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
  expect(await scale()).toBe(1);
  await big.hover();
  await window.mouse.wheel(0, -300);
  await expect.poll(scale).toBeGreaterThan(1.3);
  await window.mouse.wheel(0, 900);
  await expect.poll(scale).toBeLessThan(1);
  await big.dblclick();
  await expect.poll(scale).toBe(1);
  await expect(window.locator('.scratch-lightbox')).toBeVisible();
  await window.locator('.scratch-lightbox-close').click();
  await expect(window.locator('.scratch-lightbox')).toBeHidden();
  expect(window.pageErrors).toEqual([]);
});

test('dragging a tab to a new place does not select it', async ({ window }) => {
  await window.locator('#btn-scratch').click();
  await window.locator('#btn-help').click();                         // shortcut list is now the selected tab
  const tabs = window.locator('#tabs .tab .label');
  await expect(tabs).toHaveText(['Scratchpad', 'Keyboard shortcuts']);
  await expect(window.locator('#tabs .tab.active .label')).toHaveText('Keyboard shortcuts');

  const from = await window.locator('#tabs .tab', { hasText: 'Scratchpad' }).boundingBox();
  const to = await window.locator('#tabs .tab', { hasText: 'Keyboard shortcuts' }).boundingBox();
  await window.mouse.move(from.x + 20, from.y + from.height / 2);
  await window.mouse.down();
  await window.mouse.move(to.x + to.width - 10, to.y + to.height / 2, { steps: 10 });
  await window.mouse.up();

  await expect(tabs).toHaveText(['Keyboard shortcuts', 'Scratchpad']);                 // moved...
  await expect(window.locator('#tabs .tab.active .label')).toHaveText('Keyboard shortcuts');   // ...not selected
  await expect(window.locator('#scratch-view')).toBeHidden();

  await window.locator('#tabs .tab', { hasText: 'Scratchpad' }).click();               // a plain click still selects
  await expect(window.locator('#scratch-view')).toBeVisible();
});
