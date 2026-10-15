'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = channel => fn => ipcRenderer.on(channel, (_e, ...args) => fn(...args));

contextBridge.exposeInMainWorld('polyopticon', {
  init:          ()              => ipcRenderer.invoke('app:init'),
  ready:         ()              => ipcRenderer.send('app:ready'),
  refresh:       ()              => ipcRenderer.invoke('feeds:refresh'),
  saveSettings:  settings        => ipcRenderer.send('settings:save', settings),
  saveTags:      tags            => ipcRenderer.send('tags:save', tags),
  savePinned:    list            => ipcRenderer.send('tabs:pinned', list),
  savePinnedSync: list           => ipcRenderer.sendSync('tabs:pinned-sync', list),
  saveUi:        patch           => ipcRenderer.send('ui:save', patch),
  openExternal:  url             => ipcRenderer.send('shell:open', url),
  copy:          text            => ipcRenderer.send('clipboard:write', text),
  setState:      (key, val)      => ipcRenderer.send('state:set', key, val),
  log:           (lvl, msg)      => ipcRenderer.send('log', lvl, msg),
  setPageShortcuts: combos       => ipcRenderer.send('shortcuts:pages', combos),
  toggleFullScreen: ()           => ipcRenderer.send('window:toggle-fullscreen'),

  // Sources
  saveSource:    src             => ipcRenderer.invoke('sources:save', src),
  toggleSource:  (id, enabled)   => ipcRenderer.invoke('sources:toggle', id, enabled),
  deleteSource:  id              => ipcRenderer.invoke('sources:delete', id),

  // Political lean
  recheckBias:   ()              => ipcRenderer.invoke('bias:recheck'),

  // Global Markets
  startMarkets:  symbols         => ipcRenderer.send('markets:start', symbols),
  setMarkets:    symbols         => ipcRenderer.send('markets:set', symbols),
  stopMarkets:   ()              => ipcRenderer.send('markets:stop'),
  lookupMarket:  symbol          => ipcRenderer.invoke('markets:lookup', symbol),

  // History / snapshots
  history:       opts            => ipcRenderer.invoke('history:list', opts),
  items:         ids             => ipcRenderer.invoke('items:get', ids),
  recordOpen:    (itemId, via)   => ipcRenderer.send('open:record', itemId, via),
  captureTab:    (itemId, wcId)  => ipcRenderer.invoke('snapshot:capture', itemId, wcId),
  snapshot:      itemId          => ipcRenderer.invoke('snapshot:get', itemId),
  translateSnapshot: itemId      => ipcRenderer.invoke('snapshot:translate', itemId),
  translateStats:()              => ipcRenderer.invoke('translate:stats'),
  stopTranslation:()             => ipcRenderer.invoke('translate:stop'),

  // Screenshots
  screenshot:    (wcId, title)   => ipcRenderer.invoke('screenshot:take', wcId, title),
  chooseScreenshotFolder: ()     => ipcRenderer.invoke('screenshot:choose-folder'),
  showScreenshot: file           => ipcRenderer.send('screenshot:show', file),

  // Accounts
  saveAccounts:  patch           => ipcRenderer.invoke('accounts:save', patch),
  telegramLogin: creds           => ipcRenderer.invoke('telegram:login', creds),
  telegramAnswer:(what, value)   => ipcRenderer.send('telegram:answer', what, value),
  telegramLogout:()              => ipcRenderer.invoke('telegram:logout'),

  // IRC chats
  ircConnect:    (id, spec)      => ipcRenderer.invoke('irc:connect', id, spec),
  ircDisconnect: id              => ipcRenderer.send('irc:disconnect', id),

  // Scratchpad
  loadScratch:   ()              => ipcRenderer.invoke('scratch:load'),
  saveScratch:   note            => ipcRenderer.invoke('scratch:save', note),
  saveScratchSync: note          => ipcRenderer.sendSync('scratch:save-sync', note),

  // Storage
  storageStats:  ()              => ipcRenderer.invoke('storage:stats'),
  openDataDir:   ()              => ipcRenderer.send('storage:open'),
  clearArticles: ()              => ipcRenderer.invoke('storage:clear-articles'),
  clearModels:   ()              => ipcRenderer.invoke('storage:clear-models'),

  // Events from main
  onItems:          on('feed:items'),
  onIrcEvent:       on('irc:event'),
  onItemsUpdated:   on('feed:updated'),
  onTranslateProgress: on('translate:progress'),
  onStatus:         on('feed:status'),
  onSourcesChanged: on('sources:changed'),
  onBiasChanged:    on('bias:changed'),
  onBiasProgress:   on('bias:progress'),
  onMarketQuotes:   on('markets:quotes'),
  onMarketStatus:   on('markets:status'),
  onAccounts:       on('accounts:changed'),
  onSnapshot:       on('snapshot:saved'),
  onTelegramAsk:    on('telegram:ask'),
  onTelegramError:  on('telegram:error'),
  onTelegramDone:   on('telegram:done'),
  onShortcut:       on('app:shortcut'),
  onZoom:           on('app:zoom'),
  onFullScreen:     on('window:fullscreen'),
  onChanOpen:       on('chan:open'),
});
