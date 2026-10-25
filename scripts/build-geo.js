'use strict';

// Builds the offline place-name gazetteer and the world map used by the Map
// view. Run once (and after editing the curated lists below):
//
//   node scripts/build-geo.js
//
// Data: GeoNames cities15000 + countryInfo (CC BY 4.0, geonames.org) and
// Natural Earth 1:50m countries / admin-1 (public domain, naturalearthdata.com).
// Outputs:
//   src/main/enrich/gazetteer.json       place list + name index
//   src/renderer/assets/world.geojson    simplified country outlines

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT_GAZ = path.join(ROOT, 'src/main/enrich/gazetteer.json');
const OUT_MAP = path.join(ROOT, 'src/renderer/assets/world.geojson');

const SRC = {
  cities:    'https://download.geonames.org/export/dump/cities15000.zip',
  countries: 'https://download.geonames.org/export/dump/countryInfo.txt',
  ne0:       'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson',
  ne1:       'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces.geojson',
};

// Countries where every town ≥15k people is included (conflict/news-heavy regions).
const DENSE = new Set(['IL', 'PS', 'LB', 'SY', 'YE', 'UA', 'IQ', 'IR', 'JO', 'SD', 'AF', 'LY', 'SO', 'RU']);
const CITY_MIN_POP = 300_000;
// A city sharing its name with a city this many times larger is dropped from that name
// (a Russian town of 47k called Donetsk never wins over the Ukrainian city).
const NAME_SHARE_RATIO = 10;

// Place names that are everyday words, brands or acronyms in English text. Never matched.
const EXCLUDE = new Set(('mobile reading split nice bath orange university college garden independence liberty union ' +
  'concord mercedes trinidad progreso esperanza providence carmel dover washington columbia sale bergen gent march may ' +
  'june august male marks brent toyota perm mesa mocha batman bimbo plast oral golfe warder buy gay tara kira kita serra ' +
  'sim terek nikel dura natal ondo singa bida gombe erode aba sabha kalyan mataram duma gusev zarya plast surman ' +
  'kelar enem fili asha').split(' '));

// Place names that are also common first names or surnames. Matched only with evidence that a
// place is meant: "in Austin", "Douglas, Georgia", or another place in the same country.
const WEAK = new Set(('vladimir anna sofia victoria austin alexandria orlando phoenix columbus kennedy douglas stanley ' +
  'lyon leon ariel farah florence lincoln jackson charlotte hamilton aurora marion clayton franklin salem santos sucre ' +
  'kirov adler murom sokol jordan chad kingston newcastle surrey wellington darwin nelson preston engels roma napoli torino kenia florencia londra').split(' '));

// Words that point at a country without placing the story there: demonyms, armed groups,
// leaders, institutions. They only place a story when nothing more specific does.
const ACTORS = {
  IL: 'Israeli|Israelis|IDF|Knesset|Netanyahu', PS: 'Palestinian|Palestinians|Hamas', LB: 'Lebanese|Hezbollah|Hizbollah',
  SY: 'Syrian|Syrians', IQ: 'Iraqi|Iraqis', IR: 'Iranian|Iranians|IRGC|Khamenei', YE: 'Yemeni|Yemenis|Houthi|Houthis|Huthi|Huthis',
  SA: 'Saudi|Saudis', AE: 'Emirati|Emiratis', QA: 'Qatari|Qataris', EG: 'Egyptian|Egyptians', JO: 'Jordanian|Jordanians',
  TR: 'Turkish|Turks|Erdogan', RU: 'Russian|Russians|Kremlin|Putin', UA: 'Ukrainian|Ukrainians|Zelensky|Zelenskyy',
  CN: 'Chinese', TW: 'Taiwanese', JP: 'Japanese', KP: 'North Korean|North Koreans|N. Korean|N. Koreans', KR: 'South Korean|South Koreans|S. Korean|S. Koreans',
  IN: 'Indian|Indians', PK: 'Pakistani|Pakistanis', AF: 'Afghan|Afghans|Taliban', GB: 'British|Briton|Britons',
  FR: 'French', DE: 'German|Germans', IT: 'Italian|Italians', ES: 'Spanish|Spaniards', PL: 'Polish|Poles',
  CA: 'Canadian|Canadians', US: 'American|Americans', MX: 'Mexican|Mexicans', BR: 'Brazilian|Brazilians',
  VE: 'Venezuelan|Venezuelans', CU: 'Cuban|Cubans', AU: 'Australian|Australians|Aussie|Aussies', SD: 'Sudanese',
  ET: 'Ethiopian|Ethiopians', SO: 'Somali|Somalis', NG: 'Nigerian|Nigerians', KE: 'Kenyan|Kenyans', LY: 'Libyan|Libyans',
  GR: 'Greek|Greeks', NL: 'Dutch', BE: 'Belgian|Belgians', CH: 'Swiss', SE: 'Swedish|Swedes', NO: 'Norwegian|Norwegians',
  DK: 'Danish|Danes', FI: 'Finnish|Finns', IE: 'Irish', PT: 'Portuguese', HU: 'Hungarian|Hungarians', RO: 'Romanian|Romanians',
  RS: 'Serbian|Serbians|Serbs', BY: 'Belarusian|Belarusians', AM: 'Armenian|Armenians', AZ: 'Azerbaijani|Azeri|Azerbaijanis',
  GE: 'Georgian|Georgians', BD: 'Bangladeshi|Bangladeshis', LK: 'Sri Lankan|Sri Lankans', MM: 'Burmese', TH: 'Thai',
  VN: 'Vietnamese', PH: 'Filipino|Filipinos|Philippine', ID: 'Indonesian|Indonesians', MY: 'Malaysian|Malaysians',
  NZ: 'New Zealander|New Zealanders', ZA: 'South African|South Africans', CD: 'Congolese', HT: 'Haitian|Haitians',
  CO: 'Colombian|Colombians', AR: 'Argentine|Argentinian|Argentinians', CL: 'Chilean|Chileans', PE: 'Peruvian|Peruvians',
  KZ: 'Kazakh|Kazakhs', EE: 'Estonian|Estonians', LV: 'Latvian|Latvians', LT: 'Lithuanian|Lithuanians', IS: 'Icelandic|Icelanders',
  NP: 'Nepali|Nepalese', NA: 'Namibian|Namibians', MN: 'Mongolian|Mongolians', OM: 'Omani|Omanis', KW: 'Kuwaiti|Kuwaitis',
  BH: 'Bahraini|Bahrainis', DZ: 'Algerian|Algerians', MA: 'Moroccan|Moroccans', TN: 'Tunisian|Tunisians',
};

