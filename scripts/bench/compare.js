'use strict';

// Compares two result files written by `node scripts/bench/main.js --json=<file>`.
//
//   node scripts/bench/compare.js before.json after.json [--min=5]    # hide changes under 5%

const fs = require('fs');

const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith('--'));
const min = Number(args.find(a => a.startsWith('--min='))?.slice(6) ?? 0);
if (files.length !== 2) { console.error('usage: node compare.js before.json after.json [--min=<percent>]'); process.exit(1); }

const [before, after] = files.map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
const key = r => `${r.group}: ${r.name}`;
const old = new Map(before.results.map(r => [key(r), r]));

const rows = after.results.filter(r => old.has(key(r))).map(r => {
  const o = old.get(key(r));
  return { name: key(r), before: o.median, after: r.median, factor: o.median / r.median };
}).filter(r => Math.abs(r.factor - 1) * 100 >= min);

const fmt = ms => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2)).padStart(8);
console.log(`${'case'.padEnd(78)} ${'before'.padStart(8)} ${'after'.padStart(8)}   change`);
for (const r of rows.sort((a, b) => b.factor - a.factor)) {
  const change = r.factor >= 1.05 ? `${r.factor.toFixed(1)}x faster` : r.factor <= 0.95 ? `${(1 / r.factor).toFixed(1)}x SLOWER` : 'same';
  console.log(`${r.name.slice(0, 78).padEnd(78)} ${fmt(r.before)} ${fmt(r.after)}   ${change}`);
}
