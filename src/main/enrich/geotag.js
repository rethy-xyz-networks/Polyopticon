'use strict';

// Finds where a news item happens, using the offline gazetteer (built by
// scripts/build-geo.js).
//
// 1. Mentions: capitalised 1–4 word phrases, longest first, matched against place
//    names and "actor" words (Israeli, Kremlin, Houthis: they point at a country but
//    don't place a story there). GDELT items list their places, which are read as is.
// 2. Guards: a name inside a publication's name is skipped (Jerusalem Post, Times of
//    India). Names that are also first names or surnames (Vladimir, Austin, Stanley)
//    are skipped next to another name (Vladimir Putin, Morgan Stanley) and otherwise
//    need evidence of a place: "in Austin", "Douglas, Georgia", or another place in
//    the same country.
// 3. Ambiguous names (Georgia, Tripoli, Hyderabad) take the candidate that best fits
//    the other places in the text and the source's home country, then the larger one.
// 4. Selection: the title decides. Places it names are kept, and the summary only adds
//    places inside them (Russia -> Irkutsk). With no place in the title, summary places
//    in the title's actor countries come first ("Ukrainian drones…" + "a data center in
//    Vladimir"), then other summary places, then the actor countries, then the dateline.
//    A country is dropped when a place inside it is kept.

const gaz = require('./gazetteer.json');

const VERSION = 2;                 // bump when results change, so stored items are re-tagged
const MAX_WORDS = 4;
const MAX_PLACES = 3;
const SUMMARY_CHARS = 400;

// Called for every word of every headline: the replacements only run when there is something to replace.
const norm = s => { const l = s.toLowerCase(); return l.includes('’') ? l.replace(/’/g, "'") : l; };
const key  = s => { const n = norm(s); return n.includes('-') ? n.replace(/-/g, ' ') : n; };      // the tokenizer splits on hyphens

/** name -> candidates, with hyphenated names (Rostov-on-Don) under their spaced form. */
function nameMap(obj) {
  const map = new Map();
  for (const [k, v] of Object.entries(obj ?? {})) map.set(key(k), [...new Set([...(map.get(key(k)) ?? []), ...v])]);
  return map;
}

const places  = gaz.places;        // [key, name, kind, cc, lat, lon, pop?]
const index   = nameMap(gaz.index);
const actors  = nameMap(gaz.actors);
const weak    = new Set((gaz.weak ?? []).map(key));

const KIND_PRIOR = { country: 9, region: 8.5, state: 8 };
const STATE_HOMONYM = 1.5;         // a state named like a country (Georgia) is the likelier one in English news
const CONTEXT_PLACE = 4;           // another place in the same country
const CONTEXT_ACTOR = 1;           // an actor word for the country
const SOURCE_HOME   = 2;           // the source's own country

// Publications: "<place> Post", "Times of <place>".
const ORG_NEXT = new Set(('Post Times Herald Tribune Guardian Gazette Journal Chronicle Telegraph Observer Independent ' +
  'Insider Examiner Inquirer Express Mail Star Standard Review').split(' '));
// Companies, in any case: "Sapporo breweries".
const COMPANY_NEXT = new Set('brewery breweries holdings corp corporation inc ltd'.split(' '));
// Words after a weak name that keep it a place (Victoria Harbour, Austin Airport).
const PLACE_NEXT = new Set(('City Province Region Oblast Governorate District County State Airport Airbase Port Harbour ' +
  'Harbor Bay Gulf Sea Strait Valley River Island Islands Mountains Peninsula Border Crossing Street Square Metro Area ' +
  'Prefecture Krai Republic Police Mayor Council').split(' '));
// Capitalised words before a weak name that keep it a place (Northern Victoria, Greater Columbus).
const PLACE_PREV = new Set(('North South East West Northern Southern Eastern Western Central Greater Upper Lower Old ' +
  'New Downtown Occupied Coastal Rural Suburban Metro In At Near From To Outside Across Around').split(' '));
const LOCATIVE = new Set('in at near from to into outside across around toward towards inside via off over through throughout within of'.split(' '));
// Prepositions that say an event happened there (more than "to" or "of" do).
const SETTING = new Set('in at near outside inside across around throughout within'.split(' '));
const ARTICLES = new Set('al el ad ash as an ar at az'.split(' '));

// ASCII letters decide without a regex (most words are ASCII).
const isCap = w => { const c = w.charCodeAt(0); return c < 128 ? c >= 65 && c <= 90 : /^\p{Lu}/u.test(w); };
const isUpper = w => w === w.toUpperCase() && /\p{L}/u.test(w);
const lookup = phrase => index.get(key(phrase)) ?? null;