// Extra names for countries (beyond Natural Earth / GeoNames names). These place a story.
const COUNTRY_ALIASES = {
  US: 'United States|United States of America|US|U.S.|USA|U.S.A.|America', GB: 'United Kingdom|Great Britain|Britain|UK|U.K.',
  KR: 'South Korea|Republic of Korea|S Korea|S. Korea', KP: 'North Korea|N Korea|N. Korea|DPRK', RU: 'Russia|Russian Federation',
  CZ: 'Czech Republic|Czechia', CD: 'DR Congo|DRC|Democratic Republic of Congo', CG: 'Republic of Congo',
  CI: 'Ivory Coast|Côte d\'Ivoire', MM: 'Myanmar|Burma', TR: 'Turkey|Türkiye', VA: 'Vatican|Holy See', SY: 'Syria', IR: 'Iran|Islamic Republic of Iran',
  LA: 'Laos', MD: 'Moldova', TZ: 'Tanzania', BO: 'Bolivia', VE: 'Venezuela', VN: 'Vietnam', PS: 'Palestine',
  MK: 'North Macedonia', SZ: 'Eswatini', TL: 'East Timor|Timor-Leste', CV: 'Cape Verde', BA: 'Bosnia|Bosnia and Herzegovina',
  AE: 'UAE|Emirates', FK: 'Falklands', FO: 'Faroe Islands',
};

