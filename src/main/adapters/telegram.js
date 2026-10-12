'use strict';

// Telegram public channels, two ways:
//   • Web preview (no account): scrapes https://t.me/s/<channel>. Works for most
//     public channels; polled.
//   • MTProto (logged in via GramJS with the user's own api_id/api_hash): reads
//     channel history directly, and gets new messages pushed instantly for
//     channels the account has joined.

const { Adapter } = require('./base');
const { SourceError, request, cleanHtml, decodeEntities, headline, trunc, parseDate, sanePublished } = require('./util');

// Shared MTProto client

let gram = null;                       // lazily-loaded GramJS modules
function loadGram() {
  if (!gram) {
    const { TelegramClient, Api } = require('telegram');
    const { StringSession } = require('telegram/sessions');
    const { NewMessage } = require('telegram/events');
    const { Logger, LogLevel } = require('telegram/extensions/Logger');
    gram = { TelegramClient, Api, StringSession, NewMessage, Logger, LogLevel };
  }
  return gram;
}

const service = {
  client: null,
  user: null,                          // display name of the logged-in account
  key: null,
  connecting: null,
  log: null,
  get ready() { return !!(this.client && this.user); },

  makeClient(apiId, apiHash, sessionStr = '') {
    const g = loadGram();
    return new g.TelegramClient(new g.StringSession(sessionStr), Number(apiId), apiHash, {
      connectionRetries: 5,
      autoReconnect: true,
      baseLogger: new g.Logger(g.LogLevel.ERROR),
    });
  },

  /** Connect with a saved session (no prompts). Resolves to true if authorised. */
  async ensure(creds) {
    const tg = creds?.telegram;
    if (!tg?.apiId || !tg?.apiHash || !tg?.session) { await this.disconnect(); return false; }
    const key = `${tg.apiId}|${tg.session}`;
    if (this.key === key && this.client) return this.ready;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.disconnect();
      const client = this.makeClient(tg.apiId, tg.apiHash, tg.session);
      await client.connect();
      if (!(await client.checkAuthorization())) {
        this.log?.warn('[Telegram] Saved session is no longer authorised — log in again under Accounts');
        await client.disconnect();
        return false;
      }
      const me = await client.getMe();
      Object.assign(this, { client, key, user: displayName(me) });
      this.log?.info(`[Telegram] Connected as ${this.user}`);
      return true;
    })().catch(e => { this.log?.warn(`[Telegram] Connect failed: ${e.message}`); return false; })
      .finally(() => { this.connecting = null; });
    return this.connecting;
  },

  async disconnect() {
    const c = this.client;
    Object.assign(this, { client: null, user: null, key: null });
    if (c) { try { await c.disconnect(); } catch { /* ignore */ } }
  },

  /**
   * Interactive login. ask(what, hint) must resolve with the user's answer
   * ('code' or 'password'). Returns { session, user }.
   */
  async login({ apiId, apiHash, phone }, ask, onError) {
    const client = this.makeClient(apiId, apiHash);
    let lastError = null;
    try {
      await client.start({
        phoneNumber: async () => phone,
        phoneCode:   async () => ask('code'),
        password:    async hint => ask('password', hint),
        // GramJS retries the failed step while this returns false. Only a wrong
        // code or password is worth re-asking; anything else would loop forever.
        onError: async err => {
          lastError = err;
          const retry = /PHONE_CODE_INVALID|PASSWORD_HASH_INVALID/.test(err.errorMessage || err.message);
          if (retry) onError(err);
          return !retry;
        },
      });
    } catch (e) {
      try { await client.disconnect(); } catch { /* ignore */ }
      throw e.message === 'AUTH_USER_CANCEL' && lastError ? lastError : e;
    }
    const me = await client.getMe();
    const session = client.session.save();
    await this.disconnect();
    Object.assign(this, { client, user: displayName(me), key: `${apiId}|${session}` });
    return { session, user: this.user };
  },

  async logout() {
    if (this.client) {
      try { await this.client.invoke(new (loadGram().Api.auth.LogOut)()); } catch { /* already gone */ }
    }
    await this.disconnect();
  },
};

function displayName(me) {
  const name = [me.firstName, me.lastName].filter(Boolean).join(' ');
  return me.username ? `${name} (@${me.username})` : name || String(me.id);
}

// Web preview parsing

