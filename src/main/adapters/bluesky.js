'use strict';

// Bluesky: keyword search or a single account's posts.
// Unauthenticated search goes through api.bsky.app; if the user has saved a
// handle + app password, requests are made with a session via their PDS.

const { Adapter } = require('./base');
const { SourceError, getJson, headline, trunc, sanePublished } = require('./util');

const PUBLIC_SEARCH = 'https://api.bsky.app/xrpc';
const PUBLIC_APPVIEW = 'https://public.api.bsky.app/xrpc';

// One session per worker, shared by all Bluesky sources.
const session = { key: null, jwt: null, pds: null, pending: null };

async function getSession(creds, signal) {
  if (!creds?.handle || !creds?.appPassword) return null;
  const key = `${creds.handle}|${creds.appPassword}`;
  if (session.key === key && session.jwt) return session;
  if (session.pending) return session.pending;
  session.pending = (async () => {
    const res = await getJson('https://bsky.social/xrpc/com.atproto.server.createSession', {
      signal, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: creds.handle, password: creds.appPassword }),
    });
    const pds = res.didDoc?.service?.find(s => s.id === '#atproto_pds')?.serviceEndpoint || 'https://bsky.social';
    Object.assign(session, { key, jwt: res.accessJwt, pds: `${pds.replace(/\/$/, '')}/xrpc` });
    return session;
  })().finally(() => { session.pending = null; });
  return session.pending;
}

function toItem(post) {
  const rec = post.record || {};
  const rkey = post.uri.split('/').pop();
  const handle = post.author?.handle || post.author?.did;
  const ext = post.embed?.external ?? rec.embed?.external;
  const body = [rec.text, ext?.title && ext.title].filter(Boolean).join('\n');
  return {
    extId: post.uri,
    kind: 'post',
    title: headline(rec.text || ext?.title || '(image post)', 200),
    summary: trunc(body, 2000),
    url: `https://bsky.app/profile/${handle}/post/${rkey}`,
    author: post.author?.displayName ? `${post.author.displayName} (@${handle})` : `@${handle}`,
    publishedAt: sanePublished(Date.parse(rec.createdAt) || Date.parse(post.indexedAt) || Date.now()),
    extra: ext?.uri ? { link: ext.uri } : null,
  };
}

class BlueskyAdapter extends Adapter {
  async call(path, params, signal) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    const sess = await getSession(this.ctx.credentials.bluesky, signal);
    if (sess) {
      try {
        return await getJson(`${sess.pds}/${path}?${qs}`, { signal, headers: { Authorization: `Bearer ${sess.jwt}` } });
      } catch (e) {
        if (e.label !== 'AUTH') throw e;
        session.jwt = null;                                  // expired — re-login next poll
        throw e;
      }
    }
    const base = path.endsWith('searchPosts') ? PUBLIC_SEARCH : PUBLIC_APPVIEW;
    return getJson(`${base}/${path}?${qs}`, { signal });
  }

  async fetchItems(signal) {
    if ((this.config.mode || 'search') === 'author') {
      const res = await this.call('app.bsky.feed.getAuthorFeed',
        { actor: this.config.handle.replace(/^@/, ''), filter: 'posts_no_replies', limit: 50 }, signal);
      return res.feed.filter(f => !f.reason).map(f => toItem(f.post));     // skip reposts
    }
    const res = await this.call('app.bsky.feed.searchPosts',
      { q: this.config.query, sort: 'latest', limit: 50, lang: this.config.lang }, signal);
    if (!Array.isArray(res.posts)) throw new SourceError('PARSE', 'Unexpected search response');
    return res.posts.map(toItem);
  }
}

module.exports = { BlueskyAdapter };
