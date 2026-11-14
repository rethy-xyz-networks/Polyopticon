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
      rss('NPR',        'US', 'https://feeds.npr.org/1001/rss.xml', '#2471A3'),
      rss('PBS',        'US', 'https://www.pbs.org/newshour/feeds/rss/headlines', '#145A32'),
      rss('NBC World',  'US', 'https://feeds.nbcnews.com/nbcnews/public/world', '#1A6BA0'),
      rss('Al-Monitor', 'US', 'https://www.al-monitor.com/rss', '#7E5109'),
      // Archive of Donald Trump's Truth Social posts; untitled reposts are titled from their text (rss.js itemTitle).
      { ...rss('Trump-Truth Social', 'US', 'https://www.trumpstruth.org/feed', '#8B1E2D'), since: 9 },
      // Added in revision 12.
      { ...rss('CBS World',     'US', 'https://www.cbsnews.com/latest/rss/world', '#1B4F72'), since: 12 },
      { ...rss('ABC News Intl', 'US', 'https://abcnews.go.com/abcnews/internationalheadlines', '#B03A2E'), since: 12 },
      { ...rss('Axios',         'US', 'https://api.axios.com/feed/', '#2E4053'), since: 12 },
      { ...rss('ProPublica',    'US', 'https://feeds.propublica.org/propublica/main', '#1F618D'), since: 12 },
      { ...rss('The Hill',      'US', 'https://thehill.com/feed/', '#2874A6'), since: 12 },
      { ...rss('NPR World',     'US', 'https://feeds.npr.org/1004/rss.xml', '#1F5F8B'), since: 14 },
    ],
  },
  {
    grp: 'Canada',
    sources: [
      rss('CBC',         'CA', 'https://www.cbc.ca/webfeed/rss/rss-topstories', '#912018'),
      rss('CBC NS',      'CA', 'https://www.cbc.ca/webfeed/rss/rss-canada-novascotia', '#7D3C98'),
      { ...rss('Global News', 'CA', 'https://globalnews.ca/feed/', '#0057B8'), since: 2 },
      { ...rss('CBC World',        'CA', 'https://www.cbc.ca/webfeed/rss/rss-world', '#A93226'), since: 12 },
      { ...rss('CBC NB',           'CA', 'https://www.cbc.ca/webfeed/rss/rss-canada-newbrunswick', '#8E44AD'), since: 12 },
      { ...rss('Halifax Examiner', 'CA', 'https://www.halifaxexaminer.ca/feed/', '#5B2C6F'), since: 12 },
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
      rss('Guardian',        'UK', 'https://www.theguardian.com/world/rss', '#196F3D'),
      rss('Sky News',        'UK', 'https://feeds.skynews.com/feeds/rss/world.xml', '#1A7BB2'),
      { ...rss('BBC World',         'UK', 'https://feeds.bbci.co.uk/news/world/rss.xml', '#A93226'), since: 12 },
      { ...rss('BBC Africa',        'UK', 'https://feeds.bbci.co.uk/news/world/africa/rss.xml', '#B9770E'), since: 12 },
      { ...rss('BBC Asia',          'UK', 'https://feeds.bbci.co.uk/news/world/asia/rss.xml', '#CA6F1E'), since: 12 },
      { ...rss('BBC Europe',        'UK', 'https://feeds.bbci.co.uk/news/world/europe/rss.xml', '#2471A3'), since: 12 },
      { ...rss('BBC Latin America', 'UK', 'https://feeds.bbci.co.uk/news/world/latin_america/rss.xml', '#1E8449'), since: 12 },
      { ...rss('BBC Middle East',   'UK', 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml', '#7E5109'), since: 12 },
      { ...rss('BBC US & Canada',   'UK', 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml', '#34495E'), since: 12 },
      { ...rss('Guardian International', 'UK', 'https://www.theguardian.com/international/rss', '#1D8348'), since: 12 },
      { ...rss('The Independent',   'UK', 'https://www.independent.co.uk/news/world/rss', '#922B21'), since: 12 },
      { ...rss('The Economist',     'UK', 'https://www.economist.com/international/rss.xml', '#B71C1C'), since: 12 },
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
    ],
  },
  {
    grp: 'Ukraine',
    sources: [
      { ...rss('Kyiv Independent', 'UA', 'https://kyivindependent.com/news-archive/rss/', '#1F6FB2'), since: 2 },
      { ...rss('Ukrinform',        'UA', 'https://www.ukrinform.net/rss/block-lastnews', '#B7950B'), since: 2 },
      { ...rss('Ukrainska Pravda', 'UA', 'https://www.pravda.com.ua/eng/rss/', '#2471A3'), since: 12 },
    ],
  },
  {
    grp: 'Russia',
    sources: [
      { ...rss('RT',           'RU', 'https://www.rt.com/rss/', '#77B300'), since: 5 },
      { ...rss('Meduza', 'RU', 'https://meduza.io/rss/en/all', '#8E44AD'), since: 12 },   // exile-run
    ],
  },
  {
    grp: 'Israel',
    sources: [
      rss('Times of Israel', 'IL', 'https://www.timesofisrael.com/feed/', '#154360'),
    ],
  },
  {
    grp: 'Qatar',
    sources: [
      rss('Al Jazeera', 'QA', 'https://www.aljazeera.com/xml/rss/all.xml', '#0E7C60'),
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
      { ...rss('Tehran Times', 'IR', 'https://www.tehrantimes.com/rss', '#117A65'), since: 12 },
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
      { ...rss('The Hindu International', 'IN', 'https://www.thehindu.com/news/international/feeder/default.rss', '#2E86C1'), since: 12 },
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
    ],
  },
  {
    grp: 'Japan',
    sources: [
      { ...rss('Japan Times', 'JP', 'https://www.japantimes.co.jp/feed/', '#922B21'), since: 2 },
    ],
  },
  // Added in revision 6.
  { grp: 'Mexico',      sources: [{ ...rss('Mexico News Daily', 'MX', 'https://mexiconewsdaily.com/feed/', '#1E8449'), since: 6 }] },
  {
    grp: 'Iceland',
    sources: [
      { ...rss('Iceland Review', 'IS', 'https://www.icelandreview.com/feed/', '#2E86C1'), since: 6 },
    ],
  },
  { grp: 'Syria',       sources: [{ ...rss('Syrian Observer', 'SY', 'https://syrianobserver.com/feed', '#7B7D7D'), since: 6 }] },
  {
    grp: 'Egypt',
    sources: [
      { ...rss('Egyptian Streets', 'EG', 'https://egyptianstreets.com/feed/', '#B9770E'), since: 6 },
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
  {
    grp: 'North Korea',
    sources: [
      { ...rss('NK News', 'KP', 'https://www.nknews.org/feed/', '#5D6D7E'), since: 6 },
      { ...rss('Daily NK',   'KP', 'https://www.dailynk.com/english/feed/', '#8E44AD'), since: 14 },
      { ...rss('NK TechLab', 'KP', 'https://www.nktechlab.org/feed/', '#16A085'), since: 14 },   // North Korean technology
    ],
  },
  // Added in revision 7.
  { grp: 'Uruguay',         sources: [{ ...rss('MercoPress', 'UY', 'https://en.mercopress.com/rss', '#2874A6'), since: 7 }] },
  { grp: 'Estonia',         sources: [{ ...rss('ERR News', 'EE', 'https://news.err.ee/rss', '#0072CE'), since: 7 }] },
  { grp: 'Latvia',          sources: [{ ...rss('LSM English', 'LV', 'https://eng.lsm.lv/rss/', '#9E3039'), since: 7 }] },
  // No dates in this feed: items are dated from their link or when first seen (rss.js undatedPublished).
  { grp: 'Myanmar',         sources: [{ ...rss('The Irrawaddy', 'MM', 'https://www.irrawaddy.com/feed', '#B7950B'), since: 7 }] },   // exile-run
  // Added in revision 12.
  { grp: 'Ireland',     sources: [{ ...rss('RTÉ', 'IE', 'https://www.rte.ie/feeds/rss/?index=/news/', '#117A65'), since: 12 }] },
  { grp: 'Sweden',      sources: [{ ...rss('The Local (Sweden)', 'SE', 'https://www.thelocal.se/feeds/rss.php', '#1A5276'), since: 12 }] },
  { grp: 'Poland',      sources: [{ ...rss('Notes from Poland', 'PL', 'https://notesfrompoland.com/feed/', '#B03A2E'), since: 12 }] },
  {
    grp: 'Singapore',
    sources: [
      { ...rss('Straits Times', 'SG', 'https://www.straitstimes.com/news/world/rss.xml', '#1F618D'), since: 12 },
    ],
  },
  { grp: 'Vietnam', sources: [{ ...rss('VnExpress', 'VN', 'https://e.vnexpress.net/rss/news.rss', '#C0392B'), since: 12 }] },
  {
    grp: 'Africa',
    sources: [
      { ...rss('Africanews',       'AF', 'https://www.africanews.com/feed/rss', '#CA6F1E'), since: 12 },
      { ...rss('Egypt Independent', 'EG', 'https://egyptindependent.com/feed/', '#7E5109'), since: 12 },
    ],
  },
  {
    grp: 'International',
    sources: [
      { ...rss('Euronews',         'INT', 'https://www.euronews.com/rss', '#1F618D'), since: 12 },
      { ...rss('UN News',          'INT', 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', '#2E86C1'), since: 12 },
      { ...rss('Global Voices',    'INT', 'https://globalvoices.org/feed/', '#D35400'), since: 12 },
      { ...rss('Rest of World',    'INT', 'https://restofworld.org/feed/latest', '#B71C1C'), since: 12 },
      { ...rss('The Conversation', 'INT', 'https://theconversation.com/global/articles.atom', '#C0392B'), since: 12 },
      { ...rss('Foreign Policy',   'INT', 'https://foreignpolicy.com/feed/', '#922B21'), since: 12 },
      { ...rss('Foreign Affairs',  'INT', 'https://www.foreignaffairs.com/rss.xml', '#2C3E50'), since: 12 },
      { ...rss('Politico Europe',  'INT', 'https://www.politico.eu/feed/', '#B03A2E'), since: 12 },
      { ...rss('The Diplomat',     'INT', 'https://thediplomat.com/feed/', '#1A5276'), since: 12 },
      { ...rss('Bellingcat',       'INT', 'https://www.bellingcat.com/feed/', '#5D6D7E'), since: 12 },
    ],
  },
  {
    grp: 'Disasters & Health',
    sources: [
      { ...rss('NASA Breaking News',      'SPACE', 'https://www.nasa.gov/rss/dyn/breaking_news.rss', '#1F4E9C'), since: 12 },
    ],
  },
  {
    grp: 'Business',
    sources: [
      { ...rss('FT',                'BIZ', 'https://www.ft.com/rss/home', '#C0765B'), since: 12 },
      { ...rss('Bloomberg Markets', 'BIZ', 'https://feeds.bloomberg.com/markets/news.rss', '#2E4057'), since: 12 },
      { ...rss('CNBC',              'BIZ', 'https://www.cnbc.com/id/100003114/device/rss/rss.html', '#1A5276'), since: 12 },
      { ...rss('MarketWatch',       'BIZ', 'http://feeds.marketwatch.com/marketwatch/topstories/', '#117A65'), since: 12 },
    ],
  },
  // Added in revision 14.
  {
    grp: 'Serbia',
    sources: [
      { ...rss('Serbian News Media', 'RS', 'https://snm.rs/news/feed/', '#1A5276'), since: 14 },
      { ...rss('N1 Serbia',          'RS', 'https://n1info.rs/english/news/feed/', '#C0392B'), since: 14 },
    ],
  },
  { grp: 'Croatia',  sources: [{ ...rss('Croatian Government', 'HR', 'https://vlada.gov.hr/RSS?id=14956', '#B03A2E'), since: 14 }] },   // English news
  { grp: 'Denmark',  sources: [{ ...rss('Copenhagen Post', 'DK', 'https://cphpost.dk/category/news/politics/feed/', '#A93226'), since: 14 }] },   // politics
  { grp: 'Finland',  sources: [{ ...rss('Finland Today', 'FI', 'https://finlandtoday.fi/politics/feed/', '#1F618D'), since: 14 }] },   // politics
  { grp: 'Georgia',  sources: [{ ...rss('Civil Georgia', 'GE', 'https://civil.ge/feed', '#922B21'), since: 14 }] },
  {
    grp: 'Hungary',
    sources: [
      { ...rss('Budapest Times', 'HU', 'https://www.budapesttimes.hu/feed/', '#7E5109'), since: 14 },
    ],
  },
  { grp: 'Balkans',  sources: [{ ...rss('Balkan Insight', 'BALK', 'https://balkaninsight.com/feed/', '#B9770E'), since: 14 }] },   // BIRN, region-wide
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
  // Unused defaults dropped in revision 15 (Telegram ones match on channel).
  { since: 15, name: "Radio-Canada", url: 'https://ici.radio-canada.ca/rss/4159' },
  { since: 15, name: "Le Devoir", url: 'https://www.ledevoir.com/rss/manchettes.xml' },
  { since: 15, name: "La Presse", url: 'https://www.lapresse.ca/actualites/rss' },
  { since: 15, name: "BBC", url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { since: 15, name: "Middle East Eye", url: 'https://www.middleeasteye.net/rss' },
  { since: 15, name: "BBC Mundo", url: 'https://feeds.bbci.co.uk/mundo/rss.xml' },
  { since: 15, name: "Le Monde (FR)", url: 'https://www.lemonde.fr/rss/une.xml' },
  { since: 15, name: "Le Figaro", url: 'https://www.lefigaro.fr/rss/figaro_actualites.xml' },
  { since: 15, name: "Tagesschau", url: 'https://www.tagesschau.de/index~rss2.xml' },
  { since: 15, name: "Süddeutsche", url: 'https://rss.sueddeutsche.de/rss/Topthemen' },
  { since: 15, name: "TASS", url: 'https://tass.com/rss/v2.xml' },
  { since: 15, name: "Moscow Times", url: 'https://www.themoscowtimes.com/rss/news' },
  { since: 15, name: "Anadolu", url: 'https://www.aa.com.tr/en/rss/default?cat=guncel' },
  { since: 15, name: "Daily Sabah", url: 'https://www.dailysabah.com/rssFeed/todays-headlines' },
  { since: 15, name: "Jerusalem Post", url: 'https://www.jpost.com/Rss/RssFeedsIsraelNews.aspx' },
  { since: 15, name: "Haaretz", url: 'https://www.haaretz.com/srv/haaretz-latest-headlines' },
  { since: 15, name: "Arab News", url: 'https://www.arabnews.com/rss.xml' },
  { since: 15, name: "Times of India", url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms' },
  { since: 15, name: "The Hindu", url: 'https://www.thehindu.com/news/national/feeder/default.rss' },
  { since: 15, name: "NDTV", url: 'https://feeds.feedburner.com/ndtvnews-top-stories' },
  { since: 15, name: "Hindustan Times", url: 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml' },
  { since: 15, name: "Indian Express", url: 'https://indianexpress.com/feed/' },
  { since: 15, name: "Korea Herald", url: 'https://www.koreaherald.com/rss/newsAll' },
  { since: 15, name: "Japan Today", url: 'https://japantoday.com/feed' },
  { since: 15, name: "ABC Australia", url: 'https://www.abc.net.au/news/feed/2942460/rss.xml' },
  { since: 15, name: "SMH", url: 'https://www.smh.com.au/rss/feed.xml' },
  { since: 15, name: "Guardian Australia", url: 'https://www.theguardian.com/australia-news/rss' },
  { since: 15, name: "RÚV", url: 'https://www.ruv.is/rss/frettir' },
  { since: 15, name: "Daily News Egypt", url: 'https://dailynewsegypt.com/feed/' },
  { since: 15, name: "Rappler", url: 'https://www.rappler.com/philippines/feed/' },
  { since: 15, name: "RTV SLO", url: 'https://img.rtvslo.si/feeds/00.xml' },
  { since: 15, name: "The Namibian", url: 'https://www.namibian.com.na/feed/' },
  { since: 15, name: "Kathmandu Post", url: 'https://kathmandupost.com/rss' },
  { since: 15, name: "RNZ Pacific", url: 'https://www.rnz.co.nz/rss/pacific.xml' },
  { since: 15, name: "RNZ", url: 'https://www.rnz.co.nz/rss/national.xml' },
  { since: 15, name: "El País", url: 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada' },
  { since: 15, name: "El Mundo", url: 'https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml' },
  { since: 15, name: "ANSA", url: 'https://www.ansa.it/sito/ansait_rss.xml' },
  { since: 15, name: "La Repubblica", url: 'https://www.repubblica.it/rss/homepage/rss2.0.xml' },
  { since: 15, name: "NOS", url: 'https://feeds.nos.nl/nosnieuwsalgemeen' },
  { since: 15, name: "NRC", url: 'https://www.nrc.nl/rss/' },
  { since: 15, name: "CNA", url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml' },
  { since: 15, name: "AllAfrica", url: 'https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf' },
  { since: 15, name: "Daily Maverick", url: 'https://www.dailymaverick.co.za/dmrss/' },
  { since: 15, name: "Premium Times", url: 'https://www.premiumtimesng.com/feed' },
  { since: 15, name: "Punch", url: 'https://punchng.com/feed/' },
  { since: 15, name: "Folha", url: 'https://feeds.folha.uol.com.br/emcimadahora/rss091.xml' },
  { since: 15, name: "G1", url: 'https://g1.globo.com/rss/g1/' },
  { since: 15, name: "Rio Times", url: 'https://www.riotimesonline.com/feed/' },
  { since: 15, name: "Clarín", url: 'https://www.clarin.com/rss/lo-ultimo/' },
  { since: 15, name: "Infobae", url: 'https://www.infobae.com/arc/outboundfeeds/rss/' },
  { since: 15, name: "War on the Rocks", url: 'https://warontherocks.com/feed/' },
  { since: 15, name: "USGS Significant Quakes", url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.atom' },
  { since: 15, name: "USGS M4.5+ Quakes", url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.atom' },
  { since: 15, name: "GDACS", url: 'https://www.gdacs.org/xml/rss.xml' },
  { since: 15, name: "AFTN", url: 'https://aftn.ca/feed/' },
  { since: 15, name: "Global News Monitor", channel: 'warmonitors' },
  { since: 15, name: "Mannie's War Room", channel: 'manniefabian' },
  { since: 15, name: "NEXTA Live", channel: 'nexta_live' },
  { since: 15, name: "Al Jazeera Arabic", channel: 'ajanews' },
  { since: 15, name: "WarFront Witness", channel: 'wfwitness' },
  { since: 15, name: "Intel Slava", channel: 'intelslava' },
  // Dropped in revision 16.
  { since: 16, name: 'NYT', url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml' },
  { since: 16, name: 'NYT US', url: 'https://rss.nytimes.com/services/xml/rss/nyt/US.xml' },
  { since: 16, name: 'NYT Politics', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml' },
  { since: 16, name: 'NYT World', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
  { since: 16, name: 'Hungary Today', url: 'https://hungarytoday.hu/feed/' },
  // The New York Times API source type, withdrawn in revision 16: every source of that type is removed.
  { since: 16, type: 'nyt' },
];

// Default sources renamed later, renamed once in existing databases at the given
// revision — only while they still have the old name and the original feed, so a
// name the user chose themselves is left alone.
const RENAMED = [
  { since: 10, from: "Trump's Truth", to: 'Trump-Truth Social', url: 'https://www.trumpstruth.org/feed' },
];

/** Bump when SEED_GROUPS gains sources marked `since: <n>`, or RETIRED / RENAMED gain entries. */
const SEED_REVISION = 16;

module.exports = { SEED_GROUPS, SEED_REVISION, RETIRED, RENAMED };
