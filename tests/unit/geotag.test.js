'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { geotag, countryCode } = require('../../src/main/enrich/geotag');

const names = (title, summary = '', cc = null) => geotag({ title, summary }, { cc }).map(p => p[1]);

test('finds places in order of mention, dropping a country a city in it covers', () => {
  assert.deepEqual(names('Protests spread from Paris to Lyon as France braces for strikes'), ['Paris', 'Lyon']);
});

test('returns [key, name, lat, lon] with numeric coordinates', () => {
  const [p] = geotag('Flooding in Germany');
  assert.equal(p.length, 4);
  assert.equal(p[1], 'Germany');
  assert.equal(typeof p[2], 'number');
  assert.equal(typeof p[3], 'number');
});

test('prefers multi-word names over their parts', () => {
  assert.deepEqual(names('Talks resume in New York'), ['New York']);
});

test('short codes only match in capitals', () => {
  assert.deepEqual(names('The US and UK sign a deal'), ['United States', 'United Kingdom']);
  assert.deepEqual(names('Let us know'), []);
});

test('uses other places and the source country to resolve ambiguous names', () => {
  const georgia = (title, cc) => geotag({ title }, { cc }).find(p => p[1] === 'Georgia');
  assert.ok(georgia('Storms hit Atlanta, Georgia overnight')[3] < -60, 'US state next to Atlanta');
  // Next to Tbilisi it's the country, which Tbilisi then stands for
  assert.deepEqual(names('Georgia votes in parliamentary election, Tbilisi braces for protests'), ['Tbilisi']);
  const hyderabad = cc => geotag({ title: 'Metro fares rise in Hyderabad' }, { cc })[0];
  assert.ok(hyderabad('IN')[3] > hyderabad('PK')[3], 'Indian Hyderabad for an Indian source, Pakistani for a Pakistani one');
});

test('caps results at three places and handles empty input', () => {
  assert.ok(geotag('France Germany Italy Spain Poland Austria Belgium').length <= 3);
  assert.deepEqual(geotag(''), []);
  assert.deepEqual(geotag(null), []);
  assert.deepEqual(geotag({ title: '', summary: '' }), []);
});

// Regressions from the map audit (docs/map-audit.md): one per kind of wrong mapping.

test('Australia is Australia, not the Ashmore and Cartier Islands', () => {
  assert.deepEqual(names('Australia has never driven migration into reverse by design'), ['Australia']);
});

test('"South" and "Sri" alone are not South Africa or Sri Lanka', () => {
  assert.deepEqual(names('Hunger in the South due to the planned income tax'), []);
  assert.deepEqual(names('Over 90,000 devotees attend festivities', 'delegations from Sri Kalahasteeswara Swamy temple'), []);
  assert.deepEqual(names('A farmer in South Estonia found a trail camera'), ['Estonia']);
});

test('other languages\' names for cities are not matched (Sam, Part, Philadelphia = Amman)', () => {
  assert.deepEqual(names('Bachelor star Sam Wood denied bail'), []);
  assert.deepEqual(names('Part of the site is up for rent'), []);
  assert.deepEqual(names('Man with gun kills one Philadelphia police officer'), ['Philadelphia']);
  assert.deepEqual(names('Settlers attack wedding procession near Bethlehem'), ['Bethlehem']);
  assert.deepEqual(names('Comic Con concludes in Visakhapatnam'), ['Visakhapatnam']);
});

test('first names and surnames that are also places need a place context', () => {
  assert.deepEqual(names('Trump’s deal with Vladimir Putin will have little impact'), ['Russia']);   // via "Putin", not the city
  assert.deepEqual(names('Ukrainian drones target Russian tech giant’s data centers', 'A drone strike shut down a data center in Vladimir'), ['Vladimir']);
  assert.deepEqual(names('Morgan Stanley executive says markets are primed'), []);
  assert.deepEqual(names('Conor Kennedy and Giulia Be Married in Rio'), ['Rio de Janeiro']);
  assert.deepEqual(names('Samuel Alito and New Jersey’s Fallen Columbus Statue'), ['New Jersey']);
});

test('everyday words, brands and acronyms are not places', () => {
  assert.deepEqual(names('Male infertility is grossly underreported'), []);
  assert.deepEqual(names('Brent crude tops $104 per barrel'), []);
  assert.deepEqual(names('Thailand floods disrupt Toyota and Honda production'), ['Thailand']);
  assert.deepEqual(names('Infosys does not expect impact from US PERM suspension'), ['United States']);
});

