'use strict';

// How often to poll a feed, decided from what the feed actually does. Pure logic, no I/O.
//
//   The refresh interval (Settings) is the fastest a feed is ever polled. A feed that keeps
//   showing something new stays on it. One that goes quiet is polled a little less each time,
//   but never less often than MAX_MS, and never so rarely that it would miss what it normally
//   publishes: the wait is also limited to a fraction of the feed's usual gap between stories.
//   When something new arrives it is back on the fast interval straight away.
//
//   If the server says how long the copy it just sent stays fresh (Cache-Control: max-age,
//   less Age; or Expires), a quiet feed is not asked again before then, up to CACHE_CAP_MS.
//   That is a hint, not a guarantee (a CDN may replace the copy the moment a story is published),
//   so it only applies to feeds that have already been quiet for a while and is capped.
//
// The numbers lean towards polling too much rather than too little.

const DEFAULTS = {
  growth:       1.5,         // each further idle poll waits this much longer than the one before
  slowAfter:    2,           // idle polls in a row before a feed starts slowing down
  maxMs:        20_000,      // the longest wait the adaptive scheme adds
  gapDivisor:   20,          // poll at least this many times per usual gap between stories
  cacheCapMs:   0,           // the longest a server's freshness hint is obeyed for (0 = ignore: measured to cost freshness for almost no saving)
  gapWeight:    0.3,         // how much the newest gap counts in the running average of gaps
  maxGapMs:     3600e3,      // one very long silence shouldn't make a feed look dead
};
const { maxMs: MAX_MS, cacheCapMs: CACHE_CAP_MS } = DEFAULTS;

class Pacer {
  /** @param opts  any of DEFAULTS, to try other numbers (scripts/bench-polling/replay.js) */
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.idle = 0;                 // polls in a row that found nothing new
    this.meanGapMs = null;         // running average of the time between stories arriving
    this.lastChangeAt = null;
    this.freshUntil = 0;           // when the server's freshness hint for the latest copy runs out
  }

  /** Start from the feed's own item dates (oldest first) instead of learning its rhythm from scratch. */
  seed(dates) {
    const d = (dates || []).filter(Number.isFinite).sort((a, b) => a - b);
    if (d.length < 3 || this.meanGapMs != null) return;
    const gap = (d.at(-1) - d[0]) / (d.length - 1);
    if (gap > 0) this.meanGapMs = Math.min(gap, this.o.maxGapMs);
  }

  /** Record the outcome of a poll: did it find anything new, and for how long does the server say the copy is fresh. */
  observe({ now, changed, freshMs = 0 }) {
    if (changed) {
      if (this.lastChangeAt != null) {
        const gap = Math.min(now - this.lastChangeAt, this.o.maxGapMs);
        this.meanGapMs = this.meanGapMs == null ? gap : (1 - this.o.gapWeight) * this.meanGapMs + this.o.gapWeight * gap;
      }
      this.lastChangeAt = now;
      this.idle = 0;
    } else {
      this.idle++;
    }
    this.freshUntil = now + Math.max(0, freshMs);
  }

  /** How long to wait before the next poll; never less than `baseMs`. */
  delayMs(baseMs, now = Date.now()) {
    let wait = baseMs;
    const o = this.o;
    if (this.idle >= o.slowAfter) {
      wait = baseMs * o.growth ** (this.idle - o.slowAfter + 1);
      if (this.meanGapMs != null) wait = Math.min(wait, this.meanGapMs / o.gapDivisor);
      wait = Math.min(wait, o.maxMs);
      // the server's own statement of how long this copy is fresh
      wait = Math.max(wait, Math.min(this.freshUntil - now, o.cacheCapMs));
    }
    return Math.max(baseMs, Math.round(wait));
  }

  describe(baseMs, now = Date.now()) {
    return `next in ${(this.delayMs(baseMs, now) / 1000).toFixed(1)}s · idle ${this.idle}`
      + (this.meanGapMs != null ? ` · usual gap ${Math.round(this.meanGapMs / 1000)}s` : '');
  }
}

/**
 * How long the server says the copy it just sent stays fresh (ms from now), 0 if it doesn't say or
 * says to always revalidate. From Cache-Control max-age, else Expires, less the Age already spent in caches.
 */
function freshnessMs(headers, now = Date.now()) {
  const cc = String(headers.get('cache-control') ?? '').toLowerCase();
  if (/\b(no-cache|no-store)\b/.test(cc)) return 0;
  let life = null;
  const m = /(?:^|[,\s])max-age=(\d+)/.exec(cc);
  if (m) life = Number(m[1]) * 1000;
  else {
    const expires = Date.parse(headers.get('expires'));
    const date = Date.parse(headers.get('date'));
    if (Number.isFinite(expires)) life = expires - (Number.isFinite(date) ? date : now);
  }
  if (!(life > 0)) return 0;
  const age = Number(headers.get('age'));
  if (Number.isFinite(age) && age > 0) life -= age * 1000;
  return Math.max(0, life);
}

/** ±10%, so feeds that started together drift apart instead of polling in step. */
const jitter = (ms, rand = Math.random) => Math.round(ms * (0.9 + 0.2 * rand()));

module.exports = { Pacer, DEFAULTS, freshnessMs, jitter, MAX_MS, CACHE_CAP_MS };
