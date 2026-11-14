'use strict';

const { TYPES } = require('./types');
const { RssAdapter, GoogleNewsAdapter } = require('./rss');
const { GdeltAdapter }    = require('./gdelt');
const { BlueskyAdapter }  = require('./bluesky');
const { TelegramAdapter, telegramService } = require('./telegram');
const { GuardianAdapter, NewsApiAdapter } = require('./apis');

const ADAPTERS = {
  rss: RssAdapter,
  googlenews: GoogleNewsAdapter,
  gdelt: GdeltAdapter,
  bluesky: BlueskyAdapter,
  telegram: TelegramAdapter,
  guardian: GuardianAdapter,
  newsapi: NewsApiAdapter,
};

for (const [type, cls] of Object.entries(ADAPTERS)) cls.meta = TYPES[type];

/** Which credentials each type reads — used to restart sources when accounts change. */
const CREDENTIAL_DEPS = {
  bluesky: ['bluesky'], telegram: ['telegram'], guardian: ['guardianKey'], newsapi: ['newsapiKey'],
};

module.exports = { ADAPTERS, CREDENTIAL_DEPS, telegramService };
