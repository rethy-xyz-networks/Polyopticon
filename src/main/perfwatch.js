'use strict';

// Performance watchdog: writes to the session log when the app is struggling, so a
// slow session can be explained afterwards.
//   • a process using a lot of CPU for a while — named by what it shows (the app
//     window, an article/4chan page with its URL, a chat, the feed worker…)
//   • the window or a page not responding, and how long until it recovered
// UI freezes inside the window itself are reported by src/renderer/perfwatch.js.

const { app, webContents } = require('electron');
const log = require('./logger');

const SAMPLE_MS = 10_000;
const HOT_CPU = 60;              // % of one core…
const HOT_SAMPLES = 2;           // …for this many samples in a row (20 s) is worth a line
const REPEAT_MS = 2 * 60_000;    // then at most one line per process every 2 minutes

const hot = new Map();           // pid -> { count, lastLogged }

/** What a process is, for a log line: "app window", "page https://…", "utility (feed worker)". */
function describe(proc, pages) {
  const page = pages.get(proc.pid);
  if (page) return page;
  if (proc.type === 'Utility') return `utility (${proc.serviceName || proc.name || 'service'})`;
  return proc.type === 'Browser' ? 'main process' : proc.type.toLowerCase();
}

function pagesByPid() {
  const map = new Map();
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    const pid = wc.getOSProcessId();
    const what = wc.getType() === 'window' ? 'app window' : `${wc.getType()} ${wc.getURL().slice(0, 120)}`;
    map.set(pid, map.has(pid) ? `${map.get(pid)} + ${what}` : what);
  }
  return map;
}

function sample() {
  let pages = null;
  const seen = new Set();
  for (const p of app.getAppMetrics()) {
    seen.add(p.pid);
    const cpu = p.cpu.percentCPUUsage;
    const h = hot.get(p.pid) ?? { count: 0, lastLogged: 0 };
    h.count = cpu >= HOT_CPU ? h.count + 1 : 0;
    hot.set(p.pid, h);
    if (h.count < HOT_SAMPLES || Date.now() - h.lastLogged < REPEAT_MS) continue;
    h.lastLogged = Date.now();
    pages ??= pagesByPid();
    const mb = Math.round(p.memory.workingSetSize / 1024);
    log.warn(`Perf: high CPU for ${Math.round(h.count * SAMPLE_MS / 1000)} s — ${Math.round(cpu)}% in ${describe(p, pages)} (pid ${p.pid}, ${mb} MB)`);
  }
  for (const pid of hot.keys()) if (!seen.has(pid)) hot.delete(pid);
}

/** Logs when a window or page stops responding, and when it comes back. */
function watchResponsive(contents, label) {
  let since = 0;
  contents.on('unresponsive', () => {
    since = Date.now();
    log.warn(`Perf: ${label()} is not responding`);
  });
  contents.on('responsive', () => {
    if (since) log.warn(`Perf: ${label()} responding again after ${((Date.now() - since) / 1000).toFixed(1)} s`);
    since = 0;
  });
}

let started = false;
function start(win) {
  if (started) return;
  started = true;
  watchResponsive(win, () => 'the app window');
  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() === 'webview') watchResponsive(wc, () => `page ${wc.isDestroyed() ? '' : wc.getURL().slice(0, 120)}`);
  });
  setInterval(sample, SAMPLE_MS).unref();
  app.getAppMetrics();           // first call starts the CPU counters
}

module.exports = { start };