// Other languages' names for countries, for feeds in Spanish, Portuguese, French, Italian, German, Dutch, Slovene,
// Icelandic and Russian. Accented as written: the matcher only folds accents for names the gazetteer has unaccented.
const COUNTRY_EXONYMS = {
  US: 'Estados Unidos|EEUU|EE.UU.|EUA|États-Unis|Etats-Unis|Stati Uniti|Vereinigte Staaten|Verenigde Staten|США',
  GB: 'Reino Unido|Royaume-Uni|Regno Unito|Vereinigtes Königreich|Verenigd Koninkrijk|Gran Bretaña|Grã-Bretanha|Grande-Bretagne',
  DE: 'Alemania|Alemanha|Allemagne|Germania|Deutschland|Duitsland|Nemčija|Nemčiji|Германия|Германии',
  FR: 'Francia|França|Frankreich|Frankrijk|Francija|Franciji|Франция|Франции',
  IT: 'Italia|Itália|Italie|Italien|Italië|Italija|Italiji', ES: 'España|Espanha|Espagne|Spagna|Spanien|Spanje|Španija|Španiji|Испания',
  BR: 'Brasil|Brésil|Brasile|Brasilien|Brazilië', NL: 'Países Bajos|Países Baixos|Pays-Bas|Paesi Bassi|Niederlande|Nederland|Holanda',
  BE: 'Bélgica|Belgique|Belgio|Belgien|België', CH: 'Suiza|Suíça|Suisse|Svizzera|Schweiz|Zwitserland|Švica',
  AT: 'Österreich|Autriche|Áustria|Oostenrijk|Avstrija|Avstriji', SE: 'Suecia|Suécia|Suède|Svezia|Schweden|Zweden',
  NO: 'Noruega|Norvège|Norvegia|Norwegen|Noorwegen', DK: 'Dinamarca|Danemark|Danimarca|Dänemark|Denemarken',
  FI: 'Finlandia|Finlândia|Finlande|Finnland', PL: 'Polonia|Polônia|Polónia|Pologne|Polen|Poljska|Poljski',
  GR: 'Grecia|Grécia|Grèce|Griechenland|Griekenland|Grčija', TR: 'Turquía|Turquia|Turquie|Turchia|Türkei|Turkije|Turčija|Турция',
  HU: 'Hungría|Hungria|Hongrie|Ungheria|Ungarn|Hongarije|Madžarska', RO: 'Rumania|Rumanía|Romênia|Roménia|Roumanie|Rumänien',
  CZ: 'Chequia|República Checa|República Tcheca|Tchéquie|Tschechien|Tsjechië|Češka', HR: 'Croacia|Croácia|Croatie|Kroatien|Kroatië|Hrvaška|Hrvaški',
  RS: 'Serbie|Serbien|Servië|Srbija|Srbiji', SI: 'Eslovenia|Eslovênia|Slovénie|Slowenien|Slovenija|Sloveniji|Slovenije',
  SK: 'Eslovaquia|Eslováquia|Slovaquie|Slowakei|Slovaška', IE: 'Irlanda|Irlande|Irland|Ierland', IS: 'Islandia|Islândia|Islande|Ísland|Íslandi|Íslands',
  RU: 'Rusia|Rússia|Russie|Russland|Rusland|Rusija|Rusiji|Россия|России|Россию', UA: 'Ucrania|Ucrânia|Ucraina|Oekraïne|Ukrajina|Ukrajini|Украина|Украины|Украине|Украину',
  BY: 'Bielorrusia|Bielorrússia|Biélorussie|Weißrussland|Belarús', GE: 'Géorgie',
  EG: 'Egipto|Egito|Égypte|Egitto|Ägypten|Egypte', MA: 'Marruecos|Marrocos|Maroc|Marocco|Marokko', DZ: 'Argelia|Argélia|Algérie|Algerien',
  TN: 'Túnez|Tunísia|Tunisie', LY: 'Libia|Líbia|Libye|Libyen', ZA: 'Sudáfrica|África do Sul|Afrique du Sud|Sudafrica|Südafrika|Zuid-Afrika',
  ET: 'Etiopía|Etiópia|Éthiopie|Äthiopien', KE: 'Kenia|Quênia|Quénia', CM: 'Camerún|Camarões|Cameroun|Kamerun',
  CI: 'Costa de Marfil|Costa do Marfim', CD: 'República Democrática del Congo|República Democrática do Congo|RDC',
  SA: 'Arabia Saudita|Arabia Saudí|Arábia Saudita|Arabie saoudite|Arabie Saoudite|Saudi-Arabien',
  AE: 'Emiratos Árabes Unidos|Emirados Árabes Unidos|Émirats arabes unis|EAU', QA: 'Catar', IQ: 'Irak|Iraque',
  SY: 'Siria|Síria|Syrie|Syrien', LB: 'Líbano|Liban|Libano|Libanon', JO: 'Jordania|Jordânia|Jordanie|Jordanien',
  YE: 'Iémen|Iêmen|Yémen|Jemen', IL: 'Israël|Израиль|Израиля', IR: 'Irã|Иран', PS: 'Palestina',
  AF: 'Afganistán|Afeganistão', PK: 'Pakistán|Paquistão', IN: 'Inde|Indien|Индия', CN: 'Chine|Cina|Китай|Китая',
  JP: 'Japón|Japão|Japon|Giappone|Japonska|Японии|Япония', KR: 'Corea del Sur|Coreia do Sul|Corée du Sud|Corea del Sud|Südkorea|Zuid-Korea',
  KP: 'Corea del Norte|Coreia do Norte|Corée du Nord|Corea del Nord|Nordkorea|Noord-Korea', TH: 'Tailandia|Tailândia|Thaïlande',
  PH: 'Filipinas', MY: 'Malasia|Malásia|Malaisie', VN: 'Vietnã', NZ: 'Nueva Zelanda|Nova Zelândia|Nouvelle-Zélande|Neuseeland',
  DO: 'República Dominicana|République dominicaine', PY: 'Paraguai', EC: 'Equador', GL: 'Groenlandia|Groenlândia|Groenland|Grönland',
  VA: 'Vaticano|Ciudad del Vaticano|Cidade do Vaticano', CY: 'Chipre|Chypre',
};

// Display names for countries whose Natural Earth name reads oddly in a list.
const COUNTRY_DISPLAY = { FK: 'Falkland Islands', FO: 'Faroe Islands', SZ: 'Eswatini', MO: 'Macau', BL: 'Saint Barthélemy', MF: 'Saint Martin' };

// Named regions without a single city. Country '' = spans several countries: it gives no
// country context and never replaces a country.
const REGIONS = [
  ['Gaza Strip', 'PS', 31.42, 34.37, 'Gaza|Gazan|Gazans'], ['West Bank', 'PS', 31.95, 35.25], ['Golan Heights', 'SY', 33.0, 35.75, 'Golan'],
  ['Sinai', 'EG', 29.5, 33.8], ['Crimea', 'UA', 45.3, 34.1], ['Donbas', 'UA', 48.0, 38.0, 'Donbass'],
  ['Kashmir', 'IN', 34.1, 75.3], ['Strait of Hormuz', '', 26.57, 56.25, 'Hormuz'], ['Red Sea', '', 18.0, 39.5],
  ['Black Sea', '', 43.4, 34.0], ['Persian Gulf', '', 27.0, 51.5, 'Arabian Gulf'], ['Gulf of Oman', '', 24.5, 58.5],
  ['South China Sea', '', 12.0, 114.0], ['Taiwan Strait', '', 24.5, 119.5], ['Gulf of Aden', '', 12.5, 48.0],
  ['Bab el-Mandeb', '', 12.6, 43.4, 'Bab al-Mandab|Bab al-Mandeb'], ['Darfur', 'SD', 13.5, 24.0], ['Sahel', '', 15.0, 2.0],
  ['Kurdistan', '', 36.4, 44.0, 'Kurdish'], ['Balochistan', 'PK', 28.5, 65.0, 'Baluchistan'], ['Siberia', 'RU', 60.0, 100.0],
  ['Nagorno-Karabakh', 'AZ', 39.8, 46.75, 'Karabakh'], ['Transnistria', 'MD', 47.2, 29.4], ['Kursk Oblast', 'RU', 51.7, 36.2],
  ['Arctic', '', 78.0, 15.0], ['Middle East', '', 29.0, 41.0, 'Mideast|West Asia'], ['Tigray', 'ET', 14.0, 39.0],
  ['Northern Ireland', 'GB', 54.6, -6.7], ['Scotland', 'GB', 56.5, -4.2, 'Scottish'], ['Wales', 'GB', 52.3, -3.7, 'Welsh'],
  ['England', 'GB', 52.6, -1.5], ['Khyber Pakhtunkhwa', 'PK', 34.5, 72.0],
];

