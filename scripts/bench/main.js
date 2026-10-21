'use strict';

// Benchmarks the main-process / feed-worker pipeline on realistic, seeded data: language detection,
// tokenising, story grouping, place tagging, feed parsing, and every SQLite query the app runs.
// Developer tool, not part of the app (the renderer is measured by `npm run test:perf`).
//
//   node scripts/bench/main.js                    # run everything, print a table
//   node scripts/bench/main.js --json=out.json    # also write the numbers (compare runs with compare.js)
//   node scripts/bench/main.js --only=geotag,db   # names containing any of these
//
// Every case reports the median and p95 of its timed runs, in ms per call of `fn` (a "call" may be a
// batch: the label says how many items it handles, and `per` is the cost per item).

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flag = n => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const only = (flag('only') || '').split(',').filter(Boolean);
const jsonOut = flag('json');
const verbose = args.includes('--verbose');       // every timed run, in order

const root = path.join(__dirname, '..', '..', 'src', 'main');
const { detectLang, tokens } = require(path.join(root, 'enrich', 'text'));
const { Clusterer } = require(path.join(root, 'enrich', 'cluster'));
const { geotag } = require(path.join(root, 'enrich', 'geotag'));
const { Enricher } = require(path.join(root, 'enrich'));
const { parseFeed, itemTitle } = require(path.join(root, 'adapters', 'rss'));
const { cleanHtml, cleanText, parseDate } = require(path.join(root, 'adapters', 'util'));
const dbm = require(path.join(root, 'db'));

// Data

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = a => a[Math.floor(rnd() * a.length)];

const corpus = require('../../tests/unit/geotag-corpus.json');
const TITLES = corpus.map(c => c.title);
const SUMMARIES = corpus.map(c => c.summary).filter(Boolean);
const TITLE_WORDS = TITLES.join(' ').split(/\s+/);
const SUMMARY_WORDS = SUMMARIES.join(' ').split(/\s+/);
const sentence = (words, n) => Array.from({ length: n }, () => pick(words)).join(' ');

/** Fresh headlines that look like the corpus: ~60% recombined from its words, ~40% near-duplicates of one headline (what grouping looks for). */
function makeStories(n, now = Date.now()) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const near = rnd() < 0.4 && out.length;
    const base = near ? pick(out) : null;
    const title = near ? base.title.replace(/\b\w+\b/, () => pick(TITLE_WORDS)) : sentence(TITLE_WORDS, 8 + Math.floor(rnd() * 6));
    out.push({
      extId: `ext-${i}-${Math.floor(rnd() * 1e9)}`, kind: 'article', title,
      summary: rnd() < 0.8 ? sentence(SUMMARY_WORDS, 30 + Math.floor(rnd() * 20)) : null,
      url: `https://example${i % 40}.com/news/${i}`, author: null,
      publishedAt: now - Math.floor(rnd() * 30 * 3600e3),
    });
  }
  return out;
}

const SAMPLES = {
  en: 'Israeli forces strike targets in southern Lebanon as ceasefire talks stall, officials say',
  fr: 'Les négociations sur le cessez-le-feu se poursuivent selon les autorités dans la région',
  de: 'Die Regierung hat nach Angaben des Ministeriums neue Maßnahmen für die Region beschlossen',
  ar: 'القوات الإسرائيلية تشن غارات على أهداف في جنوب لبنان بينما تتعثر محادثات وقف إطلاق النار',
  ru: 'Российские войска нанесли удары по объектам инфраструктуры в Харьковской области, сообщили власти',
  zh: '中国外交部表示将继续推动地区和平谈判并呼吁各方保持克制',
};

function rssXml(n) {
  const items = makeStories(n).map((s, i) => `<item><title>${s.title.replace(/&/g, '&amp;')}</title><link>${s.url}</link>
<guid isPermaLink="false">g-${i}</guid><pubDate>Tue, 13 Oct 2026 10:${String(i % 60).padStart(2, '0')}:00 GMT</pubDate>
<description><![CDATA[<p>${(s.summary || '').replace(/\]\]>/g, '')} <a href="${s.url}">Read more</a></p><img src="https://x/y.jpg"/>]]></description>
<dc:creator>Some Author</dc:creator></item>`).join('\n');
  return `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>t</title>${items}</channel></rss>`;
}

// Harness

const results = [];
function run(group, name, fn, { iters = 15, warmup = 3, items = 1, setup = null } = {}) {
  const label = `${group}: ${name}`;
  if (only.length && !only.some(o => label.toLowerCase().includes(o.toLowerCase()))) return;
  const times = [];
  for (let i = 0; i < warmup + iters; i++) {
    const ctx = setup ? setup() : undefined;
    ctx?.db?.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');      // a checkpoint (an fsync, ~100 ms) the setup left due must not land in the timing
    const t0 = process.hrtime.bigint();
    fn(ctx);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    ctx?.db?.close();                      // each run's database (its page cache is large) must not outlive it
    if (i >= warmup) times.push(ms);
  }
  if (verbose) console.log(`    runs: ${times.map(t => t.toFixed(1)).join(' ')}`);
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
  results.push({ group, name, items, median, p95, per: median / items });
  console.log(`${label.padEnd(64)} ${median.toFixed(2).padStart(10)} ms  p95 ${p95.toFixed(2).padStart(9)}  ${items > 1 ? `(${(median / items * 1000).toFixed(1)} µs/item × ${items})` : ''}`);
}

