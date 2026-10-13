'use strict';

// Sources written to the database on first run. After that, sources are
// managed in Settings -> Sources and live in the `sources` table.

const rss = (name, category, url, color) => ({ type: 'rss', name, category, color, config: { url } });

// Country groups, in sidebar order (regions roughly west -> east). `since: 2`
// marks sources added after the first release: they're added once to existing
// databases too (unless a source with the same name is already there).
const SEED_GROUPS = [
  {
    grp: 'USA',
    sources: [
      rss('NBC News',   'US', 'https://feeds.nbcnews.com/nbcnews/public/news', '#1565C0'),
      rss('ABC News',   'US', 'https://abcnews.go.com/abcnews/topstories', '#A93226'),
      rss('NYT',        'US', 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', '#2C3E50'),
      rss('NPR',        'US', 'https://feeds.npr.org/1001/rss.xml', '#2471A3'),
      rss('PBS',        'US', 'https://www.pbs.org/newshour/feeds/rss/headlines', '#145A32'),
      rss('NBC World',  'US', 'https://feeds.nbcnews.com/nbcnews/public/world', '#1A6BA0'),
      rss('Al-Monitor', 'US', 'https://www.al-monitor.com/rss', '#7E5109'),
      // Archive of Donald Trump's Truth Social posts; untitled reposts are titled from their text (rss.js itemTitle).
      // NYT section feeds (since 11).
      { ...rss('NYT US',       'US', 'https://rss.nytimes.com/services/xml/rss/nyt/US.xml', '#34495E'), since: 11 },
      { ...rss('NYT Politics', 'US', 'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml', '#3D566E'), since: 11 },
      { ...rss('NYT World',    'US', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', '#46627C'), since: 11 },
      { ...rss('Trump-Truth Social', 'US', 'https://www.trumpstruth.org/feed', '#8B1E2D'), since: 9 },
    ],
  },
  {
    grp: 'Canada',
    sources: [
      rss('CBC',         'CA', 'https://www.cbc.ca/webfeed/rss/rss-topstories', '#912018'),
      rss('CBC NS',      'CA', 'https://www.cbc.ca/webfeed/rss/rss-canada-novascotia', '#7D3C98'),
      { ...rss('Global News', 'CA', 'https://globalnews.ca/feed/', '#0057B8'), since: 2 },
    ],
  },
  {
    grp: 'EU',
    sources: [
      // Eurostat: euro-indicator releases and news articles (Atom).
      { ...rss('Eurostat releases', 'EU', 'https://ec.europa.eu/eurostat/en/search?p_p_id=estatsearchportlet_WAR_estatsearchportlet&p_p_lifecycle=2&p_p_state=maximized&p_p_mode=view&p_p_resource_id=atom&_estatsearchportlet_WAR_estatsearchportlet_collection=CAT_PREREL', '#003399'), since: 4 },
      { ...rss('Eurostat news',     'EU', 'https://ec.europa.eu/eurostat/en/search?p_p_id=estatsearchportlet_WAR_estatsearchportlet&p_p_lifecycle=2&p_p_state=maximized&p_p_mode=view&p_p_resource_id=atom&_estatsearchportlet_WAR_estatsearchportlet_collection=CAT_EURNEW', '#1F4E9C'), since: 4 },
      { ...rss('EU Parliament',     'EU', 'https://www.europarl.europa.eu/rss/doc/articles/en.xml', '#2E5FA8'), since: 4 },
    ],
  },
  {
    grp: 'UK',
    sources: [
      rss('BBC',             'UK', 'https://feeds.bbci.co.uk/news/rss.xml', '#B03A2E'),
      rss('Guardian',        'UK', 'https://www.theguardian.com/world/rss', '#196F3D'),
      rss('Sky News',        'UK', 'https://feeds.skynews.com/feeds/rss/world.xml', '#1A7BB2'),
      rss('Middle East Eye', 'UK', 'https://www.middleeasteye.net/rss', '#1E8449'),
    ],
  },
  {
    grp: 'France',
    sources: [
      rss('France 24', 'FR', 'https://www.france24.com/en/rss', '#8B0000'),
      { ...rss('Le Monde',    'FR', 'https://www.lemonde.fr/en/rss/une.xml', '#1F2A44'), since: 2 },
      { ...rss('RFI English', 'FR', 'https://www.rfi.fr/en/rss', '#C0392B'), since: 2 },
    ],
  },
  {
    grp: 'Germany',
    sources: [
      rss('DW', 'DE', 'https://rss.dw.com/xml/rss-en-all', '#784212'),
      { ...rss('Tagesschau', 'DE', 'https://www.tagesschau.de/index~rss2.xml', '#0B3D91'), since: 2 },   // German; translated
    ],
  },
  {
    grp: 'Ukraine',
    sources: [
      { ...rss('Kyiv Independent', 'UA', 'https://kyivindependent.com/news-archive/rss/', '#1F6FB2'), since: 2 },
      { ...rss('Ukrinform',        'UA', 'https://www.ukrinform.net/rss/block-lastnews', '#B7950B'), since: 2 },
    ],
  },
  {
    grp: 'Russia',
    sources: [
      { ...rss('TASS',         'RU', 'https://tass.com/rss/v2.xml', '#34495E'), since: 2 },
      { ...rss('Moscow Times', 'RU', 'https://www.themoscowtimes.com/rss/news', '#5D6D7E'), since: 2 },
      { ...rss('RT',           'RU', 'https://www.rt.com/rss/', '#77B300'), since: 5 },
    ],
  },
  {
    grp: 'Turkey',
    sources: [
      { ...rss('Anadolu', 'TR', 'https://www.aa.com.tr/en/rss/default?cat=guncel', '#2E86C1'), since: 2 },
    ],
  },
  {
    grp: 'Israel',
    sources: [
      rss('Times of Israel', 'IL', 'https://www.timesofisrael.com/feed/', '#154360'),
      rss('Jerusalem Post',  'IL', 'https://www.jpost.com/Rss/RssFeedsIsraelNews.aspx', '#6C3483'),
    ],
  },
  {
    grp: 'Qatar',
    sources: [
      rss('Al Jazeera', 'QA', 'https://www.aljazeera.com/xml/rss/all.xml', '#0E7C60'),
    ],
  },
  {
    grp: 'Saudi Arabia',
    sources: [
      { ...rss('Arab News', 'SA', 'https://www.arabnews.com/rss.xml', '#117A65'), since: 2 },
    ],
  },
  {
    grp: 'UAE',
    sources: [
      { ...rss('The National', 'AE', 'https://www.thenationalnews.com/arc/outboundfeeds/rss/?outputType=xml', '#7B241C'), since: 2 },
    ],
  },
  {
    grp: 'Iran',
    sources: [
      { ...rss('Iran International', 'IR', 'https://www.iranintl.com/en/feed', '#943126'), since: 2 },
    ],
  },
  {
    grp: 'Pakistan',
    sources: [
      rss('Dawn', 'PK', 'https://www.dawn.com/feeds/home', '#0B6B59'),
    ],
  },
  {
    grp: 'India',
    sources: [
      { ...rss('Times of India', 'IN', 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', '#D35400'), since: 2 },
      { ...rss('The Hindu',      'IN', 'https://www.thehindu.com/news/national/feeder/default.rss', '#1B4F72'), since: 2 },
    ],
  },
  {
    grp: 'China',
    sources: [
      { ...rss('SCMP', 'CN', 'https://www.scmp.com/rss/4/feed', '#F1C40F'), since: 2 },
      { ...rss('CGTN', 'CN', 'https://www.cgtn.com/subscribe/rss/section/world.xml', '#C0392B'), since: 2 },
      { ...rss('SCMP World',     'CN', 'https://www.scmp.com/rss/5/feed/',  '#D4AC0D'), since: 4 },
      { ...rss('SCMP Asia',      'CN', 'https://www.scmp.com/rss/3/feed/',  '#B7950B'), since: 4 },
      { ...rss('SCMP Hong Kong', 'CN', 'https://www.scmp.com/rss/2/feed/',  '#9A7D0A'), since: 4 },
      { ...rss('SCMP News',      'CN', 'https://www.scmp.com/rss/91/feed/', '#7D6608'), since: 4 },
    ],
  },
  {
    grp: 'South Korea',
    sources: [
      { ...rss('Yonhap',       'KR', 'https://en.yna.co.kr/RSS/news.xml', '#1A5276'), since: 2 },
      { ...rss('Korea Herald', 'KR', 'https://www.koreaherald.com/rss/newsAll', '#A04000'), since: 2 },
    ],
  },
  {
    grp: 'Japan',
    sources: [
      { ...rss('Japan Times', 'JP', 'https://www.japantimes.co.jp/feed/', '#922B21'), since: 2 },
      { ...rss('Japan Today', 'JP', 'https://japantoday.com/feed', '#B03A2E'), since: 2 },
    ],
  },
  {
    grp: 'Australia',
    sources: [
      { ...rss('ABC Australia', 'AU', 'https://www.abc.net.au/news/feed/2942460/rss.xml', '#196F3D'), since: 2 },
    ],
  },
  // Added in revision 6.
  { grp: 'Mexico',      sources: [{ ...rss('Mexico News Daily', 'MX', 'https://mexiconewsdaily.com/feed/', '#1E8449'), since: 6 }] },
  {
    grp: 'Iceland',
    sources: [
      { ...rss('Iceland Review', 'IS', 'https://www.icelandreview.com/feed/', '#2E86C1'), since: 6 },
      { ...rss('RÚV', 'IS', 'https://www.ruv.is/rss/frettir', '#1F618D'), since: 7 },   // Icelandic; translated
    ],
  },
  { grp: 'Syria',       sources: [{ ...rss('Syrian Observer', 'SY', 'https://syrianobserver.com/feed', '#7B7D7D'), since: 6 }] },
  {
    grp: 'Egypt',
    sources: [
      { ...rss('Egyptian Streets', 'EG', 'https://egyptianstreets.com/feed/', '#B9770E'), since: 6 },
      { ...rss('Daily News Egypt', 'EG', 'https://dailynewsegypt.com/feed/', '#922B21'), since: 6 },
    ],
  },
  {
    grp: 'Thailand',
    sources: [
      { ...rss('Bangkok Post',           'TH', 'https://www.bangkokpost.com/rss/data/thailand.xml', '#1A5276'), since: 6 },
      { ...rss('Thailand Business News', 'TH', 'https://www.thailand-business-news.com/feed', '#117864'), since: 6 },
    ],
  },
  { grp: 'Mongolia',    sources: [{ ...rss('Mongolia Focus', 'MN', 'https://mongoliafocus.com/feed/atom/', '#A93226'), since: 6 }] },
  { grp: 'Philippines', sources: [{ ...rss('Rappler', 'PH', 'https://www.rappler.com/philippines/feed/', '#D35400'), since: 6 }] },
  { grp: 'North Korea', sources: [{ ...rss('NK News', 'KP', 'https://www.nknews.org/feed/', '#5D6D7E'), since: 6 }] },
  // Added in revision 7.
  { grp: 'Uruguay',         sources: [{ ...rss('MercoPress', 'UY', 'https://en.mercopress.com/rss', '#2874A6'), since: 7 }] },
  { grp: 'Estonia',         sources: [{ ...rss('ERR News', 'EE', 'https://news.err.ee/rss', '#0072CE'), since: 7 }] },
  { grp: 'Latvia',          sources: [{ ...rss('LSM English', 'LV', 'https://eng.lsm.lv/rss/', '#9E3039'), since: 7 }] },
  { grp: 'Slovenia',        sources: [{ ...rss('RTV SLO', 'SI', 'https://img.rtvslo.si/feeds/00.xml', '#C0392B'), since: 7 }] },   // Slovenian; translated
  { grp: 'Namibia',         sources: [{ ...rss('The Namibian', 'NA', 'https://www.namibian.com.na/feed/', '#117A65'), since: 7 }] },
  // No dates in this feed: items are dated from their link or when first seen (rss.js undatedPublished).
  { grp: 'Nepal',           sources: [{ ...rss('Kathmandu Post', 'NP', 'https://kathmandupost.com/rss', '#B03A2E'), since: 7 }] },
  { grp: 'Myanmar',         sources: [{ ...rss('The Irrawaddy', 'MM', 'https://www.irrawaddy.com/feed', '#B7950B'), since: 7 }] },   // exile-run
  { grp: 'Pacific Islands', sources: [{ ...rss('RNZ Pacific', 'PAC', 'https://www.rnz.co.nz/rss/pacific.xml', '#148F77'), since: 7 }] },
  {
    grp: 'Telegram',
    sources: [
      { type: 'telegram', name: 'Global News Monitor', category: 'TG', color: '#229ED9', config: { channel: 'warmonitors' } },
      { type: 'telegram', name: "Mannie's War Room",   category: 'TG', color: '#1B6F99', config: { channel: 'manniefabian' } },
      { type: 'telegram', name: 'NEXTA Live',          category: 'TG', color: '#2E4057', config: { channel: 'nexta_live' } },
      { type: 'telegram', name: 'Al Jazeera Arabic',   category: 'TG', color: '#0E7C60', config: { channel: 'ajanews' }, enabled: false },
      { type: 'telegram', name: 'WarFront Witness',    category: 'TG', color: '#3B7FA8', config: { channel: 'wfwitness' }, since: 8 },
      { type: 'telegram', name: 'Intel Slava',         category: 'TG', color: '#4A5A8C', config: { channel: 'intelslava' }, since: 8 },
    ],
  },
  {
    grp: 'Wires & Search',
    sources: [
      { type: 'googlenews', name: 'Reuters / AP (Google News)', category: 'WIRE', color: '#E67E22',
        config: { query: '(site:reuters.com OR site:apnews.com) when:1d', lang: 'en', country: 'US' } },
      { type: 'bluesky', name: 'Reuters (Bluesky)', category: 'BSKY', color: '#0A7AFF', config: { mode: 'author', handle: 'reuters.com' } },
      { type: 'gdelt', name: 'GDELT Middle East', category: 'GDELT', color: '#5B2C6F',
        config: { keywords: 'israel, gaza, iran, lebanon, hezbollah, houthi, syria, yemen' } },
    ],
  },
];

// Default sources withdrawn later, removed once from existing databases at the
// given revision — only while they still point at the original feed, so a
// source the user set up themselves under the same name is left alone.
const RETIRED = [
  // Every story carries the same timestamp (the feed's clock runs ahead), so the list order is meaningless.
  { since: 3, name: 'Taipei Times', url: 'https://www.taipeitimes.com/xml/index.rss' },
];

// Default sources renamed later, renamed once in existing databases at the given
// revision — only while they still have the old name and the original feed, so a
// name the user chose themselves is left alone.
const RENAMED = [
  { since: 10, from: "Trump's Truth", to: 'Trump-Truth Social', url: 'https://www.trumpstruth.org/feed' },
];

/** Bump when SEED_GROUPS gains sources marked `since: <n>`, or RETIRED / RENAMED gain entries. */
const SEED_REVISION = 11;

module.exports = { SEED_GROUPS, SEED_REVISION, RETIRED, RENAMED };
