'use strict';

// Downloads for the map's place cards that the app can't ship: photos from Wikimedia Commons, and
// Canada's census divisions from GADM (free for non-commercial use but not to be redistributed, so each
// copy of the app fetches its own). Both are saved under <data>/map. Photos are served to the renderer as
// polyopticon-map://photo/<Commons file name>; the divisions over IPC (map:canada).
//
// Wikimedia asks for a User-Agent naming the app and a contact, and no more than 200 requests a minute.
// One limiter covers every Commons request. A 429 or 503 pauses it for Retry-After and halves its rate,
// which then recovers a little with every success; a 403 means we're blocked: it pauses for ten minutes and
// is logged. A photo that can't be fetched now is tried again later. Nothing here ever needs the user.

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { app, nativeImage } = require('electron');
const log  = require('./logger');
// Not Electron's net.fetch: a response header with non-Latin-1 text makes it throw outside the request, and the
// request never settles (Electron's bug). The feeds' fetch reads such headers byte by byte.
const { parseRetryAfter, request } = require('./adapters/util');

const MANIFEST = path.join(__dirname, '../renderer/assets/map/photos.json');   // file -> [thumb url, page, artist, licence, crop from top]
const GADM_URL = 'https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_CAN_2.json.zip';
const RATE_MAX = 170 / 60e3, RATE_MIN = 20 / 60e3;      // requests per ms
const BLOCK_PAUSE_MS = 10 * 60e3, THROTTLE_PAUSE_MS = 30e3;
const JOBS = 3;
const W = 320, H = 200, H_MAX = 260;                     // the card's photo frame (16:10), and the most kept of a tall one

let dir = null, photoDir = null;
let manifest = null;
const inflight = new Map();          // file -> Promise<{ body, type } | null>
const background = [];               // files to prefetch, in order (an opened card's photo is fetched at once)
const waiting = new Set();
let running = 0;
let rate = RATE_MAX, nextAt = 0, pausedUntil = 0, blocked = false;
let saved = 0, savedBytes = 0;
let canada = null;                   // Promise<string> of the divisions' GeoJSON
let canadaState = 'not needed yet';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const userAgent = () => `Polyopticon/${app.getVersion()} (https://github.com/rethy-xyz-networks/Polyopticon) Electron/${process.versions.electron}`;

function init(dataDir) {
  dir = dataDir;
  photoDir = path.join(dir, 'photos');
  fs.mkdirSync(photoDir, { recursive: true });
  for (const f of fs.readdirSync(photoDir)) { saved++; savedBytes += fs.statSync(path.join(photoDir, f)).size; }
}

const photos = () => (manifest ??= JSON.parse(fs.readFileSync(MANIFEST, 'utf8')));
const cacheName = file => crypto.createHash('sha1').update(file).digest('hex');

// Commons requests: one shared allowance

async function slot() {
  for (;;) {
    const now = Date.now(), at = Math.max(nextAt, pausedUntil);
    if (at <= now) { nextAt = now + 1 / rate; return; }
    await sleep(at - now);
  }
}

function slowDown(ms, why) {
  rate = Math.max(RATE_MIN, rate / 2);
  pausedUntil = Math.max(pausedUntil, Date.now() + ms);
  log.warn(`Map photos: ${why}; pausing ${Math.round(ms / 1000)} s, then ${Math.round(rate * 60e3)} a minute`);
}

/** A Commons file's bytes, or { retry: true } to try later, or null if it's gone. */
async function commons(url) {
  await slot();
  let res;
  try { res = await request(url, { headers: { 'User-Agent': userAgent() }, timeout: 30e3 }); }
  catch { return { retry: true }; }
  if (res.ok) {
    if (blocked) { blocked = false; log.info('Map photos: Wikimedia is answering again'); }
    rate = Math.min(RATE_MAX, rate * 1.05);
    return { body: Buffer.from(await res.arrayBuffer()), type: (res.headers.get('content-type') || '').split(';')[0] };
  }
  if (res.status === 403) {
    if (!blocked) log.warn(`Map photos: Wikimedia refused us (403): ${(await res.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`);
    blocked = true;
    slowDown(BLOCK_PAUSE_MS, 'blocked');
    return { retry: true };
  }
  if ([429, 502, 503, 504].includes(res.status)) {
    slowDown(parseRetryAfter(res.headers.get('retry-after')) || THROTTLE_PAUSE_MS, `HTTP ${res.status}`);
    return { retry: true };
  }
  return null;
}

