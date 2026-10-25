'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeed, undatedPublished, itemTitle } = require('../../src/main/adapters/rss');
const { decodeEntities, cleanHtml, trunc, headline, hash, parseDate, splitCredentials, feedText } = require('../../src/main/adapters/util');

// Feed parsing

test('parseFeed: RSS 2.0', () => {
  const [item] = parseFeed(`<?xml version="1.0"?>
    <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
      <item>
        <title>Hello &amp; welcome</title>
        <link>https://example.com/a</link>
        <guid isPermaLink="false">id-1</guid>
        <description>&lt;p&gt;Body&lt;/p&gt;</description>
        <pubDate>Mon, 05 Oct 2026 09:30:00 GMT</pubDate>
        <dc:creator>Jane Doe</dc:creator>
      </item>
    </channel></rss>`);
  assert.equal(item.id, 'id-1');
  assert.equal(item.link, 'https://example.com/a');
  assert.equal(item.author, 'Jane Doe');
  assert.match(String(item.title), /Hello & welcome/);
  assert.equal(parseDate(item.date), Date.UTC(2026, 9, 5, 9, 30));
});

test('parseFeed: Atom picks the alternate link', () => {
  const [entry] = parseFeed(`<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <id>urn:1</id>
        <title>Atom entry</title>
        <link rel="self" href="https://example.com/self"/>
        <link rel="alternate" href="https://example.com/post"/>
        <updated>2026-10-05T09:30:00Z</updated>
        <author><name>Sam</name></author>
      </entry>
    </feed>`);
  assert.equal(entry.id, 'urn:1');
  assert.equal(entry.link, 'https://example.com/post');
  assert.equal(entry.author, 'Sam');
});

test('parseFeed: HTML block pages and junk are rejected with a clear code', () => {
  assert.throws(() => parseFeed('<!doctype html><html><body>Captcha</body></html>'), { label: 'BLOCKED' });
  assert.throws(() => parseFeed('<?xml version="1.0"?><nothing/>'), { label: 'PARSE' });
});

// Text helpers

test('decodeEntities: named, decimal and hex', () => {
  assert.equal(decodeEntities('Caf&eacute; &#8212; &#x2019;s &amp; &unknown;'), 'Café — ’s & &unknown;');
});

test('cleanHtml: strips tags, optionally keeps line breaks', () => {
  assert.equal(cleanHtml('<p>One <b>two</b></p><p>three</p>'), 'One two three');
  assert.equal(cleanHtml('<p>One</p><p>Two</p>', { keepLines: true }), 'One\nTwo');
  assert.equal(cleanHtml('   '), null);
});

test('trunc and headline', () => {
  assert.equal(trunc('abcdef', 4), 'abc…');
  assert.equal(trunc('abc', 4), 'abc');
  assert.equal(headline('\n\n  First line  \nsecond'), 'First line');
});

test('hash is stable and prefixed', () => {
  assert.equal(hash('abc'), hash('abc'));
  assert.notEqual(hash('abc'), hash('abd'));
  assert.match(hash('abc'), /^h[0-9a-z]+$/);
});

// Dates

test('parseDate: common feed formats, all as UTC', () => {
  const t = Date.UTC(2026, 9, 5, 9, 30);
  assert.equal(parseDate('2026-10-05T09:30:00Z'), t);
  assert.equal(parseDate('2026-10-05T09:30:00'), t);          // no zone -> UTC, not local
  assert.equal(parseDate('2026-10-05 09:30:00'), t);
  assert.equal(parseDate('20261005093000'), t);               // GDELT
  assert.equal(parseDate('Mon, 05 Oct 2026 05:30:00 EDT'), t);
  assert.equal(parseDate('Mon, 05 Oct 2026 09:30:00 GMT (Coordinated Universal Time)'), t);
});

test('parseDate: garbage gives null', () => {
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('not a date'), null);
  assert.equal(parseDate(null), null);
});

// Requests

test('splitCredentials: moves a URL login into a Basic Authorization header', () => {
  const [url, headers] = splitCredentials('https://user:p%40ss@example.com/feed?x=1', { Accept: 'text/xml' });
  assert.equal(url, 'https://example.com/feed?x=1');
  assert.equal(headers.Authorization, `Basic ${Buffer.from('user:p@ss').toString('base64')}`);
  assert.equal(headers.Accept, 'text/xml');
});

test('splitCredentials: leaves plain URLs and their headers alone', () => {
  const h = { Accept: 'text/xml' };
  assert.deepEqual(splitCredentials('https://example.com/feed', h), ['https://example.com/feed', h]);
});

// Undated feed items

test('undatedPublished: earlier days use the link date, today uses first-seen time', () => {
  const now = Date.UTC(2026, 9, 5, 13, 20);
  assert.equal(undatedPublished('https://kathmandupost.com/politics/2026/10/04/some-story', now), Date.UTC(2026, 9, 4, 12));
  assert.equal(undatedPublished('https://kathmandupost.com/politics/2026/10/05/some-story', now), now);
  assert.equal(undatedPublished('https://example.com/story-without-date', now), now);
  assert.equal(undatedPublished(null, now), now);
});

// Titles

test('itemTitle: placeholder titles fall back to the post text', () => {
  assert.equal(itemTitle({ title: '[No Title] - Post from October 4, 2026', summary: 'RT: https://truthsocial.com/users/x/statuses/1' }),
               'RT: https://truthsocial.com/users/x/statuses/1');
  assert.equal(itemTitle({ title: 'Untitled', summary: '<p>First line</p><p>Second</p>' }), 'First line');
  assert.equal(itemTitle({ title: null, summary: 'Only text here' }), 'Only text here');
});

test('itemTitle: real titles are kept, even ones mentioning "no title"', () => {
  assert.equal(itemTitle({ title: 'Gas prices rise', summary: 'Body' }), 'Gas prices rise');
  assert.equal(itemTitle({ title: 'No title defence for champion after loss', summary: 'Body' }), 'No title defence for champion after loss');
  assert.equal(itemTitle({ title: '[No Title]', summary: '' }), '[No Title]');      // nothing better available
  assert.equal(itemTitle({ title: null, summary: null }), '(no title)');
});

test('feedText: reads the charset from the header, else the XML declaration', async () => {
  const latin1 = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><t>S\xe3o Paulo</t>', 'latin1');
  assert.match(await feedText(new Response(latin1, { headers: { 'content-type': 'text/xml' } })), /São Paulo/);
  assert.match(await feedText(new Response(latin1, { headers: { 'content-type': 'text/xml; charset=iso-8859-1' } })), /São Paulo/);
  assert.match(await feedText(new Response('<t>São Paulo</t>', { headers: { 'content-type': 'text/xml' } })), /São Paulo/);
  assert.match(await feedText(new Response('<t>ok</t>', { headers: { 'content-type': 'text/xml; charset=bogus' } })), /ok/);
});
