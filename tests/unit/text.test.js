'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectLang, tokens } = require('../../src/main/enrich/text');

test('detectLang: non-Latin scripts', () => {
  assert.equal(detectLang('Путин заявил о новых санкциях'), 'ru');
  assert.equal(detectLang('Зеленський зустрівся з міністрами'), 'uk');
  assert.equal(detectLang('الحكومة تعلن عن خطة جديدة'), 'ar');
  assert.equal(detectLang('ממשלת ישראל אישרה את התקציב'), 'he');
  assert.equal(detectLang('東京で地震が発生しました'), 'ja');
  assert.equal(detectLang('中国政府发布新政策'), 'zh');
  assert.equal(detectLang('서울에서 대규모 시위'), 'ko');
});

test('detectLang: Latin-script languages by function words', () => {
  assert.equal(detectLang('The president says the talks will resume after the summit'), 'en');
  assert.equal(detectLang('Le gouvernement annonce des mesures pour les agriculteurs dans la région'), 'fr');
  assert.equal(detectLang('Die Regierung will nicht mit der Opposition über das Gesetz sprechen'), 'de');
  assert.equal(detectLang('El gobierno anuncia una reforma para los trabajadores del sector'), 'es');
});

test('detectLang: Icelandic and the Latin-script Slavic languages', () => {
  assert.equal(detectLang('Ríkisstjórnin kynnti í dag nýjar efnahagsaðgerðir til að berjast gegn verðbólgu'), 'is');
  assert.equal(detectLang('Vláda dnes oznámila nové opatrenia, ktoré sú podľa ministra potrebné pre rodiny'), 'sk');
  assert.equal(detectLang('Vláda dnes oznámila nová opatření, která jsou podle ministra potřebná pro rodiny, které byly postiženy'), 'cs');
  assert.equal(detectLang('Vlada je danes napovedala nove ukrepe, ki so po besedah ministra potrebni tudi za družine'), 'sl');
  assert.equal(detectLang('Vlada je danas najavila nove mjere koje su prema riječima ministra potrebne također za obitelji'), 'hr');
});

test('detectLang: defaults to English when unsure, null when empty', () => {
  assert.equal(detectLang('Breaking: NATO'), 'en');
  assert.equal(detectLang(''), null);
  assert.equal(detectLang('12345 !!!'), null);
});

test('tokens: drops stop words, links and short words; stems plurals and -ing', () => {
  const t = tokens('Missile strikes hit Kyiv as officials say attacks are striking power plants reut.rs/4hZzTaC');
  assert.ok(t.has('missile'));
  assert.ok(t.has('strike'));          // strikes → strike
  assert.ok(t.has('strik'));           // striking → strik (light stemmer)
  assert.ok(t.has('kyiv'));
  assert.ok(t.has('plant'));
  assert.ok(!t.has('as') && !t.has('are') && !t.has('say'));
  assert.ok(![...t].some(w => w.includes('reut')));
});

test('tokens: strips accents and possessives, keeps numbers', () => {
  const t = tokens("Zürich's 2024 budget approved");
  assert.ok(t.has('zurich'));
  assert.ok(t.has('2024'));
  assert.ok(t.has('budget'));
});

test('detectLang: Slovenian and Icelandic', () => {
  assert.equal(detectLang('Cena bencina se bo znižala za 1,6 centa za liter, cena dizla pa za 4,6 centa'), 'sl');
  assert.equal(detectLang('Vojko Flis odstopil z mesta direktorja UKC-ja Maribor, kot je sporočil'), 'sl');
  assert.equal(detectLang('Opnað fyrir umferð um nýjan Arnarnesveg í dag klukkan tvö'), 'is');
  assert.equal(detectLang('Lögregla kvödd til þegar tveir menn voru komnir með höfuð inn um glugga'), 'is');
});

test('detectLang: an Icelandic place name does not make English text Icelandic', () => {
  assert.equal(detectLang('A yellow landslide warning issued on Saturday follows rockfalls and a large slide near Ísafjörður'), 'en');
  assert.equal(detectLang('Tourists flock to Þingvellir as the season ends'), 'en');
});
