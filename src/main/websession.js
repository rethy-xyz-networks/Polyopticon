'use strict';

// Site logins and cookie choices survive restarts, as in a browser that continues where it left off.
//
// The "persist:" sessions (articles, chat, 4chan) already keep persistent cookies, local storage,
// IndexedDB and the HTTP cache on disk. Two things are lost between launches without this module:
//   - session cookies (no expiry date), which Chromium drops when the app exits. Many sites keep
//     a login or a cookie-banner answer in one. They are saved here and set again at the next start,
//     before any page loads.
//   - cookies changed in the last ~30 s, which Chromium hasn't written yet if the app is killed or
//     Windows shuts down (no 'before-quit' then). The cookie store is flushed with each save.
// Saves happen a few seconds after a session cookie changes, and once more at quit.
//
// The file (session-cookies.bin, next to Chromium's own Cookies file) is encrypted with safeStorage
// (DPAPI on Windows). Where OS encryption is unavailable it is written readable by this user only,
// as Chromium's own Cookies file is.

const { session, safeStorage } = require('electron');
const fs  = require('fs');
const log = require('./logger');

const SAVE_DELAY_MS = 5_000;       // after a session cookie changes
const SAVE_TIMEOUT_MS = 3_000;     // quitting never waits longer than this

let file = null;
let partitions = [];
let timer = null;

/** Session cookie (from cookies.get) -> the details cookies.set takes to recreate it. */
function toSetDetails(c) {
  const host = c.domain.replace(/^\./, '');
  const d = {
    url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
    name: c.name, value: c.value, path: c.path || '/',
    secure: !!c.secure, httpOnly: !!c.httpOnly,
  };
  if (!c.hostOnly) d.domain = c.domain;       // host-only cookies (and __Host- ones) must not name a domain
  if (c.sameSite) d.sameSite = c.sameSite;
  return d;                                   // no expirationDate: it stays a session cookie
}

function encode(obj) {
  const json = JSON.stringify(obj);
  return safeStorage.isEncryptionAvailable()
    ? Buffer.concat([Buffer.from('E'), safeStorage.encryptString(json)])
    : Buffer.from(`P${json}`);
}
function decode(buf) {
  if (buf[0] === 0x45) return JSON.parse(safeStorage.decryptString(buf.subarray(1)));   // 'E'
  if (buf[0] === 0x50) return JSON.parse(buf.subarray(1).toString('utf8'));              // 'P'
  throw new Error('unknown format');
}

function init(opts) {
  ({ file, partitions } = opts);
  for (const p of partitions) {
    session.fromPartition(p).cookies.on('changed', (_e, cookie) => { if (cookie.session) schedule(); });
  }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; save().catch(e => log.warn(`Site sessions not saved: ${e.message}`)); }, SAVE_DELAY_MS);
  timer.unref?.();
}

/** Sets the saved session cookies again. Call before any page loads. */
async function restore() {
  let saved;
  try {
    if (!fs.existsSync(file)) return;
    saved = decode(fs.readFileSync(file));
  } catch (e) {
    log.warn(`Saved site sessions unreadable (${e.message}) — starting without them`);
    return;
  }
  let n = 0;
  for (const p of partitions) {
    const cookies = session.fromPartition(p).cookies;
    await Promise.all((saved[p] || []).map(c => cookies.set(toSetDetails(c)).then(() => n++, e => log.debug(`Session cookie ${c.name} for ${c.domain} not restored: ${e.message}`))));
  }
  log.info(`Site sessions restored: ${n} session cookies`);
}

let saving = null;
/** Writes every session's session cookies to the file and flushes the cookie stores. */
function save() {
  if (!file) return Promise.resolve();          // quit before start-up finished
  if (saving) return saving;
  clearTimeout(timer);
  timer = null;
  const work = (async () => {
    const out = {};
    for (const p of partitions) {
      const cookies = session.fromPartition(p).cookies;
      out[p] = (await cookies.get({})).filter(c => c.session)
        .map(({ name, value, domain, hostOnly, path, secure, httpOnly, sameSite }) => ({ name, value, domain, hostOnly, path, secure, httpOnly, sameSite }));
      await cookies.flushStore();
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, encode(out), { mode: 0o600 });
    fs.renameSync(tmp, file);
  })();
  const limit = new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), SAVE_TIMEOUT_MS).unref?.());
  saving = Promise.race([work, limit]).finally(() => { saving = null; });
  return saving;
}

module.exports = { init, restore, save };
