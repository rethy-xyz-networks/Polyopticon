'use strict';

// The Scratchpad: one permanent note (text plus pasted images), encrypted with Electron
// safeStorage (DPAPI on Windows — only this Windows user can decrypt the file), like secrets.js.
// Nothing is ever written unencrypted: if OS encryption is unavailable the note stays in memory.
//
// Shape: { text: string, images: { <id>: 'data:image/…;base64,…' } }
// The text refers to an image as ![name](scratch-img:<id>).

const { safeStorage } = require('electron');
const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

const MAX_BYTES = 64 * 1024 * 1024;                       // the whole note, before encryption
const IMAGE_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const IMAGE_ID  = /^[A-Za-z0-9_-]{1,40}$/;

let file = null;
let data = { text: '', images: {} };

function load(dir) {
  file = path.join(dir, 'scratchpad.bin');
  data = { text: '', images: {} };
  try {
    if (fs.existsSync(file)) data = clean(JSON.parse(safeStorage.decryptString(fs.readFileSync(file))));
  } catch (e) {
    log.warn(`Scratchpad could not be decrypted (${e.message}) — starting empty`);
  }
  return data;
}

/** Only what the note is allowed to contain: text, and image data URLs under safe ids. */
function clean(raw) {
  const out = { text: typeof raw?.text === 'string' ? raw.text : '', images: {} };
  for (const [id, url] of Object.entries(raw?.images ?? {}))
    if (IMAGE_ID.test(id) && typeof url === 'string' && IMAGE_URL.test(url)) out.images[id] = url;
  return out;
}

/** Writes the note. Returns { ok, error? }. */
function save(next) {
  const note = clean(next);
  const json = JSON.stringify(note);
  if (json.length > MAX_BYTES) return { ok: false, error: 'The scratchpad is too large to save (over 64 MB) — remove some images.' };
  data = note;
  if (!file) return { ok: false, error: 'The scratchpad is not ready yet.' };
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('OS encryption unavailable — scratchpad kept in memory only');
    return { ok: false, error: 'Windows encryption is unavailable, so the scratchpad was not saved to disk.' };
  }
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, safeStorage.encryptString(json));
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    log.warn(`Scratchpad save failed: ${e.message}`);
    return { ok: false, error: `Could not save the scratchpad: ${e.message}` };
  }
}

const get = () => data;

module.exports = { load, save, get };
