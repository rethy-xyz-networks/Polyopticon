'use strict';

// Ad / tracker blocking for the article and 4chan <webview> sessions.
//
// Two layers:
//   1. A built-in list of ad-exchange / tracker hosts — always on, works offline.
//   2. EasyList + EasyPrivacy (the lists uBlock Origin uses), via Ghostery's
//      adblocker engine: blocks ad requests by URL pattern and hides the empty
//      ad slots left on the page (cosmetic filters). The lists are downloaded in
//      the background, kept in the data folder and refreshed weekly; until the
//      first download finishes only layer 1 applies.
// Only sub-resources are blocked — the page itself always loads.

const fs = require('fs');
const log = require('./logger');

const BLOCKED_SUFFIXES = [
  // Ad exchanges / SSPs / DSPs
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
  'amazon-adsystem.com', 'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net',
  'casalemedia.com', 'indexww.com', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com',
  'sharethrough.com', 'triplelift.com', '3lift.com', 'smartadserver.com', 'teads.tv', 'yieldmo.com',
  'adsrvr.org', 'bidswitch.net', 'contextweb.com', 'districtm.io', 'gumgum.com', 'media.net',
  'sovrn.com', 'lijit.com', 'spotxchange.com', 'spotx.tv', 'springserve.com', 'undertone.com',
  'omnitagjs.com', 'adyoulike.com', 'cootlogix.com', 'kueez.com', 'smaato.net', 'servenobid.com',
  'ads-tinyorbit.com', 'measureadv.com', 'programmaticx.ai', 'krushmedia.com', 'onetag-sys.com',
  'yahoo.net', 'adtech.yahoo.com', 'advertising.com', 'zemanta.com', 'mgid.com', 'revcontent.com',
  'adform.net', 'adition.com', 'connatix.com', 'primis.tech', 'minutemedia-prebid.com',
  'prebid.org', 'ad-delivery.net', 'adsafeprotected.com', 'doubleverify.com', 'moatads.com',
  'everesttech.net', 'demdex.net', 'agkn.com', 'bluekai.com', 'krxd.net', 'exelator.com',
  'rlcdn.com', 'tapad.com', 'crwdcntrl.net', 'id5-sync.com', 'liadm.com', 'mathtag.com',
  'turn.com', 'eyeota.net', 'adsymptotic.com', 'quantserve.com', 'quantcount.com', 'scorecardresearch.com',
  'chartbeat.com', 'chartbeat.net', 'permutive.com', 'permutive.app', 'hotjar.com', 'mouseflow.com',
  'newrelic.com', 'nr-data.net', 'branch.io', 'bounceexchange.com', 'bouncex.net', 'wunderkind.co',
  'facebook.net', 'connect.facebook.net', 'ads-twitter.com', 'analytics.twitter.com', 'ads.linkedin.com',
  'snap.licdn.com', 'bat.bing.com', 'clarity.ms',
  'googletagmanager.com', 'google-analytics.com', 'googletagservices.com',
];

// Hostname prefixes that are almost always tracking/sync endpoints.
const BLOCKED_PREFIX = /^(ads?|adserver|adsrv|track(er|ing)?|pixel|bsync|usersync|cookie-?sync|sync|beacon|metrics|stats|telemetry)[.-]/i;

const suffixSet = new Set(BLOCKED_SUFFIXES);

function isBlockedHost(host) {
  if (BLOCKED_PREFIX.test(host)) return true;
  // Walk parent domains: a.b.example.com → b.example.com → example.com
  for (let h = host; h.includes('.'); h = h.slice(h.indexOf('.') + 1))
    if (suffixSet.has(h)) return true;
  return false;
}

// Filter lists

const LIST_MAX_AGE_MS = 7 * 24 * 3600e3;

let engine = null;                   // ElectronBlocker once the lists are loaded
const sessions = new Set();          // sessions blocking is installed on
const stats = { blocked: 0 };

/** Cosmetic filtering (hiding ad slots) runs from a preload in each page of the session. */
function enableCosmetics(ses) {
  if (!engine) return;
  ses.registerPreloadScript({ type: 'frame', filePath: require.resolve('@ghostery/adblocker-electron-preload') });
}

function useEngine(e) {
  const { ipcMain } = require('electron');
  const first = !engine;
  engine = e;
  if (!first) return;
  // One pair of handlers serves the preloads of every session.
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (ev, url, msg) => engine.onInjectCosmeticFilters(ev, url, msg));
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', ev => engine.onIsMutationObserverEnabled(ev));
  for (const ses of sessions) enableCosmetics(ses);
}

/** Load the lists from `cacheFile`, downloading them when missing or a week old. */
async function loadLists(cacheFile) {
  const { ElectronBlocker } = require('@ghostery/adblocker-electron');
  let age = Infinity;
  try {
    const buf = await fs.promises.readFile(cacheFile);
    age = Date.now() - (await fs.promises.stat(cacheFile)).mtimeMs;
    useEngine(ElectronBlocker.deserialize(new Uint8Array(buf)));
    log.info(`Ad blocking: filter lists loaded (${Math.round(age / 3600e3)} h old)`);
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn(`Ad blocking: saved filter lists unreadable (${e.message}) — downloading`);
  }
  if (age < LIST_MAX_AGE_MS) return;
  try {
    const fresh = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
    await fs.promises.writeFile(cacheFile, fresh.serialize());
    useEngine(fresh);
    log.info('Ad blocking: filter lists downloaded');
  } catch (e) {
    log.warn(`Ad blocking: filter list download failed (${e.message}) — ${engine ? 'keeping the saved lists' : 'built-in host list only'}`);
  }
}

/** Is this sub-resource request an ad or tracker? */
function shouldBlock(details) {
  let host;
  try { host = new URL(details.url).hostname; } catch { return { cancel: false }; }
  if (isBlockedHost(host)) return { cancel: true };
  if (!engine) return { cancel: false };
  const { fromElectronDetails } = require('@ghostery/adblocker-electron');
  const request = fromElectronDetails(details);
  if (request.type === 'other') request.guessTypeOfRequest();
  const { redirect, match } = engine.match(request);
  if (redirect) return { redirectURL: redirect.dataUrl };     // e.g. a harmless stand-in script
  return { cancel: !!match };
}

/** Installs blocking on an Electron session. Returns a counter for logging. */
function install(ses) {
  sessions.add(ses);
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, cb) => {
    if (details.resourceType === 'mainFrame') return cb({});
    const result = shouldBlock(details);
    if (result.cancel || result.redirectURL) stats.blocked++;
    cb(result);
  });
  enableCosmetics(ses);
  return stats;
}

module.exports = { install, loadLists, isBlockedHost };
