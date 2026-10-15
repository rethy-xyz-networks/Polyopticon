'use strict';

// Language detection and headline tokenising, shared by grouping, place
// tagging and translation. Detection is script-based for non-Latin text and
// stop-word based for Latin text; tuned for short headlines and posts.

// Language detection

const SCRIPTS = [
  ['arabic',     /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g],
  ['hebrew',     /[֐-׿]/g],
  ['cyrillic',   /[Ѐ-ӿ]/g],
  ['greek',      /[Ͱ-Ͽ]/g],
  ['kana',       /[぀-ヿ]/g],
  ['han',        /[一-鿿]/g],
  ['hangul',     /[가-힯]/g],
  ['thai',       /[฀-๿]/g],
  ['devanagari', /[ऀ-ॿ]/g],
  ['armenian',   /[԰-֏]/g],
  ['georgian',   /[Ⴀ-ჿ]/g],
  ['latin',      /[A-Za-zÀ-ɏ]/g],
];

// Common function words per Latin-script language.
const STOP = {
  en: 'the of and to in is for on that with as at by from after over says said will are was has have be its new us this but not more than who about into amid',
  fr: 'le la les des du de un une et est pour dans sur avec par qui que au aux ce cette sont pas plus selon après',
  de: 'der die das und ist nicht mit von den dem zu auf für im ein eine sich auch nach bei wird werden über',
  es: 'el la los las de del y en que por para con una un se su al es más tras según como sobre ha',
  it: 'il lo la gli le di del della e che per con un una in è sono non più dopo nel alla dal',
  pt: 'o a os as de do da dos das e em que para com um uma no na por é não mais após pelo',
  nl: 'de het een en van in is op te dat voor met niet zijn aan bij ook naar door',
  tr: 've bir bu için ile da de olarak olan sonra en çok gibi daha ama kadar mi',
  pl: 'i w na z do się nie że jest to o po dla od jak przez już są',
  id: 'yang dan di ke dari untuk dengan ini itu pada tidak dalam akan adalah oleh',
  sv: 'och i att det som en på är av för med till den har inte',
  sl: 'in je da na v za se so z s ki pa po iz od bo tudi ter še kot ob pri ali bi ni le ga jih',
  cs: 'je se na že ve jsou byl byla bylo jako také nebo který podle při však jeho její jsme být bude pro aby',
  sk: 'je sa na že sú bol bola bolo ako tiež alebo ktorý podľa pri však jeho jej sme byť bude pre aby',
  hr: 'je se na da su bio bila bilo kao ili koji koja koje će također nakon prema ali još ne od za',
  is: 'og í á að er um við til fyrir með sem var ekki en hann hún það af eru frá úr verður hefur þegar',
};
const STOP_SETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v.split(' '))]));

// Each UTF-16 code unit's scripts as a bit mask (the regexes above, evaluated once per unit), so the
// detector counts a headline's letters in one pass instead of running twelve global regexes over it.
const SCRIPT_BITS = new Uint16Array(0x10000);
SCRIPTS.forEach(([, rx], i) => {
  const one = new RegExp(rx.source);
  for (let c = 0; c < 0x10000; c++) if (one.test(String.fromCharCode(c))) SCRIPT_BITS[c] |= 1 << i;
});

// Stop word -> the languages (in STOP order) that list it. Scoring then walks a text's words once.
const LANGS = Object.keys(STOP_SETS);
const STOP_OWNERS = new Map();
LANGS.forEach((lang, i) => { for (const w of STOP_SETS[lang]) (STOP_OWNERS.get(w) ?? STOP_OWNERS.set(w, []).get(w)).push(i); });
const EN = LANGS.indexOf('en');
const IS = LANGS.indexOf('is');

