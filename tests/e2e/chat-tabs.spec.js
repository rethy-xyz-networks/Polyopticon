'use strict';

// Chat tabs work like the article tabs: drag to reorder, pin (stays left, no ✕), right-click menu.
// Twitch channel names are only a way to get tabs; no chat page is opened, so nothing loads from the network.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

// Shrink-to-fit layout: this test is about dragging, and all three tabs must be in view (scrolling is tab-scroll.spec.js).
test.use({ settings: { ChatTwitchChannels: 'alpha, bravo, charlie', ScrollableTabs: false } });

const names = window => window.locator('.chat-tab .name').allTextContents();

// The test window is off-screen and unfocused, so a pointer gesture is now and then swallowed
// (a window blur closes the menu mid-click). Gestures are retried until their effect shows.
async function until(check, attempt) {
  for (let i = 0; i < 4; i++) {
    await attempt();
    try { await expect.poll(check, { timeout: 2_500 }).toBe(true); return; } catch { /* try again */ }
  }
  await expect.poll(check, { timeout: 2_500 }).toBe(true);
}

test('chat tabs can be reordered by dragging, pinned, and closed from the menu; order and pins are remembered', async ({ window, dataDir }) => {
  await window.locator('#btn-chat').click();
  await expect(window.locator('.chat-tab')).toHaveCount(3);
  expect(await names(window)).toEqual(['alpha', 'bravo', 'charlie']);

  const tab = n => window.locator('.chat-tab', { hasText: n });
  const same = async expected => JSON.stringify(await names(window)) === JSON.stringify(expected);
  const drag = async (who, onto) => {
    const a = await tab(who).boundingBox(), b = await tab(onto).boundingBox();
    await window.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await window.mouse.down();
    await window.mouse.move(b.x + 3, b.y + b.height / 2, { steps: 12 });
    await window.mouse.up();
  };
  const menu = async (who, label) => {
    await tab(who).click({ button: 'right' });
    await window.locator('.ctx-menu button', { hasText: label }).click();
  };

  // Drag charlie to the front.
  await until(() => same(['charlie', 'alpha', 'bravo']), () => drag('charlie', 'alpha'));

  // Pin bravo: it moves to the front, loses its ✕, shows a pin, and middle-click no longer closes it.
  await until(() => same(['bravo', 'charlie', 'alpha']), () => menu('bravo', /^Pin tab$/));
  await expect(tab('bravo')).toHaveClass(/pinned/);
  await expect(tab('bravo').locator('.pin')).toBeVisible();
  await expect(tab('bravo').locator('.x')).toHaveCount(0);
  await tab('bravo').click({ button: 'middle' });
  await expect(window.locator('.chat-tab')).toHaveCount(3);

  // Dragging an unpinned tab onto the pinned one only moves it within its own group.
  await until(() => same(['bravo', 'alpha', 'charlie']), () => drag('alpha', 'bravo'));

  // The order and the pin are remembered (ui.json).
  const saved = () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'ui.json'), 'utf8')); } catch { return {}; } };
  await expect.poll(() => saved().chatPinned).toEqual(['tw:bravo']);
  await expect.poll(() => saved().chatOrder).toEqual(['tw:bravo', 'tw:alpha', 'tw:charlie']);

  // Close other tabs keeps the pinned tab; Unpin works.
  await until(() => same(['bravo', 'alpha']), () => menu('alpha', /^Close other tabs$/));
  await until(async () => !(await tab('bravo').getAttribute('class')).includes('pinned'), () => menu('bravo', /^Unpin tab$/));

  // Close tabs to the right, then close the last one from its menu.
  await until(() => same(['bravo']), () => menu('bravo', /^Close tabs to the right$/).catch(() => {}));
  await until(async () => (await window.locator('.chat-tab').count()) === 0, () => menu('bravo', /^Close tab$/).catch(() => {}));
});

test('Ctrl+Shift+A in the chat searches the chat tabs', async ({ window }) => {
  await window.locator('#btn-chat').click();
  await expect(window.locator('.chat-tab')).toHaveCount(3);
  await window.locator('.chat-tab', { hasText: 'alpha' }).click();      // the chat is now the area the tab shortcuts act on
  await window.keyboard.press('Control+Shift+a');
  const box = window.locator('.tab-search');
  await expect(box.locator('.tab-search-head')).toContainText('Chat tabs');
  await expect(box.locator('.tab-search-label')).toHaveText(['alpha', 'bravo', 'charlie']);
  await expect(box.locator('.tab-search-detail').first()).toHaveText('twitch.tv/alpha');
  await window.keyboard.type('charl');
  await window.keyboard.press('Enter');
  await expect(box).toHaveCount(0);
  await expect(window.locator('.chat-tab.active')).toContainText('charlie');
  expect(window.pageErrors).toEqual([]);
});
