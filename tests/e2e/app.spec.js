'use strict';

// Smoke tests for the app shell. They check structure and behaviour, never
// specific stories: live feeds differ on every run.

const fs   = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

test('starts cleanly with the three panes and the default sources', async ({ window }) => {
  await expect(window).toHaveTitle(/Polyopticon/);
  await expect(window.locator('.sidebar')).toBeVisible();
  await expect(window.locator('.feed')).toBeVisible();
  await expect(window.locator('.story')).toBeVisible();
  await expect(window.locator('#source-groups .group').first()).toBeVisible();
  expect(window.pageErrors).toEqual([]);
});

test('Live/History switch swaps the list; Group stays put in both modes', async ({ window }) => {
  const live = window.locator('#mode-switch [data-mode="live"]');
  const history = window.locator('#mode-switch [data-mode="history"]');
  const group = window.locator('#btn-group');

  await expect(live).toHaveClass(/\bon\b/);
  await expect(window.locator('#btn-autoscroll')).toBeVisible();
  const liveBox = await group.boundingBox();

  await history.click();
  await expect(history).toHaveClass(/\bon\b/);
  await expect(window.locator('#history-list')).toBeVisible();
  await expect(window.locator('#feed-list')).toBeHidden();
  await expect(window.locator('#history-scope')).toBeVisible();
  await expect(window.locator('#btn-autoscroll')).toBeHidden();
  const historyBox = await group.boundingBox();
  expect(Math.round(historyBox.x + historyBox.width)).toBe(Math.round(liveBox.x + liveBox.width));

  await live.click();
  await expect(window.locator('#feed-list')).toBeVisible();
  await expect(window.locator('#btn-autoscroll')).toBeVisible();
});

test('Live button shows only the status dot', async ({ window }) => {
  const live = window.locator('#mode-switch [data-mode="live"]');
  await expect(live.locator('.live-dot')).toBeVisible();
  await expect(live).toHaveText('');
  await expect(live).toHaveAttribute('aria-label', 'Live');
});

test('settings panel opens, switches tabs and closes with Esc', async ({ window }) => {
  const overlay = window.locator('#settings-overlay');
  await window.locator('#btn-settings').click();
  await expect(overlay).toBeVisible();

  for (const tab of ['sources', 'accounts', 'storage', 'general']) {
    await window.locator(`#settings-tabs [data-tab="${tab}"]`).click();
    await expect(window.locator(`.settings-page[data-page="${tab}"]`)).toBeVisible();
  }

  await window.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
});

test('Ctrl+, opens and closes Settings', async ({ window }) => {
  const overlay = window.locator('#settings-overlay');
  await window.locator('#feed-list').focus();
  await window.keyboard.press('Control+,');
  await expect(overlay).toBeVisible();
  await expect(window.locator('#btn-settings')).toHaveClass(/\bon\b/);
  await window.keyboard.press('Control+,');
  await expect(overlay).toBeHidden();
});

test('the Settings button toggles the panel; the ✏️ button toggles Sources', async ({ window }) => {
  const overlay = window.locator('#settings-overlay'), gear = window.locator('#btn-settings');
  await gear.click();
  await expect(overlay).toBeVisible();
  await expect(gear).toHaveClass(/\bon\b/);
  await gear.click();                                                 // second click closes
  await expect(overlay).toBeHidden();
  await expect(gear).not.toHaveClass(/\bon\b/);

  // ✏️ opens the Sources page; it sits under the backdrop then, so clicking it again closes.
  await window.locator('#btn-sources').click();
  await expect(window.locator('.settings-page[data-page="sources"]')).toBeVisible();
  await window.locator('#btn-sources').click({ force: true });
  await expect(overlay).toBeHidden();
});

