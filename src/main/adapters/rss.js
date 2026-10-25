'use strict';

// RSS / Atom / RDF feeds, and Google News searches (which are RSS underneath).
// Conditional requests (ETag / Last-Modified) keep 304 polls nearly free. For feeds that
// never answer 304 (no validators, or ignored ones) the body is fingerprinted: an identical
// body is dropped before parsing, and per-source counters show where the traffic goes.

const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const { Adapter }   = require('./base');
const { freshnessMs } = require('./pacing');
const { SourceError, parseRetryAfter, request, feedText, text, cleanText, cleanHtml, trunc, hash, parseDate, sanePublished } = require('./util');

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: false,
  isArray: name => name === 'item' || name === 'entry',
});

function atomLink(links) {
  const arr = Array.isArray(links) ? links : links ? [links] : [];
  const alt = arr.find(l => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate'));
  const pick = alt ?? arr[0];
  return typeof pick === 'object' ? pick?.['@_href'] ?? null : pick ?? null;
}

/**
 * Date for an item whose feed gives none (e.g. Kathmandu Post). Stories from earlier
 * days get noon UTC of the /YYYY/MM/DD/ date in their link; anything else is dated
 * when first seen — the database keeps that first time, so new stories still arrive
 * at the top of the list. Without a link date there's nothing better than first seen.
 */
function undatedPublished(link, now = Date.now()) {
  const m = /\/(20\d{2})\/(\d{2})\/(\d{2})\//.exec(link || '');
  if (m) {
    const day = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (day < now - (now % 86400e3)) return day + 12 * 3600e3;    // before today (UTC)
  }
  return now;
}

// Placeholder titles some feeds give untitled posts, e.g. "[No Title] - Post from October 4, 2026".
const PLACEHOLDER_TITLE = /^\[?\s*(no title|untitled)\s*\]?(\s*[-–—:].*)?$/i;

/** An entry's headline; untitled or placeholder-titled posts use their first line of text. */
function itemTitle(e) {
  const title = cleanText(e.title);
  if (title && !PLACEHOLDER_TITLE.test(title)) return title;
  const line = cleanHtml(e.summary, { keepLines: true })?.split('\n').find(l => l.trim());
  return line ? trunc(line.trim(), 160) : title ?? '(no title)';
}

/** Normalises RSS 2.0, RSS 1.0 (RDF) and Atom into a flat list of raw entries. */
function parseFeed(content) {
  const doc = xml.parse(content);

  const rss = doc.rss?.channel ?? doc['rdf:RDF'] ?? doc.RDF;
  if (rss) {
    return (rss.item ?? []).map(i => {
      const guid = i.guid;
      const permalink = typeof guid === 'object' && guid['@_isPermaLink'] !== 'false' ? text(guid) : null;
      return {
        id: text(guid) || text(i['@_rdf:about']),
        title: i.title,
        link: text(i.link) || permalink || null,
        summary: i.description ?? i['content:encoded'],
        date: i.pubDate ?? i['dc:date'] ?? i['a10:updated'] ?? i.published ?? i.updated,
        author: text(i['dc:creator']) || text(i.author) || null,
        source: text(i.source) || null,
        sourceUrl: typeof i.source === 'object' ? i.source['@_url'] ?? null : null,
      };
    });
  }

  const atom = doc.feed;
  if (atom) {
    return (atom.entry ?? []).map(e => ({
      id: text(e.id),
      title: e.title,
      link: atomLink(e.link),
      summary: e.summary ?? e.content,
      date: e.published ?? e.updated ?? e.issued ?? e.modified,
      author: text(e.author?.name) || null,
      source: null,
    }));
  }

  if (/<html[\s>]/i.test(content.slice(0, 2000))) throw new SourceError('BLOCKED', 'Got an HTML page instead of a feed (captcha or block page?)');
  throw new SourceError('PARSE', 'Unrecognised feed format');
}

class RssAdapter extends Adapter {
  constructor(source, ctx) {
    super(source, ctx);
    this.etag = null;
    this.lastMod = null;
    this.bodyHash = null;                          // fingerprint of the last body we parsed
    this.net = { polls: 0, notModified: 0, sameBody: 0, full: 0, bytes: 0 };
  }

  /** Where this source's requests went, for the state log (every 12th poll, so it isn't noisy). */
  reportNet() {
    const n = this.net;
    if (n.polls % 12 !== 1) return;
    this.log.set(`src.${this.name}.net`, `polls ${n.polls} · 304 ${n.notModified} · same body ${n.sameBody} · downloaded ${n.full} (${Math.round(n.bytes / 1024)} KB)`);
  }

  get feedUrl() { return this.config.url; }
  get paced() { return true; }

  async fetchItems(signal) {
    const headers = { Accept: 'application/rss+xml, application/atom+xml, text/xml, */*' };
    if (this.etag)    headers['If-None-Match']     = this.etag;
    if (this.lastMod) headers['If-Modified-Since'] = this.lastMod;

    const resp = await request(this.feedUrl, { signal, headers });
    this.net.polls++;
    this.freshMs = freshnessMs(resp.headers);      // how long the server says this copy stays fresh
    if (resp.status === 304) { this.net.notModified++; this.reportNet(); return null; }
    if (!resp.ok) {
      throw new SourceError(resp.status === 429 ? 'LIMIT' : `HTTP ${resp.status}`, `HTTP ${resp.status} ${resp.statusText}`,
        { retryAfterMs: parseRetryAfter(resp.headers.get('retry-after')) });         // the server says how long to wait
    }

    this.etag    = resp.headers.get('etag');
    this.lastMod = resp.headers.get('last-modified');
    const body = await feedText(resp);
    this.net.bytes += body.length;
    if (!body.trim()) return [];

    // Many feeds send no validators (or ignore ours) yet return the very same body poll after poll.
    const digest = crypto.createHash('sha1').update(body).digest('hex');
    if (digest === this.bodyHash) { this.net.sameBody++; this.reportNet(); return null; }
    this.net.full++;

    const items = [];
    const dates = [];                              // the dates the feed itself gives, newest last
    let undated = 0;
    for (const e of parseFeed(body)) {
      let publishedAt = parseDate(e.date);
      const title = itemTitle(e);
      if (publishedAt != null) dates.push(sanePublished(publishedAt));
      if (publishedAt == null) { undated++; publishedAt = undatedPublished(e.link); }
      items.push(this.transform({
        extId: e.id || e.link || hash(title),
        title,
        summary: cleanHtml(e.summary),
        url: e.link || null,
        author: e.author ? cleanText(e.author) : null,
        publishedAt: sanePublished(publishedAt),
      }, e));
    }
    this.bodyHash = digest;                        // only once it parsed: a bad body is tried again
    this.itemDates = dates.sort((a, b) => a - b);  // how often the feed publishes, before we have watched it ourselves
    this.pacer?.seed(this.itemDates);
    this.reportNet();
    if (undated && this.firstPoll) this.log.info(`[${this.name}] ${undated} item(s) have no date; using the link date or first-seen time`);
    return items;
  }

  transform(item) { return item; }
}

class GoogleNewsAdapter extends RssAdapter {
  get feedUrl() {
    const lang = this.config.lang || 'en';
    const country = (this.config.country || 'US').toUpperCase();
    const params = `hl=${lang}-${country}&gl=${country}&ceid=${country}:${lang}`;
    return this.config.query
      ? `https://news.google.com/rss/search?q=${encodeURIComponent(this.config.query)}&${params}`
      : `https://news.google.com/rss?${params}`;
  }

  // Titles arrive as "Headline - Publisher"; move the publisher into author.
  transform(item, raw) {
    const publisher = raw.source;
    if (publisher && item.title.endsWith(` - ${publisher}`)) item.title = item.title.slice(0, -(publisher.length + 3));
    item.author = publisher || item.author;
    // Links are news.google.com redirects; remember the publisher's site for its icon.
    if (raw.sourceUrl) item.extra = { ...item.extra, site: raw.sourceUrl };
    // Google's descriptions are just the headline + publisher again.
    item.summary = null;
    item.title = trunc(item.title, 300);
    return item;
  }
}

module.exports = { RssAdapter, GoogleNewsAdapter, parseFeed, undatedPublished, itemTitle };
