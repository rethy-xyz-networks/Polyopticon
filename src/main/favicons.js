'use strict';

// Site icons for feed rows, served to the renderer as polyopticon-icon://site/<host>
// (or polyopticon-icon://tg/<channel> for a Telegram channel's avatar).
//
// Each icon is fetched once — the site's own <link rel=icon>/apple-touch-icon,
// then /favicon.ico, then Google's free favicon service as a last resort —
// shrunk to 32×32 and cached in <data>/icons. Misses are remembered for a few
// days so unreachable sites aren't retried on every row.

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { net, nativeImage } = require('electron');
const log  = require('./logger');
const { BROWSER_UA } = require('./adapters/util');

const SIZE = 32;
const MISS_RETRY_MS = 3 * 86400e3;
const FETCH_TIMEOUT_MS = 8000;
const MAX_PARALLEL = 4;

let dir = null;
let index = {};                      // key -> { file, type, at } | { miss: at }
const memory = new Map();            // key -> { body, type }
const inflight = new Map();          // key -> Promise
let saveTimer = null;
let active = 0;
const waiting = [];

function init(dataDir) {
  dir = dataDir;
  fs.mkdirSync(dir, { recursive: true });
  try { index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { index = {}; }
}

function saveIndex() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const p = path.join(dir, 'index.json');
      fs.writeFileSync(`${p}.tmp`, JSON.stringify(index));
      fs.renameSync(`${p}.tmp`, p);
    } catch (e) { log.warn(`Favicons: index save failed: ${e.message}`); }
  }, 2000);
}

// Fetching

async function limited(fn) {
  if (active >= MAX_PARALLEL) await new Promise(r => waiting.push(r));
  active++;
  try { return await fn(); }
  finally { active--; waiting.shift()?.(); }
}

async function get(url, accept = '*/*') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await net.fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': BROWSER_UA, Accept: accept } });
    if (!res.ok) return null;
    return { url: res.url || url, type: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), body: Buffer.from(await res.arrayBuffer()) };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

const attr = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(2).find(v => v != null) ?? null;

/** Icon candidates declared in a page's <head>, best first. */
function iconLinks(html, base) {
  const head = html.slice(0, 200_000);
  const out = [];
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    if (!/\bicon\b|apple-touch-icon/.test(rel) || /mask-icon/.test(rel)) continue;
    const href = attr(tag, 'href');
    if (!href || href.startsWith('data:')) continue;
    let url; try { url = new URL(href.replace(/&amp;/g, '&'), base).href; } catch { continue; }
    const sizes = (attr(tag, 'sizes') || '').match(/\d+/g)?.map(Number) ?? [];
    const svg = /\.svg(\?|$)/i.test(url) || /svg/.test(attr(tag, 'type') || '');
    // Prefer something comfortably larger than 32px; SVG can't be resized here, so it goes last.
    let size = sizes.length ? Math.max(...sizes) : rel.includes('apple-touch-icon') ? 180 : 16;
    const score = svg ? 1 : size >= 32 && size <= 256 ? 1000 - Math.abs(size - 96) : size > 256 ? 500 : 100 + size;
    out.push({ url, score });
  }
  return out.sort((a, b) => b.score - a.score).map(c => c.url);
}

const looksLikeImage = r => r && r.body.length > 60 && r.body.length < 2_000_000 &&
  (/^image\//.test(r.type) || /octet-stream|x-icon/.test(r.type)) && !/^\s*</.test(r.body.subarray(0, 64).toString('latin1'))
  || r && /svg/.test(r.type) && r.body.length < 300_000;

/** Shrink to SIZE×SIZE PNG; SVG (which nativeImage can't decode) is kept as is. */
function normalise(r) {
  if (/svg/.test(r.type)) return { body: r.body, type: 'image/svg+xml' };
  const img = nativeImage.createFromBuffer(r.body);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  if (width < 8 || height < 8) return null;
  const out = width > SIZE || height > SIZE ? img.resize({ width: SIZE, height: SIZE, quality: 'best' }) : img;
  return { body: out.toPNG(), type: 'image/png' };
}

async function firstImage(urls) {
  for (const u of urls) {
    const r = await get(u, 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5');
    if (!looksLikeImage(r)) continue;
    const icon = normalise(r);
    if (icon) return icon;
  }
  return null;
}

async function fetchSite(host) {
  for (const origin of [`https://${host}`, `https://www.${host}`]) {
    const page = await get(`${origin}/`, 'text/html');
    const candidates = page && /html/.test(page.type) ? iconLinks(page.body.toString('utf8'), page.url) : [];
    const icon = await firstImage([...candidates.slice(0, 4), `${origin}/favicon.ico`]);
    if (icon) return icon;
    if (page) break;              // the site answered but has no usable icon; www. won't differ
  }
  // Bot-protected sites (e.g. Reuters) refuse direct requests.
  return firstImage([`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`]);
}

/** A public Telegram channel's avatar, from its t.me page. */
async function fetchTelegram(channel) {
  const page = await get(`https://t.me/${channel}`, 'text/html');
  const img = page && attr(page.body.toString('utf8').match(/<meta[^>]+property="og:image"[^>]*>/i)?.[0] ?? '', 'content');
  return (img && await firstImage([img])) || fetchSite('telegram.org');
}

// Lookup

async function lookup(kind, name) {
  const key = `${kind}:${name}`;
  if (memory.has(key)) return memory.get(key);
  const entry = index[key];
  if (entry?.file) {
    try {
      const icon = { body: fs.readFileSync(path.join(dir, entry.file)), type: entry.type };
      memory.set(key, icon);
      return icon;
    } catch { /* file gone — fetch again */ }
  } else if (entry?.miss && Date.now() - entry.miss < MISS_RETRY_MS) return null;

  if (!inflight.has(key)) {
    inflight.set(key, limited(async () => {
      const icon = kind === 'tg' ? await fetchTelegram(name) : await fetchSite(name);
      if (icon) {
        const file = `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}${icon.type === 'image/png' ? '.png' : '.svg'}`;
        fs.writeFileSync(path.join(dir, file), icon.body);
        index[key] = { file, type: icon.type, at: Date.now() };
        memory.set(key, icon);
      } else {
        index[key] = { miss: Date.now() };
        log.debug(`Favicons: none found for ${key}`);
      }
      saveIndex();
      return icon;
    }).finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

const HOST_RX = /^[a-z0-9.-]{1,253}$/i;
const CHANNEL_RX = /^[a-z0-9_]{3,64}$/i;

/** protocol.handle callback for polyopticon-icon://site/<host> and polyopticon-icon://tg/<channel>. */
async function handle(req) {
  const u = new URL(req.url);
  const name = decodeURIComponent(u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
  const kind = u.hostname === 'tg' ? 'tg' : 'site';
  const valid = kind === 'tg' ? CHANNEL_RX.test(name) : HOST_RX.test(name) && name.includes('.');
  const icon = valid ? await lookup(kind, name).catch(() => null) : null;
  if (!icon) return new Response(null, { status: 404 });
  return new Response(icon.body, { headers: { 'content-type': icon.type, 'cache-control': 'max-age=86400' } });
}

function stats() {
  const entries = Object.values(index);
  return { icons: entries.filter(e => e.file).length, misses: entries.filter(e => e.miss).length };
}

module.exports = { init, handle, stats };
