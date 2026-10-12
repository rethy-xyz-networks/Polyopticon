'use strict';

// Place matching against hand-labelled articles from real feeds (geotag-corpus.json).
//   want: where the story happens; ok: also acceptable (the containing country,
//   the countries involved). Any other place is a wrong mapping. Labels are names,
//   or Name@CC where the name is ambiguous (Georgia@US).
// Most items were picked because the old matcher got them wrong (see docs/map-audit.md);
// items marked holdout are a random sample.

const test = require('node:test');
const assert = require('node:assert/strict');
const { geotag } = require('../../src/main/enrich/geotag');
const gaz = require('../../src/main/enrich/gazetteer.json');
const corpus = require('./geotag-corpus.json');

const ccOf = new Map(gaz.places.map(p => [p[0], p[3]]));
const matches = (p, label) => { const [name, cc] = label.split('@'); return p[1] === name && (!cc || ccOf.get(p[0]) === cc); };

function score(items) {
  let predicted = 0, wrong = 0, wanted = 0, found = 0;
  const failures = [];
  for (const it of items) {
    const got = geotag({ title: it.title, summary: it.summary }, { cc: it.cc });
    const bad = got.filter(p => ![...it.want, ...it.ok].some(l => matches(p, l)));
    const hit = it.want.filter(l => got.some(p => matches(p, l)));
    predicted += got.length; wrong += bad.length; wanted += it.want.length; found += hit.length;
    if (bad.length || hit.length < it.want.length)
      failures.push(`#${it.id} ${it.title.slice(0, 70)} → ${got.map(p => p[1]).join(', ') || '—'} (want ${it.want.join(', ') || '—'})`);
  }
  return { precision: 1 - wrong / predicted, recall: found / wanted, failures };
}

test('labelled corpus: few wrong places, most places found', () => {
  const { precision, recall, failures } = score(corpus);
  assert.ok(precision >= 0.95, `precision ${(precision * 100).toFixed(1)}%\n${failures.join('\n')}`);
  assert.ok(recall >= 0.92, `recall ${(recall * 100).toFixed(1)}%\n${failures.join('\n')}`);
});

test('random held-out sample holds up as well', () => {
  const { precision, recall, failures } = score(corpus.filter(it => it.holdout));
  assert.ok(precision >= 0.93, `precision ${(precision * 100).toFixed(1)}%\n${failures.join('\n')}`);
  assert.ok(recall >= 0.9, `recall ${(recall * 100).toFixed(1)}%\n${failures.join('\n')}`);
});
