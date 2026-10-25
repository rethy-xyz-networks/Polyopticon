'use strict';

// Which sources are national outlets: those whose located stories are nearly all in their home
// country (The Hindu, RTV SLO, Folha), unlike outlets covering several countries (Infobae, CNA).
// A national outlet's story that names no place is placed in its home country: "Lok Sabha passes
// the bill" on The Hindu, "Vlada sprejela proračun" on RTV SLO.

const MIN_LOCATED = 10;      // located stories before a source can count as national
const MIN_SHARE   = 0.9;     // share of them at home
const MAX_COUNT   = 400;     // counts halve past this, so a source that changes its coverage is noticed

class HomeShare {
  /** @param saved  a previous toJSON() */
  constructor(saved = {}) {
    this.counts = new Map(Object.entries(saved).map(([id, [home, located]]) => [String(id), { home, located }]));
  }

  /** Counts a story's places (from the matcher, never the fallback) for its source. */
  record(sourceId, homeCc, ccs) {
    if (!homeCc || !ccs.length) return;
    const c = this.counts.get(String(sourceId)) ?? { home: 0, located: 0 };
    c.located++;
    if (ccs.includes(homeCc)) c.home++;
    if (c.located > MAX_COUNT) { c.home /= 2; c.located /= 2; }
    this.counts.set(String(sourceId), c);
  }

  national(sourceId) {
    const c = this.counts.get(String(sourceId));
    return !!c && c.located >= MIN_LOCATED && c.home / c.located >= MIN_SHARE;
  }

  toJSON() {
    return Object.fromEntries([...this.counts].map(([id, c]) => [id, [Math.round(c.home * 10) / 10, Math.round(c.located * 10) / 10]]));
  }
}

module.exports = { HomeShare };
