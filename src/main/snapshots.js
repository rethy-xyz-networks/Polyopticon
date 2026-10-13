'use strict';

// Offline copies of opened articles:
//   • page  — the rendered page saved as a single MHTML file (images, layout)
//   • text  — Mozilla Readability's clean extraction, stored in SQLite (searchable)
//
// Articles opened in a tab are captured from that tab (exactly what was seen,
// with the user's session). Articles opened in the system browser are loaded
// once in a hidden window and captured there.

const { app, BrowserWindow, webContents } = require('electron');
const fs   = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const log  = require('./logger');
const { detectLang } = require('./enrich/text');

// Page-side scripts (see src/main/page/): clean.js strips walls/banners/overlays,
// extract.js picks the best article text (Readability, site rules, JSON-LD, paragraphs).
const READABILITY_SRC = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8');
const CLEAN_SRC   = fs.readFileSync(path.join(__dirname, 'page', 'clean.js'), 'utf8');
const EXTRACT_SRC = READABILITY_SRC + '\n;' + fs.readFileSync(path.join(__dirname, 'page', 'extract.js'), 'utf8');
const RESTORE_SRC = 'window.__polyopticonRestore?.(); true';
const IMAGES_SRC  = fs.readFileSync(path.join(__dirname, 'page', 'images.js'), 'utf8');
const ISOLATED_WORLD = 1099;

let dir = null;
let db = null;
let partition = null;
let notify = () => {};
const inProgress = new Set();
const httpStatus = new WeakMap();   // webContents -> status of its last main-frame navigation
const backgroundQueue = [];
let backgroundBusy = false;

function init(opts) {
  ({ db, partition, notify } = opts);
  dir = opts.dir;
  fs.mkdirSync(dir, { recursive: true });
  app.on('web-contents-created', (_e, wc) =>
    wc.on('did-navigate', (_ev, _url, code) => httpStatus.set(wc, code)));
}

const pagePath = itemId => path.join(dir, `${itemId}.mhtml`);
const pageUrl  = file => pathToFileURL(file).href;
const isInside = file => path.resolve(file).startsWith(path.resolve(dir) + path.sep);

const SOCIAL_KINDS = new Set(['post', 'message']);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function run(wc, code, what, itemId) {
  try { return await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code }]); }
  catch (e) { log.debug(`${what} failed for item ${itemId}: ${e.message}`); return null; }
}

/** Telegram / Bluesky posts: the item already holds the full text; the page is just chrome. */
function socialArticle(item) {
  const text = (item.summary || item.title || '').trim();
  return {
    method: 'item-text', title: item.title, byline: item.author, siteName: item.sourceName,
    text, content: text.split(/\n+/).filter(p => p.trim()).map(p => `<p>${esc(p)}</p>`).join('\n'),
    words: text.split(/\s+/).length, partial: false,
  };
}

/** Cleans the page, extracts the article, then (optionally) puts the live page back. */
async function cleanAndExtract(wc, item, { restore, loadImages = false }) {
  if (loadImages) await run(wc, IMAGES_SRC, 'Image loading', item.id);
  const cleaned = await run(wc, CLEAN_SRC, 'Cleanup', item.id);
  const article = SOCIAL_KINDS.has(item.kind) ? socialArticle(item) : await run(wc, EXTRACT_SRC, 'Extraction', item.id);
  return { cleaned, article, restore: restore ? () => run(wc, RESTORE_SRC, 'Restore', item.id) : null };
}

function snapshotFields(article, cleaned) {
  const text = article?.text?.replace(/\n{3,}/g, '\n\n').trim() || null;
  return {
    title: article?.title, byline: article?.byline, siteName: article?.siteName, excerpt: article?.excerpt,
    contentHtml: article?.content, text, wordCount: text ? text.split(/\s+/).length : null,
    lang: text ? detectLang(text.slice(0, 1500)) : null,
    method: article?.method ?? 'none',
    partial: !!(article?.partial || cleaned?.wall),
  };
}

