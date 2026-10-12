'use strict';

// Records what the seeded RSS feeds do, polled the way the app polls them at the fixed interval
// (the real RssAdapter: conditional GET, body fingerprint), so the adaptive scheme can be replayed
// against the real thing afterwards (replay.js). Developer tool, not part of the app.
//
//   node scripts/bench-polling/record.js <out.jsonl> [minutes=60] [intervalSeconds=5]
//
// One JSON line per poll: [ms since start, source index, new story ids (after the first poll), freshMs, ok]
// a header line with the source names, and ['seed', source index, the item dates in the first poll, ms since start]. A feed's first poll only establishes what it already had.

const fs = require('fs');
const { SEED_GROUPS } = require('../../src/main/config');
const { RssAdapter } = require('../../src/main/adapters/rss');

const [out, minutes = '60', interval = '5'] = process.argv.slice(2);
if (!out) { console.error('usage: node record.js <out.jsonl> [minutes] [intervalSeconds]'); process.exit(1); }

const sources = SEED_GROUPS.flatMap(g => g.sources).filter(s => s.type === 'rss');
const baseMs = Number(interval) * 1000;
const endAt = Date.now() + Number(minutes) * 60e3;
const t0 = Date.now();
const fd = fs.openSync(out, 'w');
const write = line => fs.writeSync(fd, JSON.stringify(line) + '\n');
write({ header: true, started: new Date(t0).toISOString(), baseMs, sources: sources.map(s => s.name) });

const quiet = { info() {}, warn() {}, debug() {}, set() {}, onError() {} };
const ctx = { log: quiet, ingest: () => [], status() {}, intervalMs: () => baseMs, pollingMode: 'fixed' };
let polls = 0, errors = 0;

async function run(source, index, delay) {
  const adapter = new RssAdapter({ id: index, name: source.name, type: 'rss', config: source.config }, ctx);
  const seen = new Set();
  let first = true;
  await new Promise(r => setTimeout(r, delay));
  while (Date.now() < endAt) {
    const started = Date.now();
    let fresh = [], ok = 1;
    try {
      const items = await adapter.fetchItems(AbortSignal.timeout(20_000));
      if (first && adapter.itemDates) write(['seed', index, adapter.itemDates, Date.now() - t0]);   // what the feed's own dates say about its rate
      if (items) for (const it of items) if (!seen.has(it.extId)) { seen.add(it.extId); if (!first) fresh.push(it.extId); }
    } catch { ok = 0; errors++; }
    first = false;
    polls++;
    write([started - t0, index, fresh, adapter.freshMs || 0, ok]);
    await new Promise(r => setTimeout(r, Math.max(0, baseMs - (Date.now() - started))));
  }
}

console.error(`recording ${sources.length} feeds every ${baseMs / 1000}s for ${minutes} min -> ${out}`);
const progress = setInterval(() => console.error(`${Math.round((Date.now() - t0) / 60e3)} min · ${polls} polls · ${errors} errors`), 5 * 60e3);
Promise.all(sources.map((s, i) => run(s, i, i * 300))).then(() => {
  clearInterval(progress);
  fs.closeSync(fd);
  console.error(`done: ${polls} polls, ${errors} errors`);
});
