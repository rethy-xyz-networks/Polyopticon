'use strict';

// Opening and closing (styles.css, "Opening and closing"): the add bars float over what is under them
// instead of resizing it, and pop-ups fade out before they go.

const { test, expect } = require('./fixtures');

test.use({ settings: { ChatIrc: 'irc://127.0.0.1:1/#motion' } });   // a chat to open the bar over; it never connects

const SHOTS = process.env.POLYOPTICON_SHOTS;                          // a folder: also save pictures there, to look at

test('the chat add bar floats over the chat instead of pushing it down', async ({ window }) => {
  await window.locator('#btn-chat').click();
  const views = window.locator('#chat-views'), bar = window.locator('#chat-add');
  await expect(window.locator('#chat-tabs .tab')).toHaveCount(1);
  await expect(bar).toBeHidden();
  const before = await views.boundingBox();

  await window.locator('#chat-add-btn').click();
  await expect(bar).toBeVisible();
  await expect(bar).toHaveCSS('opacity', '1');                        // slid in
  await window.locator('#chat-type-twitch').click();                 // the second row
  await expect(window.locator('#chat-add-twitch')).toBeVisible();
  expect(await views.boundingBox()).toEqual(before);                  // nothing under it moved or shrank
  const b = await bar.boundingBox();
  expect(b.y).toBe(before.y);                                         // directly under the header
  if (SHOTS) await window.screenshot({ path: `${SHOTS}/chat-add.png` });

  await window.locator('#chat-add-btn').click();
  await expect(bar).toBeHidden();
  expect(await views.boundingBox()).toEqual(before);
});

test('with nothing under it, the stream add bar sits in the layout above the hint', async ({ window }) => {
  await window.locator('#chat-video-btn').click();
  const bar = window.locator('#video-add');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveClass(/\binline\b/);
  const b = await bar.boundingBox(), hint = await window.locator('#video-empty').boundingBox();
  expect(hint.y).toBeGreaterThanOrEqual(b.y + b.height);              // the hint is below it, not covered
  if (SHOTS) await window.screenshot({ path: `${SHOTS}/video-add.png` });
});

test('a right-click menu fades out and is then removed; a second one can open meanwhile', async ({ window }) => {
  await window.locator('#btn-chat').click();
  const tab = window.locator('#chat-tabs .tab').first();
  await tab.click({ button: 'right' });
  const menu = window.locator('.ctx-menu:not(.closing)');
  await expect(menu).toHaveCount(1);
  await expect(menu).toHaveCSS('opacity', '1');
  if (SHOTS) await window.screenshot({ path: `${SHOTS}/menu.png` });
  await tab.dispatchEvent('contextmenu');                             // closes the first, opens another (the menu covers the tab)
  await expect(menu).toHaveCount(1);
  await window.keyboard.press('Escape');
  await expect(window.locator('.ctx-menu')).toHaveCount(0);
});
