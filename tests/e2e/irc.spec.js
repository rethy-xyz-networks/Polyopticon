'use strict';

// IRC chats: added from the ➕ row of chat types, joined anonymously (no PASS, no login),
// and shown as a message list in a chat tab. Runs against a tiny fake IRC server on localhost.

const net = require('net');
const { test, expect } = require('./fixtures');

let server, port;
const received = [];
const sockets = new Set();

test.beforeAll(async () => {
  server = net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let nick = '';
    let buf = '';
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        received.push(line);
        if (line.startsWith('NICK ')) nick = line.slice(5);
        if (line.startsWith('USER ')) socket.write(`:srv 001 ${nick} :Welcome\r\n`);
        if (line.startsWith('JOIN ')) {
          const room = line.slice(5);
          socket.write(`:${nick}!u@h JOIN ${room}\r\n:srv 332 ${nick} ${room} :Topic of the day\r\n:srv 353 ${nick} = ${room} :@op alice dave ${nick}\r\n:srv 366 ${nick} ${room} :End\r\n`);
          socket.write(`:alice!a@h PRIVMSG ${room} :\x02hello\x02 from the fake server\r\n`);
          socket.write(`:alice!a@h PRIVMSG ${room} :\x01ACTION waves\x01\r\n`);
          socket.write(`:carol!c@h JOIN ${room}\r\n:carol!c@h PART ${room} :see you\r\n:dave!d@h QUIT :Ping timeout\r\n`);
          socket.write(`:alice!a@h NICK :alice_away\r\n:op!o@h KICK ${room} alice_away :behave\r\n:op!o@h TOPIC ${room} :New topic\r\n`);
          socket.write(`:eve!e@h QUIT :never seen in this room\r\n`);
          socket.write(`:bob!b@h PRIVMSG ${nick} :a private message that must not show\r\n`);
        }
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
test.afterAll(() => { for (const s of sockets) s.destroy(); server?.close(); });

test('➕ shows the chat types; IRC asks for a server and a room, connects anonymously and shows the room', async ({ window }) => {
  await window.locator('#btn-chat').click();
  await window.locator('#chat-add-btn').click();
  for (const id of ['#chat-type-twitch', '#chat-type-dgg', '#chat-type-irc']) await expect(window.locator(id)).toBeVisible();
  await expect(window.locator('#chat-add-twitch')).toBeHidden();
  await expect(window.locator('#chat-add-irc')).toBeHidden();

  await window.locator('#chat-type-twitch').click();
  await expect(window.locator('#chat-add-twitch')).toBeVisible();
  await window.locator('#chat-type-irc').click();                      // the second row switches to the IRC fields
  await expect(window.locator('#chat-add-twitch')).toBeHidden();
  await expect(window.locator('#chat-irc-server')).toBeVisible();
  await expect(window.locator('#chat-irc-room')).toBeVisible();

  await window.locator('#chat-irc-server').fill('not a server!');
  await window.locator('#chat-irc-room').fill('test');
  await window.getByRole('button', { name: 'Connect' }).click();
  await expect(window.locator('#chat-irc-server')).toHaveClass(/invalid/);

  await window.locator('#chat-irc-server').fill(`irc://127.0.0.1:${port}`);
  await window.getByRole('button', { name: 'Connect' }).click();

  const tab = window.locator('.chat-tab.irc');
  await expect(tab).toHaveCount(1);
  await expect(tab).toContainText('#test');
  const log = window.locator('.irc-view .irc-log');
  await expect(log).toContainText('hello from the fake server');         // formatting codes stripped
  await expect(log).toContainText('alice');
  await expect(log.locator('.irc-line.action')).toContainText('waves');
  await expect(log).not.toContainText('private message');
  await expect(window.locator('.irc-status')).toContainText('#test');
  // Who is here: op, alice, dave and the guest = 4; carol came and went, dave quit, alice was kicked -> 2.
  await expect(window.locator('.irc-status')).toContainText('2 users');
  await expect(window.locator('.irc-topic')).toHaveText('New topic');

  // The log says what happened: connecting, connected, joined, and who came and went.
  for (const line of ['Connecting to 127.0.0.1', 'Connected — joining #test', 'Joined #test', 'carol joined', 'carol left (see you)',
    'dave quit (Ping timeout)', 'alice is now known as alice_away', 'alice_away was kicked by op (behave)', 'op changed the topic to: New topic'])
    await expect(log).toContainText(line);
  await expect(log).not.toContainText('eve');                              // a quit from someone who was never in this room

  // Anonymous: a guest nick, no password, no services login.
  expect(received.some(l => /^NICK Guest\d+$/.test(l))).toBe(true);
  expect(received.some(l => /^(PASS|AUTHENTICATE|PRIVMSG NickServ)/i.test(l))).toBe(false);
  expect(received).toContain('JOIN #test');

  // The room is remembered, and ✕ on its tab leaves it (the connection closes).
  await tab.hover();
  await tab.locator('.x').click();
  await expect(window.locator('.chat-tab.irc')).toHaveCount(0);
  await expect.poll(() => received.some(l => l.startsWith('QUIT'))).toBe(true);
});

test('Kick chats: ➕ -> Kick -> a channel name or link opens chat.kick.cx/embed/<channel> as a tab', async ({ window }) => {
  await window.locator('#btn-chat').click();
  await window.locator('#chat-add-btn').click();
  await expect(window.locator('#chat-type-kick')).toBeVisible();
  await window.locator('#chat-type-kick').click();
  await expect(window.locator('#chat-add-kick')).toBeVisible();

  const input = window.locator('#chat-add-kick-input');
  await input.fill('x');                                               // too short
  await input.press('Enter');
  await expect(input).toHaveClass(/invalid/);

  await input.fill('https://kick.com/XQC');
  await input.press('Enter');
  await expect(window.locator('#chat-tabs .chat-tab.kick.active .name')).toHaveText('xqc');
  await expect(window.locator('#chat-views webview:not(.inactive)')).toHaveAttribute('src', 'https://chat.kick.cx/embed/xqc');

  // Pasting the embed link itself works too, and the channel is kept in Settings.
  await window.locator('#chat-add-btn').click();
  await window.locator('#chat-type-kick').click();
  await input.fill('chat.kick.cx/embed/trainwreckstv');
  await input.press('Enter');
  await expect(window.locator('#chat-tabs .chat-tab.kick .name')).toHaveText(['xqc', 'trainwreckstv']);
  const saved = await window.evaluate(() => import('./state.js').then(m => m.state.settings.ChatKickChannels));
  expect(saved).toBe('xqc, trainwreckstv');

  // ✕ removes just that channel.
  const xqc = window.locator('#chat-tabs .chat-tab.kick', { hasText: 'xqc' });
  await xqc.hover();                                                   // the ✕ shows on hover
  await xqc.locator('.x').click();
  await expect(window.locator('#chat-tabs .chat-tab.kick .name')).toHaveText(['trainwreckstv']);
});
