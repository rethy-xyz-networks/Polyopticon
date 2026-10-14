'use strict';

// The video pane's volume control is compact (the speaker only) until hovered, then the slider slides out.

const { test, expect } = require('./fixtures');

test('the volume slider shows only on hover', async ({ window }) => {
  await window.locator('#btn-chat').click();
  await window.locator('#chat-video-btn').click();
  await expect(window.locator('#video-pane')).toBeVisible();

  const slider = window.locator('#video-volume');
  const width = () => slider.evaluate(el => el.getBoundingClientRect().width);
  await window.mouse.move(5, 5);
  await expect.poll(width).toBe(0);                          // compact: nothing but the speaker button
  await expect(window.locator('#video-mute')).toBeVisible();

  await window.locator('.video-vol').hover();
  await expect.poll(width).toBeGreaterThan(60);              // hovered: the full slider
  await window.locator('.video-vol').screenshot({ path: 'test-results/volume-hover.png' });

  await window.mouse.move(5, 5);
  await expect.poll(width).toBe(0);
  await window.locator('.video-vol').screenshot({ path: 'test-results/volume-compact.png' });
});