// States and provinces (Natural Earth admin-1) for these countries. Extra names: NE name -> aliases.
const STATE_COUNTRIES = ['US', 'CA', 'AU', 'IN', 'CN'];
const STATE_ALIASES = {
  Xizang: 'Tibet', 'Inner Mongol': 'Inner Mongolia', Odisha: 'Orissa', 'British Columbia': 'B.C.',
  'New Mexico': 'Nuevo México|Novo México|Nouveau-Mexique', 'New Jersey': 'Nueva Jersey|Nova Jersey', Hawaii: 'Hawái|Havaí',
  'North Carolina': 'Carolina del Norte|Carolina do Norte', 'South Carolina': 'Carolina del Sur|Carolina do Sul',
  Louisiana: 'Luisiana', Pennsylvania: 'Pensilvania|Pensilvânia|Pennsylvanie',
};
const STATE_DISPLAY = { Xizang: 'Tibet', 'Inner Mongol': 'Inner Mongolia' };

// Landmarks that stand for a city in headlines: name -> [city ascii name, country].
const LANDMARKS = {
  'White House': ['Washington', 'US'], 'Capitol Hill': ['Washington', 'US'], 'Pentagon': ['Washington', 'US'],
  'Downing Street': ['London', 'GB'], 'Westminster': ['London', 'GB'], 'Whitehall': ['London', 'GB'],
  'Elysee': ['Paris', 'FR'], 'Élysée': ['Paris', 'FR'], 'Wall Street': ['New York City', 'US'], 'Times Square': ['New York City', 'US'],
  'Ben Gurion': ['Tel Aviv', 'IL'], 'King Khalid International': ['Riyadh', 'SA'],
};

