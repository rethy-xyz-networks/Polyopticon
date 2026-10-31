'use strict';

// A stream can be disabled: its tab stays, but it gets no player (nothing loads) until it is enabled again.

const { test, expect } = require('./fixtures');

test('a disabled stream loads nothing and stays disabled until enabled', async ({ window }) => {
  // Two streams saved beforehand (adding a second one through the plus is covered in app.spec.js).
  await window.evaluate(() => import('./ui.js').then(m => m.saveUi({ streams: [{ site: 'kick', name: 'alpha' }, { site: 'kick', name: 'bravo' }], streamTab: 'kick:bravo' })));
  await window.locator('#chat-video-btn').click();
  const views = window.locator('#video-view webview');
  await expect(views).toHaveCount(2);

  // The bar's button disables the stream shown: its player goes, the tab is dimmed, the pane says so.
  await window.locator('#video-disable').click();
  await expect(views).toHaveCount(1);
  await expect(window.locator('#video-tabs .tab', { hasText: 'bravo' })).toHaveClass(/disabled/);
  await expect(window.locator('#video-disabled')).toBeVisible();
  await expect(window.locator('#video-disable')).toHaveClass(/\bon\b/);
  await expect(window.locator('#video-reload')).toBeDisabled();
  await expect(window.locator('#video-volume')).toBeDisabled();

  // Other tabs are unaffected; switching back shows the notice again.
  await window.locator('#video-tabs .tab .label', { hasText: 'alpha' }).click();
  await expect(window.locator('#video-disabled')).toBeHidden();
  await window.locator('#video-tabs .tab .label', { hasText: 'bravo' }).click();
  await expect(window.locator('#video-disabled')).toBeVisible();

  // Closing and reopening the pane doesn't bring it back, and it's saved.
  await window.locator('#chat-video-btn').click();
  await expect(views).toHaveCount(0);
  await window.locator('#chat-video-btn').click();
  await expect(views).toHaveCount(1);
  const saved = () => window.evaluate(() => import('./ui.js').then(m => m.ui.streams));
  expect((await saved()).find(s => s.name === 'bravo').disabled).toBe(true);

  // Enable from the notice; disable / enable from the tab's menu too. (The menu opens over the players, and under
  // xvfb a real click there can land in a player's page instead, hence dispatchEvent.)
  await window.locator('#video-enable').click();
  await expect(views).toHaveCount(2);
  await expect(window.locator('#video-disabled')).toBeHidden();
  expect((await saved()).find(s => s.name === 'bravo').disabled).toBeUndefined();
  await window.locator('#video-tabs .tab', { hasText: 'alpha' }).click({ button: 'right' });
  await window.locator('.ctx-menu button', { hasText: 'Disable stream' }).dispatchEvent('click');
  await expect(views).toHaveCount(1);
  await window.locator('#video-tabs .tab', { hasText: 'alpha' }).click({ button: 'right' });
  await window.locator('.ctx-menu button', { hasText: 'Enable stream' }).dispatchEvent('click');
  await expect(views).toHaveCount(2);
  expect(window.pageErrors).toEqual([]);
});
