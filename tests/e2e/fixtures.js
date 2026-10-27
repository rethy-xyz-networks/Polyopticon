'use strict';

// Shared fixtures: every test gets the real app, launched against a throwaway
// data folder (POLYOPTICON_DATA_DIR) so it never reads or changes the user's own
// settings, database or logins. The folder is deleted afterwards.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { test: base, expect, _electron: electron } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..', '..');

// The ad-blocking filter lists (a few MB) are downloaded once and shared by every
// test's data folder, instead of once per launch.
const LISTS = 'adblock-lists.bin';
const SHARED_LISTS = path.join(os.tmpdir(), `polyopticon-test-${LISTS}`);
const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
// Likewise Canada's census divisions for the map, which the app downloads from GADM.
const CANADA = path.join('map', 'ca-divisions.geojson');
const SHARED_CANADA = path.join(os.tmpdir(), 'polyopticon-test-ca-divisions.geojson');

// Pre-seeded settings: keep runs quick and quiet. The large translation model is
// ~1 GB to download if a test translates an article,
// and the chat panel would load destiny.gg.
const TEST_SETTINGS = {
  TranslateLargeModel: false,
  ChatDestiny: false,
  ChatTwitchChannels: '',
  ChatIrc: '',
};

const test = base.extend({
  // Settings to merge over TEST_SETTINGS; override per file with test.use({ settings: {...} }).
  settings: [{}, { option: true }],

  dataDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyopticon-test-'));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  },

  app: async ({ dataDir, settings }, use) => {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ ...TEST_SETTINGS, ...settings }, null, 2));
    const lists = path.join(dataDir, LISTS);
    if (mtime(SHARED_LISTS)) fs.copyFileSync(SHARED_LISTS, lists);
    const canada = path.join(dataDir, CANADA);
    if (mtime(SHARED_CANADA)) { fs.mkdirSync(path.dirname(canada), { recursive: true }); fs.copyFileSync(SHARED_CANADA, canada); }
    const app = await electron.launch({
      args: [ROOT],
      cwd: ROOT,
      // Off-screen and unfocused, so the computer stays usable during a run. The map fetches only the photos a test opens.
      env: { ...process.env, POLYOPTICON_DATA_DIR: dataDir, POLYOPTICON_OFFSCREEN: '1', POLYOPTICON_NO_PREFETCH: '1' },
    });
    await use(app);
    await app.close();
    if (mtime(lists) > mtime(SHARED_LISTS)) fs.copyFileSync(lists, SHARED_LISTS);
    if (mtime(canada) > mtime(SHARED_CANADA)) fs.copyFileSync(canada, SHARED_CANADA);
  },

  // The main window, loaded and initialised, with uncaught page errors collected.
  window: async ({ app }, use) => {
    const win = await app.firstWindow();
    const errors = [];
    win.on('pageerror', err => errors.push(err));
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('#status-text')).not.toHaveText('Connecting…');
    win.pageErrors = errors;
    await use(win);
  },
});

module.exports = { test, expect };