// News spellings for cities, mapped to their GeoNames ascii name + country. The first alias of a
// city becomes its display name, so list the spelling to show first.
const CITY_ALIASES = [
  ['Kyiv', 'Kyiv', 'UA'], ['Kiev', 'Kyiv', 'UA'], ['Odesa', 'Odesa', 'UA'], ['Odessa', 'Odesa', 'UA'],
  ['Kharkiv', 'Kharkiv', 'UA'], ['Kharkov', 'Kharkiv', 'UA'], ['Zaporizhzhia', 'Zaporizhzhya', 'UA'], ['Zaporizhia', 'Zaporizhzhya', 'UA'],
  ['Zaporozhye', 'Zaporizhzhya', 'UA'], ['Mykolaiv', 'Mykolayiv', 'UA'], ['Nikolaev', 'Mykolayiv', 'UA'], ['Dnipro', 'Dnipro', 'UA'],
  ['Lviv', 'Lviv', 'UA'], ['Lvov', 'Lviv', 'UA'], ['Luhansk', 'Luhansk', 'UA'], ['Lugansk', 'Luhansk', 'UA'],
  ['Sloviansk', 'Slovyansk', 'UA'], ['Kostiantynivka', 'Kostyantynivka', 'UA'], ['Kupiansk', 'Kupyansk', 'UA'],
  ['Dobropillia', 'Dobropillya', 'UA'], ['Kryvyi Rih', 'Kryvyy Rih', 'UA'], ['Izium', 'Izyum', 'UA'], ['Vinnytsia', 'Vinnytsya', 'UA'],
  ['Berdiansk', 'Berdyansk', 'UA'], ['Feodosia', 'Feodosiya', 'UA'], ['Izmail', 'Izmayil', 'UA'], ['Kamianske', 'Kamyanske', 'UA'],
  ['Pervomaisk', 'Pervomaysk', 'UA'], ['Makiivka', 'Makiyivka', 'UA'], ['Avdiivka', 'Avdiyivka', 'UA'],
  ['Sievierodonetsk', 'Siverskodonetsk', 'UA'], ['Severodonetsk', 'Siverskodonetsk', 'UA'],
  ['Ryazan', "Ryazan'", 'RU'], ['Almetyevsk', "Al'met'yevsk", 'RU'],
  ['Khan Younis', 'Khan Yunis', 'PS'], ['Gaza City', 'Gaza', 'PS'], ['Deir el-Balah', 'Dayr al Balah', 'PS'], ['Jabalia', 'Jabalya', 'PS'],
  ['Beit Lahia', 'Bayt Lahya', 'PS'], ['Nuseirat', 'An Nusayrat', 'PS'], ['Tel Aviv', 'Tel Aviv', 'IL'], ['Jerusalem', 'Jerusalem', 'IL'],
  ["Be'er Sheva", 'Beersheba', 'IL'], ['Sanaa', 'Sanaa', 'YE'], ["Sana'a", 'Sanaa', 'YE'], ['Hodeidah', 'Al Hudaydah', 'YE'],
  ['Hudaydah', 'Al Hudaydah', 'YE'], ['Marib', "Ma'rib", 'YE'],
  ['Mecca', 'Makkah', 'SA'], ['Makkah', 'Makkah', 'SA'], ['Medina', 'Madinah', 'SA'], ['Madinah', 'Madinah', 'SA'],
  ['Riyadh', 'Riyadh', 'SA'], ['Riyad', 'Riyadh', 'SA'], ['Riad', 'Riyadh', 'SA'], ['Beijing', 'Beijing', 'CN'], ['Peking', 'Beijing', 'CN'],
  ['Urumqi', 'UEruemqi', 'CN'], ['New Delhi', 'New Delhi', 'IN'], ['Washington DC', 'Washington', 'US'], ['Washington D.C.', 'Washington', 'US'],
  ['Washington', 'Washington', 'US'], ['New York', 'New York City', 'US'], ['NYC', 'New York City', 'US'], ['LA', 'Los Angeles', 'US'],
  ['Mumbai', 'Mumbai', 'IN'], ['Bombay', 'Mumbai', 'IN'], ['Kolkata', 'Kolkata', 'IN'], ['Calcutta', 'Kolkata', 'IN'],
  ['Chennai', 'Chennai', 'IN'], ['Madras', 'Chennai', 'IN'], ['Bengaluru', 'Bengaluru', 'IN'], ['Bangalore', 'Bengaluru', 'IN'],
  ['Visakhapatnam', 'Visakhapatnam', 'IN'], ['Vizag', 'Visakhapatnam', 'IN'], ['Vadodara', 'Vadodara', 'IN'], ['Baroda', 'Vadodara', 'IN'],
  ['Thiruvananthapuram', 'Thiruvananthapuram', 'IN'], ['Trivandrum', 'Thiruvananthapuram', 'IN'], ['Gurugram', 'Gurugram', 'IN'], ['Gurgaon', 'Gurugram', 'IN'],
  ['Mysuru', 'Mysuru', 'IN'], ['Mysore', 'Mysuru', 'IN'], ['Kozhikode', 'Kozhikode', 'IN'], ['Calicut', 'Kozhikode', 'IN'],
  ['Pune', 'Pune', 'IN'], ['Poona', 'Pune', 'IN'], ['Varanasi', 'Varanasi', 'IN'], ['Benares', 'Varanasi', 'IN'],
  ['Chittagong', 'Chattogram', 'BD'], ['Dhaka', 'Dhaka', 'BD'], ['Dacca', 'Dhaka', 'BD'],
  ['Tyre', 'Tyre', 'LB'], ['Sidon', 'Sidon', 'LB'], ['Nabatieh', 'Nabatiye et Tahta', 'LB'], ['Baalbek', 'Baalbek', 'LB'],
  ['Aleppo', 'Aleppo', 'SY'], ['Idlib', 'Idlib', 'SY'], ['Homs', 'Homs', 'SY'], ['Hama', 'Hamah', 'SY'], ['Daraa', "Dar'a", 'SY'],
  ['Latakia', 'Latakia', 'SY'], ['Raqqa', 'Ar Raqqah', 'SY'], ['Deir ez-Zor', 'Deir ez-Zor', 'SY'], ['Deir al-Zor', 'Deir ez-Zor', 'SY'],
  ['Douma', 'Duma', 'SY'],
  ['Mosul', 'Mosul', 'IQ'], ['Erbil', 'Erbil', 'IQ'], ['Irbil', 'Erbil', 'IQ'], ['Basra', 'Basrah', 'IQ'],
  ['Isfahan', 'Isfahan', 'IR'], ['Esfahan', 'Isfahan', 'IR'], ['Tabriz', 'Tabriz', 'IR'], ['Ahvaz', 'Ahvaz', 'IR'], ['Ahwaz', 'Ahvaz', 'IR'],
  ['Bandar Abbas', 'Bandar Abbas', 'IR'], ['Natanz', 'Natanz', 'IR'], ['Fordow', 'Qom', 'IR'], ['El Fasher', 'El Fasher', 'SD'],
  ['Port Sudan', 'Port Sudan', 'SD'], ['Khartoum', 'Khartoum', 'SD'], ['Tripoli', 'Tripoli', 'LY'], ['Benghazi', 'Benghazi', 'LY'],
  ['Cologne', 'Koeln', 'DE'], ['Munich', 'Munich', 'DE'], ['Nuremberg', 'Nuremberg', 'DE'], ['Malmö', 'Malmoe', 'SE'], ['Malmo', 'Malmoe', 'SE'],
  ['Ho Chi Minh City', 'Ho Chi Minh City', 'VN'], ['Saigon', 'Ho Chi Minh City', 'VN'], ['Yangon', 'Yangon', 'MM'], ['Rangoon', 'Yangon', 'MM'],
  ['Busan', 'Busan', 'KR'], ['Pusan', 'Busan', 'KR'], ['St Petersburg', 'Saint Petersburg', 'RU'], ['St. Petersburg', 'Saint Petersburg', 'RU'],
  ['Rostov-on-Don', 'Rostov-on-Don', 'RU'], ['Rostov', 'Rostov-on-Don', 'RU'], ['Nizhny Novgorod', 'Nizhniy Novgorod', 'RU'],
  ['Mexico City', 'Mexico City', 'MX'], ['CDMX', 'Mexico City', 'MX'], ['Rio de Janeiro', 'Rio de Janeiro', 'BR'], ['Rio', 'Rio de Janeiro', 'BR'],
  ['Kathmandu', 'Kathmandu', 'NP'], ['Katmandu', 'Kathmandu', 'NP'], ['The Bronx', 'The Bronx', 'US'], ['Bronx', 'The Bronx', 'US'],
  ['Johannesburg', 'Johannesburg', 'ZA'], ['Joburg', 'Johannesburg', 'ZA'], ['Philadelphia', 'Philadelphia', 'US'], ['Philly', 'Philadelphia', 'US'],
];