// The first word of every name in the gazetteer. A capitalised word that starts none of them can't begin a
// place, so its 1-4 word phrases are not looked up at all (most capitalised words in a headline).
const firstWords = new Set();
for (const map of [index, actors]) for (const k of map.keys()) firstWords.add(k.split(' ')[0]);

// Tokens

/** Words with their offsets. Hyphens split words (US-Iran, Al-Mukalla) since names are
 *  indexed with spaces; "'s", closing quotes and trailing dots go, except in acronyms (U.S.). */
function tokenize(text) {
  const out = [];
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}.'’]*/gu)) {
    let w = m[0];
    if (w.includes("'") || w.includes('’')) w = w.replace(/['’]s$/u, '').replace(/['’]+$/u, '');
    if (w.endsWith('.') && !/^(\p{Lu}\.)+$/u.test(w)) w = w.replace(/\.+$/, '');
    if (!w) continue;
    out.push({ w, start: m.index, end: m.index + w.length });
  }
  for (let i = 0; i < out.length; i++) {
    const gap = text.slice(i ? out[i - 1].end : 0, out[i].start);
    out[i].gap = gap;                                              // text before the word
    if (gap === ' ') { out[i].joined = false; out[i].sentStart = i === 0; continue; }   // by far the commonest gap
    out[i].joined = /^-$/.test(gap);                               // hyphenated to the previous word
    out[i].sentStart = i === 0 || /[.!?:;|"“”()\[\]\n—–]|\s-\s/.test(gap) || /\p{Extended_Pictographic}/u.test(gap);
  }
  return out;
}

const LATIN_WORD = /^[A-Za-z]+$/;       // a quick yes for the common case; anything else gets the full Unicode check

/** Headline Case or ALL CAPS: capitals don't tell names from words. */
function caseless(tokens) {
  const words = tokens.slice(1).filter(t => t.w.length >= 4 && (LATIN_WORD.test(t.w) || /^\p{L}{4,}$/u.test(t.w)));
  if (words.length < 3) return false;
  return words.filter(t => isCap(t.w)).length / words.length >= 0.7 || words.every(t => isUpper(t.w));
}

// Mentions

/**
 * @returns {Array<{ pos, n, phrase, cands?, actor?, weak, evidence, seg }>}
 *   cands: place indexes; actor: country place index.
 */
function mentions(text, seg) {
  const tokens = tokenize(text);
  const noCase = caseless(tokens);
  const out = [];
  const isPlace = w => index.has(key(w));
  for (let i = 0; i < tokens.length;) {
    let matched = 0;
    const t = tokens[i];
    if (isCap(t.w) && firstWords.has(key(t.w)) && !(ARTICLES.has(norm(t.w)) && tokens[i + 1]?.joined)) {
      for (let n = Math.min(MAX_WORDS, tokens.length - i); n >= 1; n--) {
        const words = tokens.slice(i, i + n);
        if (words.slice(1).some(w => !w.joined && /[,.;:!?]/.test(w.gap))) continue;   // a phrase doesn't cross punctuation
        const phrase = key(words.map(w => w.w).join(' '));
        const cands = index.get(phrase) ?? null;
        const actor = actors.get(phrase)?.[0];
        if (!cands && actor == null) continue;
        if (phrase.length <= 2 && !isUpper(t.w)) continue;   // US, UK, LA must be in caps
        matched = n;
        const prev = tokens[i - 1], next = tokens[i + n];
        const after = text.slice(words[n - 1].end, next ? next.start : undefined);

        // A publication or company: Jerusalem Post, Times of India, Sapporo Breweries
        if (next && /^\s+$/.test(after) && (ORG_NEXT.has(next.w) || COMPANY_NEXT.has(next.w.toLowerCase()))) break;
        if (prev && norm(prev.w) === 'of' && tokens[i - 2]?.w === 'Times') break;

        const prevWord = prev && /^\s+$/.test(t.gap) ? prev.w.toLowerCase() : null;
        const m = { pos: t.start, n, phrase, seg, weak: weak.has(phrase), evidence: false, noCase, setting: SETTING.has(prevWord) };
        if (cands) m.cands = cands; else m.actor = actor;

        if (m.weak) {
          // Next to another capitalised word that isn't a place: part of a person's or firm's name.
          const nextIsName = next && /^\s+$/.test(after) && isCap(next.w) && !PLACE_NEXT.has(next.w) && !isPlace(next.w);
          const prevIsName = prevWord && isCap(prev.w) && !PLACE_PREV.has(prev.w) && !isPlace(prev.w);
          if (!noCase && (nextIsName || prevIsName)) break;   // Vladimir Putin, Morgan Stanley
          m.evidence = LOCATIVE.has(prevWord)
            || (next && /^\s*,\s*$/.test(after) && isPlace(next.w))          // Douglas, Georgia
            || (next && PLACE_NEXT.has(next.w));
          // Weak country names (Jordan, Chad) only need the name guards above.
          if (cands && cands.every(c => places[c][2] === 'country')) m.evidence = true;
        }
        out.push(m);
        break;
      }
    }
    i += matched || 1;
  }
  return out;
}

