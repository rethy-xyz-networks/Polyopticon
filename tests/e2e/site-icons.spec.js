'use strict';

// Chat and stream tabs lead with their site's icon (cached like a feed's), a glyph for IRC rooms and direct
// links, and the site's colour dot when it has no icon. The icon cache is filled beforehand, so nothing is fetched.

const fs = require('fs');
const path = require('path');
const base = require('./fixtures');
const { expect } = base;

// A 1×1 PNG, as twitch.tv's cached icon; kick.com is a remembered miss (no icon found)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const test = base.test.extend({
  dataDir: async ({ dataDir }, use) => {
    const dir = path.join(dataDir, 'icons');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'twitch.png'), PNG);
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
      'site:twitch.tv': { file: 'twitch.png', type: 'image/png', at: Date.now() },
      'site:kick.com': { miss: Date.now() },
    }));
    await use(dataDir);
  },
});
test.use({ settings: { ChatTwitchChannels: 'alpha', ChatKickChannels: 'bravo', ChatIrc: 'irc://127.0.0.1:1/#charlie', ScrollableTabs: false } });

test('chat and stream tabs show their site icon, a glyph for IRC and direct links, or the colour dot', async ({ window }) => {
  await window.locator('#btn-chat').click();
  const chat = n => window.locator('#chat-tabs .tab', { hasText: n });
  await expect(chat('alpha').locator('img.fav')).toHaveAttribute('src', 'polyopticon-icon://site/twitch.tv');
  await expect.poll(() => chat('alpha').locator('img.fav').evaluate(img => img.complete && img.naturalWidth)).toBe(1);
  await expect(chat('bravo').locator('.dot')).toHaveCount(1);              // kick.com has no icon: the dot stays
  await expect(chat('bravo').locator('img')).toHaveCount(0);
  await expect(chat('charlie').locator('.tab-mode svg')).toHaveCount(1);   // IRC: the chat glyph
  await expect(chat('charlie').locator('.dot, img')).toHaveCount(0);

  await window.evaluate(() => import('./ui.js').then(m => m.saveUi({
    streams: [{ site: 'twitch', name: 'delta', disabled: true }, { site: 'direct', name: 'https://example.org/clip.mp4', disabled: true }] })));
  await window.locator('#chat-video-btn').click();
  const stream = n => window.locator('#video-tabs .tab', { hasText: n });
  await expect(stream('delta').locator('img.fav')).toHaveAttribute('src', 'polyopticon-icon://site/twitch.tv');
  await expect(stream('clip.mp4').locator('.tab-mode svg')).toHaveCount(1);
  expect(window.pageErrors).toEqual([]);
});