// Cases

const stories = makeStories(2000);
const withSummary = stories.filter(s => s.summary);

// 1. text
for (const [lang, s] of Object.entries(SAMPLES)) run('text', `detectLang ${lang} ×1000`, () => { for (let i = 0; i < 1000; i++) detectLang(s); }, { items: 1000 });
run('text', 'detectLang title+summary ×1000', () => { for (let i = 0; i < 1000; i++) { const s = stories[i]; detectLang(`${s.title} ${(s.summary || '').slice(0, 200)}`); } }, { items: 1000 });
run('text', 'tokens ×1000', () => { for (let i = 0; i < 1000; i++) tokens(stories[i].title); }, { items: 1000 });

// 2. grouping
for (const size of [2_000, 10_000, 40_000]) {
  const base = makeStories(size);
  const fresh = makeStories(200);
  run('cluster', `add 200 new into ${size} docs`, c => { for (const s of fresh) c.add(1e9 + (s._i = (s._i ?? 0) + 1) + Math.floor(rnd() * 1e6), s.title, s.publishedAt); },
    { items: 200, iters: size > 10_000 ? 5 : 10, setup: () => { const c = new Clusterer(); base.forEach((s, i) => c.add(i + 1, s.title, s.publishedAt, i + 1)); return c; } });
}
{
  const base = makeStories(20_000);
  run('cluster', 'startup index build, 20000 stored docs (clusterId known)', () => { const c = new Clusterer(); base.forEach((s, i) => c.add(i + 1, s.title, s.publishedAt, i + 1)); }, { items: 20_000, iters: 3, warmup: 1 });
  run('cluster', 'startup backfill 3000 untagged into 20000 (no clusterId)', c => { for (let i = 0; i < 3000; i++) { const s = base[i]; c.add(1e9 + i, s.title, s.publishedAt); } },
    { items: 3000, iters: 3, warmup: 1, setup: () => { const c = new Clusterer(); base.forEach((s, i) => c.add(i + 1, s.title, s.publishedAt, i + 1)); return c; } });
}

// 3. places
run('geotag', 'real corpus title+summary ×293', () => { for (const c of corpus) geotag({ title: c.title, summary: c.summary }, { cc: c.cc }); }, { items: corpus.length });
run('geotag', 'real corpus title only ×293', () => { for (const c of corpus) geotag(c.title, { cc: c.cc }); }, { items: corpus.length });
run('geotag', 'synthetic title+summary ×1000', () => { for (let i = 0; i < 1000; i++) geotag({ title: stories[i].title, summary: stories[i].summary }); }, { items: 1000 });

// 4. feed parsing
for (const n of [30, 100, 300]) {
  const xml = rssXml(n);
  run('feed', `parseFeed ${n} items (${Math.round(xml.length / 1024)} KB)`, () => parseFeed(xml), { items: n });
  const entries = parseFeed(xml);
  run('feed', `transform ${n} entries (dates, titles, cleanHtml)`, () => { for (const e of entries) { parseDate(e.date); itemTitle(e); cleanHtml(e.summary); cleanText(e.author); } }, { items: n });
}
{
  const html = '<p>' + sentence(SUMMARY_WORDS, 60) + ' <a href="https://a/b">link</a> &amp; &quot;quoted&quot; &#8217;</p><img src="x"/><br/>';
  run('feed', 'cleanHtml ×5000', () => { for (let i = 0; i < 5000; i++) cleanHtml(html); }, { items: 5000 });
  run('feed', 'parseDate ×5000 (RFC 822 / ISO / zone name)', () => { for (let i = 0; i < 5000; i++) { parseDate('Tue, 13 Oct 2026 10:22:00 GMT'); parseDate('2026-10-13T10:22:00Z'); parseDate('Tue, 13 Oct 2026 10:22:00 EST'); } }, { items: 15_000 });
}

// 5. database + enricher
const tmpDirs = [];
function freshDb(n = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polybench-'));
  tmpDirs.push(dir);
  const db = dbm.open(path.join(dir, 'p.db'));
  const src = db.addSource({ type: 'rss', name: 'Bench', grp: 'USA', config: { url: 'x' } });
  if (n) {
    const all = makeStories(n);
    for (let i = 0; i < all.length; i += 500) db.insertItems(src.id, all.slice(i, i + 500));
    db.raw.exec(`UPDATE items SET cluster_id = id, places = '[]', lang = 'en'`);
  }
  return { db, src };
}

