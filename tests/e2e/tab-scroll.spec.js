'use strict';

// Story, live-chat and video tab strips share one behaviour (tabscroll.js), controlled by
// the "Scrollable tabs" setting: tabs keep a readable width and the strip scrolls with a
// visible scrollbar and the mouse wheel. Off, the tabs shrink to fit. Tabs are injected into
// the strips so no feed or stream has to load.

const { test, expect } = require('./fixtures');

const STRIPS = [
  { name: 'story', strip: '#tabs',       tab: 'div',    cls: 'tab',      label: 'label' },
  { name: 'chat',  strip: '#chat-tabs',  tab: 'div', cls: 'tab', label: 'label' },
  { name: 'video', strip: '#video-tabs', tab: 'div', cls: 'tab', label: 'label' },
];

async function fill(window, s, count) {
  await window.evaluate(({ s, count }) => {
    const strip = document.querySelector(s.strip);
    strip.replaceChildren(...Array.from({ length: count }, (_, i) => {
      const t = document.createElement(s.tab);
      t.className = s.cls;
      t.innerHTML = `<span class="${s.label}">A fairly long tab title number ${i}</span>`;
      return t;
    }));
  }, { s, count });
}

const metrics = (window, s) => window.evaluate(s => {
  const el = document.querySelector(s.strip);
  const tabs = [...el.children];
  return {
    overflow: el.scrollWidth > el.clientWidth + 1,
    scrollbar: el.offsetHeight - el.clientHeight,           // thickness of the horizontal scrollbar
    minTab: Math.min(...tabs.map(t => t.getBoundingClientRect().width)),
    scrollLeft: el.scrollLeft,
  };
}, s);

test('every tab strip scrolls with a scrollbar and the wheel, and shrinks to fit when the setting is off', async ({ window }) => {
  await window.locator('#btn-chat').click();
  await window.locator('#chat-video-btn').click();          // reveals the video pane (no streams, so nothing loads)
  await expect(window.locator('#video-pane')).toBeVisible();

  for (const s of STRIPS) await fill(window, s, 40);
  const widths = {};

  for (const s of STRIPS) {
    await expect.poll(() => metrics(window, s).then(m => m.overflow), { message: `${s.name} overflows` }).toBe(true);
    const m = await metrics(window, s);
    expect(m.scrollbar, `${s.name} scrollbar`).toBeGreaterThanOrEqual(6);
    expect(m.minTab, `${s.name} tab width`).toBeGreaterThan(120);
    widths[s.name] = m.minTab;

    // The mouse wheel scrolls the strip sideways.
    await window.locator(s.strip).hover();
    await window.mouse.wheel(0, 200);
    await expect.poll(() => metrics(window, s).then(m => m.scrollLeft), { message: `${s.name} wheel scrolls` }).toBeGreaterThan(0);
  }

  // Switch the setting off: one control, all three strips follow.
  await window.evaluate(() => document.querySelector('[data-setting="ScrollableTabs"]').click());
  await expect(window.locator('body')).not.toHaveClass(/tabs-scroll/);
  for (const s of STRIPS) {
    const m = await metrics(window, s);
    expect(m.minTab, `${s.name} tabs shrink`).toBeLessThan(widths[s.name]);
  }

  // And back on.
  await window.evaluate(() => document.querySelector('[data-setting="ScrollableTabs"]').click());
  for (const s of STRIPS) await expect.poll(() => metrics(window, s).then(m => m.overflow), { message: `${s.name} overflows again` }).toBe(true);
  expect(window.pageErrors).toEqual([]);
});