test('publications and companies named after places are not places', () => {
  assert.deepEqual(names('New York Times report hides a truth about Israel'), ['Israel']);
  assert.deepEqual(names('Japan beer giants raided', 'Investigators probe Asahi, Kirin, Suntory and Sapporo breweries'), ['Japan']);
  assert.deepEqual(names('Readers write to the Times of India about Kerala floods'), ['Kerala']);
});

test('landmarks resolve to the right country\'s city', () => {
  assert.equal(geotag({ title: 'Downing Street said talks would go ahead' })[0][0], geotag('London')[0][0]);
  assert.deepEqual(names('Flydubai co-pilot planned to crash plane at Ben Gurion'), ['Tel Aviv']);
});

test('city districts stand for their city', () => {
  assert.deepEqual(names('Fire breaks out in a Shinjuku tower'), ['Tokyo']);
  assert.deepEqual(names('Power cut across Obolon after strike'), ['Kyiv']);
});

test('the summary refines the title\'s country but does not add unrelated places', () => {
  assert.deepEqual(names('Russia says all clear after plague case', 'The lab worker in Irkutsk died last week'), ['Irkutsk']);
  assert.deepEqual(names('Boat from Djibouti to Yemen capsizes', 'NAIROBI, Kenya (AP) — At least 139 migrants died'), ['Djibouti', 'Yemen']);
  // A capital in a summary usually means the government
  assert.deepEqual(names('Russia interfered in Brexit vote, says Burnham', 'Moscow denies the claim'), ['Russia']);
});

test('actor words place a story only when nothing more specific does', () => {
  assert.deepEqual(names('Indian national dies after Riyadh airport attack'), ['Riyadh']);
  assert.deepEqual(names('Putin hosts Schroder at home on his birthday — Kremlin'), ['Russia']);
  assert.deepEqual(names('Israeli strikes kill 12 across the enclave', 'Strikes hit Khan Younis and Gaza City overnight'), ['Khan Younis', 'Gaza City']);
  // A nationality in the summary alone doesn't place a story abroad
  assert.deepEqual(names('Pair bailed after security breach at RAF base', 'Police say the two Latvian nationals have been bailed', 'GB'), []);
});

test('the dateline is used only when nothing else places the story', () => {
  assert.deepEqual(names('Nominee vows to end politicization of investigations', 'SEOUL, Oct. 8 (Yonhap) -- The nominee to lead'), ['Seoul']);
  assert.deepEqual(names('Plague worker death still unexplained in Russia', 'GENEVA: The World Health Organization said'), ['Russia']);
});

test('reads GDELT location lists as structured places', () => {
  const s = 'Locations: Yemeni; Riyadh, Ar Riyad, Saudi Arabia; Saudi Arabia; Gaza, Israel (General), Israel · Tone -5.1';
  assert.deepEqual(names('Houthi missiles target Saudi capital', s), ['Riyadh']);
  // Of the countries an article names, the one it names most (Kenya, not Burkina Faso)
  assert.deepEqual(names('Aspirant questions rival\'s momentum', 'Locations: Nairobi, Nairobi Area, Kenya; Kenyans; Burkina Faso; Kenya · Tone -0.3'), ['Nairobi']);
  // GDELT files Gaza under Israel
  assert.deepEqual(names('Ceasefire anniversary marks year of broken promises', 'Locations: Israeli; Gaza, Israel (General), Israel · Tone -3.3'), ['Gaza Strip']);
});

test('splits hyphenated names and Arabic articles', () => {
  assert.deepEqual(names('Kharkiv hit by drones as US-Iran talks stall'), ['Kharkiv', 'United States', 'Iran']);
  assert.deepEqual(names('Explosions rock Yemen’s Al-Mukalla'), ['Mukalla']);
  assert.deepEqual(names('Forces advance toward Bab al-Mandeb'), ['Bab el-Mandeb']);
});

test('countryCode reads source group names', () => {
  assert.equal(countryCode('USA'), 'US');
  assert.equal(countryCode('UK'), 'GB');
  assert.equal(countryCode('Saudi Arabia'), 'SA');
  assert.equal(countryCode('Wires & Search'), null);
  assert.equal(countryCode(null), null);
});
