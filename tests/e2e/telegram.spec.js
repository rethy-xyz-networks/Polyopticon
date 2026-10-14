'use strict';

// Telegram channels (✈️ in the toolbar): a new tab whose title bar is a field for the channel's name
// or link; connecting turns it into the channel's page (t.me/s/<name>/) and the field goes away.
// Like 4chan: live only, on the memory-only session; like articles: pinnable, and pins are remembered.
// Nothing here waits for t.me itself.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, _electron: electron } = require('@playwright/test');
const { test: appTest, expect: appExpect } = require('./fixtures');

const ROOT = path.resolve(__dirname, '..', '..');

appTest('✈️ opens a tab with a channel field where the title goes; connecting replaces it with the page', async ({ window, dataDir }) => {
  await appExpect(window.locator('#btn-telegram').locator('svg')).toHaveAttribute('data-icon', 'telegram');
  await window.locator('#btn-telegram').click();
  const tab = window.locator('#tabs .tab.active');
  await appExpect(tab).toHaveCount(1);
  await appExpect(tab.locator('.tab-mode').locator('svg')).toHaveAttribute('data-icon', 'telegram');

  // The temporary field sits in the title's place; nothing to pin, copy or open yet; no page yet.
  const field = window.locator('#tg-channel');
  await appExpect(field).toBeVisible();
  await appExpect(field).toBeFocused();
  await appExpect(window.locator('#story-title')).toBeHidden();
  for (const id of ['#btn-copy', '#btn-open']) await appExpect(window.locator(id)).toBeHidden();   // no link yet
  await appExpect(window.locator('#btn-pin')).toBeVisible();                                       // but any tab can be pinned
  await appExpect(window.locator('webview')).toHaveCount(0);
  await appExpect(window.locator('#chat-tabs .tab')).toHaveCount(0);                // not a chat

  // A second press reuses the same new tab.
  await window.locator('#btn-telegram').click();
  await appExpect(window.locator('#tabs .tab')).toHaveCount(1);

  await field.fill('not a channel!');
  await field.press('Enter');
  await appExpect(field).toHaveClass(/invalid/);
  await appExpect(window.locator('webview')).toHaveCount(0);

  await field.fill('https://t.me/s/durov/');
  await field.press('Enter');
  await appExpect(field).toBeHidden();                                          // the field goes away…
  await appExpect(window.locator('#story-title')).toBeVisible();                // …and the title is back
  await appExpect(window.locator('#story-title')).toContainText(/durov/i);
  await appExpect(window.locator('webview')).toHaveAttribute('src', 'https://t.me/s/durov/');
  await appExpect(window.locator('webview')).toHaveAttribute('partition', 'chan');

  // Live only (no view modes / translate / save chip) but pinnable, copyable and openable.
  for (const id of ['#view-modes', '#btn-translate', '#save-state']) await appExpect(window.locator(id)).toBeHidden();
  for (const id of ['#btn-pin', '#btn-copy', '#btn-open', '#btn-reload']) await appExpect(window.locator(id)).toBeVisible();

  // Pinned by page address, since it has no database item.
  await window.locator('#btn-pin').click();
  await appExpect(tab).toHaveClass(/pinned/);
  const pinned = () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'pinned.json'), 'utf8')); } catch { return []; } };
  await appExpect.poll(() => pinned().map(p => p.url)).toEqual(['https://t.me/s/durov/']);
  appExpect(pinned()[0]).toMatchObject({ chan: true, mode: 'live' });

  // Connecting a second new tab to the same channel switches to the open one instead of duplicating it.
  await window.locator('#btn-telegram').click();
  await appExpect(window.locator('#tabs .tab')).toHaveCount(2);
  await window.locator('#tg-channel').fill('@durov');
  await window.locator('#tg-channel').press('Enter');
  await appExpect(window.locator('#tabs .tab')).toHaveCount(1);
  await appExpect(window.locator('#tabs .tab.active')).toContainText(/durov/i);
});

test('a pinned Telegram channel comes back at the next start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyopticon-tg-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ TranslateEnabled: false, ChatDestiny: false, ChatTwitchChannels: '', ChatIrc: '' }));
  fs.writeFileSync(path.join(dir, 'pinned.json'), JSON.stringify([
    { id: -5, mode: 'live', chan: true, url: 'https://t.me/s/telegram/', title: '@telegram' },
    { id: -6, mode: 'live', chan: true, url: 'file:///etc/passwd', title: 'not a web page' },        // refused
  ]));
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, POLYOPTICON_DATA_DIR: dir, POLYOPTICON_OFFSCREEN: '1' } });
  try {
    const window = await app.firstWindow();
    await expect(window.locator('#tabs .tab.pinned')).toHaveCount(1, { timeout: 30_000 });
    await expect(window.locator('#tabs .tab.pinned')).toContainText('telegram');
    await expect(window.locator('#tabs .tab.pinned .tab-mode').locator('svg')).toHaveAttribute('data-icon', 'telegram');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
