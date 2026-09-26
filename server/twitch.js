// Twitch Plays Worm: a read-only, anonymous Twitch chat bridge over IRC-over-WebSocket.
// It joins one channel as a justinfan guest (it can't post) and turns `!worm <text>` and `!poke`
// into onSay / onPoke calls. Moderation, rate limits and bans are the caller's job.
// It never logs chat content.
import { WebSocket } from 'ws';

const CHANNEL = /^[a-z0-9_]{2,25}$/;
const MAX_BACKOFF = 60_000;
const OPEN = 1, CLOSED = 3;
const TAG_ESC = { ':': ';', s: ' ', '\\': '\\', r: '\r', n: '\n' };
const unescapeTag = (v) => v.replace(/\\(.?)/gs, (_, c) => TAG_ESC[c] ?? c);

/** Parse one IRC line (IRCv3 tags, prefix, command, params). The trailing param is also the last of `params`. */
export function parseIrc(line) {
  const m = { tags: {}, prefix: '', nick: '', command: '', params: [], trailing: '' };
  let rest = line;
  if (rest[0] === '@') {
    const sp = rest.indexOf(' ');
    for (const kv of rest.slice(1, sp < 0 ? rest.length : sp).split(';')) {
      if (!kv) continue;
      const eq = kv.indexOf('=');
      m.tags[eq < 0 ? kv : kv.slice(0, eq)] = eq < 0 ? '' : unescapeTag(kv.slice(eq + 1));
    }
    rest = sp < 0 ? '' : rest.slice(sp + 1).trimStart();
  }
  if (rest[0] === ':') {
    const sp = rest.indexOf(' ');
    m.prefix = rest.slice(1, sp < 0 ? rest.length : sp);
    m.nick = m.prefix.split(/[!@]/)[0];
    rest = sp < 0 ? '' : rest.slice(sp + 1).trimStart();
  }
  const t = rest.indexOf(' :');
  if (t >= 0) { m.trailing = rest.slice(t + 2); rest = rest.slice(0, t); }
  const parts = rest.split(' ').filter(Boolean);
  m.command = (parts.shift() || '').toUpperCase();
  m.params = t >= 0 ? [...parts, m.trailing] : parts;
  return m;
}

/**
 * Read-only, anonymous Twitch chat bridge.
 * opts: { channel, sayPrefix='!worm', pokeCommand='!poke', onSay(user, text), onPoke(user),
 *   url, WebSocketImpl (ws-compatible), logger=console, now=Date.now,
 *   backoffMs=1000, pingIntervalMs=240000, pingTimeoutMs=10000 }
 * user = { login, name, id }. Returns { start(), stop(): Promise, status() }.
 */
