'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSpec, parseLine } = require('../../src/main/irc');

test('parseSpec: server, port, encryption and room', () => {
  assert.deepEqual(parseSpec('ircs://irc.libera.chat:6697/#linux'), { host: 'irc.libera.chat', port: 6697, secure: true, channel: '#linux' });
  assert.deepEqual(parseSpec('irc://Example.org/#Room'), { host: 'example.org', port: 6667, secure: false, channel: '#Room' });
  assert.deepEqual(parseSpec('ircs://irc.example.org/&local'), { host: 'irc.example.org', port: 6697, secure: true, channel: '&local' });
  for (const bad of ['', 'irc.libera.chat', 'http://irc.libera.chat/#x', 'ircs://host:99999/#x', 'ircs://host/nohash', 'ircs://host/#a,b', 'ircs://ho st/#x'])
    assert.equal(parseSpec(bad), null, bad);
});

test('parseLine: prefix, command and trailing parameter', () => {
  assert.deepEqual(parseLine(':alice!a@host PRIVMSG #room :hello  there: friend'),
    { prefix: 'alice!a@host', nick: 'alice', cmd: 'PRIVMSG', params: ['#room', 'hello  there: friend'] });
  assert.deepEqual(parseLine('PING :irc.example.org'), { prefix: '', nick: '', cmd: 'PING', params: ['irc.example.org'] });
  assert.deepEqual(parseLine('@time=2026-01-01T00:00:00Z :srv 001 Guest12345 :Welcome'),
    { prefix: 'srv', nick: 'srv', cmd: '001', params: ['Guest12345', 'Welcome'] });
  assert.equal(parseLine(':srv 353 me = #room :@op +voiced plain').params[3], '@op +voiced plain');
});