/** Returns an ISO 639-1 code ('en', 'ar', 'he', …) or null when unsure. */
function detectLang(text) {
  if (!text) return null;
  const s = String(text).slice(0, 600);
  const counts = new Array(SCRIPTS.length).fill(0);
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const bits = SCRIPT_BITS[s.charCodeAt(i)];
    if (!bits) continue;
    for (let k = 0; k < counts.length; k++) if (bits & (1 << k)) { counts[k]++; total++; }
  }
  if (!total) return null;
  let top = 0;                                   // the first script with the highest count
  for (let k = 1; k < counts.length; k++) if (counts[k] > counts[top]) top = k;
  if (counts[top] / total < 0.5) return null;
  const count = name => counts[SCRIPTS.findIndex(([n]) => n === name)];

  switch (SCRIPTS[top][0]) {
    case 'arabic':
      if (/[ٹڈڑںےھ]/.test(s)) return 'ur';
      // Persian uses ی/ک (U+06CC/06A9) and پچژگ; Arabic uses ي/ك (U+064A/0643).
      return (s.match(/[پچژگیک]/g) || []).length > (s.match(/[يكةى]/g) || []).length ? 'fa' : 'ar';
    case 'hebrew':     return 'he';
    case 'cyrillic':   return /[іїєґ]/i.test(s) ? 'uk' : /[ўі]/.test(s) ? 'be' : 'ru';
    case 'greek':      return 'el';
    case 'kana':       return 'ja';
    case 'han':        return count('kana') > 0 ? 'ja' : 'zh';
    case 'hangul':     return 'ko';
    case 'thai':       return 'th';
    case 'devanagari': return 'hi';
    case 'armenian':   return 'hy';
    case 'georgian':   return 'ka';
  }

  // Latin script: score function words.
  const words = s.toLowerCase().match(/[a-zà-ɏ']+/g) || [];
  if (words.length < 3) return 'en';
  const points = new Array(LANGS.length).fill(0);
  for (const w of words) {
    const owners = STOP_OWNERS.get(w);
    if (owners) for (const i of owners) points[i]++;
    // þ/ð appear only in Icelandic words — but one place name (Ísafjörður) in an English story mustn't flip it.
    if (/[þð]/.test(w)) points[IS]++;
  }
  const scores = LANGS.map((lang, i) => [lang, points[i]]).sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  // Prefer English unless another language is clearly ahead — mistranslating English is worse than missing a translation.
  if (best[0] !== 'en' && best[1] >= 2 && best[1] > (points[EN] + 1) && best[1] > second[1]) return best[0];
  return 'en';
}

// Tokenising (for grouping)

const EN_STOP = new Set((
  'a an the of and or but to in on at by for from with without into onto over under after before about against between ' +
  'during amid as is are was were be been being has have had do does did will would can could should may might must ' +
  'this that these those it its it\'s their them they he she his her him we our you your i me my not no yes ' +
  'says said say tells told report reports reported according new news live latest update updates breaking watch video ' +
  'photos photo more most first last than then just now today yesterday tomorrow week year years day days time ' +
  'what who why how when where which while amid also out up down off back still very much many some any all one two three ' +
  'here there get gets got make makes made take takes took man woman people says' ).split(/\s+/));

const ASCII = /^[\x00-\x7f]*$/;

/** Distinctive lower-case word stems from a headline. */
function tokens(text) {
  const out = new Set();
  const clean = String(text).replace(/\bhttps?:\/\/\S+|\b[\w-]+\.[a-z]{2,}\/\S*/gi, ' ');    // drop links like reut.rs/4hZzTaC
  for (let w of clean.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+(?:'[a-z]+)?/g) || []) {
    w = w.replace(/'s$/, '').replace(/'/g, '');
    if (w.length < 3 && !/^\d{2,}$/.test(w)) continue;
    if (EN_STOP.has(w)) continue;
    // Light stemming so "strike"/"strikes"/"striking" meet.
    if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.length > 4 && w.endsWith('es') && /(ss|sh|ch|x|z)es$/.test(w)) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    else if (w.length > 5 && w.endsWith('ed')) w = w.slice(0, -2);
    out.add(w);
  }
  return out;
}

module.exports = { detectLang, tokens };
