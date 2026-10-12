'use strict';

// Source-type catalogue. Pure data, shared by the main process (validation,
// UI) and the feed worker (scheduling). Intervals are in seconds;
// defaultInterval 'global' means "use the Refresh interval setting".

const TYPES = {
  rss: {
    label: 'RSS / Atom feed',
    help: 'Any RSS, Atom or RDF feed URL.',
    defaultInterval: 'global', minInterval: 5,
    fields: [
      { key: 'url', label: 'Feed URL', type: 'url', required: true, placeholder: 'https://example.com/feed.xml' },
    ],
  },
  googlenews: {
    label: 'Google News search',
    help: 'Any search Google News understands: keywords, "exact phrases", site:reuters.com, OR, -exclude, when:1d.',
    defaultInterval: 120, minInterval: 60,
    fields: [
      { key: 'query',   label: 'Search', type: 'text', placeholder: 'site:reuters.com israel OR iran  (blank = top stories)' },
      { key: 'lang',    label: 'Language', type: 'text', placeholder: 'en', default: 'en' },
      { key: 'country', label: 'Country', type: 'text', placeholder: 'US', default: 'US' },
    ],
  },
  gdelt: {
    label: 'GDELT global news',
    help: 'Worldwide English-language coverage, updated every 15 minutes. Matches any keyword in the headline or URL; optional theme and location filters narrow it.',
    defaultInterval: 60, minInterval: 60,
    fields: [
      { key: 'keywords', label: 'Keywords (comma-separated, any match)', type: 'text', placeholder: 'gaza, hezbollah, strait of hormuz' },
      { key: 'themes',   label: 'GDELT themes (optional, any match)', type: 'text', placeholder: 'ARMEDCONFLICT, TERROR, PROTEST' },
      { key: 'location', label: 'Location mentions (optional)', type: 'text', placeholder: 'Lebanon' },
    ],
  },
  bluesky: {
    label: 'Bluesky',
    help: 'Posts matching a search, or every post from one account. Logging in under Accounts makes search more reliable.',
    defaultInterval: 60, minInterval: 20, kind: 'post',
    fields: [
      { key: 'mode',   label: 'Mode', type: 'select', options: [['search', 'Search posts'], ['author', 'Account feed']], default: 'search' },
      { key: 'query',  label: 'Search (search mode)', type: 'text', placeholder: '"breaking" gaza' },
      { key: 'handle', label: 'Handle (account mode)', type: 'text', placeholder: 'reuters.com' },
      { key: 'lang',   label: 'Language filter (search mode)', type: 'text', placeholder: 'en' },
    ],
  },
  telegram: {
    label: 'Telegram channel',
    help: 'A public channel by username. Works without an account via the public web preview; log in under Accounts for instant delivery and channels without previews.',
    defaultInterval: 60, minInterval: 15, kind: 'message',
    fields: [
      { key: 'channel', label: 'Channel username or t.me link', type: 'text', required: true, placeholder: 'AJEnglish' },
    ],
  },
  guardian: {
    label: 'The Guardian API',
    help: 'Guardian search by keyword and/or section. Needs a free key from open-platform.theguardian.com (Accounts).',
    defaultInterval: 300, minInterval: 180, credential: 'guardianKey',
    fields: [
      { key: 'query',   label: 'Search (optional)', type: 'text', placeholder: 'ceasefire' },
      { key: 'section', label: 'Section (optional)', type: 'text', placeholder: 'world' },
    ],
  },
  nyt: {
    label: 'New York Times API',
    help: 'Times Newswire (everything as it publishes) or Top Stories. Needs a free key from developer.nytimes.com (Accounts).',
    defaultInterval: 300, minInterval: 180, credential: 'nytKey',
    fields: [
      { key: 'feed',    label: 'Feed', type: 'select', options: [['newswire', 'Times Newswire'], ['topstories', 'Top Stories']], default: 'newswire' },
      { key: 'section', label: 'Section', type: 'text', placeholder: 'all / world / us / business', default: 'all' },
    ],
  },
  newsapi: {
    label: 'NewsAPI.org',
    help: 'Searches 80,000+ outlets. The free plan allows 100 requests/day and delays articles by 24 hours. Needs a free key (Accounts).',
    defaultInterval: 1800, minInterval: 900, credential: 'newsapiKey',
    fields: [
      { key: 'query',    label: 'Search', type: 'text', required: true, placeholder: 'israel AND iran' },
      { key: 'language', label: 'Language', type: 'text', placeholder: 'en', default: 'en' },
    ],
  },
};

// Badge colours for sources created without one.
const PALETTE = ['#1565C0', '#A93226', '#0E7C60', '#7D3C98', '#B9770E', '#1A7BB2', '#145A32', '#7E5109',
                 '#6C3483', '#2471A3', '#196F3D', '#8B0000', '#154360', '#784212', '#0B6B59', '#5B2C6F'];

function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

/** Validates and normalises a source definition from the UI. Throws with a user-facing message. */
function validateSource(s) {
  const meta = TYPES[s.type];
  if (!meta) throw new Error(`Unknown source type "${s.type}"`);
  const name = String(s.name || '').trim();
  if (!name) throw new Error('Name is required');
  const config = {};
  for (const f of meta.fields) {
    let v = String(s.config?.[f.key] ?? '').trim();
    if (!v && f.default) v = f.default;
    if (f.required && !v) throw new Error(`${f.label} is required`);
    if (f.type === 'url' && v && !/^https?:\/\//i.test(v)) throw new Error(`${f.label} must start with http:// or https://`);
    if (v) config[f.key] = v;
  }
  if (s.type === 'gdelt' && !config.keywords && !config.themes && !config.location)
    throw new Error('GDELT needs at least one keyword, theme or location — unfiltered it is ~2,000 articles an hour');
  if (s.type === 'bluesky' && (config.mode || 'search') === 'search' && !config.query) throw new Error('Search text is required');
  if (s.type === 'bluesky' && config.mode === 'author' && !config.handle) throw new Error('Handle is required');
  if (s.type === 'telegram') config.channel = config.channel.replace(/^(https?:\/\/)?(t\.me\/)(s\/)?/i, '').replace(/^@/, '').split(/[/?]/)[0];
  const interval = Number(s.config?.interval);
  if (interval) config.interval = Math.max(meta.minInterval, Math.round(interval));
  return {
    type: s.type, name,
    grp: String(s.grp || '').trim() || 'Other',
    category: String(s.category || '').trim() || null,
    color: /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : colorFor(name),
    enabled: s.enabled !== false,
    config,
  };
}

module.exports = { TYPES, PALETTE, colorFor, validateSource };