// Other languages' names for cities: "ascii name|country" -> names. Unlike CITY_ALIASES they don't rename the city.
const CITY_EXONYMS = {
  'New York City|US': 'Nueva York|Nova York|Nova Iorque', 'London|GB': 'Londres|Londra',
  'Moscow|RU': 'Moscú|Moscou|Mosca|Moskau|Moskou|Moskva|Москва|Москве|Москвы', 'Beijing|CN': 'Pekín|Pequim|Pékin|Pechino',
  'Tokyo|JP': 'Tokio|Tóquio', 'New Delhi|IN': 'Nueva Delhi|Nova Délhi|Nova Deli', 'Brussels|BE': 'Bruselas|Bruxelas|Bruxelles|Brüssel|Bruxelles-Capitale',
  'Vienna|AT': 'Viena|Wien', 'Athens|GR': 'Atenas|Athènes|Atene|Athen',
  'Warsaw|PL': 'Varsovia|Varsóvia|Varsovie|Warschau', 'Prague|CZ': 'Praga|Prag', 'Stockholm|SE': 'Estocolmo',
  'Copenhagen|DK': 'Copenhague|Kopenhagen', 'Lisbon|PT': 'Lisboa|Lisbonne|Lissabon', 'Milan|IT': 'Milán|Milão|Milano|Mailand',
  'Naples|IT': 'Nápoles|Napoli|Neapel', 'Florence|IT': 'Florencia|Florença|Firenze|Florenz',
  'Turin|IT': 'Turín|Turim', 'Rome|IT': 'Roma', 'Munich|DE': 'Múnich|Munique|München|Monaco di Baviera', 'Koeln|DE': 'Köln',
  'Istanbul|TR': 'Estambul|Istambul|İstanbul', 'Cairo|EG': 'El Cairo|Le Caire|Il Cairo', 'Jerusalem|IL': 'Jerusalén|Jerusalém|Jérusalem|Gerusalemme',
  'Tehran|IR': 'Teherán|Teerã|Téhéran|Teheran|Тегеран', 'Baghdad|IQ': 'Bagdad|Bagdá', 'Damascus|SY': 'Damasco', 'Beirut|LB': 'Beyrouth',
  'Kyiv|UA': 'Kiev|Kiew|Kijev|Kijevu|Киев|Киева|Киеве|Київ', 'Krakow|PL': 'Cracovia|Cracóvia|Cracovie|Kraków', 'Edinburgh|GB': 'Edimburgo',
  'Mexico City|MX': 'Ciudad de México|Cidade do México', 'Guatemala City|GT': 'Ciudad de Guatemala', 'Panama City|PA': 'Ciudad de Panamá',
  'New Orleans|US': 'Nueva Orleans|Nova Orleans|La Nouvelle-Orléans', 'Philadelphia|US': 'Filadelfia|Filadélfia',
  'Saint Petersburg|RU': 'San Petersburgo|São Petersburgo|Saint-Pétersbourg|San Pietroburgo|Sankt Petersburg|Петербург|Петербурге',
  'Cape Town|ZA': 'Ciudad del Cabo|Cidade do Cabo', 'Havana|CU': 'La Habana|Habana|Havane|L\'Avana', 'Sevilla|ES': 'Sevilla|Sevilha|Séville',
  'Zaragoza|ES': 'Saragossa|Saragosse', 'Barcelona|ES': 'Barcelone', 'Marseille|FR': 'Marsella|Marselha|Marsiglia',
  'Hamburg|DE': 'Hambourg|Amburgo', 'Berlin|DE': 'Berlino', 'Paris|FR': 'Parigi', 'Ljubljana|SI': 'Ljubljani|Ljubljane|Liubliana',
  'Reykjavik|IS': 'Reykjavík|Reykjavíkur', 'Bucharest|RO': 'Bucarest|Bucareste|București', 'Budapest|HU': 'Budapeste',
  'The Hague|NL': 'La Haya|Haia|La Haye|Den Haag|L\'Aia', 'Antwerp|BE': 'Amberes|Antuérpia|Anvers|Antwerpen',
};

// helpers

