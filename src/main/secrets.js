'use strict';

// API keys and account sessions, encrypted with Electron safeStorage
// (DPAPI on Windows — only this Windows user can decrypt the file).
//
// Shape: { guardianKey, nytKey, newsapiKey,
//          bluesky: { handle, appPassword },
//          telegram: { apiId, apiHash, session, user } }

const { safeStorage } = require('electron');
const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

let file = null;
let data = {};

function load(dir) {
  file = path.join(dir, 'accounts.bin');
  data = {};
  try {
    if (fs.existsSync(file)) data = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
  } catch (e) {
    log.warn(`Accounts file could not be decrypted (${e.message}) — starting empty`);
  }
  return data;
}

function save(next) {
  data = next;
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('OS encryption unavailable — account details kept in memory only');
    return;
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(data)));
  fs.renameSync(tmp, file);
}

const get = () => data;

/** What the UI may see: which keys are set, never the values. */
function summary() {
  return {
    guardianKey: !!data.guardianKey,
    nytKey: !!data.nytKey,
    newsapiKey: !!data.newsapiKey,
    bluesky: data.bluesky?.handle ? { handle: data.bluesky.handle } : null,
    telegram: {
      apiId: data.telegram?.apiId || '',
      hasApiHash: !!data.telegram?.apiHash,
      user: data.telegram?.session ? data.telegram.user || 'Logged in' : null,
    },
  };
}

module.exports = { load, save, get, summary };