{
  const batch = makeStories(50);
  run('db', 'insertItems 50 (new)', ({ db, src }) => { db.insertItems(src.id, batch.map(b => ({ ...b, extId: `${b.extId}-${rnd()}` }))); }, { items: 50, setup: () => freshDb() });
  run('db', 'insertItems 50 (all duplicates)', ({ db, src }) => { db.insertItems(src.id, batch); }, { items: 50, setup: () => { const f = freshDb(); f.db.insertItems(f.src.id, batch); return f; } });
}
{
  const big = freshDb(30_000);
  const { db, src } = big;
  const ids = db.raw.prepare('SELECT id FROM items LIMIT 2000').all().map(r => r.id);
  run('db', 'setEnrichment ×2000 (one statement each)', () => { for (const id of ids) db.setEnrichment(id, { clusterId: id, places: [['x', 'Y', 1, 2]] }); }, { items: 2000, iters: 5 });
  run('db', 'setEnrichment ×2000 in one transaction', () => { db.tx(() => { for (const id of ids) db.setEnrichment(id, { clusterId: id, places: [['x', 'Y', 1, 2]] }); }); }, { items: 2000, iters: 5 });
  run('db', 'setLang ×2000', () => { for (const id of ids) db.setLang(id, 'en'); }, { items: 2000, iters: 5 });
  run('db', 'getItem ×2000', () => { for (const id of ids) db.getItem(id); }, { items: 2000, iters: 5 });
  run('db', 'getSource ×2000', () => { for (let i = 0; i < 2000; i++) db.getSource(src.id); }, { items: 2000, iters: 5 });
  run('db', 'recentItems(48h, 1000, 10/src) over 30000 rows', () => db.recentItems(Date.now() - 48 * 3600e3, 1000, 10), { iters: 10 });
  run('db', 'clusterWindow 54h over 30000 rows', () => db.clusterWindow(Date.now() - 54 * 3600e3), { iters: 10 });
  run('db', 'taggedItems (retag) over 30000 rows', () => db.taggedItems(), { iters: 5 });
  run('db', "history scope=all, 200 rows", () => db.history({ scope: 'all', limit: 200 }), { iters: 20 });
  run('db', "history scope=all, search 'government'", () => db.history({ scope: 'all', query: 'government', limit: 200 }), { iters: 20 });
  run('db', "history scope=all, search 'israel offi' (prefix)", () => db.history({ scope: 'all', query: 'israel offi', limit: 200 }), { iters: 20 });
  for (const id of ids.slice(0, 500)) db.recordOpen(id, 'tab');
  run('db', "history scope=opened (500 opens)", () => db.history({ scope: 'opened', limit: 200 }), { iters: 20 });
  run('db', "history scope=opened, search", () => db.history({ scope: 'opened', query: 'government', limit: 200 }), { iters: 20 });
  run('db', 'stats()', () => db.stats(), { iters: 20 });
  run('db', 'getMeta ×2000', () => { for (let i = 0; i < 2000; i++) db.getMeta('geotagVersion'); }, { items: 2000, iters: 5 });
  db.close();
}

// 6. enricher (what the worker does for every arriving item and at startup)
function enricherOver(db) {
  const log = { info() {}, warn() {}, debug() {}, error() {} };
  return new Enricher({ store: db, log, emitUpdate() {} });
}
{
  const batch = makeStories(50);
  run('enrich', 'process 50 new items (lang+group+geotag+2 writes) into 10000-item index', ({ e, db, src }) => {
    const added = db.insertItems(src.id, batch.map(b => ({ ...b, extId: `${b.extId}-${rnd()}` })));
    e.process(added, src);
  }, { items: 50, iters: 8, setup: () => { const f = freshDb(10_000); const e = enricherOver(f.db); f.db.raw.exec('UPDATE items SET places = NULL'); f.db.setMeta('geotagVersion', 2); e.init(); return { ...f, e }; } });
  run('enrich', 'init(): index + backfill 10000 stored items (cold start)', ({ e }) => e.init(),
    { items: 10_000, iters: 3, warmup: 0, setup: () => { const f = freshDb(10_000); f.db.raw.exec('UPDATE items SET places = NULL, cluster_id = NULL, lang = NULL'); f.db.setMeta('geotagVersion', 2); return { e: enricherOver(f.db), db: f.db }; } });
  run('enrich', 'retag(): first chunk of 500 items', ({ e }) => { const real = global.setImmediate; global.setImmediate = () => {}; try { e.retag(); } finally { global.setImmediate = real; } },
    { items: 500, iters: 2, warmup: 0, setup: () => { const f = freshDb(10_000); f.db.raw.exec(`UPDATE items SET places = '[]'`); f.db.setMeta('geotagVersion', 1); return { e: enricherOver(f.db), db: f.db }; } });
}

// Summary

console.log('\nSlowest per-item costs:');
for (const r of [...results].sort((a, b) => b.per - a.per).slice(0, 12)) console.log(`  ${(r.per * 1000).toFixed(1).padStart(10)} µs  ${r.group}: ${r.name}`);

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ node: process.version, cpus: os.cpus()[0].model, at: new Date().toISOString(), results }, null, 1));
for (const d of tmpDirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* still open on Windows: harmless */ }