/** Scaled to cover the card's frame, then cut to at most 320×260: centred, or from the top for a montage. */
function fit(body, top) {
  let img = nativeImage.createFromBuffer(body);
  if (img.isEmpty()) return null;
  let { width: w, height: h } = img.getSize();
  const k = Math.max(W / w, H / h);
  img = img.resize({ width: Math.max(W, Math.round(w * k)), height: Math.max(H, Math.round(h * k)), quality: 'best' });
  ({ width: w, height: h } = img.getSize());
  const ch = Math.min(h, H_MAX);
  return img.crop({ x: Math.floor((w - W) / 2), y: top ? 0 : Math.floor((h - ch) / 2), width: W, height: ch }).toJPEG(80);
}

// Photos

function readCached(file) {
  try { return { body: fs.readFileSync(path.join(photoDir, cacheName(file))), type: 'image/jpeg' }; } catch { return null; }
}

/** The saved photo, or { retry: true }, or null if it can't be had. */
async function download(file) {
  const [url, , , , top] = photos()[file];
  const got = await commons(url);
  if (!got?.body) return got;
  const body = fit(got.body, top);
  if (!body) return null;
  const p = path.join(photoDir, cacheName(file));
  fs.writeFileSync(`${p}.tmp`, body);
  fs.renameSync(`${p}.tmp`, p);
  saved++; savedBytes += body.length;
  return { body, type: 'image/jpeg' };
}

function pump() {
  while (running < JOBS && background.length) {
    const file = background.shift();
    if (!waiting.delete(file)) continue;       // already fetched for a card
    running++;
    photo(file).finally(() => { running--; pump(); });
  }
}

function queue(file) {
  if (waiting.has(file) || inflight.has(file) || fs.existsSync(path.join(photoDir, cacheName(file)))) return;
  waiting.add(file);
  background.push(file);
  pump();
}

/** A photo from the cache, else downloaded now. One Wikimedia couldn't give us now is queued to try again later. */
function photo(file) {
  const cached = readCached(file);
  if (cached) return Promise.resolve(cached);
  if (!inflight.has(file)) inflight.set(file, (async () => {
    const got = await download(file).catch(e => { log.warn(`Map photos: ${file}: ${e.message}`); return null; });
    inflight.delete(file);
    if (got?.retry) { queue(file); return null; }
    return got;
  })());
  return inflight.get(file);
}

/** Files to fetch in the background, most wanted first. */
function prefetch(files) {
  if (!Array.isArray(files) || process.env.POLYOPTICON_NO_PREFETCH) return;     // the e2e tests fetch only what they open
  for (const f of files) if (typeof f === 'string' && Object.hasOwn(photos(), f)) queue(f);
}

/** protocol.handle callback for polyopticon-map://photo/<file>. */
async function handle(req) {
  const u = new URL(req.url);
  const file = decodeURIComponent(u.pathname.slice(1));
  if (u.hostname !== 'photo' || !Object.hasOwn(photos(), file)) return new Response(null, { status: 404 });
  waiting.delete(file);
  const got = await photo(file);
  if (!got) return new Response(null, { status: 503 });
  return new Response(got.body, { headers: { 'content-type': got.type, 'cache-control': 'max-age=31536000' } });
}

// Canada's census divisions (GADM level 2)

/** The bytes of the first entry in a zip whose name matches rx. */
function unzipEntry(buf, rx) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip file');
  let p = buf.readUInt32LE(end + 16);
  for (let i = buf.readUInt16LE(end + 10); i > 0; i--) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nl), at = buf.readUInt32LE(p + 42);
    if (rx.test(name)) {
      const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28), data = buf.subarray(start, start + size);
      return method === 8 ? zlib.inflateRawSync(data) : data;
    }
    p += 46 + nl + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  throw new Error(`nothing like ${rx} in the zip`);
}

