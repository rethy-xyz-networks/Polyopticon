'use strict';

// Story grouping. Each headline becomes a set of distinctive word stems; words
// are weighted by rarity (IDF over the recent window), and a new item joins the
// group of its most similar recent item if their weighted overlap is high
// enough. Groups are identified by the id of their first item.
// Templated headlines share all their words but the place ("Clima hoy en Esquel…", "Dólar hoy en
// Bolivia…"), so two items whose places disagree never join: no city or state in common when both
// name one, else no country in common.

const { tokens } = require('./text');

const WINDOW_MS     = 36 * 3600e3;   // only group stories published within this span
const THRESHOLD     = 0.42;          // weighted Jaccard needed to join a group
const MIN_SHARED    = 2;             // …and at least this many shared stems
const COMMON_RATIO  = 0.04;          // stems in more than 4% of items aren't used to find candidates

const NOWHERE = { ccs: [], spots: [] };
/** A doc's places, worked out on first use when they were given as a function. */
const whereOf = d => (typeof d.where === 'function' ? (d.where = d.where()) : d.where);
const meets = (a, b) => a.some(x => b.includes(x));
/** Two items' places don't rule out one story. */
const samePlace = (a, b) => a.spots.length && b.spots.length ? meets(a.spots, b.spots)
  : !a.ccs.length || !b.ccs.length || meets(a.ccs, b.ccs);

class Clusterer {
  constructor() {
    this.docs = new Map();           // id -> { tokens, publishedAt, clusterId, where }
    this.df = new Map();             // stem -> number of docs containing it
    this.postings = new Map();       // stem -> Set(id)
  }

  get size() { return this.docs.size; }

  weight(t) {
    const n = this.docs.size + 1;
    return Math.log((n + 1) / ((this.df.get(t) ?? 0) + 1)) + 1;
  }

  /** Best matching existing doc for a token set, or null. */
  match(toks, publishedAt, excludeId = null, where = NOWHERE) {
    const cap = Math.max(3, this.docs.size * COMMON_RATIO);
    const cand = new Map();          // id -> shared count
    for (const t of toks) {
      const posting = this.postings.get(t);
      if (!posting || posting.size > cap) continue;
      for (const id of posting) if (id !== excludeId) cand.set(id, (cand.get(id) ?? 0) + 1);
    }
    // A token's weight is asked for once per candidate that has it; compute each once. The new item's own
    // weights add up to the same `base` for every candidate (same terms, same order, so the same float).
    const memo = new Map();
    const weigh = t => { let w = memo.get(t); if (w === undefined) memo.set(t, w = this.weight(t)); return w; };
    let base = 0;
    for (const t of toks) base += weigh(t);
    let best = null, bestSim = 0;
    for (const [id, shared] of cand) {
      if (shared < MIN_SHARED) continue;
      const d = this.docs.get(id);
      if (Math.abs(d.publishedAt - publishedAt) > WINDOW_MS) continue;
      if (!samePlace(where, whereOf(d))) continue;
      let inter = 0, union = base;
      for (const t of toks) if (d.tokens.has(t)) inter += weigh(t);
      for (const t of d.tokens) if (!toks.has(t)) union += weigh(t);
      const sim = union ? inter / union : 0;
      if (sim > bestSim) { bestSim = sim; best = d; }
    }
    return bestSim >= THRESHOLD ? { doc: best, sim: bestSim } : null;
  }

  /**
   * Adds an item and returns its cluster id. A known clusterId (from the
   * database) is kept as-is so groups stay stable across restarts.
   * @param where  { ccs, spots } of the item's places (see Enricher.where); unknown places agree with any.
   *               A function returning them is called only if another item is compared with this one
   *               (at startup, most stored items never are).
   */
  add(id, title, publishedAt, clusterId = null, where = NOWHERE) {
    const toks = tokens(title);
    if (clusterId == null) {
      const m = toks.size >= MIN_SHARED ? this.match(toks, publishedAt, id, typeof where === 'function' ? (where = where()) : where) : null;
      clusterId = m ? m.doc.clusterId : id;
    }
    const prev = this.docs.get(id);
    if (prev) this.remove(id);
    this.docs.set(id, { id, tokens: toks, publishedAt, clusterId, where });
    for (const t of toks) {
      this.df.set(t, (this.df.get(t) ?? 0) + 1);
      if (!this.postings.has(t)) this.postings.set(t, new Set());
      this.postings.get(t).add(id);
    }
    return clusterId;
  }

  remove(id) {
    const d = this.docs.get(id);
    if (!d) return;
    for (const t of d.tokens) {
      const n = (this.df.get(t) ?? 1) - 1;
      if (n <= 0) this.df.delete(t); else this.df.set(t, n);
      this.postings.get(t)?.delete(id);
      if (!this.postings.get(t)?.size) this.postings.delete(t);
    }
    this.docs.delete(id);
  }

  /** Drops items older than the window (relative to now). */
  prune(now = Date.now()) {
    for (const [id, d] of this.docs) if (now - d.publishedAt > WINDOW_MS * 1.5) this.remove(id);
  }
}

module.exports = { Clusterer, WINDOW_MS, THRESHOLD };