test('theme toggle switches dark/light and saves the setting', async ({ window, dataDir }) => {
  const root = window.locator('html');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await window.locator('#btn-theme').click();
  await expect(root).toHaveAttribute('data-theme', 'light');

  // Saved to the test's own data folder, not the user's.
  await expect.poll(() => {
    const file = path.join(dataDir, 'settings.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).IsDarkTheme;
  }).toBe(false);
});

test('chat pane toggles from the toolbar button', async ({ window }) => {
  const pane = window.locator('#chat-pane');
  const btn = window.locator('#btn-chat');
  const wasOpen = await pane.isVisible();

  await btn.click();
  await expect(pane).toBeVisible({ visible: !wasOpen });
  await btn.click();
  await expect(pane).toBeVisible({ visible: wasOpen });
  await expect(window.locator('#chat-video-btn')).toBeVisible();                        // the split button is always there
});

test('buttons follow the design system: square and borderless', async ({ window }) => {
  const styles = await window.locator('.icon-btn, .toggle-btn, .primary-btn, .segmented button').evaluateAll(els =>
    els.map(el => {
      const cs = getComputedStyle(el);
      return { id: el.id || el.className, radius: cs.borderTopLeftRadius, border: cs.borderTopWidth };
    }));
  expect(styles.length).toBeGreaterThan(10);
  for (const s of styles) expect(s, s.id).toMatchObject({ radius: '0px', border: '0px' });
});

test('map is fully offline: draws the built-in world map, no tile server or tiles setting', async ({ window }) => {
  const external = [];
  window.on('request', r => { if (/^https?:/.test(r.url())) external.push(r.url()); });

  await expect(window.locator('#map-view')).toBeVisible();                    // open from the start
  await expect(window.locator('#map-canvas canvas').first()).toBeVisible();   // Leaflet canvas renderer
  await expect(window.locator('.leaflet-tile')).toHaveCount(0);
  await expect(window.locator('[data-setting="MapOnlineTiles"]')).toHaveCount(0);

  await window.locator('#btn-theme').click();   // restyles the outlines without errors
  await window.locator('#btn-map').click();
  await expect(window.locator('#map-view')).toBeHidden();
  expect(external).toEqual([]);
  expect(window.pageErrors).toEqual([]);
});

test('buttons sitting side by side share one height', async ({ window }) => {
  // Feed header: Live/History next to Group and Auto-Scroll, as tall as the toolbar's buttons.
  const heights = await window.locator('.feed .pane-header').locator('button:visible')
    .evaluateAll(els => els.map(el => [el.textContent.trim() || el.getAttribute('aria-label'), el.getBoundingClientRect().height]));
  expect(heights.length).toBeGreaterThanOrEqual(4);
  for (const [label, h] of heights) expect(h, label).toBe(heights[0][1]);

  // Every other compact button group matches the standard toggle height.
  const sizes = await window.evaluate(() => {
    const h = sel => document.querySelector(sel).getBoundingClientRect().height;
    return { feed: h('#btn-group'), tools: h('#btn-refresh'), map: h('#map-window button'), sources: h('#btn-sources'), toggle: h('#btn-case') };
  });
  expect(sizes.feed, 'feed header vs toolbar').toBe(sizes.tools);
  expect(sizes.map).toBe(sizes.toggle);
  expect(sizes.sources, "Manage sources").toBe(sizes.toggle);
});

test('a narrow feed column wraps its header instead of cutting off Group', async ({ window }) => {
  await window.click('#mode-switch [data-mode="history"]');                // the widest header
  await window.evaluate(() => document.documentElement.style.setProperty('--w-feed', '260px'));
  const { group, header } = await window.evaluate(() => ({
    group: document.getElementById('btn-group').getBoundingClientRect().right,
    header: document.querySelector('.feed .pane-header').getBoundingClientRect().right,
  }));
  expect(group).toBeLessThanOrEqual(header);
});

test('the logo is Polyopticon.png',async ({ window }) => {
  const dir = require('path').join(__dirname, '..', '..', 'src', 'renderer', 'assets');
  const variants = require('fs').readdirSync(dir).filter(f => /^Polyopticon\.png$/i.test(f));
  const current = async () => decodeURIComponent((await window.locator('#logo-anim').getAttribute('src')).split('/').pop());
  expect(variants).toContain(await current());
  if (variants.length < 2) return;
  for (let i = 0; i < 3; i++) {
    const before = await current();
    await window.locator('.logo').click();
    const after = await current();
    expect(variants).toContain(after);
    expect(after).not.toBe(before);                                  // never the same one twice in a row
  }
});

test('a quick double-click on Settings leaves it closed, not invisible and in the way', async ({ window }) => {
  await window.locator('#btn-settings').dblclick();
  await expect(window.locator('#settings-overlay')).toBeHidden();
  await window.locator('#search').click();                            // nothing covers the app
});

test('the split (TV) button opens a hidden chat with the stream split on, then toggles the split', async ({ window }) => {
  const pane = window.locator('#chat-pane'), btn = window.locator('#chat-video-btn'), video = window.locator('#video-pane');
  await expect(pane).toBeHidden();
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(pane).toBeVisible();
  await expect(video).toBeVisible();
  await expect(btn).toHaveClass(/\bon\b/);
  await btn.click();                                   // chat already open: only the split toggles
  await expect(pane).toBeVisible();
  await expect(video).toBeHidden();
  await expect(btn).not.toHaveClass(/\bon\b/);
  await window.locator('#btn-chat').click();           // hide the chat
  await expect(pane).toBeHidden();
  await btn.click();                                   // opens it again, split on
  await expect(pane).toBeVisible();
  await expect(video).toBeVisible();
});

test('Ctrl+V shows and hides the video player, but pastes as usual in a text box', async ({ window }) => {
  const btn = window.locator('#chat-video-btn');
  await expect(btn).not.toHaveClass(/\bon\b/);
  await window.locator('#feed-list').focus();
  await window.keyboard.press('Control+v');
  await expect(btn).toHaveClass(/\bon\b/);                          // opens the chat with the streams split on
  await expect(window.locator('#video-add')).toBeVisible();
  await window.locator('#feed-list').focus();                        // away from the stream field it focused
  await window.keyboard.press('Control+v');
  await expect(btn).not.toHaveClass(/\bon\b/);

  await window.locator('#search').focus();
  await window.keyboard.press('Control+v');
  await expect(btn).not.toHaveClass(/\bon\b/);                      // typing: left to paste
});

test('the stream split works like the chat: plus -> Twitch / Kick / YouTube buttons -> a field below', async ({ window }) => {
  await window.locator('#chat-video-btn').click();
  const add = window.locator('#video-add'), input = window.locator('#video-channel'), plus = window.locator('#video-add-btn');
  await expect(add).toBeVisible();                                   // nothing chosen yet: the buttons are already open
  await expect(add.locator('[data-site]')).toHaveText(['Twitch', 'Kick', 'YouTube']);
  await expect(window.locator('#video-form')).toBeHidden();          // the field comes with a site

  // Same header as the chat: same height, same plus and refresh buttons.
  const box = async sel => window.locator(sel).evaluate(el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { h: r.height, w: r.width, fs: cs.fontSize }; });
  expect((await box('#chat-pane .chat-head >> nth=1')).h).toBe((await box('#chat-pane .chat-head >> nth=0')).h);
  expect(await box('#video-add-btn')).toEqual(await box('#chat-add-btn'));
  expect(await box('#video-reload')).toEqual(await box('#chat-reload'));

  await add.locator('[data-site="kick"]').click();
  await expect(window.locator('#video-form')).toBeVisible();
  await input.fill('x');                                             // too short
  await input.press('Enter');
  await expect(input).toHaveClass(/invalid/);
  await input.fill('xqc');
  await input.press('Enter');
  await expect(add).toBeHidden();
  await expect(window.locator('#video-tabs .chat-tab.active .name')).toHaveText('Kick: xqc');
  await expect(window.locator('#video-view webview')).toHaveAttribute('src', 'https://player.kick.com/xqc');

  await plus.click();                                                // a pasted link picks its own site
  await add.locator('[data-site="twitch"]').click();
  await input.fill('https://www.youtube.com/@NASA/live');
  await input.press('Enter');
  await expect(window.locator('#video-tabs .chat-tab.active .name')).toHaveText('YouTube: @NASA');
  await expect(window.locator('#video-view webview:not(.inactive)')).toHaveAttribute('src', 'https://www.youtube.com/@NASA/live');

  await plus.click();
  await add.locator('[data-site="twitch"]').click();
  await input.fill('twitch.tv/Destiny');
  await input.press('Enter');
  await expect(window.locator('#video-tabs .chat-tab.active .name')).toHaveText('Twitch: destiny');
  await expect(window.locator('#video-view webview:not(.inactive)')).toHaveAttribute('src', /^https:\/\/player\.twitch\.tv\/\?channel=destiny&/);

  // All three are tabs, and their players keep running side by side.
  await expect(window.locator('#video-tabs .chat-tab .name')).toHaveText(['Kick: xqc', 'YouTube: @NASA', 'Twitch: destiny']);
  await expect(window.locator('#video-view webview')).toHaveCount(3);

  // Switching tabs shows another player without stopping the others.
  await window.locator('#video-tabs .chat-tab', { hasText: 'Kick' }).click();
  await expect(window.locator('#video-view webview:not(.inactive)')).toHaveAttribute('src', 'https://player.kick.com/xqc');
  await expect(window.locator('#video-view webview')).toHaveCount(3);

  // Closing a tab removes only its player.
  await window.locator('#video-tabs .chat-tab', { hasText: 'YouTube' }).click({ button: 'middle' });
  await expect(window.locator('#video-tabs .chat-tab .name')).toHaveText(['Kick: xqc', 'Twitch: destiny']);
  await expect(window.locator('#video-view webview')).toHaveCount(2);

  // Pinned tabs move to the front.
  await window.locator('#video-tabs .chat-tab', { hasText: 'Twitch' }).click({ button: 'right' });
  await window.locator('.ctx-menu button', { hasText: 'Pin tab' }).click();
  await expect(window.locator('#video-tabs .chat-tab .name')).toHaveText(['Twitch: destiny', 'Kick: xqc']);
  await expect(window.locator('#video-tabs .chat-tab').first()).toHaveClass(/pinned/);
  expect(window.pageErrors).toEqual([]);
});

