'use strict';

// Map accuracy: runs the place matcher (src/main/enrich/geotag.js) on 5,000 labelled stories
// (geo-bench.json: a random sample of one story per group from five days of the real feeds, every
// language) and reports what the map would show right, wrong and missing.
//
//   node scripts/bench/geo.js                  # summary
//   node scripts/bench/geo.js --list[=wrong]   # the stories that aren't right (or one verdict), with what was shown
//   node scripts/bench/geo.js --json=out.json  # per-story results, to compare runs
//   node scripts/bench/geo.js --half=tune      # only the tuning half (even i); --half=holdout for the odd half.
//                                                Tune on one, check on the other, so fixes aren't fitted to the test.
//
// Each story was labelled independently by two models (Claude Sonnet, with 100 stories by Claude Opus;
// DeepSeek v4 Pro) from the text the matcher reads, following bench-data/geo/guide.txt; where they
// disagreed, DeepSeek v4 Pro adjudicated. Labels are places { name, cc, kind } in three lists:
//   want     where the story happens, as precisely as the text says
//   ok       also acceptable: the containing area, the countries involved
//   implied  no place named, but where it is is plain (a ministry, a national court)

const fs = require('fs');
const path = require('path');
const { geotag } = require('../../src/main/enrich/geotag');
const gaz = require('../../src/main/enrich/gazetteer.json');

const args = process.argv.slice(2);
const listArg = args.find(a => a.startsWith('--list'));
const listOnly = listArg?.includes('=') ? listArg.split('=')[1] : null;
const jsonOut = args.find(a => a.startsWith('--json='))?.slice(7);
const half = args.find(a => a.startsWith('--half='))?.slice(7);
if (half && !['tune', 'holdout'].includes(half)) throw new Error('--half is tune or holdout');
const bench = JSON.parse(fs.readFileSync(path.join(__dirname, 'geo-bench.json'), 'utf8'))
  .filter(it => !half || (it.i % 2 === 0) === (half === 'tune'));

// Labels to gazetteer places
const fold = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’']/g, "'").replace(/[-.]/g, ' ').replace(/\s+/g, ' ').trim();
const index = new Map();
for (const [k, v] of Object.entries(gaz.index)) index.set(fold(k), [...new Set([...(index.get(fold(k)) ?? []), ...v])]);
const byKey = new Map(gaz.places.map(p => [p[0], p]));
// Labellers called the same places states or areas (Scotland, Crimea), so either matches either.
const KINDS = { city: ['city', 'capital'], landmark: ['city', 'capital'], state: ['state', 'region', 'area'], country: ['country'], area: ['region', 'area', 'state'] };
const sameCc = (label, place) => !label.cc || !place[3] || label.cc.toUpperCase() === place[3];
// City-states (Hong Kong, Singapore, Macau): the country and its capital share a name, and labels call them
// either, so a label for one is also the other.
const cityState = new Map();         // cc -> [country, capital]
for (const p of gaz.places) if (p[2] === 'capital') {
  const country = gaz.places.find(c => c[2] === 'country' && c[3] === p[3]);
  if (country && (index.get(fold(p[1])) ?? []).some(i => gaz.places[i] === country)) cityState.set(p[3], [country, p]);
}
// States matched only in qualified form ("São Paulo State", "Kharkiv Oblast") under their bare name, as labels write them.
const QUALIFIER = /\s+(state|province|oblast|region|governorate|department)$/;
const bareStates = new Map();
for (const p of gaz.places) if (p[2] === 'state' && QUALIFIER.test(fold(p[1]))) {
  const k = fold(p[1]).replace(QUALIFIER, '');
  bareStates.set(k, [...(bareStates.get(k) ?? []), p]);
}
/** The gazetteer places a label means (same name, same country, compatible kind). */
const resolve = label => {
  const named = [...(index.get(fold(label.name)) ?? []).map(i => gaz.places[i]), ...(bareStates.get(fold(label.name)) ?? [])]
    .filter(p => sameCc(label, p));
  const pair = cityState.get(label.cc?.toUpperCase());
  if (pair && named.some(p => pair.includes(p))) return pair;
  return named.filter(p => !KINDS[label.kind] || KINDS[label.kind].includes(p[2]));
};
/** A shown place is this label. */
const is = (shown, label) => resolve(label).some(p => p[0] === shown[0]);
/** A shown city named like a labelled state or area (Sao Paulo state shown on Sao Paulo city): close but misleading. */
const namesake = (shown, label) => ['state', 'area'].includes(label.kind) && fold(shown[1]) === fold(label.name) && sameCc(label, byKey.get(shown[0]));

