'use strict';

// Site logins and cookie choices last between launches, as in a browser (src/main/websession.js):
// session cookies (no expiry), persistent cookies and site storage come back after the app is
// closed — and after it is killed, once the few-second save has run. A local server stands in for
// a site that logs you in with a session cookie and remembers a consent answer in a dated one.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { test, expect, _electron: electron } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..', '..');

let server, base;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const headers = { 'Content-Type': 'text/html' };
    if (req.url === '/login') headers['Set-Cookie'] = [
      'sid=abc123; Path=/; HttpOnly',                                      // session cookie: no Expires / Max-Age
      'consent=yes; Path=/; Max-Age=31536000',                             // persistent
    ];
    res.writeHead(200, headers);
    res.end(`<html><body><script>localStorage.setItem('choice', 'accepted')</script>Logged in</body></html>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => server?.close());

const launch = dir => electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, POLYOPTICON_DATA_DIR: dir, POLYOPTICON_OFFSCREEN: '1', POLYOPTICON_NO_PREFETCH: '1' } });

/** Loads `url` in a hidden page on the given session, as a tab would. */
const visit = (app, partition, url) => app.evaluate(({ BrowserWindow }, [partition, url]) => {
  const w = new BrowserWindow({ show: false, webPreferences: { partition } });
  return w.loadURL(url).then(() => w.webContents.executeJavaScript(`localStorage.getItem('choice')`)).finally(() => w.destroy());
}, [partition, url]);

const cookies = (app, partition, url) => app.evaluate(({ session }, [partition, url]) =>
  session.fromPartition(partition).cookies.get({ url }).then(list => Object.fromEntries(list.map(c => [c.name, c.session ? 'session' : 'persistent']))),
[partition, url]);

async function started(app) {
  const window = await app.firstWindow();
  await expect(window.locator('#status-text')).not.toHaveText('Connecting…');
  return window;
}

for (const partition of ['persist:articles', 'persist:chan']) {
  test(`logins and cookie choices in ${partition} survive a restart and a crash`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyopticon-sites-'));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ChatDestiny: false, ChatTwitchChannels: '', ChatIrc: '' }));
    try {
      let app = await launch(dir);
      await started(app);
      expect(await visit(app, partition, `${base}/login`)).toBe('accepted');
      expect(await cookies(app, partition, base)).toEqual({ sid: 'session', consent: 'persistent' });
      await app.close();

      // Closed and opened again: the login (a session cookie) is back before any page loads.
      app = await launch(dir);
      await started(app);
      expect(await cookies(app, partition, base)).toEqual({ sid: 'session', consent: 'persistent' });
      expect(await visit(app, partition, `${base}/page`)).toBe('accepted');      // site storage too

      // A new login, then the app is killed (no quit events): the save a few seconds later kept it.
      await app.evaluate(({ session }, [partition, url]) =>
        session.fromPartition(partition).cookies.set({ url, name: 'sid2', value: 'later' }), [partition, base]);
      await new Promise(r => setTimeout(r, 7_000));                            // past the 5 s save delay
      app.process().kill('SIGKILL');
      await new Promise(r => app.process().once('exit', r));

      app = await launch(dir);
      await started(app);
      expect(await cookies(app, partition, base)).toEqual({ sid: 'session', sid2: 'session', consent: 'persistent' });
      await app.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
}