test('every stream plays at once, each with its own volume bar and mute', async ({ window }) => {
  await window.locator('#chat-video-btn').click();
  const slider = window.locator('#video-volume'), mute = window.locator('#video-mute');
  await expect(slider).toBeDisabled();                               // nothing to control yet

  const add = async (site, name) => {
    await window.locator('#video-add [data-site]').first().waitFor();
    await window.locator(`#video-add [data-site="${site}"]`).click();
    await window.locator('#video-channel').fill(name);
    await window.locator('#video-channel').press('Enter');
    await expect(window.locator('#video-tabs .chat-tab.active .name')).toContainText(name);
  };
  await add('kick', 'alpha');
  await window.locator('#video-add-btn').click();
  await add('kick', 'bravo');
  await expect(slider).toBeEnabled();
  await expect(mute.locator('svg')).toHaveAttribute('data-icon', 'volume-2');

  // The bar belongs to the tab shown (bravo); alpha keeps its own level.
  await slider.fill('20');
  await expect(mute.locator('svg')).toHaveAttribute('data-icon', 'volume-0');
  await window.locator('#video-tabs .chat-tab .name', { hasText: 'alpha' }).click();
  await expect(slider).toHaveValue('100');
  await expect(mute.locator('svg')).toHaveAttribute('data-icon', 'volume-2');
  await window.locator('#video-tabs .chat-tab .name', { hasText: 'bravo' }).click();
  await expect(slider).toHaveValue('20');

  // A tab's own speaker mutes just that stream, without switching to it.
  await window.locator('#video-tabs .chat-tab', { hasText: 'alpha' }).locator('.snd').click();
  await expect(window.locator('#video-tabs .chat-tab', { hasText: 'alpha' }).locator('.snd').locator('svg')).toHaveAttribute('data-icon', 'muted');
  await expect(window.locator('#video-tabs .chat-tab', { hasText: 'bravo' }).locator('.snd').locator('svg')).toHaveAttribute('data-icon', 'volume-2');
  await expect(window.locator('#video-tabs .chat-tab.active .name')).toContainText('bravo');

  // Both players exist and stay visible (a hidden player would be paused by its site); the one shown is on top.
  const states = await window.locator('#video-view webview').evaluateAll(list => list.map(w => ({
    visibility: getComputedStyle(w).visibility, display: getComputedStyle(w).display, inactive: w.classList.contains('inactive'),
  })));
  expect(states).toHaveLength(2);
  expect(states.every(s => s.visibility === 'visible' && s.display !== 'none')).toBe(true);
  expect(states.filter(s => s.inactive)).toHaveLength(1);

  // Mute / unmute on the bar; unmuting from 0 brings the level back to half.
  await mute.click();
  await expect(mute.locator('svg')).toHaveAttribute('data-icon', 'muted');
  await mute.click();
  await expect(mute.locator('svg')).toHaveAttribute('data-icon', 'volume-0');
  await slider.fill('0');
  await expect(mute.locator('svg')).toHaveAttribute('data-icon', 'muted');
  await mute.click();
  await expect(slider).toHaveValue('50');

  const saved = await window.evaluate(() => import('./ui.js').then(m => m.ui.streams));
  expect(saved.find(s => s.name === 'alpha').muted).toBe(true);
  expect(saved.find(s => s.name === 'bravo').volume).toBe(0.5);
  expect(window.pageErrors).toEqual([]);
});
