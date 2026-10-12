'use strict';

// Base class for every source type. Subclasses implement fetchItems(signal),
// returning normalised items (or null for "not modified"). The base handles
// scheduling, overlap protection, de-duplication via the store, and status.
//
// Normalised item: { extId, title, summary?, url?, author?, publishedAt, kind?, extra? }

const { SourceError } = require('./util');
const { Pacer, jitter } = require('./pacing');

// After repeated failures a source is polled less often (doubling each time, up to this), so a feed that
// is blocked or down isn't hit every few seconds all day. The first retry still comes at the normal
// interval, and one success puts the source straight back on it.
const BACKOFF_CAP_MS = 5 * 60e3;

/** Wait before the next poll given `failures` in a row; never shorter than the source's own interval. */
function backoffMs(intervalMs, failures) {
  if (failures < 2) return intervalMs;
  return Math.max(intervalMs, Math.min(BACKOFF_CAP_MS, intervalMs * 2 ** Math.min(failures - 1, 20)));
}

class Adapter {
  /**
   * @param source  row from the sources table
   * @param ctx     { ingest(source, items) → added[], status(source, label, isError), log, credentials, intervalMs(source, meta) }
   */
  constructor(source, ctx) {
    this.source    = source;
    this.config    = source.config || {};
    this.ctx       = ctx;
    this.log       = ctx.log;
    this.timer     = null;
    this.inflight  = null;
    this.stopped   = false;
    this.firstPoll = true;
    this.total     = 0;
    this.errors    = 0;
    this.failures  = 0;                 // failed polls in a row
    this.retryAfterMs = 0;              // the server asked for this long a pause (Retry-After)
    this.freshMs = 0;                   // how long the server says the latest copy stays fresh (set by the subclass)
    this.pacer = this.paced ? new Pacer() : null;   // adaptive polling state (see pacing.js)
    this.abort     = new AbortController();
  }

  /** Static metadata comes from types.js; subclasses set `static type`. */
  get meta() { return this.constructor.meta; }
  get name() { return this.source.name; }
  get intervalMs() { return this.ctx.intervalMs(this.source, this.meta); }

  /** Subclasses that poll a plain URL set this: their polling then follows what the feed does (see pacing.js). */
  get paced() { return false; }

  /** After a successful poll: tell the adaptive scheme whether the feed had anything new. */
  observePoll(changed) {
    this.pacer?.observe({ now: Date.now(), changed, freshMs: this.freshMs });
  }

  /** Wait before the next poll when nothing has gone wrong: the interval, or longer for a quiet feed. */
  nextDelayMs() {
    const base = this.intervalMs;
    if (!this.pacer) return base;
    const wait = this.pacer.delayMs(base);
    return wait > base ? Math.max(base, jitter(wait)) : base;
  }

  /** One line for the state log: what the polling is doing for this source. */
  pacingLine() { return this.pacer ? this.pacer.describe(this.intervalMs) : null; }

  start(delayMs = 0) {
    this.timer = setTimeout(() => this.tick(), delayMs);
  }

  async tick() {
    this.timer = null;
    await this.pollOnce();
    if (this.stopped) return;
    const wait = Math.max(backoffMs(this.nextDelayMs(), this.failures), this.retryAfterMs);
    this.retryAfterMs = 0;
    if (this.failures >= 2 && wait > this.intervalMs) this.log.debug(`[${this.name}] ${this.failures} failures in a row — next try in ${Math.round(wait / 1000)}s`);
    this.timer = setTimeout(() => this.tick(), wait);
  }

  /** Reschedule a waiting timer after the interval setting changed. */
  reschedule() {
    if (!this.timer || this.firstPoll) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }

  pollOnce() {
    if (!this.inflight) this.inflight = this.poll().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.abort.abort();
  }

  status(label, isError = false) { this.ctx.status(this.source, label, isError); }

  /** Stores items; returns the newly added ones. Also used by push-style adapters. */
  ingest(items) {
    if (!items.length) return [];
    const added = this.ctx.ingest(this.source, items);
    this.total += added.length;
    return added;
  }

  async poll() {
    try {
      const items = await this.fetchItems(this.abort.signal);
      if (this.stopped) return;
      const n = items?.length ?? 0;
      const added = items ? this.ingest(items) : [];
      if (this.firstPoll) this.log.info(`[${this.name}] First poll — items: ${n}, new: ${added.length}`);
      else if (added.length) this.log.info(`[${this.name}] +${added.length} new item(s)`);
      this.firstPoll = false;
      this.failures = 0;
      this.observePoll(added.length > 0);
      this.pollCount = (this.pollCount ?? 0) + 1;
      if (this.pacer && this.pollCount % 12 === 1) this.log.set(`src.${this.name}.pacing`, this.pacingLine());
      this.log.set(`src.${this.name}.last_status`, items ? 'OK' : 'Not modified');
      this.status(String(this.total));
    } catch (e) {
      if (this.stopped) return;
      this.errors++;
      this.failures++;
      if (e.retryAfterMs) this.retryAfterMs = e.retryAfterMs;
      const label = e instanceof SourceError ? e.label
                  : e.name === 'TimeoutError' ? 'TMO'
                  : 'ERR';
      const cause = e.cause?.code ? ` (${e.cause.code})` : '';
      this.log.warn(`[${this.name}] ${label}: ${e.message}${cause}`);
      this.log.set(`src.${this.name}.last_status`, `${label}: ${e.message}`);
      this.log.set(`src.${this.name}.errors`, this.errors);
      this.log.onError(`[${this.name}] ${e.message}`);
      this.status(label, true);
    }
  }

  /** @returns {Promise<object[]|null>} */
  async fetchItems() { throw new Error('not implemented'); }
}

module.exports = { Adapter, backoffMs, BACKOFF_CAP_MS };