/** "SEOUL, Oct. 8 (Yonhap) --", "NAIROBI, Kenya (AP) —", "PESHAWAR:": where the reporter
 *  filed from. Returns the length of the dateline, or 0. */
function datelineEnd(summary) {
  const m = summary.match(/^\s*\p{Lu}[\p{Lu}.'’ -]{2,40}(?:,[^,:—–(\n]{1,30})?\s*(?:\([^)\n]{1,40}\))?\s*(?::|—|–|--|\s-\s)/u);
  return m && isUpper(m[0].split(/[,:(—–]/)[0]) ? m[0].length : 0;
}

/** GDELT summaries: "Locations: Riyadh, Ar Riyad, Saudi Arabia; Iranian; Iran · Tone -6.1". */
function gdeltMentions(summary) {
  const m = summary.match(/^Locations: (.*?)(?: · Tone -?[\d.]+)?$/s);
  if (!m) return null;
  const out = [];
  for (const [k, entry] of m[1].split('; ').entries()) {
    const parts = entry.split(', ').map(p => p.replace(/\s*\(General\)$/, '').trim()).filter(Boolean);
    const at = { pos: k, seg: 'summary', weak: false, evidence: true, fixed: true };
    const countryName = norm(parts[parts.length - 1]);
    const country = (lookup(countryName) ?? []).find(i => places[i][2] === 'country');
    if (parts.length === 1) {
      const cands = lookup(countryName);
      if (cands) out.push({ ...at, phrase: countryName, cands });
      else if (actors.has(key(countryName))) out.push({ ...at, phrase: countryName, actor: actors.get(key(countryName))[0] });
      continue;
    }
    const cc = country != null ? places[country][3] : null;
    const inCountry = name => (lookup(name) ?? []).filter(i => places[i][2] !== 'country' && (cc == null || places[i][3] === cc || !places[i][3]));
    const region = name => (lookup(name) ?? []).filter(i => places[i][2] === 'region');   // GDELT files Gaza under Israel
    // The middle part is a province; only take it when it's one we know as a state (not Kerman province -> Kerman city).
    const state = name => inCountry(name).filter(i => places[i][2] === 'state');
    const hit = [inCountry(parts[0]), region(parts[0]), parts.length > 2 ? state(parts[1]) : []].find(h => h.length) ?? [];
    if (hit.length) out.push({ ...at, phrase: norm(parts[0]), cands: hit });
    else if (country != null) out.push({ ...at, phrase: countryName, cands: [country] });
  }
  return out;
}

// Resolution

function resolve(all, homeCc) {
  const strong = new Map();                 // cc -> mentions placing something there
  const actorCcs = new Set();
  const addStrong = cc => cc && strong.set(cc, (strong.get(cc) ?? 0) + 1);
  for (const m of all) {
    if (m.actor != null) actorCcs.add(places[m.actor][3]);
    else if (m.cands.length === 1 && (!m.weak || m.evidence)) addStrong(places[m.cands[0]][3]);
  }
  const score = (i, cands) => {
    const [, , kind, cc, , , pop] = places[i];
    const homonym = kind === 'state' && cands.some(c => places[c][2] === 'country');
    return (KIND_PRIOR[kind] ?? Math.log10(pop || 1e5) + (kind === 'capital' ? 1 : 0)) + (homonym ? STATE_HOMONYM : 0)
      + (strong.has(cc) ? CONTEXT_PLACE : 0) + (actorCcs.has(cc) ? CONTEXT_ACTOR : 0) + (cc && cc === homeCc ? SOURCE_HOME : 0);
  };
  for (const m of all) {
    if (m.actor != null) continue;
    m.place = m.cands.length === 1 ? m.cands[0] : m.cands.reduce((a, b) => (score(b, m.cands) > score(a, m.cands) ? b : a));
    const cc = places[m.place][3];
    if (m.weak && !m.evidence) {
      // Another mention (not this one) or the source's home country can vouch for a weak name, except
      // in a headline-case title, where any word may be capitalised ("Columbus Statue").
      m.drop = m.noCase || !(strong.get(cc) > 0 || (cc && cc === homeCc));
      continue;
    }
    if (m.cands.length > 1) addStrong(cc);
  }
  return all.filter(m => !m.drop);
}

// Selection

/** Summary places in the country the summary is most about: each mention of a country (by place
 *  or actor word) counts 1, and 2 after "in"/"at" (GDELT lists every country an article names). */
function dominant(summary) {
  const area = i => places[i][3] || `#${i}`;     // a sea or other area without a country counts on its own
  const weight = new Map();
  for (const m of summary) {
    const i = m.place ?? m.actor;
    if (i != null) weight.set(area(i), (weight.get(area(i)) ?? 0) + (m.setting ? 2 : 1));
  }
  const named = summary.filter(m => m.place != null).map(m => m.place);
  const top = Math.max(...named.map(i => weight.get(area(i))));
  return named.filter(i => weight.get(area(i)) === top);
}

function select(title, summary, dateline, homeCc) {
  const names  = ms => ms.filter(m => m.place != null).map(m => m.place);
  const ccOf   = i => places[i][3];
  const kindOf = i => places[i][2];
  const isCountry = i => kindOf(i) === 'country';
  const tNames = names(title), sNames = names(summary), dNames = names(dateline);

  let chosen;
  if (tNames.length) {
    // The summary only refines a country or region the title names (Russia -> Irkutsk, Scotland ->
    // Glasgow). Not with a capital: "Moscow" or "Beijing" in a summary usually means the government.
    const areas = new Set(tNames.filter(i => isCountry(i) || kindOf(i) === 'region').map(ccOf).filter(Boolean));
    chosen = [...tNames, ...sNames.filter(i => !isCountry(i) && kindOf(i) !== 'capital' && areas.has(ccOf(i)))];
  } else {
    // Actor countries: the title's, else the summary's own-country ones ("Icelandic teachers" on RÚV,
    // but not "two Latvian nationals" in a BBC story about an RAF base)
    const titleActors = new Set(title.filter(m => m.actor != null).map(m => ccOf(m.actor)));
    const actorCount = new Map();
    for (const m of [...title, ...summary]) {
      if (m.actor == null || (!titleActors.size && ccOf(m.actor) !== homeCc)) continue;
      actorCount.set(m.actor, (actorCount.get(m.actor) ?? 0) + (m.seg === 'title' ? 2 : 1));
    }
    const topActor = Math.max(0, ...actorCount.values());
    // Places inside the countries the title's actor words point at ("Ukrainian drones…" -> Vladimir)
    const inActors = [...sNames, ...dNames].filter(i => !isCountry(i) && titleActors.has(ccOf(i)));
    chosen = inActors.length ? inActors
      : sNames.length ? dominant(summary)
      : actorCount.size ? [...actorCount].filter(([, n]) => n === topActor).map(([i]) => i)
      : dNames;
  }

  const unique = [...new Set(chosen)];
  const inside = new Set(unique.filter(i => !isCountry(i)).map(ccOf).filter(Boolean));
  return unique.filter(i => !(isCountry(i) && inside.has(ccOf(i)))).slice(0, MAX_PLACES);
}

// API

/** Strips feed boilerplate and the title when the summary repeats it. */
function cleanSummary(title, summary) {
  let s = String(summary || '').replace(/The post .+? appeared first on .+$/s, '').trim();
  const head = String(title || '').replace(/…$/, '').trim();
  if (head.length > 20 && s.startsWith(head)) s = s.slice(head.length);
  return s.slice(0, SUMMARY_CHARS);
}

/**
 * @param input  title text, or { title, summary }
 * @param opts   { cc }: ISO code of the source's home country (breaks ties: Hyderabad, Georgia)
 * @returns {Array<[key, name, lat, lon]>} where the story happens, most specific first.
 */
function geotag(input, { cc = null } = {}) {
  const { title = '', summary = '' } = typeof input === 'string' || input == null ? { title: input || '' } : input;
  if (!title && !summary) return [];
  const s = cleanSummary(title, summary);
  const t = mentions(String(title), 'title');
  let sum = gdeltMentions(s), date = [];
  if (!sum) {
    const end = datelineEnd(s);
    const all = mentions(s, 'summary');
    date = all.filter(m => m.pos < end);
    sum = all.filter(m => m.pos >= end);
  }
  const resolved = new Set(resolve([...t, ...sum, ...date], cc));
  const keep = ms => ms.filter(m => resolved.has(m));
  return select(keep(t), keep(sum), keep(date), cc).map(i => [places[i][0], places[i][1], places[i][4], places[i][5]]);
}

/** ISO code of a country by name ("USA", "Saudi Arabia"), or null. For source groups. */
function countryCode(name) {
  const i = (lookup(norm(String(name || '').trim())) ?? []).find(c => places[c][2] === 'country');
  return i == null ? null : places[i][3];
}

module.exports = { geotag, countryCode, GEOTAG_VERSION: VERSION };
