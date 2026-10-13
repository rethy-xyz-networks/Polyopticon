'use strict';

// Session file logger + StateDebugger port.
// Files live in %LocalAppData%\Polyopticon\logs\ (same place as the C# build):
//   session_YYYY-MM-DD_HH-mm-ss.log  — chronological log
//   debug_YYYY-MM-DD_HH-mm-ss.log    — state snapshots written on errors

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
const fileStamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
  `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

let logDir      = null;
let logPath     = null;
let logStream   = null;
let debugPath   = null;
let debugStream = null;
let debugEnabled = false;
let snapshotCount = 0;
const slots = new Map();

function trim(prefix, retain) {
  if (!logDir) return;
  try {
    fs.readdirSync(logDir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.log'))
      .sort().reverse()
      .slice(Math.max(1, retain))
      .forEach(f => { try { fs.unlinkSync(path.join(logDir, f)); } catch { /* in use */ } });
  } catch { /* never crash the app over logs */ }
}

function write(level, msg) {
  if (!logStream) return;
  logStream.write(`${stamp()} [${level}] ${msg}\n`);
}

function init(baseDir, retain = 20) {
  try {
    logDir = path.join(baseDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const ts = fileStamp();
    logPath   = path.join(logDir, `session_${ts}.log`);
    debugPath = path.join(logDir, `debug_${ts}.log`);
    logStream   = fs.createWriteStream(logPath,   { flags: 'a' });
    debugStream = fs.createWriteStream(debugPath, { flags: 'a' });
    trim('session_', retain);
    trim('debug_', retain);

    write('INFO ', '═══ Session started — Polyopticon News Monitor ═══');
    write('INFO ', `Log: ${logPath}`);
    write('INFO ', `OS: ${os.type()} ${os.release()}  Electron: ${process.versions.electron}  Node: ${process.versions.node}`);
    debugStream.write(`${stamp()}  ═══ StateDebugger initialised ═══\n`);
  } catch { /* logging must never crash the app */ }
}

const log = {
  init,
  get path() { return logPath; },
  setDebug(on) { debugEnabled = !!on; },
  debug: msg => { if (debugEnabled) write('DEBUG', msg); },
  info:  msg => write('INFO ', msg),
  warn:  msg => write('WARN ', msg),
  error: (msg, err) => write('ERROR', err ? `${msg} -> ${err.name}: ${err.message}` : msg),
  trimToRetention(retain) { trim('session_', retain); trim('debug_', retain); },

  // StateDebugger
  set(key, value) { slots.set(key, value == null ? '(null)' : String(value)); },

  snapshot(label) {
    if (!debugStream) return;
    const n = ++snapshotCount;
    const lines = ['', `┌─── Snapshot #${n}  [${stamp()}]  ${label}`];
    [...slots.keys()].sort().forEach(k => lines.push(`│  ${k.padEnd(46)} ${slots.get(k)}`));
    lines.push(`└${'─'.repeat(68)}`);
    debugStream.write(lines.join('\n') + '\n');
  },

  onError(context) {
    const d = new Date();
    log.set('meta.last_error', `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] ${context}`);
    log.snapshot(`ERROR — ${context}`);
  },

  shutdown() {
    write('INFO ', '═══ Session ended ═══');
    logStream?.end();
    debugStream?.end();
  },
};

module.exports = log;
