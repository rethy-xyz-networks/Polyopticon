'use strict';

// Replays the adaptive polling scheme (src/main/adapters/pacing.js) against a recording made by
// record.js, and measures what it would have cost and how late it would have shown stories.
// Developer tool, not part of the app.
//
//   node scripts/bench-polling/replay.js <trace.jsonl> [more traces…] [growth=1.5 slowAfter=2 maxMs=60000
//                                                       gapDivisor=6 cacheCapMs=60000 gapWeight=0.3]
//   node scripts/bench-polling/replay.js <trace.jsonl> --sweep      # a table of variations
//   add --worst=N to list the N latest stories, --by-source for a per-feed table
//
// The recording is the truth: it polled every feed every few seconds, so the first time it saw a story
// is the earliest the app could have. The replay polls on the schedule the Pacer picks and shows a story
// at the first of its polls after that. Lateness = that moment - the moment the recording first saw it.
// (Lateness is measured from when a story first appeared to the recording, not from when the site
// published it. A story that appears and disappears between two replay polls would still be seen,
// because the replay reads the recording's list of everything the feed ever showed.)

const fs = require('fs');
const { Pacer, DEFAULTS } = require('../../src/main/adapters/pacing');

const args = process.argv.slice(2);
const files = args.filter(a => !a.includes('=') && !a.startsWith('--'))
  .flatMap(a => (fs.statSync(a).isDirectory() ? fs.readdirSync(a).filter(f => f.endsWith('.jsonl')).sort().map(f => require('path').join(a, f)) : [a]));   // a folder = every trace in it
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k, v = ''] = a.slice(2).split('='); return [k, v]; }));
const overrides = Object.fromEntries(args.filter(a => /^[a-zA-Z]+=/.test(a) && !a.startsWith('--')).map(a => { const [k, v] = a.split('='); return [k, Number(v)]; }));
if (!files.length) { console.error('usage: node replay.js <trace.jsonl or folder>… [key=value…] [--sweep] [--by-source] [--worst=N]'); process.exit(1); }

function load(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const header = lines.shift();
  const feeds = header.sources.map(name => ({ name, polls: [], stories: [] }));
  for (const [t, i, fresh, freshMs, ok] of lines) {
    if (t === 'seed') { feeds[i].seed = fresh; continue; }   // the feed's own item dates, not a poll
    const f = feeds[i];
    f.polls.push({ t, freshMs, ok });
    for (const id of fresh) f.stories.push({ t, id });
  }
  for (const f of feeds) f.polls.sort((a, b) => a.t - b.t);
  return { header, feeds };
}

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);

/** Run the Pacer over one feed's recording. */
function replayFeed(feed, base, opts) {
  const polls = feed.polls.filter(p => p.ok);
  if (polls.length < 2) return null;
  const start = polls[0].t, end = polls.at(-1).t;
  const pacer = new Pacer(opts);
  if (!opts.noSeed && feed.seed) pacer.seed(feed.seed);
  const stories = [...feed.stories].sort((a, b) => a.t - b.t);
  let si = 0, pi = 0, vt = start, prev = start;
  const late = [], det = [];
  let made = 0;
  while (vt <= end) {
    made++;
    // what the feed shows at vt: every story the recording had seen by then
    let changed = false;
    while (si < stories.length && stories[si].t <= vt) {
      late.push(vt - stories[si].t);
      det.push({ id: stories[si].id, seen: stories[si].t, shown: vt });
      si++; changed = true;
    }
    while (pi + 1 < polls.length && polls[pi + 1].t <= vt) pi++;
    // the freshness hint the server gave on the nearest recorded poll, aged to now
    const hint = Math.max(0, polls[pi].freshMs - (vt - polls[pi].t));
    pacer.observe({ now: vt, changed, freshMs: hint });
    prev = vt;
    vt += pacer.delayMs(base, vt);
  }
  return { late, det, made, fixed: Math.floor((end - start) / base) + 1, stories: stories.length, unseen: stories.length - si, span: end - start };
}

function run(traces, opts) {
  const all = { late: [], made: 0, fixed: 0, stories: 0, unseen: 0, feeds: [] };
  for (const { header, feeds } of traces) {
    for (const f of feeds) {
      const r = replayFeed(f, header.baseMs, opts);
      if (!r) continue;
      all.late.push(...r.late); all.made += r.made; all.fixed += r.fixed; all.stories += r.stories; all.unseen += r.unseen;
      all.feeds.push({ name: f.name, ...r });
    }
  }
  all.late.sort((a, b) => a - b);
  return all;
}

