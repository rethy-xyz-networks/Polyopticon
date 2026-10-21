'use strict';

// The app was renamed from ItsOver: the first launch moves the old data folders
// (%LocalAppData%\ItsOver, %AppData%\ItsOver) and database file to the new names.
// Runs with LOCALAPPDATA / APPDATA pointing at a temp folder — never the real ones.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, _electron: electron } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..', '..');

test('first launch after the rename moves the old folders and database', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'polyopticon-rename-'));
  const local = path.join(home, 'Local'), roaming = path.join(home, 'Roaming');
  const oldData = path.join(local, 'ItsOver'), oldBrowser = path.join(roaming, 'ItsOver');
  fs.mkdirSync(oldData, { recursive: true });
  fs.mkdirSync(oldBrowser, { recursive: true });
  // A real database from a first run, then renamed back to the old file name.
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'polyopticon-seed-'));
  let app = await electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, POLYOPTICON_DATA_DIR: seed, POLYOPTICON_OFFSCREEN: '1' } });
  await (await app.firstWindow()).waitForLoadState('domcontentloaded');
  await app.close();
  fs.copyFileSync(path.join(seed, 'polyopticon.db'), path.join(oldData, 'itsover.db'));
  fs.writeFileSync(path.join(oldData, 'settings.json'), JSON.stringify({ IsDarkTheme: false, ChatDestiny: false }));
  fs.writeFileSync(path.join(oldBrowser, 'marker.txt'), 'cookies live here');

  const env = { ...process.env, LOCALAPPDATA: local, APPDATA: roaming, POLYOPTICON_OFFSCREEN: '1' };
  delete env.POLYOPTICON_DATA_DIR;
  app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  try {
    const window = await app.firstWindow();
    await expect(window.locator('#status-text')).not.toHaveText('Connecting…', { timeout: 30_000 });
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');     // old settings carried over
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(path.join(roaming, 'Polyopticon'));
  } finally { await app.close(); }

  const newData = path.join(local, 'Polyopticon');
  expect(fs.existsSync(oldData)).toBe(false);
  expect(fs.existsSync(path.join(newData, 'polyopticon.db'))).toBe(true);
  expect(fs.existsSync(path.join(newData, 'itsover.db'))).toBe(false);
  expect(fs.readFileSync(path.join(roaming, 'Polyopticon', 'marker.txt'), 'utf8')).toBe('cookies live here');
  const logs = fs.readdirSync(path.join(newData, 'logs')).map(f => fs.readFileSync(path.join(newData, 'logs', f), 'utf8')).join('');
  expect(logs).toContain('Renamed from the old name');
  for (const d of [home, seed]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
