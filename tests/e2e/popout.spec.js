'use strict';

// Popping tabs out (right-click a tab -> Pop out): an article-area tab, a chat (an IRC room) and a
// stream each float in a window of their own, on the same session; closing the window puts the
// tab back; what floats when the app closes floats again at the next start. Local servers stand in
// for the sites: a web page, a video link and a tiny IRC server.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { test, expect, _electron: electron } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..', '..');

let server, base, irc, ircPort;
const sockets = new Set();
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url.endsWith('.mp4')) { res.writeHead(200, { 'Content-Type': 'video/mp4' }); return res.end(''); }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'seen=yes; Path=/; Max-Age=3600' });
    res.end(`<html><head><title>Page ${req.url}</title></head><body><p id="c">${req.headers.cookie || 'no cookie'}</p><a href="/next">next</a></body></html>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  irc = net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let nick = '', buf = '';
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (line.startsWith('NICK ')) nick = line.slice(5);
        if (line.startsWith('USER ')) socket.write(`:srv 001 ${nick} :Welcome\r\n`);
        if (line.startsWith('JOIN ')) {
          const room = line.slice(5);
          socket.write(`:${nick}!u@h JOIN ${room}\r\n:srv 366 ${nick} ${room} :End\r\n:alice!a@h PRIVMSG ${room} :hello from the fake server\r\n`);
        }
      }
    });
  });
  await new Promise(r => irc.listen(0, '127.0.0.1', r));
  ircPort = irc.address().port;
});
test.afterAll(() => { for (const s of sockets) s.destroy(); irc?.close(); server?.close(); });

const launch = dir => electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, POLYOPTICON_DATA_DIR: dir, POLYOPTICON_OFFSCREEN: '1', POLYOPTICON_NO_PREFETCH: '1' } });

async function started(app) {
  const window = await app.firstWindow();
  await expect(window.locator('#status-text')).not.toHaveText('Connecting…');
  return window;
}

/** The pop-out windows' pages, by title. */
const popouts = app => app.windows().filter(w => w.url().endsWith('/popout.html'));
async function popoutTitled(app, re) {
  let found = null;
  await expect.poll(async () => {
    for (const w of popouts(app)) if (re.test(await w.locator('#pop-title').textContent().catch(() => ''))) { found = w; return true; }
    return false;
  }, { timeout: 15_000 }).toBe(true);
  return found;
}

// The test window is unfocused, so a menu is now and then closed mid-click: retried until its effect shows.
async function menuUntil(window, tab, label, check) {
  for (let i = 0; i < 4; i++) {
    await tab().click({ button: 'right' });
    await window.locator('.ctx-menu button', { hasText: label }).click({ timeout: 2_000 }).catch(() => {});
    try { await expect.poll(check, { timeout: 2_500 }).toBe(true); return; } catch { /* again */ }
  }
  await expect.poll(check, { timeout: 2_500 }).toBe(true);
}

/** Runs JS inside the page a pop-out window shows. */
const inPage = (app, pop, js) => pop.locator('webview').evaluate(v => v.getWebContentsId())
  .then(id => app.evaluate(({ webContents }, [id, js]) => webContents.fromId(id).executeJavaScript(js, true), [id, js]));   // as a user action

test('article, chat and stream tabs pop out into their own windows, return when closed, and float again after a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyopticon-popout-'));
  const video = `${base}/clip.mp4`;
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    ChatDestiny: false, ChatTwitchChannels: '', ChatIrc: `irc://127.0.0.1:${ircPort}/#room`, TranslateLargeModel: false }));
  fs.writeFileSync(path.join(dir, 'ui.json'), JSON.stringify({ chatOpen: true, videoOpen: true, streams: [{ site: 'direct', name: video }] }));
  try {
    let app = await launch(dir);
    let window = await started(app);
    const storyTab = () => window.locator('#tabs .tab', { hasText: 'Page /pol/' });
    const chatTab = () => window.locator('#chat-tabs .tab', { hasText: '#room' });
    const streamTab = () => window.locator('#video-tabs .tab', { hasText: 'clip.mp4' });

    // An article-area tab: pops out by its menu, on the same session (the cookie set in the tab is sent).
    await window.evaluate(url => import('./tabs.js').then(m => m.openChanTab(url)), `${base}/pol/`);
    await expect(storyTab()).toHaveCount(1);
    await menuUntil(window, storyTab, 'Pop out', async () => popouts(app).length === 1);
    await expect(storyTab()).toHaveCount(0);                                   // it left the strip
    let pop = await popoutTitled(app, /Page \/pol\//);
    await expect(pop.locator('webview')).toHaveAttribute('partition', 'persist:chan');
    await expect(pop.locator('webview')).toHaveAttribute('src', `${base}/pol/`);
    await expect.poll(() => inPage(app, pop, `document.getElementById('c')?.textContent ?? ''`).catch(() => '')).toBe('seen=yes');
    // Its page is locked down like a tab's: no preload, no node.
    expect(await inPage(app, pop, `typeof window.polyopticon + typeof require`)).toBe('undefinedundefined');
    // Back / Forward follow the page.
    await expect(pop.locator('#pop-back')).toBeDisabled();
    await inPage(app, pop, `location.href = '/next'`);
    await expect(pop.locator('#pop-back')).toBeEnabled();
    await expect(pop.locator('#pop-title')).toHaveText('Page /next');
    await pop.locator('#pop-back').click();
    await expect(pop.locator('#pop-title')).toHaveText('Page /pol/');
    // Opening the same page again brings up no second tab or window.
    await window.evaluate(url => import('./tabs.js').then(m => m.openChanTab(url)), `${base}/pol/`);
    await expect(storyTab()).toHaveCount(0);
    expect(popouts(app).length).toBe(1);

    // "Return to main window": the tab is back in the strip, selected, and the window is gone.
    await pop.locator('#pop-dock').click();
    await expect(storyTab()).toHaveCount(1);
    await expect(window.locator('#tabs .tab.active .label')).toHaveText('Page /pol/');
    await expect.poll(() => popouts(app).length).toBe(0);

    // A chat (an IRC room): its messages arrive in the pop-out; the tab leaves the chat strip.
    await expect(chatTab()).toHaveCount(1);
    await menuUntil(window, chatTab, 'Pop out', async () => popouts(app).length === 1);
    await expect(chatTab()).toHaveCount(0);
    const chatPop = await popoutTitled(app, /#room on 127\.0\.0\.1/);
    await expect(chatPop.locator('.irc-log')).toContainText('hello from the fake server');
    await expect(chatPop.locator('#pop-nav')).toBeHidden();

    // A stream: pops out on its own session; its tab leaves the stream strip.
    await expect(streamTab()).toHaveCount(1);
    await menuUntil(window, streamTab, 'Pop out', async () => popouts(app).length === 2);
    await expect(streamTab()).toHaveCount(0);
    const streamPop = await popoutTitled(app, /clip\.mp4/);
    await expect(streamPop.locator('webview')).toHaveAttribute('src', video);
    await expect(streamPop.locator('webview')).toHaveAttribute('partition', 'direct-video');

    // The article tab again, so all three kinds float when the app closes.
    await menuUntil(window, storyTab, 'Pop out', async () => popouts(app).length === 3);
    await app.close();
    const ui = JSON.parse(fs.readFileSync(path.join(dir, 'ui.json'), 'utf8'));
    expect(ui.chatPopped).toEqual([`irc:irc://127.0.0.1:${ircPort}/#room`]);
    expect(ui.streamPopped).toEqual([`direct:${video}`]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'pinned.json'), 'utf8')).filter(p => p.popped).map(p => p.url)).toEqual([`${base}/pol/`]);

    // Next start: the three float again, and aren't in the strips.
    app = await launch(dir);
    window = await started(app);
    await expect.poll(() => popouts(app).length, { timeout: 30_000 }).toBe(3);
    await expect(storyTab()).toHaveCount(0);
    await expect(chatTab()).toHaveCount(0);
    await expect(streamTab()).toHaveCount(0);
    pop = await popoutTitled(app, /Page \/pol\//);
    const chatPop2 = await popoutTitled(app, /#room on 127\.0\.0\.1/);
    await expect(chatPop2.locator('.irc-log')).toContainText('hello from the fake server');

    // Closing a pop-out window (here: Ctrl+W in it) puts its tab back where it came from.
    await chatPop2.locator('#pop-title').click();
    await chatPop2.keyboard.press('Control+w').catch(() => {});                  // the window closes under the key press
    await expect(chatTab()).toHaveCount(1);
    await expect(window.locator('#chat-views .irc-log')).toContainText('hello from the fake server');
    await pop.close();
    await expect(storyTab()).toHaveCount(1);
    await expect.poll(() => popouts(app).length).toBe(1);                       // the stream still floats
    await app.close();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'ui.json'), 'utf8')).chatPopped).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
