import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createTwitchBridge, parseIrc } from '../server/twitch.js';

const quiet = { log() {}, warn() {} };
const ROOM = '#worm_stream';

// A tiny stand-in for irc-ws.chat.twitch.tv: records every line each client sends.
async function mockIrc() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const srv = { conns: [], autoPong: false, onConn: null, url: `ws://127.0.0.1:${wss.address().port}` };
  wss.on('connection', (ws) => {
    const c = { ws, lines: [], t: Date.now(), closeCode: null, send: (...l) => ws.send(l.join('\r\n')) };
    ws.on('message', (d) => {
      for (const line of String(d).split('\r\n').filter(Boolean)) {
        c.lines.push(line);
        if (srv.autoPong && line.startsWith('PING')) ws.send(':tmi.twitch.tv PONG tmi.twitch.tv :tmi.twitch.tv');
      }
    });
    ws.on('close', (code) => { c.closeCode = code; });
    srv.conns.push(c);
    srv.onConn?.(c);
  });
  srv.close = () => new Promise((r) => { for (const c of srv.conns) c.ws.terminate(); wss.close(r); });
  return srv;
}

async function until(pred, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const loggedIn = (srv, i = 0) => until(() => srv.conns[i]?.lines.includes(`JOIN ${ROOM}`));
const nickOf = (c) => c.lines.find((l) => l.startsWith('NICK ')).slice(5);
const pm = (login, text, tags = '') => `${tags ? `@${tags} ` : ''}:${login}!${login}@${login}.tmi.twitch.tv PRIVMSG ${ROOM} :${text}`;

test('validates and normalises the channel', () => {
  const bot = createTwitchBridge({ channel: '  #Worm_Stream' });
  assert.deepEqual(bot.status(), { enabled: true, channel: 'worm_stream', connected: false, joined: false, received: 0, lastMessageAt: null, reconnects: 0 });
  for (const bad of [undefined, '', '#', 'a', 'has space', 'x'.repeat(26), 'worm-stream', 'wörm']) {
    assert.throws(() => createTwitchBridge({ channel: bad }), /Invalid Twitch channel/);
  }
});

test('parseIrc: tags with escapes, prefix, command, params, trailing', () => {
  const m = parseIrc('@a=x\\sy\\:z\\\\w\\r\\n;empty=;flag;q=\\q;end=ab\\ :nick!nick@nick.tmi.twitch.tv PRIVMSG #chan :hello :) there');
  assert.deepEqual(m.tags, { a: 'x y;z\\w\r\n', empty: '', flag: '', q: 'q', end: 'ab' });
  assert.equal(m.prefix, 'nick!nick@nick.tmi.twitch.tv');
  assert.equal(m.nick, 'nick');
  assert.equal(m.command, 'PRIVMSG');
  assert.deepEqual(m.params, ['#chan', 'hello :) there']);
  assert.equal(m.trailing, 'hello :) there');
  const p = parseIrc('PING :tmi.twitch.tv');
  assert.equal(p.command, 'PING'); assert.equal(p.trailing, 'tmi.twitch.tv'); assert.equal(p.prefix, '');
  const r = parseIrc('@emote-only=0;room-id=12 :tmi.twitch.tv ROOMSTATE #chan');
  assert.deepEqual([r.command, r.params, r.trailing, r.tags['room-id']], ['ROOMSTATE', ['#chan'], '', '12']);
});

test('logs in anonymously, joins, and answers PING', async () => {
  const srv = await mockIrc();
  const bot = createTwitchBridge({ channel: '#Worm_Stream', url: srv.url, logger: quiet });
  try {
    bot.start();
    bot.start();   // idempotent
    await loggedIn(srv);
    const c = srv.conns[0];
    assert.equal(c.lines[0], 'CAP REQ :twitch.tv/tags twitch.tv/commands');
    assert.equal(c.lines[1], 'PASS SCHMOOPIIE');
    assert.match(c.lines[2], /^NICK justinfan[1-9]\d{4}$/);
    assert.equal(c.lines[3], `JOIN ${ROOM}`);
    assert.equal(c.lines.length, 4);
    assert.equal(bot.status().connected, true);
    assert.equal(bot.status().joined, false);

    // someone else joining doesn't count; the PONG proves that line was already handled
    c.send(':someone!someone@someone.tmi.twitch.tv JOIN #worm_stream', 'PING :tmi.twitch.tv');
    await until(() => c.lines.includes('PONG :tmi.twitch.tv'));
    assert.equal(bot.status().joined, false);

    const nick = nickOf(c);
    c.send(`:${nick}!${nick}@${nick}.tmi.twitch.tv JOIN #worm_stream`);
    await until(() => bot.status().joined);
    assert.equal(srv.conns.length, 1);
  } finally {
    await bot.stop(); await srv.close();
  }
});

test('turns chat commands into onSay / onPoke with sanitised users', async () => {
  const srv = await mockIrc();
  const says = [], pokes = [];
  const bot = createTwitchBridge({
    channel: 'worm_stream', url: srv.url, logger: quiet, now: () => 1234,
    onSay: (user, text) => says.push([user, text]), onPoke: (user) => pokes.push(user),
  });
  try {
    bot.start();
    await loggedIn(srv);
    const c = srv.conns[0];
    c.send('@emote-only=0;room-id=12 :tmi.twitch.tv ROOMSTATE #worm_stream');
    await until(() => bot.status().joined);
    assert.equal(bot.status().lastMessageAt, null);

    // all in one frame, like Twitch batches them
    c.send(
      pm('alice', '!worm hello there', 'badge-info=;color=#FF0000;display-name=Alice_W;user-id=123'),
      pm('bob', '!WORM   x  ', 'display-name=B\\so\\:b\\\\;user-id=456'),
      pm('carol', 'just chatting about !worm stuff'),
      pm('dave', '!poke', 'display-name=デイブ;user-id=789'),
      pm('erin', '!POKE the worm', 'user-id=abc'),
      pm('frank', '!pokey'),
      pm('gina', '!worm'),
      pm('gina', '!worm    '),
      pm('gina', '!wormy hi'),
      pm(nickOf(c), '!worm from myself'),
      ':henry!henry@henry.tmi.twitch.tv PRIVMSG #elsewhere :!worm wrong room',
      pm('ivan', '\x01ACTION !poke\x01'),
      pm('judy', '!worm gm fam \u{E0000}', 'display-name=Judy'),
    );
    await until(() => bot.status().received === 11);
    assert.deepEqual(says, [
      [{ login: 'alice', name: 'Alice_W', id: '123' }, 'hello there'],
      [{ login: 'bob', name: 'Bob', id: '456' }, 'x'],
      [{ login: 'judy', name: 'Judy', id: '' }, 'gm fam'],
    ]);
    assert.deepEqual(pokes, [
      { login: 'dave', name: 'dave', id: '789' },
      { login: 'erin', name: 'erin', id: '' },
      { login: 'ivan', name: 'ivan', id: '' },
    ]);
    assert.equal(bot.status().lastMessageAt, 1234);
  } finally {
    await bot.stop(); await srv.close();
  }
});

test('custom commands, and handlers that throw or reject do not break the bridge', async () => {
  const srv = await mockIrc();
  const says = [];
  const bot = createTwitchBridge({
    channel: 'worm_stream', url: srv.url, logger: quiet, sayPrefix: '!Say', pokeCommand: '!boop',
    onSay: (u, text) => { says.push(text); if (text === 'boom') throw new Error('boom'); if (text === 'later') return Promise.reject(new Error('later')); },
    onPoke: () => { throw new Error('poke failed'); },
  });
  try {
    bot.start();
    await loggedIn(srv);
    srv.conns[0].send(pm('a1', '!say boom'), pm('a2', '!BOOP'), pm('a3', '!say later'), pm('a4', '!worm ignored'), pm('a5', '!SAY still here'));
    await until(() => bot.status().received === 5);
    await new Promise((r) => setTimeout(r, 20));   // let the rejected promise settle
    assert.deepEqual(says, ['boom', 'later', 'still here']);
    assert.equal(bot.status().connected, true);
  } finally {
    await bot.stop(); await srv.close();
  }
});

test('reconnects on RECONNECT and when the server drops, with exponential backoff reset by JOIN', async () => {
  const srv = await mockIrc();
  const bot = createTwitchBridge({ channel: 'worm_stream', url: srv.url, logger: quiet, backoffMs: 20 });
  const join = (c) => c.send(`:tmi.twitch.tv ROOMSTATE ${ROOM}`);
  try {
    bot.start();
    await loggedIn(srv);
    join(srv.conns[0]);
    await until(() => bot.status().joined);

    srv.conns[0].send(':tmi.twitch.tv RECONNECT');
    await loggedIn(srv, 1);
    assert.equal(bot.status().reconnects, 1);
    join(srv.conns[1]);
    await until(() => bot.status().joined);

    // the server now drops every new connection straight away: 20, 40, 80 ms between tries
    srv.onConn = (c) => c.ws.terminate();
    srv.conns[1].ws.terminate();
    await until(() => srv.conns.length >= 5);
    srv.onConn = null;
    const gap = (i) => srv.conns[i + 1].t - srv.conns[i].t;
    assert.ok(gap(2) >= 35, `second retry waited ${gap(2)} ms`);
    assert.ok(gap(3) >= 75, `third retry waited ${gap(3)} ms`);
    assert.ok(gap(3) > gap(2));

    // a successful JOIN resets the backoff to 20 ms
    const n = srv.conns.length;
    await loggedIn(srv, n);   // the next one is allowed through
    join(srv.conns[n]);
    await until(() => bot.status().joined);
    srv.conns[n].ws.terminate();
    await loggedIn(srv, n + 1);
    assert.ok(srv.conns[n + 1].t - srv.conns[n].t < 250, 'backoff was reset');
    assert.equal(bot.status().reconnects, n + 1);
    assert.equal(bot.status().connected, true);
  } finally {
    await bot.stop(); await srv.close();
  }
});

test('client PING keeps a live link and replaces a silent one', async () => {
  const srv = await mockIrc();
  srv.autoPong = true;
  const bot = createTwitchBridge({ channel: 'worm_stream', url: srv.url, logger: quiet, backoffMs: 10, pingIntervalMs: 30, pingTimeoutMs: 60 });
  try {
    bot.start();
    await loggedIn(srv);
    await until(() => srv.conns[0].lines.filter((l) => l === 'PING :tmi.twitch.tv').length >= 4);
    assert.equal(srv.conns.length, 1, 'answered pings keep the connection');

    srv.autoPong = false;
    await loggedIn(srv, 1);
    assert.equal(bot.status().reconnects, 1);
  } finally {
    await bot.stop(); await srv.close();
  }
});

test('stop() closes cleanly and leaves no timers behind', async () => {
  const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timeouts();
  const srv = await mockIrc();
  const bot = createTwitchBridge({ channel: 'worm_stream', url: srv.url, logger: quiet, backoffMs: 60_000 });

  // stop while connected: a normal close handshake
  bot.start();
  await loggedIn(srv);
  await bot.stop();
  await until(() => srv.conns[0].closeCode !== null);
  assert.equal(srv.conns[0].closeCode, 1000);
  assert.equal(bot.status().connected, false);

  // stop while waiting to retry
  bot.start();
  await loggedIn(srv, 1);
  srv.conns[1].ws.terminate();
  await until(() => !bot.status().connected);
  await bot.stop();

  // stop while still connecting
  bot.start();
  await bot.stop();

  await srv.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(timeouts() <= before, `timers left: ${timeouts() - before}`);
});
