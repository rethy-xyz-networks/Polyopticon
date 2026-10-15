'use strict';

// Launches the real app against a database of realistic size and times start-up:
//   window   - launch until the window shows its first state (not "Connecting…")
//   init IPC - the renderer's app:init call (settings, sources, the live list: runs on the main thread)
//   index    - the feed worker building the story-grouping index ("Grouping index … in N ms" in the log)
//   retag    - re-tagging places after the matcher changed ("Places re-tagged … in N ms"), when it runs
//
//   node scripts/bench/startup.js [--items=40000] [--runs=3] [--cold] [--root=<app folder>]
//
// --cold stores the items without groups/places/language, as after an upgrade (the worker then fills them in).
// --root runs another checkout (e.g. a git worktree of an older commit) against the same data, to compare.
// The data comes from this checkout's src/main/db.js; the app is closed after each run.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('@playwright/test');

const args = process.argv.slice(2);
const flag = (n, d) => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const ITEMS = Number(flag('items', 40000));
const RUNS = Number(flag('runs', 3));
const COLD = args.includes('--cold');
const APP = path.resolve(flag('root', path.join(__dirname, '..', '..')));
const HERE = path.resolve(__dirname, '..', '..');

const dbm = require(path.join(HERE, 'src', 'main', 'db'));
const { SEED_REVISION } = require(path.join(HERE, 'src', 'main', 'config'));
const corpus = require(path.join(HERE, 'tests', 'unit', 'geotag-corpus.json'));

function seed(dir) {
  const db = dbm.open(path.join(dir, 'polyopticon.db'));
  const sources = Array.from({ length: 120 }, (_, i) => db.addSource({ type: 'rss', name: `Bench ${i}`, grp: ['USA', 'UK', 'Israel', 'India', 'France'][i % 5], enabled: false, config: { url: `http://127.0.0.1:9/${i}` } }));
  let s = 99;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const now = Date.now();
  for (let at = 0; at < ITEMS; at += 1000) {
    db.insertItems(sources[at % sources.length].id, Array.from({ length: Math.min(1000, ITEMS - at) }, (_, k) => {
      const c = corpus[(at + k) % corpus.length];
      return { extId: `x${at + k}`, kind: 'article', title: `${c.title} ${at + k}`, summary: c.summary, url: `https://example.com/${at + k}`, publishedAt: now - Math.floor(rnd() * 60 * 3600e3) };
    }));
  }
  if (!COLD) db.raw.exec(`UPDATE items SET cluster_id = id, places = '[]', lang = 'en'`);
  db.setMeta('seed_revision', SEED_REVISION);        // keep the app from adding its default sources
  db.setMeta('geotagVersion', COLD ? 1 : 2);
  db.close();
}

const logLines = dir => {
  const logs = path.join(dir, 'logs');
  if (!fs.existsSync(logs)) return [];
  const f = fs.readdirSync(logs).filter(n => n.startsWith('session_')).sort().pop();
  return f ? fs.readFileSync(path.join(logs, f), 'utf8').split('\n') : [];
};
const ms = (lines, rx) => { const m = lines.map(l => rx.exec(l)).find(Boolean); return m ? Number(m[1]) : null; };
const median = a => { a = a.filter(x => x != null).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };

(async () => {
  const template = fs.mkdtempSync(path.join(os.tmpdir(), 'polybench-template-'));
  seed(template);
  console.log(`${APP}\n  ${ITEMS} stored items, ${COLD ? 'cold (no groups/places)' : 'warm (already tagged)'}, ${RUNS} runs`);
  const runs = [];
  for (let r = 0; r < RUNS; r++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polybench-run-'));
    for (const f of fs.readdirSync(template)) fs.cpSync(path.join(template, f), path.join(dir, f), { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ TranslateEnabled: false, ChatDestiny: false, ChatTwitchChannels: '', ChatIrc: '' }));
    const t0 = Date.now();
    const app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, POLYOPTICON_DATA_DIR: dir, POLYOPTICON_OFFSCREEN: '1' } });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => document.getElementById('status-text')?.textContent !== 'Connecting…', null, { timeout: 120000 });
    const window = Date.now() - t0;
    const init = await win.evaluate(async () => { const t = performance.now(); await window.polyopticon.init(); return performance.now() - t; });
    let lines = [];
    for (let i = 0; i < 240; i++) {                  // up to 2 min for the worker
      lines = logLines(dir);
      const idx = ms(lines, /Grouping index: .* in (\d+) ms/);
      const retagNeeded = COLD;
      if (idx != null && (!retagNeeded || ms(lines, /Places re-tagged: .* in (\d+) ms/) != null)) break;
      await new Promise(r => setTimeout(r, 500));
    }
    const row = { window, init: Math.round(init), index: ms(lines, /Grouping index: .* in (\d+) ms/), retag: ms(lines, /Places re-tagged: .* in (\d+) ms/) };
    runs.push(row);
    console.log('  run', r + 1, JSON.stringify(row));
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  const med = k => median(runs.map(r => r[k]));
  console.log(`  median: window ${med('window')} ms · init IPC ${med('init')} ms · grouping index ${med('index')} ms${COLD ? ` · retag ${med('retag')} ms` : ''}`);
  fs.rmSync(template, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
