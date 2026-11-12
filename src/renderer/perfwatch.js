// Freezes in the app window, written to the session log (src/main/perfwatch.js covers
// CPU use and pages that stop responding).
//
// A frame in which the window's thread was blocked for FREEZE_MS or more is a freeze (long
// animation frame timing: covers script, style, layout and paint). The frame's own length
// is not used: it also counts the wait for the screen, which is hours for a window on a
// hidden workspace. The first few a minute are
// logged one by one with their cause — a step named with `measure`, else the script
// the browser blames — and the rest are summed up, so a struggling session doesn't
// flood the log.

import { api } from './dom.js';

const FREEZE_MS = 150;              // blocked time, which starts 50 ms into a task: one task of 200 ms
const SLOW_STEP_MS = 100;
const DETAILED = 5;                 // per minute, then only the summary

let lastSlow = null;                // the last slow step, if the freeze followed it
let minute = { count: 0, total: 0, worst: 0, logged: 0 };

/** Runs fn; if it's slow, a freeze around it names it. `label` may be a function (called only then). */
export function measure(label, fn) {
  const t0 = performance.now();
  try { return fn(); }
  finally {
    const ms = performance.now() - t0;
    if (ms >= SLOW_STEP_MS) lastSlow = { label: typeof label === 'function' ? label() : label, ms, at: performance.now() };
  }
}

/** The longest script in a long animation frame: "renderFeed (feed.js) via TimerHandler:setTimeout". */
function blamed(entry) {
  const s = [...(entry.scripts ?? [])].sort((a, b) => b.duration - a.duration)[0];
  if (!s || s.duration < SLOW_STEP_MS) return '';
  const file = s.sourceURL ? ` (${s.sourceURL.split('/').pop()})` : '';
  return ` — script ${s.sourceFunctionName || '(anonymous)'}${file} via ${s.invoker} took ${Math.round(s.duration)} ms`;
}

/** ms: how long the thread was blocked; start/end: the frame (or task) it happened in. */
function onFreeze(ms, start, end, entry) {
  minute.count++;
  minute.total += ms;
  minute.worst = Math.max(minute.worst, ms);
  if (minute.logged >= DETAILED) return;
  minute.logged++;
  // Script time inside the freeze, if a measured step was the cause.
  const cause = lastSlow && lastSlow.at <= end + 50 && lastSlow.at >= start - 50
    ? ` — ${lastSlow.label} took ${Math.round(lastSlow.ms)} ms` : blamed(entry);
  api.log('warn', `Perf: window froze for ${Math.round(ms)} ms${cause}`);
}

export function startPerfWatch() {
  const type = ['long-animation-frame', 'longtask'].find(t => PerformanceObserver.supportedEntryTypes?.includes(t));
  if (!type) return;                // no frame timing: nothing to watch
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      const blocked = e.blockingDuration ?? e.duration - 50;     // a long task has no blocked time of its own
      if (blocked >= FREEZE_MS) onFreeze(blocked, e.startTime, e.startTime + e.duration, e);
    }
  }).observe({ type, buffered: true });
  setInterval(() => {
    if (minute.count > minute.logged) {
      api.log('warn', `Perf: window froze ${minute.count} times in the last minute — ${Math.round(minute.total)} ms in all, worst ${Math.round(minute.worst)} ms`);
    }
    minute = { count: 0, total: 0, worst: 0, logged: 0 };
  }, 60_000);
}

/** With "Decode video on the graphics card" on (Linux), logs which formats the card took on: it depends on the driver. */
export async function logVideoDecode() {
  if (!window.VideoDecoder) return;
  const CODECS = [['H.264', 'avc1.640028'], ['HEVC', 'hev1.1.6.L120.90'], ['VP9', 'vp09.00.40.08'], ['AV1', 'av01.0.08M.08']];
  const on = [];
  for (const [name, codec] of CODECS) {
    const ok = await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080, hardwareAcceleration: 'prefer-hardware' }).then(r => r.supported, () => false);
    if (ok) on.push(name);
  }
  api.log(on.length ? 'info' : 'warn', `Video decoding on the graphics card: ${on.length ? on.join(', ') : 'not available (no working VA-API driver, or a display it cannot be used on) — the CPU decodes'}`);
}