async function capture(wc, itemId) {
  if (inProgress.has(itemId) || wc.isDestroyed()) return null;
  const item = db.getItem(itemId);
  if (!item) return null;
  inProgress.add(itemId);
  const started = Date.now();
  try {
    const finalUrl = wc.getURL();
    if (!/^https?:/i.test(finalUrl)) return null;
    // Never keep an error page (401 login prompt, 404, 5xx) as the saved copy.
    const status = httpStatus.get(wc);
    if (status >= 400) { log.info(`Not saving item ${itemId}: the page returned HTTP ${status}`); return null; }

    // Strip walls/prompts, extract text, save the cleaned page, then restore the live tab.
    const { cleaned, article, restore } = await cleanAndExtract(wc, item, { restore: true, loadImages: true });
    let mhtmlPath = null, mhtmlBytes = null;
    try {
      const file = pagePath(itemId);
      await wc.savePage(file, 'MHTML');
      mhtmlPath = file;
      mhtmlBytes = fs.statSync(file).size;
    } catch (e) { log.warn(`Saving page for item ${itemId} failed: ${e.message}`); }
    finally { await restore?.(); }

    const fields = snapshotFields(article, cleaned);
    if (!mhtmlPath && !fields.text) return null;
    db.saveSnapshot(itemId, { capturedAt: Date.now(), finalUrl, mhtmlPath, mhtmlBytes, ...fields });
    log.info(`Saved item ${itemId}: page ${mhtmlBytes ? `${Math.round(mhtmlBytes / 1024)} KB` : 'no'}, ` +
             `text ${fields.wordCount ?? 0} words via ${fields.method}${fields.partial ? ' (site showed part of the article)' : ''}, ` +
             `${cleaned?.removed ?? 0} overlay(s) removed (${Date.now() - started} ms)`);
    const info = describe(itemId);
    notify(info);
    return info;
  } finally {
    inProgress.delete(itemId);
  }
}

/**
 * Re-runs extraction on saved pages from before the current extractor
 * (loads each MHTML offline in a hidden window — no network needed).
 */
async function reextractOld() {
  const rows = db.snapshotsToReextract();
  if (!rows.length) return;
  log.info(`Re-extracting text for ${rows.length} saved article(s)`);
  const win = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { partition: 'polyopticon-reextract', sandbox: true, contextIsolation: true } });   // saved pages never run their own scripts
  let fixed = 0;
  try {
    for (const { itemId, mhtmlPath } of rows) {
      const item = db.getItem(itemId);
      if (!item || !isInside(mhtmlPath) || !fs.existsSync(mhtmlPath)) continue;
      try {
        await win.loadURL(pathToFileURL(mhtmlPath).href);
        const { cleaned, article } = await cleanAndExtract(win.webContents, item, { restore: false });
        const fields = snapshotFields(article, cleaned);
        db.updateSnapshotText(itemId, fields);
        fixed++;
        log.debug(`Re-extracted item ${itemId}: ${fields.wordCount ?? 0} words via ${fields.method}`);
      } catch (e) { log.debug(`Re-extract of item ${itemId} failed: ${e.message}`); }
    }
  } finally { win.destroy(); }
  log.info(`Re-extraction done: ${fixed}/${rows.length}`);
}

/** Capture from a live <webview> tab, identified by its webContents id. */
function captureTab(itemId, webContentsId) {
  const wc = webContents.fromId(webContentsId);
  return wc ? capture(wc, itemId) : null;
}

/** Load the article invisibly and capture it (for articles opened in the system browser). */
function queueBackground(itemId, url) {
  if (db.getSnapshot(itemId) || backgroundQueue.some(j => j.itemId === itemId)) return;
  backgroundQueue.push({ itemId, url });
  runBackground();
}

async function runBackground() {
  if (backgroundBusy) return;
  backgroundBusy = true;
  while (backgroundQueue.length) {
    const { itemId, url } = backgroundQueue.shift();
    const win = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    try {
      await Promise.race([
        win.loadURL(url).catch(() => {}),
        new Promise(r => setTimeout(r, 30000)),
      ]);
      await waitForQuiet(win.webContents, 2500, 20000);
      await capture(win.webContents, itemId);
    } catch (e) {
      log.warn(`Background capture failed for item ${itemId}: ${e.message}`);
    } finally {
      win.destroy();
    }
  }
  backgroundBusy = false;
}

/** Resolves once the page has stopped loading for `quietMs` (handles JS redirects), or after maxMs. */
function waitForQuiet(wc, quietMs, maxMs) {
  return new Promise(resolve => {
    let timer = null;
    const done = () => { clearTimeout(timer); clearTimeout(max); wc.off('did-stop-loading', arm); wc.off('did-start-loading', disarm); resolve(); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(done, quietMs); };
    const disarm = () => clearTimeout(timer);
    const max = setTimeout(done, maxMs);
    wc.on('did-stop-loading', arm);
    wc.on('did-start-loading', disarm);
    if (!wc.isLoading()) arm();
  });
}

/** What the UI needs to know about an item's saved copy. */
function describe(itemId) {
  const s = db.getSnapshot(itemId);
  if (!s) return { itemId, saved: false };
  const pageOk = s.mhtml_path && fs.existsSync(s.mhtml_path);
  return {
    itemId, saved: true, capturedAt: s.captured_at,
    pageUrl: pageOk ? pageUrl(s.mhtml_path) : null,
    hasText: !!s.text, wordCount: s.word_count, partial: !!s.partial,
    lang: s.lang, hasTranslation: !!s.translated_text,
  };
}