async function download(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Polyopticon build-geo' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function unzipEntry(buf, name) {
  // Walk the central directory to find the entry.
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  const n = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const fnLen = buf.readUInt16LE(p + 28), exLen = buf.readUInt16LE(p + 30), cmLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const fname = buf.toString('utf8', p + 46, p + 46 + fnLen);
    if (fname === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + fnLen + exLen + cmLen;
  }
  throw new Error(`${name} not in zip`);
}

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

// build

(async () => {
  console.log('Downloading…');
  const [citiesZip, countryInfo, ne0Buf, ne1Buf] = await Promise.all(Object.values(SRC).map(download));
  const ne0 = JSON.parse(ne0Buf), ne1 = JSON.parse(ne1Buf);

  const places = [];          // [key, name, kind, cc, lat, lon, pop?]
  const index = new Map();    // lower name -> Set(place index): names that place a story
  const actors = new Map();   // lower name -> country index: words that only point at a country
  const norm = name => name.trim().toLowerCase().replace(/’/g, "'");
  const addName = (name, idx, map = index) => {
    const k = norm(name);
    if (k.length < 2) return;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(idx);
  };
  const addPlace = (key, name, kind, cc, lat, lon) => { places.push([key, name, kind, cc, round(lat), round(lon)]); return places.length - 1; };

  // Countries (coords: Natural Earth label point). A dependency can carry its sovereign's code as
  // ISO_A2_EH (Ashmore and Cartier Islands -> AU), so a feature with its own ISO_A2 always wins.
  const neByIso = new Map();
  for (const f of ne0.features) {
    const p = f.properties;
    const own = p.ISO_A2 !== '-99';
    const iso = own ? p.ISO_A2 : p.ISO_A2_EH;
    if (!iso || iso === '-99') continue;
    const prev = neByIso.get(iso);
    if (!prev || (own && !prev.own) || (own === prev.own && p.TYPE !== 'Dependency' && prev.p.TYPE === 'Dependency')) neByIso.set(iso, { p, own });
  }
  const countryIdx = new Map();
  for (const line of countryInfo.toString('utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const c = line.split('\t');
    const iso = c[0], name = c[4];
    const ne = neByIso.get(iso)?.p;
    if (!ne) continue;
    const display = COUNTRY_DISPLAY[iso] ?? (iso === 'US' ? 'United States' : ne.NAME && !ne.NAME.includes('.') ? ne.NAME : ne.NAME_LONG || name);
    const idx = addPlace(`c:${iso}`, display, 'country', iso, ne.LABEL_Y, ne.LABEL_X);
    countryIdx.set(iso, idx);
    for (const n of new Set([name, ne.NAME, ne.NAME_LONG, ne.ADMIN, ne.NAME_EN, display].filter(Boolean))) if (!n.includes('.')) addName(n, idx);
    for (const n of `${COUNTRY_ALIASES[iso] || ''}|${COUNTRY_EXONYMS[iso] || ''}`.split('|').filter(Boolean)) addName(n, idx);
  }
  for (const [iso, words] of Object.entries(ACTORS))
    if (countryIdx.has(iso)) for (const w of words.split('|')) addName(w, countryIdx.get(iso), actors);

  // Regions (skipped where a country of that name exists, e.g. Hong Kong, Greenland)
  for (const [name, cc, lat, lon, aliases] of REGIONS) {
    if (index.has(norm(name))) { console.warn(`  region "${name}" is already a country`); continue; }
    const idx = addPlace(`r:${name.toLowerCase().replace(/\W+/g, '-')}`, name, 'region', cc, lat, lon);
    addName(name, idx);
    for (const a of (aliases || '').split('|').filter(Boolean)) addName(a, idx);
  }

  // Cities
  const cityTxt = unzipEntry(citiesZip, 'cities15000.txt').toString('utf8');
  const cityByKey = new Map();   // "ascii|cc" -> idx
  const cityNames = new Set();   // "lower name|cc", to skip states named after their capital (Delhi, Beijing)
  let nCities = 0;
  const rows = [];
  for (const line of cityTxt.split('\n')) {
    if (!line) continue;
    const c = line.split('\t');
    const row = { gid: c[0], name: c[1], ascii: c[2], lat: +c[4], lon: +c[5], fcode: c[7], cc: c[8], pop: +c[14] };
    if (row.fcode === 'PPLC' || row.pop >= CITY_MIN_POP || DENSE.has(row.cc)) rows.push(row);
  }
  // Only the official and ASCII names. GeoNames' alternate names are mostly other languages'
  // spellings (Sam = Damascus, Part = Perth, Philadelphia = Amman); news spellings are in CITY_ALIASES.
  const addCityNames = (row, idx, capital) => {
    for (const n of new Set([row.name, row.ascii])) {
      if (EXCLUDE.has(norm(n))) continue;
      if (n.length < 4 && !capital && row.pop < 1_000_000) continue;
      addName(n, idx);
      cityNames.add(`${norm(n)}|${row.cc}`);
    }
  };
  const districts = rows.filter(r => r.fcode === 'PPLX');
  for (const row of rows) {
    if (row.fcode === 'PPLX') continue;
    const capital = row.fcode === 'PPLC';
    const idx = addPlace(`g:${row.gid}`, row.ascii || row.name, capital ? 'capital' : 'city', row.cc, row.lat, row.lon);   // ASCII reads better in English UI
    places[idx].push(row.pop);
    cityByKey.set(`${row.ascii.toLowerCase()}|${row.cc}`, idx);
    nCities++;
    addCityNames(row, idx, capital);
  }
  // City districts (Brooklyn, Podilskyi, Shinjuku) stand for the larger city they're part of.
  // A district name several cities have (most Ukrainian cities have a Shevchenkivskyi) is dropped.
  const km = (a, b) => Math.hypot(a.lat - b[4], (a.lon - b[5]) * Math.cos(a.lat * Math.PI / 180)) * 111;
  const districtParents = new Map();   // lower name -> Set(parent idx)
  let nDistricts = 0;
  for (const row of districts) {
    let parent = null;
    for (let i = 0; i < places.length; i++) {
      const p = places[i];
      if (p[3] !== row.cc || p[6] == null || p[6] <= row.pop || km(row, p) > 30) continue;
      if (parent == null || p[6] > places[parent][6]) parent = i;
    }
    if (parent == null) {
      const idx = addPlace(`g:${row.gid}`, row.ascii || row.name, 'city', row.cc, row.lat, row.lon);
      places[idx].push(row.pop);
      addCityNames(row, idx, false);
    } else {
      addCityNames(row, parent, false);
      for (const n of [row.name, row.ascii]) {
        if (!districtParents.has(norm(n))) districtParents.set(norm(n), new Set());
        districtParents.get(norm(n)).add(parent);
      }
      nDistricts++;
    }
  }
  for (const [k, parents] of districtParents) if (parents.size > 1) for (const p of parents) index.get(k)?.delete(p);
  console.log(`  ${nDistricts} city districts folded into their city`);

  // A name shared by several cities keeps only those within NAME_SHARE_RATIO of the largest.
  for (const [k, set] of index) {
    const cities = [...set].filter(i => places[i][6] != null);
    if (cities.length < 2) continue;
    const top = Math.max(...cities.map(i => places[i][6]));
    for (const i of cities) if (places[i][6] * NAME_SHARE_RATIO < top) set.delete(i);
  }

  // States and provinces
  for (const f of ne1.features) {
    const p = f.properties;
    if (!STATE_COUNTRIES.includes(p.iso_a2) || p.latitude == null) continue;
    if (cityNames.has(`${norm(p.name)}|${p.iso_a2}`)) continue;
    const idx = addPlace(`a:${p.iso_3166_2}`, STATE_DISPLAY[p.name] ?? p.name, 'state', p.iso_a2, p.latitude, p.longitude);
    addName(p.name, idx);
    for (const a of (STATE_ALIASES[p.name] || '').split('|').filter(Boolean)) addName(a, idx);
  }

  const aliasNamed = new Set();
  for (const [alias, ascii, cc] of CITY_ALIASES) {
    const idx = cityByKey.get(`${ascii.toLowerCase()}|${cc}`);
    if (idx == null) { console.warn(`  alias "${alias}": no city "${ascii}" in ${cc}`); continue; }
    if (!aliasNamed.has(idx) && alias.length > 3) { places[idx][1] = alias; aliasNamed.add(idx); }   // first alias = display name (news spelling)
    index.delete(norm(alias));              // the alias is authoritative
    addName(alias, idx);
  }
  for (const [city, names] of Object.entries(CITY_EXONYMS)) {
    const [ascii, cc] = city.split('|');
    const idx = cityByKey.get(`${ascii.toLowerCase()}|${cc}`);
    if (idx == null) { console.warn(`  exonyms: no city "${city}"`); continue; }
    for (const n of names.split('|')) { index.delete(norm(n)); addName(n, idx); }
  }
  for (const [mark, [cityName, cc]] of Object.entries(LANDMARKS)) {
    const idx = cityByKey.get(`${cityName.toLowerCase()}|${cc}`);
    if (idx == null) { console.warn(`  landmark "${mark}": no city "${cityName}" in ${cc}`); continue; }
    index.delete(norm(mark));
    addName(mark, idx);
  }

  const out = map => Object.fromEntries([...map].filter(([, v]) => v.size).map(([k, v]) => [k, [...v]]));
  const gaz = {
    built: new Date().toISOString().slice(0, 10), places, index: out(index), actors: out(actors),
    weak: [...WEAK].filter(w => index.has(w)),
  };
  fs.writeFileSync(OUT_GAZ, JSON.stringify(gaz));
  console.log(`Gazetteer: ${places.length} places (${nCities} cities), ${index.size} names, ${actors.size} actor words -> ${(fs.statSync(OUT_GAZ).size / 1024).toFixed(0)} KB`);

  // World map: 1:50m countries, 2-decimal coordinates, minimal properties.
  const roundCoords = c => (typeof c[0] === 'number' ? [round(c[0], 2), round(c[1], 2)] : c.map(roundCoords));
  const world = {
    type: 'FeatureCollection',
    features: ne0.features.map(f => ({
      type: 'Feature',
      properties: { name: f.properties.NAME, iso: f.properties.ISO_A2 !== '-99' ? f.properties.ISO_A2 : f.properties.ISO_A2_EH },
      geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) },
    })),
  };
  fs.writeFileSync(OUT_MAP, JSON.stringify(world));
  console.log(`World map: ${world.features.length} countries -> ${(fs.statSync(OUT_MAP).size / 1024).toFixed(0)} KB`);
})().catch(e => { console.error(e); process.exit(1); });