/** Douglas–Peucker: the points of pts that keep it within tol of the original. */
function simplifyLine(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(), [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let m = -1, md = tol;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = pts[i];
      const d = len < 1e-9 ? Math.hypot(x - ax, y - ay) : Math.abs(dy * x - dx * y + bx * ay - by * ax) / len;
      if (d > md) { m = i; md = d; }
    }
    if (m > 0) { keep[m] = 1; stack.push([a, m], [m, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** A ring simplified to about half a km and rounded to 3 decimals; null if nothing is left of it. */
function simplifyRing(pts) {
  const out = [];
  for (const [x, y] of simplifyLine(pts, 0.006)) {
    const p = [Math.round(x * 1e3) / 1e3, Math.round(y * 1e3) / 1e3];
    if (!out.length || out.at(-1)[0] !== p[0] || out.at(-1)[1] !== p[1]) out.push(p);
  }
  return out.length >= 4 ? out : null;
}

function simplifyGeometry(g) {
  const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map(poly => poly.map(simplifyRing).filter(Boolean)).filter(p => p.length);
  return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
}

// Statistics Canada's province codes, by GADM's HASC; a division's code is its province's and its own number
// (Wikidata's P3012). GADM's "NF" is Newfoundland and Labrador (ISO CA-NL).
const SGC = { NF: '10', PE: '11', NS: '12', NB: '13', QC: '24', ON: '35', MB: '46', SK: '47', AB: '48', BC: '59', YT: '60', NT: '61', NU: '62' };

/** GADM's Canada level 2 -> the map's census divisions: simplified, with province, name and code. */
function divisionsFromGadm(geo) {
  const features = [];
  for (const f of geo.features) {
    const p = f.properties, geometry = simplifyGeometry(f.geometry);
    if (!geometry) continue;
    const hasc = (p.HASC_2 || '').split('.')[1];
    features.push({ type: 'Feature', geometry, properties: {
      iso: 'CA', parent: `CA-${hasc === 'NF' ? 'NL' : hasc}`, kind: 'Census division',
      name: p.NAME_2.replace(/(?<=[a-z])(?=[A-Z0-9])|(?<=\.)(?=\d)/g, ' '),
      code: SGC[hasc] && /^\d\d$/.test(p.CC_2) ? SGC[hasc] + p.CC_2 : p.GID_2,
    } });
  }
  return { type: 'FeatureCollection', features };
}

async function fetchCanada() {
  const res = await request(GADM_URL, { headers: { 'User-Agent': userAgent() }, timeout: 180e3 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  return JSON.stringify(divisionsFromGadm(JSON.parse(unzipEntry(zip, /\.json$/i).toString('utf8'))));
}

/** The divisions' GeoJSON: from the cache, else downloaded, trying again (less and less often) until it works. */
function canadaDivisions() {
  return (canada ??= (async () => {
    const file = path.join(dir, 'ca-divisions.geojson');
    try { const text = fs.readFileSync(file, 'utf8'); canadaState = 'saved'; return text; } catch {}
    for (let wait = 60e3; ; wait = Math.min(wait * 3, 6 * 3600e3)) {
      canadaState = 'downloading';
      try {
        const text = await fetchCanada();
        fs.writeFileSync(`${file}.tmp`, text);
        fs.renameSync(`${file}.tmp`, file);
        canadaState = 'saved';
        log.info(`Map: Canada's census divisions downloaded from GADM (${Math.round(text.length / 1e3)} kB)`);
        return text;
      } catch (e) {
        canadaState = `waiting to retry (${e.message})`;
        log.warn(`Map: Canada's census divisions not downloaded (${e.message}); trying again in ${Math.round(wait / 60e3)} min`);
        await sleep(wait);
      }
    }
  })());
}

function stats() {
  return {
    photos: saved, photoBytes: savedBytes, photosQueued: waiting.size,
    pausedUntil: pausedUntil > Date.now() ? pausedUntil : 0, blocked, canada: canadaState,
  };
}

module.exports = { init, handle, prefetch, canadaDivisions, stats, unzipEntry, divisionsFromGadm, simplifyRing };
