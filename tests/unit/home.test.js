'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HomeShare } = require('../../src/main/enrich/home');

test('a source is national once nearly all its located stories are at home', () => {
  const h = new HomeShare();
  for (let i = 0; i < 9; i++) h.record('hindu', 'IN', ['IN']);
  assert.equal(h.national('hindu'), false, 'not before ten located stories');
  h.record('hindu', 'IN', ['IN']);
  assert.equal(h.national('hindu'), true);
  h.record('hindu', 'IN', []);                                   // a story with no place doesn't count
  assert.equal(h.national('hindu'), true);
  for (let i = 0; i < 3; i++) h.record('hindu', 'IN', ['PK']);   // 10 of 13 at home: below 90%
  assert.equal(h.national('hindu'), false);
});

test('an outlet covering several countries is not national, and counts survive a save', () => {
  const h = new HomeShare();
  for (let i = 0; i < 20; i++) h.record('infobae', 'AR', [i % 4 ? 'ES' : 'AR']);
  assert.equal(h.national('infobae'), false);
  for (let i = 0; i < 20; i++) h.record('rnz', 'NZ', ['NZ']);
  const again = new HomeShare(JSON.parse(JSON.stringify(h)));
  assert.equal(again.national('rnz'), true);
  assert.equal(again.national('infobae'), false);
  assert.equal(again.national('unknown'), false);
});
