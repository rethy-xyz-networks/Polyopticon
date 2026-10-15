'use strict';

// What the app costs while it just runs: launches it with its default sources (live network), then samples
// CPU and memory of every process every few seconds. Developer tool; results depend on the network.
//
//   node scripts/bench/idle.js [--seconds=90] [--root=<app folder>]
//
// The first 20 s (everything polling at once, the first stories arriving) are reported apart from the rest.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('@playwright/test');

const args = process.argv.slice(2);
const flag = (n, d) => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const SECONDS = Number(flag('seconds', 90));
const APP = path.resolve(flag('root', path.join(__dirname, '..', '..')));
const SAMPLE_MS = 2000;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polybench-idle-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ TranslateEnabled: false, ChatDestiny: false, ChatTwitchChannels: '', ChatIrc: '' }));
  const app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, POLYOPTICON_DATA_DIR: dir, POLYOPTICON_OFFSCREEN: '1' } });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  console.log(APP);

  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1000) {
    await new Promise(r => setTimeout(r, SAMPLE_MS));
    const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map(m => ({ type: m.type, name: m.name || m.serviceName || '', cpu: m.cpu.percentCPUUsage, mb: m.memory.workingSetSize / 1024 })));
    const count = await win.evaluate(() => document.getElementById('feed-count')?.textContent ?? '');
    samples.push({ at: (Date.now() - t0) / 1000, metrics, count });
  }

  const label = m => (m.type === 'Utility' ? `utility ${m.name}` : m.type === 'Browser' ? 'main' : m.type === 'Tab' ? 'renderer/pages' : m.type.toLowerCase());
  const table = (rows, title) => {
    const by = new Map();
    for (const s of rows) for (const m of s.metrics) {
      const k = label(m);
      const e = by.get(k) ?? { cpu: 0, n: 0, mb: 0, peak: 0 };
      e.cpu += m.cpu; e.n++; e.mb = m.mb; e.peak = Math.max(e.peak, m.mb);
      by.set(k, e);
    }
    console.log(`\n${title} (${rows.length} samples)`);
    let total = 0;
    for (const [k, e] of [...by].sort((a, b) => b[1].cpu - a[1].cpu)) {
      const cpu = e.cpu / rows.length;       // processes of one kind add up
      total += cpu;
      console.log(`  ${k.padEnd(34)} cpu ${cpu.toFixed(1).padStart(5)}%   mem ${Math.round(e.mb).toString().padStart(4)} MB (peak ${Math.round(e.peak)})`);
    }
    console.log(`  ${'all processes'.padEnd(34)} cpu ${total.toFixed(1).padStart(5)}%`);
  };
  table(samples.filter(s => s.at <= 20), 'first 20 s');
  table(samples.filter(s => s.at > 20), 'after 20 s');
  console.log(`\nstories in the list at the end: ${samples.at(-1).count}`);
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
})().catch(e => { console.error(e); process.exit(1); });
