'use strict';

// Publisher / aggregator APIs with free keys: The Guardian, NYT, NewsAPI.org.

const { Adapter } = require('./base');
const { SourceError, getJson, cleanHtml, cleanText, trunc, parseDate, sanePublished } = require('./util');

class GuardianAdapter extends Adapter {
  async fetchItems(signal) {
    const key = this.ctx.credentials.guardianKey;
    if (!key) throw new SourceError('NO KEY', 'Add a free Guardian API key under Settings -> Accounts');
    const params = new URLSearchParams({
      'order-by': 'newest', 'page-size': '50', 'show-fields': 'trailText,byline',
      'api-key': key,
    });
    if (this.config.query)   params.set('q', this.config.query);
    if (this.config.section) params.set('section', this.config.section);
    const res = await getJson(`https://content.guardianapis.com/search?${params}`, { signal });
    if (res.response?.status !== 'ok') throw new SourceError('API', res.response?.message || 'Guardian API error');
    return res.response.results.map(r => ({
      extId: r.id,
      title: cleanText(r.webTitle) ?? '(no title)',
      summary: cleanHtml(r.fields?.trailText),
      url: r.webUrl,
      author: r.fields?.byline || r.sectionName || null,
      publishedAt: sanePublished(parseDate(r.webPublicationDate) ?? Date.now()),
    }));
  }
}

class NytAdapter extends Adapter {
  async fetchItems(signal) {
    const key = this.ctx.credentials.nytKey;
    if (!key) throw new SourceError('NO KEY', 'Add a free NYT API key under Settings -> Accounts');
    const section = encodeURIComponent(this.config.section || 'all');
    const url = this.config.feed === 'topstories'
      ? `https://api.nytimes.com/svc/topstories/v2/${section === 'all' ? 'home' : section}.json?api-key=${key}`
      : `https://api.nytimes.com/svc/news/v3/content/all/${section}.json?limit=50&api-key=${key}`;
    const res = await getJson(url, { signal });
    return (res.results || []).filter(r => r.url && r.title).map(r => ({
      extId: r.uri || r.url,
      title: cleanText(r.title),
      summary: cleanText(r.abstract),
      url: r.url,
      author: cleanText(r.byline)?.replace(/^By /, '') || r.section || null,
      publishedAt: sanePublished(parseDate(r.published_date || r.first_published_date) ?? Date.now()),
    }));
  }
}

class NewsApiAdapter extends Adapter {
  async fetchItems(signal) {
    const key = this.ctx.credentials.newsapiKey;
    if (!key) throw new SourceError('NO KEY', 'Add a free NewsAPI key under Settings -> Accounts');
    const params = new URLSearchParams({ q: this.config.query, sortBy: 'publishedAt', pageSize: '50', language: this.config.language || 'en' });
    const res = await getJson(`https://newsapi.org/v2/everything?${params}`, { signal, headers: { 'X-Api-Key': key } });
    if (res.status !== 'ok') throw new SourceError(res.code === 'rateLimited' ? 'LIMIT' : 'API', res.message || 'NewsAPI error');
    return res.articles.filter(a => a.url && a.title && a.title !== '[Removed]').map(a => ({
      extId: a.url,
      title: trunc(cleanText(a.title), 300),
      summary: cleanText(a.description),
      url: a.url,
      author: [a.source?.name, a.author].filter(Boolean).join(' · ') || null,
      publishedAt: sanePublished(parseDate(a.publishedAt) ?? Date.now()),
    }));
  }
}

module.exports = { GuardianAdapter, NytAdapter, NewsApiAdapter };
