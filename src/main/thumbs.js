'use strict';

// Story pictures for feed rows, served to the renderer as polyopticon-icon://thumb/<item id>
// (and larger, for the hover preview, as polyopticon-icon://thumb/<item id>?size=preview).
//
// The picture is the one the story's feed gave (items.extra.image). It is fetched here,
// not by the page, so the window never contacts the publisher's image hosts itself.
// Each one is shrunk to THUMB_WIDTH (PREVIEW_WIDTH) and kept in <data>/thumbs for a few days; files
// nobody asked for in that time are deleted. Misses are remembered until restart.

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nativeImage } = require('electron');
const log  = require('./logger');
const { get } = require('./favicons');

const THUMB_WIDTH = 192;                  // twice the widest the row shows it
const PREVIEW_WIDTH = 720;                // twice the widest the hover preview shows it
const KEEP_MS = 7 * 86400e3;
const MAX_PARALLEL = 4;
const MAX_RAW_BYTES = 1_500_000;          // formats nativeImage can't decode are passed through up to this size
const MAX_BYTES = 15_000_000;             // feeds often link the full-size original

let dir = null;
let imageOf = () => null;                 // item id -> image URL
const misses = new Set();                 // image URLs that failed this session
const inflight = new Map();               // image URL -> Promise
let active = 0;
const waiting = [];

/** `lookup(id)` returns the image URL the feed gave for that story (or null). */
function init(dataDir, lookup) {
  dir = dataDir;
  imageOf = lookup;
  fs.mkdirSync(dir, { recursive: true });
  prune();
  setInterval(prune, 12 * 3600e3).unref();
}

function prune() {
  const cutoff = Date.now() - KEEP_MS;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    try { if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); removed++; } } catch { /* already gone */ }
  }
  if (removed) log.debug(`Thumbnails: removed ${removed} old file(s)`);
}

async function limited(fn) {
  if (active >= MAX_PARALLEL) await new Promise(r => waiting.push(r));
  active++;
  try { return await fn(); }
  finally { active--; waiting.shift()?.(); }
}

/** Shrinks to `maxWidth` wide as JPEG; WebP/AVIF/GIF that nativeImage can't decode are kept as they are. */
function normalise(r, maxWidth) {
  const img = nativeImage.createFromBuffer(r.body);
  if (img.isEmpty()) {
    return /^image\/(webp|avif|gif)$/.test(r.type) && r.body.length <= MAX_RAW_BYTES ? { body: r.body, type: r.type } : null;
  }
  const { width, height } = img.getSize();
  if (width < 32 || height < 32) return null;                 // spacers and logos, not story pictures
  const out = width > maxWidth ? img.resize({ width: maxWidth, quality: 'good' }) : img;
  return { body: out.toJPEG(82), type: 'image/jpeg' };
}

const EXT = { 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/avif': '.avif', 'image/gif': '.gif' };
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));

function cached(key) {
  for (const [ext, type] of Object.entries(TYPE)) {
    const p = path.join(dir, key + ext);
    try {
      const body = fs.readFileSync(p);
      const now = new Date();
      fs.utimesSync(p, now, now);                             // still wanted: keep it past the next prune
      return { body, type };
    } catch { /* not this format */ }
  }
  return null;
}

async function thumb(url, width) {
  const key = crypto.createHash('sha1').update(width === THUMB_WIDTH ? url : `${url}#${width}`).digest('hex').slice(0, 20);
  const hit = cached(key);
  if (hit) return hit;
  if (misses.has(url)) return null;
  if (!inflight.has(key)) {
    inflight.set(key, limited(async () => {
      // JPEG/PNG first: those are the formats that can be shrunk here.
      const r = await get(url, 'image/jpeg,image/png,image/*;q=0.8');
      const usable = r && r.body.length > 60 && r.body.length <= MAX_BYTES && !/svg|html|text/.test(r.type);
      const out = usable ? normalise(r, width) : null;
      if (out) fs.writeFileSync(path.join(dir, key + EXT[out.type]), out.body);
      else misses.add(url);
      return out;
    }).finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

/** protocol.handle callback for polyopticon-icon://thumb/<item id>[?size=preview]. */
async function handle(req) {
  const u = new URL(req.url);
  const id = Number(u.pathname.split('/').filter(Boolean)[0]);
  const url = Number.isInteger(id) && id > 0 ? imageOf(id) : null;
  const width = u.searchParams.get('size') === 'preview' ? PREVIEW_WIDTH : THUMB_WIDTH;
  const img = url ? await thumb(url, width).catch(() => null) : null;
  if (!img) return new Response(null, { status: 404 });
  return new Response(img.body, { headers: { 'content-type': img.type, 'cache-control': 'max-age=86400' } });
}

module.exports = { init, handle };