const tally = { stories: 0, shown: 0, right: 0, ok: 0, approx: 0, wrong: 0, wanted: 0, found: 0, gazMissing: 0, implied: 0 };
const verdicts = { correct: 0, wrong: 0, coarse: 0, missed: 0, implied: 0 };
const byLang = {}, bySource = {};
const results = [];

for (const it of bench) {
  const got = geotag({ title: it.title, summary: it.summary }, { cc: it.cc });
  const kind = p => it.want.some(l => is(p, l)) ? 'right'
    : it.ok.some(l => is(p, l)) || it.implied.some(l => is(p, l)) ? 'ok'
    : [...it.want, ...it.ok].some(l => namesake(p, l)) ? 'approx' : 'wrong';
  const shown = got.map(p => ({ name: p[1], kind: kind(p) }));
  const missing = it.want.filter(l => !got.some(p => is(p, l)));
  const gazMissing = missing.filter(l => !resolve(l).length);

  tally.stories++;
  tally.shown += got.length;
  for (const s of shown) tally[s.kind]++;
  tally.wanted += it.want.length;
  tally.found += it.want.length - missing.length;
  tally.gazMissing += gazMissing.length;
  if (!it.want.length && it.implied.length) tally.implied++;

  // One verdict per story: a wrong (or misleading) place beats everything; then a wanted place not shown
  // (coarse when something acceptable is shown instead); then a placeless story whose place is obvious.
  const verdict = shown.some(s => s.kind === 'wrong' || s.kind === 'approx') ? 'wrong'
    : missing.length ? (shown.length ? 'coarse' : 'missed')
    : !got.length && it.implied.length ? 'implied' : 'correct';
  verdicts[verdict]++;
  for (const [map, key] of [[byLang, it.lang], [bySource, it.source]]) {
    const r = map[key] ??= { stories: 0, correct: 0 };
    r.stories++;
    if (verdict === 'correct') r.correct++;
  }
  results.push({ i: it.i, id: it.id, lang: it.lang, source: it.source, verdict, shown, want: it.want.map(l => l.name), missing: missing.map(l => l.name),
    notInGazetteer: gazMissing.map(l => l.name), implied: it.implied.map(l => l.name), title: it.title });
}

const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '—') + '%';
console.log(`${tally.stories} stories, ${tally.shown} places shown\n`);
console.log('Per story');
for (const [k, label] of [['correct', 'right (or rightly nothing)'], ['wrong', 'a wrong place shown'], ['coarse', 'a wanted place missing, something acceptable shown'],
  ['missed', 'nothing shown, a place is named'], ['implied', 'nothing shown, place obvious from context']])
  console.log(`  ${label.padEnd(52)} ${String(verdicts[k]).padStart(5)}  ${pct(verdicts[k], tally.stories)}`);
console.log('\nPer place');
console.log(`  precision: shown places that are right or acceptable  ${pct(tally.right + tally.ok, tally.shown)}  (${tally.wrong} wrong, ${tally.approx} a city named like the state meant)`);
console.log(`  recall: wanted places shown                          ${pct(tally.found, tally.wanted)}  (${tally.found} of ${tally.wanted})`);
console.log(`    missing because the gazetteer lacks them            ${tally.gazMissing}`);
console.log(`    missing though the gazetteer has them               ${tally.wanted - tally.found - tally.gazMissing}`);
console.log(`  stories with no place named but an obvious one        ${tally.implied}`);
console.log('\nRight per language');
for (const [lang, l] of Object.entries(byLang).sort((a, b) => b[1].stories - a[1].stories))
  console.log(`  ${lang.padEnd(3)} ${String(l.correct).padStart(5)} of ${String(l.stories).padStart(5)}  ${pct(l.correct, l.stories)}`);

if (listArg) {
  for (const v of ['wrong', 'coarse', 'missed', 'implied'].filter(v => !listOnly || v === listOnly)) {
    console.log(`\n${v.toUpperCase()}`);
    for (const r of results.filter(r => r.verdict === v))
      console.log(`  #${r.id} [${r.lang}] ${r.title.slice(0, 100)}\n      shown: ${r.shown.map(s => s.kind === 'right' ? s.name : `${s.name} (${s.kind})`).join(', ') || '—'}`
        + `   want: ${r.want.join(', ') || '—'}${r.implied.length ? `   implied: ${r.implied.join(', ')}` : ''}${r.notInGazetteer.length ? `   not in gazetteer: ${r.notInGazetteer.join(', ')}` : ''}`);
  }
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ tally, verdicts, byLang, bySource, results }, null, 1));
