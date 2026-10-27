'use strict';

// settings.json / tags.json persistence. Uses the same location and
// PascalCase JSON shape as the C# build so existing files carry over.
// Enums are numeric: FeedDensity 0=Compact 1=Normal 2=Comfortable,
// TagScope 0=Both 1=Title 2=Description.

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

// The app's own pages that can be open as tabs (src/renderer/tabs.js APP_TABS).
const APP_PAGES = new Set(['help', 'scratch', 'map', 'bias', 'markets']);

const DEFAULT_SETTINGS = Object.freeze({
  FontFamily: 'Segoe UI',
  FontSize: 13.0,
  FeedDensity: 1,
  ShowSourceBadge: true,
  DescriptionLength: 160,      // characters of each story's description in the list; 0 = off
  RefreshIntervalSeconds: 5,   // the fastest a feed is polled (quiet feeds are polled less often, see adapters/pacing.js)
  MaxArticleAgeHours: 0,
  MaxFeedItems: 1000,
  AlwaysOpenInBrowser: false,
  WebViewZoom: 1.0,
  SourceStaggerMs: 300,
  LogRetentionCount: 20,
  DebugLogging: false,
  IsDarkTheme: true,
  SnapshotRetentionDays: 90,
  TranslateLargeModel: true,
  GroupStories: true,
  ChatTwitchChannels: '',      // comma-separated Twitch channel names
  ChatKickChannels: '',        // comma-separated Kick channel names
  ChatIrc: '',                  // comma-separated IRC rooms, e.g. ircs://irc.libera.chat:6697/#linux
  ChatDestiny: false,           // destiny.gg chat: off until switched on in the chat panel or Settings
  ScrollableTabs: true,        // story tabs keep a readable width and the strip scrolls, instead of shrinking to fit
  ShowChanButton: true,       // the 🍀 4chan /pol/ button in the toolbar
  ScreenshotFolder: '',        // where 📸 screenshots are saved; '' = the user's Pictures folder
});

let baseDir = null;

function readJson(file) {
  const p = path.join(baseDir, file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
}

// Write via temp file + rename so a crash mid-write can't corrupt the file.
function writeJson(file, data) {
  const p = path.join(baseDir, file);
  const tmp = `${p}.tmp`;
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

module.exports = {
  init(dir) { baseDir = dir; },

  loadSettings() {
    try {
      const raw = readJson('settings.json') || {};
      const s = { ...DEFAULT_SETTINGS };
      for (const k of Object.keys(DEFAULT_SETTINGS))
        if (raw[k] !== undefined && typeof raw[k] === typeof DEFAULT_SETTINGS[k]) s[k] = raw[k];
      return s;
    } catch (e) {
      log.warn(`Settings load failed: ${e.message}`);
      return { ...DEFAULT_SETTINGS };
    }
  },

  saveSettings(s) {
    try { writeJson('settings.json', s); }
    catch (e) { log.warn(`Settings save failed: ${e.message}`); }
  },

  loadTags() {
    try {
      const raw = readJson('tags.json') || {};
      const clean = list => (Array.isArray(list) ? list : [])
        .filter(t => t && typeof t.Text === 'string' && t.Text.trim())
        .map(t => ({ Text: t.Text, IsActive: t.IsActive !== false, Scope: [0, 1, 2].includes(t.Scope) ? t.Scope : 0 }));
      return { Inclusions: clean(raw.Inclusions), Exclusions: clean(raw.Exclusions) };
    } catch (e) {
      log.error('Failed to load tag filters', e);
      return { Inclusions: [], Exclusions: [] };
    }
  },

  saveTags(tags) {
    try { writeJson('tags.json', tags); }
    catch (e) { log.error('Failed to save tag filters', e); }
  },

  /** Layout and view state (window, pane widths, unticked sources, toggles) — see ui.js in the renderer. */
  loadUi() {
    try {
      const raw = readJson('ui.json');
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (e) {
      log.warn(`UI state load failed: ${e.message}`);
      return {};
    }
  },

  saveUi(ui) {
    try { writeJson('ui.json', ui); }
    catch (e) { log.warn(`UI state save failed: ${e.message}`); }
  },

  /** The open tabs in strip order (pinned.json; it held only the pinned ones before tabs were restored in full):
   *  [{ id, mode, pinned, active? }], plus { chan, url, title } for 4chan / Telegram pages
   *  ({ draft } for a new Telegram tab not yet connected) and { app } for the app's own pages (APP_PAGES).
   *  Entries from the old pinned-only file have no `pinned` flag and count as pinned. */
  loadPinned() {
    try {
      const raw = readJson('pinned.json');
      return (Array.isArray(raw) ? raw : []).filter(p => Number.isInteger(p?.id)).map(p => ({
        id: p.id, mode: String(p.mode || 'live'), pinned: p.pinned !== false, ...(p.active ? { active: true } : {}),
        ...(p.chan && typeof p.url === 'string' ? { chan: true, url: p.url, title: String(p.title || ''), ...(p.draft ? { draft: true } : {}) } : {}),   // 4chan / Telegram page
        ...(APP_PAGES.has(p.app) ? { app: p.app } : {}),
      }));
    } catch (e) {
      log.warn(`Pinned tabs load failed: ${e.message}`);
      return [];
    }
  },

  savePinned(list) {
    try { writeJson('pinned.json', Array.isArray(list) ? list : []); }
    catch (e) { log.warn(`Pinned tabs save failed: ${e.message}`); }
  },
};
