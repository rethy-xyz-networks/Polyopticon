'use strict';

// The story, live-chat and video tab strips share one height (--tab-h) and one look.
// A real story tab (from a local feed) and real chat tabs are compared with a video-strip tab
// built like the chat ones (no stream is loaded). Screenshots go to test-results/tab-sizes/.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { test, expect } = require('./fixtures');

test.use({ settings: { ChatTwitchChannels: 'alpha, bravo' } });

let server, base;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/feed') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Local</title>
        <item><title>Alpha story</title><link>${base}/a</link><guid>${base}/a</guid><pubDate>${new Date().toUTCString()}</pubDate></item>
      </channel></rss>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><p>Article</p></body></html>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => server?.close());

const OUT = process.env.TAB_SHOTS || path.join(__dirname, '..', '..', 'test-results', 'tab-sizes');

test('story, chat and video tabs (and their headers) are the same height and share theme values', async ({ window }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const saved = await window.evaluate(url => window.polyopticon.saveSource({
    type: 'rss', name: 'Local Feed', grp: 'Test', category: 'T', color: '#555555', enabled: true, config: { url },
  }), `${base}/feed`);
  expect(saved.ok, saved.error).toBe(true);
  await window.locator('#feed-list .item', { hasText: 'Alpha story' }).dblclick({ timeout: 30_000 });
  await expect(window.locator('#tabs .tab.active .label')).toHaveText('Alpha story');

  await window.locator('#btn-chat').click();
  await expect(window.locator('#chat-tabs .tab')).toHaveCount(2);
  await window.locator('#chat-video-btn').click();
  await expect(window.locator('#video-pane')).toBeVisible();
  await window.evaluate(async () => {                        // a video tab, from the same builder the app uses (no stream is loaded)
    const { tabEl } = await import('./tabstrip.js');
    const { h } = await import('./dom.js');
    document.querySelector('#video-tabs').replaceChildren(tabEl({
      id: 'v1', kind: 'twitch', label: 'one', title: 'one', active: true, lead: [h('span', { class: 'dot' })],
      onSelect() {}, onClose() {}, onMenu() {},
    }));
  });

  const strips = { story: '#tabs', chat: '#chat-tabs', video: '#video-tabs' };
  const measure = sel => window.evaluate(sel => {
    const strip = document.querySelector(sel);
    const header = strip.closest('.pane-header');
    const tab = strip.querySelector('.active') || strip.firstElementChild;
    const cs = getComputedStyle(tab);
    const close = tab.querySelector('.close');
    const box = close?.getBoundingClientRect();
    return {
      // the close button is a real, visible button of one size on every unpinned tab
      closeSize: box && getComputedStyle(close).visibility === 'visible' ? `${box.width}x${box.height}` : 'hidden or missing',
      padding: cs.padding, gap: cs.columnGap, divider: cs.borderLeftWidth,
      header: header.getBoundingClientRect().height, tab: tab.getBoundingClientRect().height + (strip.offsetHeight - strip.clientHeight),
      font: cs.fontSize, color: cs.color, underline: cs.borderBottomWidth, underlineColor: cs.borderBottomColor, bg: cs.backgroundColor,
    };
  }, sel);

  // At the default font size and at a large one (the FontSize setting scales the tab text, and used to grow the story tabs only).
  for (const [label, scale] of [['13px', 1], ['18px', 18 / 13]]) {
    await window.evaluate(v => document.documentElement.style.setProperty('--scale', v), scale);
    const m = {};
    for (const [name, sel] of Object.entries(strips)) {
      m[name] = await measure(sel);
      await window.locator(sel).locator('xpath=ancestor::*[contains(@class,"pane-header")][1]')
        .screenshot({ path: path.join(OUT, `${name}-${label}.png`), animations: 'disabled' });
    }
    console.log(label, JSON.stringify(m));

    // One rendered height everywhere, and the same theme values.
    for (const name of Object.keys(strips)) {
      expect(m[name].closeSize, `${label} ${name} close button`).toBe('20x20');
      for (const key of Object.keys(m.chat)) expect(m[name][key], `${label} ${name} ${key}`).toBe(m.chat[key]);
    }
  }
  await window.screenshot({ path: path.join(OUT, 'window.png') });
});