export function createTwitchBridge(opts = {}) {
  const channel = String(opts.channel ?? '').trim().toLowerCase().replace(/^#/, '');
  if (!CHANNEL.test(channel)) throw new Error(`Invalid Twitch channel name: ${JSON.stringify(opts.channel)}`);
  const {
    sayPrefix = '!worm', pokeCommand = '!poke', onSay = () => {}, onPoke = () => {},
    url = 'wss://irc-ws.chat.twitch.tv:443', WebSocketImpl = WebSocket, logger = console, now = () => Date.now(),
    backoffMs = 1000, pingIntervalMs = 4 * 60_000, pingTimeoutMs = 10_000,
  } = opts;
  const room = '#' + channel;
  const sayCmd = sayPrefix.toLowerCase(), pokeCmd = pokeCommand.toLowerCase();
  const st = { enabled: true, channel, connected: false, joined: false, received: 0, lastMessageAt: null, reconnects: 0 };
  let ws = null, nick = '', running = false, attempt = 0;
  let retryTimer = null, pingTimer = null, pongTimer = null;

  const send = (line) => { if (ws && ws.readyState === OPEN) ws.send(line); };
  const clearTimers = () => {
    clearTimeout(retryTimer); clearInterval(pingTimer); clearTimeout(pongTimer);
    retryTimer = pingTimer = pongTimer = null;
  };

  function connect() {
    retryTimer = null;
    nick = `justinfan${10000 + Math.floor(Math.random() * 90000)}`;
    let sock;
    try { sock = new WebSocketImpl(url, { handshakeTimeout: 10_000, closeTimeout: 2000 }); } catch (err) {
      logger.warn(`[twitch] cannot connect: ${err.message}`);
      return retry();
    }
    ws = sock;
    sock.on('open', () => {
      if (sock !== ws) return;
      st.connected = true;
      logger.log(`[twitch] connected, joining ${room}`);
      for (const l of ['CAP REQ :twitch.tv/tags twitch.tv/commands', 'PASS SCHMOOPIIE', `NICK ${nick}`, `JOIN ${room}`]) sock.send(l);
      // Our own keepalive: a half-open socket otherwise looks like a quiet channel forever.
      pingTimer = setInterval(() => {
        send('PING :tmi.twitch.tv');
        pongTimer ??= setTimeout(() => { logger.warn('[twitch] ping timed out'); sock.terminate(); }, pingTimeoutMs);
      }, pingIntervalMs);
    });
    sock.on('message', (data) => {
      if (sock !== ws) return;
      clearTimeout(pongTimer); pongTimer = null;   // any data proves the link is alive
      for (const line of String(data).split(/\r?\n/)) if (line) handle(parseIrc(line));
    });
    sock.on('error', (err) => { if (sock === ws) logger.warn(`[twitch] ${err.message}`); });
    sock.on('close', () => {
      if (sock !== ws) return;
      clearTimers();
      ws = null;
      st.connected = st.joined = false;
      if (running) retry();
    });
  }

  function retry() {
    const delay = Math.min(MAX_BACKOFF, backoffMs * 2 ** Math.min(attempt++, 16));
    logger.warn(`[twitch] disconnected, reconnecting in ${delay / 1000}s`);
    retryTimer = setTimeout(() => { st.reconnects++; connect(); }, delay);
  }

  function handle(m) {
    switch (m.command) {
      case 'PING': send(`PONG :${m.trailing || 'tmi.twitch.tv'}`); break;
      case 'RECONNECT': logger.log('[twitch] server asked us to reconnect'); ws?.terminate(); break;
      case 'JOIN': if (m.nick === nick && m.params[0] === room) joined(); break;
      case 'ROOMSTATE': if (m.params[0] === room) joined(); break;
      case 'NOTICE': logger.warn(`[twitch] notice: ${m.tags['msg-id'] || m.trailing}`); break;
      case 'PRIVMSG': if (m.params[0] === room) chat(m); break;
    }
  }

  function joined() {
    if (st.joined) return;
    st.joined = true; attempt = 0;
    logger.log(`[twitch] joined ${room}`);
  }

  function chat(m) {
    const login = m.nick.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!login || login === nick) return;
    st.received++; st.lastMessageAt = now();
    const text = m.trailing
      .replace(/^\x01ACTION (.*?)\x01?$/s, '$1')     // /me
      .replace(/[\u{E0000}-\u{E007F}]/gu, '')         // Chatterino/7TV append U+E0000 to dodge the duplicate filter
      .trim();
    const sp = text.search(/\s/);
    const cmd = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
    if (cmd !== sayCmd && cmd !== pokeCmd) return;
    const id = m.tags['user-id'] || '';
    const user = { login, name: (m.tags['display-name'] || '').replace(/[^A-Za-z0-9_]/g, '') || login, id: /^\d{1,20}$/.test(id) ? id : '' };
    if (cmd === pokeCmd) return safely(onPoke, user);
    const arg = sp < 0 ? '' : text.slice(sp + 1).trim();
    if (arg) safely(onSay, user, arg);
  }

  function safely(fn, ...args) {
    const warn = (err) => logger.warn(`[twitch] handler failed: ${err?.message || err}`);
    try { const r = fn(...args); if (r && typeof r.catch === 'function') r.catch(warn); } catch (err) { warn(err); }
  }

  return {
    start() {
      if (running) return;
      running = true; attempt = 0;
      connect();
    },
    stop() {
      running = false;
      clearTimers();
      const sock = ws; ws = null;
      st.connected = st.joined = false;
      if (!sock || sock.readyState === CLOSED) return Promise.resolve();
      return new Promise((resolve) => {
        sock.once('close', resolve);
        if (sock.readyState === OPEN) sock.close(1000); else sock.terminate();
      });
    },
    status: () => ({ ...st }),
  };
}
