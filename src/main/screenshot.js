'use strict';

// Full-page screenshots of an article / 4chan / Telegram page (the 📸 button, Ctrl+Shift+S).
// The page is scrolled one screen at a time and each screen captured, then the pieces are
// joined. (Chromium's own "capture beyond the viewport" just repeats the visible screen
// inside a <webview>.) Fixed bars are hidden after the first screen so they appear once;
// sticky ones are pinned in place. The image goes to the clipboard and to a PNG in the
// screenshot folder.

const fs   = require('fs');
const path = require('path');
const { app, clipboard, ClipboardItem, nativeImage } = require('electron');
const log  = require('./logger');

const MAX_PIXELS   = 60e6;          // ≈ 240 MB of bitmap; anything taller is cut off at the bottom
const LAZY_LOAD_MS = 4000;          // at most this long scrolling through the page so lazy images load
const WORLD        = 1077;          // a script world of our own: the page's scripts and CSP don't get in the way

/** The folder screenshots go to: the setting, else the user's Pictures folder. */
const folderFor = setting => (typeof setting === 'string' && setting.trim()) || app.getPath('pictures');

// Runs in the page, in calls that return at once: saved pages run without timers or animation
// frames, so all the waiting is done here in the main process.
// start(): lazy images load eagerly; -> the scroll height. pending(): images still loading.
// prepare(): the scrollbar and smooth scrolling go away, sticky bars stay put; -> the sizes to capture.
// at(y): scrolls there; -> where it actually got to. hideFixed(): fixed bars (site headers,
// cookie banners) are hidden for the remaining screens. restore(): everything as it was.
const PAGE_SCRIPT = `window.__polyShot = {
  el: document.scrollingElement || document.documentElement,
  touched: [],
  set(node, prop, value) { this.touched.push([node, prop, node.style.getPropertyValue(prop), node.style.getPropertyPriority(prop)]); node.style.setProperty(prop, value, 'important'); },
  start() {
    this.x = this.el.scrollLeft; this.y = this.el.scrollTop;
    for (const img of document.images) if (img.loading === 'lazy') img.loading = 'eager';
    return { height: this.el.scrollHeight, view: innerHeight };
  },
  pending() { return [...document.images].filter(i => !i.complete && i.getBoundingClientRect().width).length; },
  prepare() {
    this.style = document.createElement('style');
    this.style.textContent = 'html, body { scroll-behavior: auto !important; scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; }';
    document.documentElement.append(this.style);
    this.fixed = [];
    for (const node of document.querySelectorAll('body *')) {
      const pos = getComputedStyle(node).position;
      if (pos === 'sticky') this.set(node, 'position', 'relative');
      else if (pos === 'fixed') this.fixed.push(node);
    }
    return { height: this.el.scrollHeight, view: innerHeight };
  },
  at(y) { this.el.scrollTop = y; return this.el.scrollTop; },
  hideFixed() { for (const node of this.fixed) this.set(node, 'visibility', 'hidden'); },
  restore() {
    for (const [node, prop, value, prio] of this.touched.reverse()) node.style.setProperty(prop, value, prio);
    this.style?.remove();
    this.el.scrollLeft = this.x; this.el.scrollTop = this.y;
    delete window.__polyShot;
  },
}; 0;`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PAINT_MS = 80;                // after a scroll, before capturing: time for the page to repaint

/** A file name from the page title and the time: "Some headline 2026-10-10 14.03.22.png". */
function fileName(title, now = new Date()) {
  const clean = String(title || 'Screenshot').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100).replace(/[. ]+$/, '') || 'Screenshot';
  const p = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}`;
  return `${clean} ${stamp}`;
}

function uniquePath(dir, base) {
  for (let i = 1; ; i++) {
    const p = path.join(dir, `${base}${i > 1 ? ` (${i})` : ''}.png`);
    if (!fs.existsSync(p)) return p;
  }
}

/** The whole page as one image. */
async function capturePage(wc) {
  const run = code => wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]);
  await run(PAGE_SCRIPT);
  try {
    // One quick scroll through the page so lazy images load, then a short wait for them.
    const end = Date.now() + LAZY_LOAD_MS;
    const first = await run('__polyShot.start()');
    for (let y = 0; y < first.height && Date.now() < end; y += Math.max(200, first.view * 0.9)) { await run(`__polyShot.at(${y})`); await sleep(40); }
    await run(`__polyShot.at(${first.height})`);
    while (Date.now() < end && await run('__polyShot.pending()')) await sleep(100);

    const { height, view } = await run('__polyShot.prepare()');
    const slices = [];
    let pxWidth = 0, pxHeight = 0, scale = 0, truncated = false;
    for (let y = 0; y < height; y += view) {
      const top = await run(`__polyShot.at(${y})`);             // the last screen stops short at the page's end
      await sleep(PAINT_MS);
      let img = await wc.capturePage();
      // At the screen's real resolution (on a 125 % display, 1.25 pixels per page pixel), as a plain bitmap.
      img = nativeImage.createFromBuffer(img.toPNG({ scaleFactor: img.getScaleFactors?.()[0] ?? 1 }));
      let size = img.getSize();
      if (!pxWidth) { pxWidth = size.width; scale = size.height / view; }
      else if (size.width !== pxWidth) { img = img.resize({ width: pxWidth }); size = img.getSize(); }
      // Keep only the part not already captured, and nothing past the page's end.
      const skip = Math.round((y - top) * scale);
      let rows = Math.min(size.height - skip, Math.round(height * scale) - pxHeight);
      if (rows <= 0) break;
      if ((pxHeight + rows) * pxWidth > MAX_PIXELS) { rows = Math.floor(MAX_PIXELS / pxWidth) - pxHeight; truncated = true; }
      if (rows > 0) {
        slices.push((skip || rows !== size.height ? img.crop({ x: 0, y: skip, width: pxWidth, height: rows }) : img).toBitmap());
        pxHeight += rows;
      }
      if (truncated) break;
      if (y === 0) await run('__polyShot.hideFixed()');
    }
    return { image: nativeImage.createFromBitmap(Buffer.concat(slices), { width: pxWidth, height: pxHeight }), truncated };
  } finally {
    await run('window.__polyShot?.restore()').catch(() => {});
  }
}

/**
 * Screenshot of a page: copied to the clipboard and saved as a PNG.
 * -> { ok: true, file, width, height, truncated } or { ok: false, error }
 */
async function take(wc, { title, folder } = {}) {
  const started = Date.now();
  try {
    if (!wc || wc.isDestroyed()) throw new Error('The page is gone');
    const { image, truncated } = await capturePage(wc);
    const { width, height } = image.getSize();
    if (!width || !height) throw new Error('The page had nothing to capture');
    const png = image.toPNG();
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    const dir = folderFor(folder);
    fs.mkdirSync(dir, { recursive: true });
    const file = uniquePath(dir, fileName(title));
    fs.writeFileSync(file, png);
    log.info(`Screenshot: ${width}×${height}${truncated ? ' (cut off: page too tall)' : ''} in ${Date.now() - started} ms -> ${file}`);
    return { ok: true, file, width, height, truncated };
  } catch (e) {
    log.warn(`Screenshot failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { take, folderFor, fileName };