function parseWebPreview(html, channel) {
  const out = [];
  const chunks = html.split('data-post="').slice(1);
  for (const chunk of chunks) {
    const post = chunk.slice(0, chunk.indexOf('"'));                 // "Channel/123"
    const id = Number(post.split('/')[1]);
    if (!id) continue;
    const textM = chunk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const timeM = chunk.match(/<time datetime="([^"]+)"/);
    const media = /tgme_widget_message_video|tgme_widget_message_roundvideo/.test(chunk) ? 'Video'
                : /tgme_widget_message_photo/.test(chunk) ? 'Photo'
                : /tgme_widget_message_document/.test(chunk) ? 'File' : null;
    const body = textM ? cleanHtml(textM[1], { keepLines: true }) : null;
    if (!body && !media) continue;
    out.push({ id, body, media, date: timeM ? parseDate(timeM[1]) : null, channel: post.split('/')[0] || channel });
  }
  return out;
}

function channelTitle(html) {
  const m = html.match(/<div class="tgme_channel_info_header_title"[^>]*>(?:<span[^>]*>)?([^<]+)/);
  return m ? decodeEntities(m[1]).trim() : null;
}

function toItem({ id, body, media, date, channel }) {
  const text = body || `[${media}]`;
  return {
    extId: String(id),
    kind: 'message',
    title: headline(media && !body ? `[${media}]` : text, 200),
    summary: trunc(text + (media && body ? `\n[${media}]` : ''), 4000),
    url: `https://t.me/${channel}/${id}`,
    author: `@${channel}`,
    publishedAt: sanePublished(date ?? Date.now()),
    extra: media ? { media } : null,
  };
}

// Adapter

class TelegramAdapter extends Adapter {
  constructor(source, ctx) {
    super(source, ctx);
    this.channel = this.config.channel;
    this.handler = null;
    service.log = ctx.log;
  }

  async fetchItems(signal) {
    if (await service.ensure(this.ctx.credentials)) {
      this.subscribe();
      return this.fetchMtproto();
    }
    return this.fetchWeb(signal);
  }

  async fetchWeb(signal) {
    const resp = await request(`https://t.me/s/${encodeURIComponent(this.channel)}`, { signal, browser: true });
    if (!resp.ok) throw new SourceError(`HTTP ${resp.status}`, `t.me web preview: HTTP ${resp.status}`);
    const html = await resp.text();
    // Channels with previews disabled (or private ones) redirect to the plain profile page.
    if (!html.includes('tgme_widget_message') && !html.includes('tgme_channel_history'))
      throw new SourceError('NO PREVIEW', `@${this.channel} has no public web preview — log in to Telegram under Accounts to follow it`);
    if (this.firstPoll) {
      const title = channelTitle(html);
      if (title) this.log.info(`[${this.name}] Telegram channel: ${title}`);
    }
    return parseWebPreview(html, this.channel).map(toItem);
  }

  async fetchMtproto() {
    try {
      const msgs = await service.client.getMessages(this.channel, { limit: 30 });
      return msgs.map(m => this.fromMessage(m)).filter(Boolean);
    } catch (e) {
      const wait = e.seconds ?? e.message?.match(/FLOOD_WAIT_(\d+)/)?.[1];
      if (wait) throw new SourceError('FLOOD', `Telegram rate limit — wait ${wait}s`);
      if (/USERNAME_(INVALID|NOT_OCCUPIED)|No user has/.test(e.message)) throw new SourceError('NOT FOUND', `@${this.channel} doesn't exist`);
      throw e;
    }
  }

  fromMessage(m) {
    if (!m || m.className !== 'Message') return null;
    const media = m.media ? (m.media.className === 'MessageMediaPhoto' ? 'Photo'
                          : m.media.className === 'MessageMediaDocument' ? (m.media.video ? 'Video' : 'File')
                          : m.media.className === 'MessageMediaWebPage' ? null : 'Media') : null;
    const body = (m.message || '').trim() || null;
    if (!body && (!media || m.groupedId)) return null;           // album parts without a caption
    return toItem({ id: m.id, body, media, date: m.date * 1000, channel: this.channel });
  }

  /** Instant delivery for channels the account has joined. */
  subscribe() {
    if (this.handler || !service.client) return;
    const { NewMessage } = loadGram();
    const event = new NewMessage({ chats: [this.channel] });
    this.handler = async ev => {
      const item = this.fromMessage(ev.message);
      if (!item || this.stopped) return;
      const added = this.ingest([item]);
      if (added.length) { this.log.info(`[${this.name}] +1 pushed message`); this.status(String(this.total)); }
    };
    this.handlerEvent = event;
    this.handlerClient = service.client;
    service.client.addEventHandler(this.handler, event);
  }

  stop() {
    super.stop();
    if (this.handler && this.handlerClient) {
      try { this.handlerClient.removeEventHandler(this.handler, this.handlerEvent); } catch { /* client gone */ }
    }
    this.handler = null;
  }
}

module.exports = { TelegramAdapter, telegramService: service, parseWebPreview };
