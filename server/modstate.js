// What the mods have switched on: paused chat or pokes, slow mode, an announcement, muted senders
// and extra blocklist phrases. Saved to disk so a restart doesn't undo a raid response.
import fs from 'node:fs';
import crypto from 'node:crypto';

export class ModState {
  constructor({ file = null } = {}) {
    this.file = file;
    this.chatPaused = false;
    this.pokesPaused = false;
    this.slowSec = 0;
    this.announce = null;          // {text, until}
    this.bans = new Map();         // key -> {label, until, reason}
    this.extra = [];               // extra lower-case blocklist phrases
    this.salt = '';                // secret salt for hashing visitor addresses into mute keys
    if (file) {
      try {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.chatPaused = !!s.chatPaused; this.pokesPaused = !!s.pokesPaused; this.slowSec = s.slowSec | 0;
        this.announce = s.announce || null;
        this.bans = new Map(s.bans || []);
        this.extra = Array.isArray(s.extra) ? s.extra : [];
        this.salt = s.salt || '';
      } catch { /* first run */ }
    }
    if (!this.salt) { this.salt = crypto.randomBytes(16).toString('hex'); this.save(); }
  }

  isBanned(key, now = Date.now()) {
    const b = this.bans.get(key);
    if (!b) return false;
    if (b.until <= now) { this.bans.delete(key); this.save(); return false; }
    return true;
  }

  ban(key, label, hours, reason = '') {
    this.bans.set(key, { label, until: Date.now() + hours * 3600e3, reason });
    this.save();
  }

  unban(key) { const had = this.bans.delete(key); if (had) this.save(); return had; }

  publicState(now = Date.now()) {
    if (this.announce && this.announce.until <= now) this.announce = null;
    return { chatPaused: this.chatPaused, pokesPaused: this.pokesPaused, slowSec: this.slowSec, announce: this.announce };
  }

  banList(now = Date.now()) {
    for (const [k, b] of this.bans) if (b.until <= now) this.bans.delete(k);
    return [...this.bans].map(([key, b]) => ({ key, ...b }));
  }

  save() {
    if (!this.file) return;
    const s = { chatPaused: this.chatPaused, pokesPaused: this.pokesPaused, slowSec: this.slowSec, announce: this.announce, bans: [...this.bans], extra: this.extra, salt: this.salt };
    fs.writeFile(this.file, JSON.stringify(s), () => {});
  }
}

/** Events in the last minute, for the mod panel's stats strip. */
export class Counter {
  constructor() { this.t = []; }
  hit(now = Date.now()) { this.t.push(now); if (this.t.length > 5000) this.t.splice(0, this.t.length - 5000); }
  lastMinute(now = Date.now()) { while (this.t.length && this.t[0] < now - 60e3) this.t.shift(); return this.t.length; }
}