// Reader view (served on the polyopticon-reader: scheme)


/** "www.aljazeera.net/news/2026/10/4/…" — readable host + path, decoded, trimmed. */
function shortUrl(u) {
  try {
    const x = new URL(u);
    const p = decodeURIComponent(x.pathname);
    return x.hostname.replace(/^www\./, '') + (p.length > 60 ? `${p.slice(0, 57)}…` : p);
  } catch { return u; }
}

function readerHtml(itemId, { translated = false } = {}) {
  const s = db.getSnapshot(itemId);
  const item = db.getItem(itemId);
  if (!s || !(s.content_html || s.text)) return null;
  const useTranslation = translated && s.translated_text;
  const paragraphs = text => `<p>${esc(text).split(/\n+/).filter(p => p.trim()).join('</p><p>')}</p>`;
  const body = useTranslation ? paragraphs(s.translated_text) : s.content_html || paragraphs(s.text);
  const dir = !useTranslation && ['ar', 'he', 'fa', 'ur', 'ps'].includes(s.lang) ? 'rtl' : 'ltr';
  const meta = [s.byline, s.site_name || item?.sourceName,
                item?.publishedAt && new Date(item.publishedAt).toLocaleString()].filter(Boolean).map(esc).join(' · ');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.title || item?.title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfaf7; --fg:#1d1d1d; --muted:#6b6b6b; --link:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141414; --fg:#e6e6e6; --muted:#8c8c8c; --link:#ff6b75; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:18px/1.65 Georgia, "Times New Roman", serif; }
  main { max-width: 42rem; margin: 0 auto; padding: 32px 24px 80px; }
  h1 { font: 700 30px/1.25 "Segoe UI", system-ui, sans-serif; margin: 0 0 10px; }
  .meta { color:var(--muted); font: 13px "Segoe UI", system-ui, sans-serif; margin-bottom: 6px; }
  .orig { font: 13px "Segoe UI", system-ui, sans-serif; margin-bottom: 28px; word-break: break-all; }
  .note { color:var(--muted); font: 12px "Segoe UI", system-ui, sans-serif; border-top:1px solid #8884; margin-top:40px; padding-top:12px; }
  .partial { font: 13px/1.5 "Segoe UI", system-ui, sans-serif; background:#B9770E22; border:1px solid #B9770E66; border-radius:6px; padding:10px 12px; margin:0 0 24px; }
  a { color: var(--link); } img, video, figure { max-width: 100%; height: auto; } figure { margin: 1.5em 0; }
  figcaption { color:var(--muted); font-size: 14px; } pre { white-space: pre-wrap; } table { max-width:100%; overflow:auto; display:block; }
</style></head><body><main dir="${dir}">
<h1>${esc(useTranslation ? item?.title : s.title || item?.title)}</h1>
<div class="meta">${meta}</div>
<div class="orig"><a href="${esc(s.final_url || item?.url)}">${esc(shortUrl(s.final_url || item?.url))}</a></div>
${s.partial ? `<div class="partial">The site only sent part of this article when it was saved (subscriber or registration wall).
If you have an account, log in to the site once in a Live tab — the login is remembered, and later saves will keep the full text.</div>` : ''}
${body}
<div class="note">Saved ${esc(new Date(s.captured_at).toLocaleString())} · reader view${useTranslation ? ` · machine-translated from ${esc(s.lang)} on your computer` : ""}</div>
</main></body></html>`;
}

/** Deletes saved page files older than `days` (text is kept). */
function expire(days) {
  if (!days) return;
  const paths = db.expirePages(Date.now() - days * 86400e3);
  for (const p of paths) if (isInside(p)) { try { fs.unlinkSync(p); } catch { /* already gone */ } }
  if (paths.length) log.info(`Snapshot retention: removed ${paths.length} saved page(s) older than ${days} days`);
}

/** Deletes every saved article: page files and text. */
function clearAll() {
  backgroundQueue.length = 0;
  const paths = db.clearSnapshots();
  for (const p of paths) if (isInside(p)) { try { fs.unlinkSync(p); } catch { /* already gone */ } }
  // Pages whose rows were already expired or lost
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.mhtml')) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* in use */ } }
  log.info(`Cleared all saved articles (${paths.length} page file(s))`);
}

module.exports = { init, captureTab, reextractOld, queueBackground, describe, readerHtml, expire, clearAll, isInside, get dir() { return dir; } };