const s = ms => `${(ms / 1000).toFixed(1)}s`;
const summary = r => ({
  stories: r.late.length,
  mean: r.late.length ? r.late.reduce((a, b) => a + b, 0) / r.late.length : 0,
  p50: quantile(r.late, 0.5), p90: quantile(r.late, 0.9), p95: quantile(r.late, 0.95), p99: quantile(r.late, 0.99), max: r.late.at(-1) ?? 0,
  over30: r.late.filter(x => x > 30_000).length, over60: r.late.filter(x => x > 60_000).length, over120: r.late.filter(x => x > 120_000).length,
  saved: r.fixed ? 100 * (1 - r.made / r.fixed) : 0,
});
const line = (label, r) => {
  const m = summary(r);
  return `${label.padEnd(44)} ${String(m.stories).padStart(5)} stories | late mean ${s(m.mean).padStart(6)} p50 ${s(m.p50).padStart(6)} p90 ${s(m.p90).padStart(6)} p95 ${s(m.p95).padStart(6)} p99 ${s(m.p99).padStart(7)} max ${s(m.max).padStart(7)} | >30s ${String(m.over30).padStart(3)} >60s ${String(m.over60).padStart(3)} >120s ${String(m.over120).padStart(3)} | requests -${m.saved.toFixed(1)}%`;
};

const traces = files.map(load);
const first = traces[0];
console.log(`${files.length} trace(s): ${first.feeds.length} feeds, interval ${first.header.baseMs / 1000}s, started ${first.header.started}`);
const hours = traces.reduce((n, t) => n + Math.max(...t.feeds.map(f => (f.polls.at(-1)?.t ?? 0))) / 3600e3, 0);
console.log(`recorded ${hours.toFixed(2)} h; ${traces.reduce((n, t) => n + t.feeds.reduce((m, f) => m + f.stories.length, 0), 0)} new stories seen after each feed's first poll`);

if (flags.sweep !== undefined) {
  const grid = [
    ['current defaults', {}],
    ['no cache hints', { cacheCapMs: 0 }],
    ['no hints, unseeded', { cacheCapMs: 0, noSeed: 1 }],
    ['no hints, ceiling 30, div 20', { cacheCapMs: 0, maxMs: 30_000, gapDivisor: 20 }],
    ['no hints, ceiling 30, div 30', { cacheCapMs: 0, maxMs: 30_000, gapDivisor: 30 }],
    ['no hints, ceiling 20, div 20', { cacheCapMs: 0, maxMs: 20_000, gapDivisor: 20 }],
    ['no hints, ceiling 40, div 30', { cacheCapMs: 0, maxMs: 40_000, gapDivisor: 30 }],
    ['no hints, ceiling 30, div 30, slow 3', { cacheCapMs: 0, maxMs: 30_000, gapDivisor: 30, slowAfter: 3 }],
    ['cache hints up to 30s', { cacheCapMs: 30_000 }],
    ['ceiling 30s', { maxMs: 30_000, cacheCapMs: 30_000 }],
    ['ceiling 30s, divisor 10', { maxMs: 30_000, cacheCapMs: 30_000, gapDivisor: 10 }],
    ['ceiling 20s', { maxMs: 20_000, cacheCapMs: 20_000 }],
    ['ceiling 120s', { maxMs: 120_000, cacheCapMs: 120_000 }],
    ['divisor 3', { gapDivisor: 3 }],
    ['divisor 10', { gapDivisor: 10 }],
    ['divisor 12', { gapDivisor: 12 }],
    ['growth 1.25', { growth: 1.25 }],
    ['growth 2', { growth: 2 }],
    ['slowAfter 4', { slowAfter: 4 }],
    ['slowAfter 6', { slowAfter: 6 }],
    ['fixed (never slows)', { maxMs: 0, cacheCapMs: 0 }],
  ];
  for (const [label, o] of grid) console.log(line(label, run(traces, { ...overrides, ...o })));
} else {
  const r = run(traces, overrides);
  console.log(`parameters: ${JSON.stringify({ ...DEFAULTS, ...overrides })}`);
  console.log(line('adaptive vs recorded fixed polling', r));
  const m = summary(r);
  console.log(`polls: fixed ${r.fixed}, adaptive ${r.made}; stories not yet shown when the recording ended: ${r.unseen}`);
  if (flags['by-source'] !== undefined) {
    console.log('\nper feed (late stories only):');
    for (const f of r.feeds.filter(f => f.late.length).sort((a, b) => Math.max(...b.late) - Math.max(...a.late)))
      console.log(`  ${f.name.padEnd(24)} stories ${String(f.late.length).padStart(3)}  mean ${s(f.late.reduce((a, b) => a + b, 0) / f.late.length).padStart(6)}  max ${s(Math.max(...f.late)).padStart(7)}  polls ${f.made}/${f.fixed} (-${(100 * (1 - f.made / f.fixed)).toFixed(0)}%)`);
  }
  const worst = Number(flags.worst ?? 0);
  if (worst) {
    console.log(`\n${worst} latest stories:`);
    const rows = r.feeds.flatMap(f => f.det.map(d => ({ feed: f.name, ...d, late: d.shown - d.seen }))).sort((a, b) => b.late - a.late).slice(0, worst);
    for (const x of rows) console.log(`  ${s(x.late).padStart(7)}  ${x.feed.padEnd(22)} ${String(x.id).slice(0, 70)}`);
  }
}
