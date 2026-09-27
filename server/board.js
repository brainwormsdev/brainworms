// "Break the worm": messages ranked by the most cells firing at once (the `peak` in their summary).
// One entry per distinct message (the best run of it), today's board (UTC) and all-time.
import fs from 'node:fs';

const norm = (t) => t.toLowerCase().replace(/\s+/g, ' ').trim();
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
const better = (a, b) => b.peak - a.peak || a.ts - b.ts;

export class Board {
  /** model: the model the scores come from; a board saved under another model starts fresh (its scale differs). */
  constructor({ size = 10, file = null, model = null } = {}) {
    this.size = size;
    this.file = file;
    this.model = model;
    this.day = { key: dayKey(Date.now()), list: [] };
    this.all = [];
    this.tugs = [];               // recent tug results, newest first
    this._saveTimer = null;
    if (file) {
      try {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        if ((s.model || null) !== model) throw new Error('scores from another model');
        if (Array.isArray(s.all)) this.all = s.all;
        if (Array.isArray(s.tugs)) this.tugs = s.tugs;
        if (s.day && s.day.key === this.day.key && Array.isArray(s.day.list)) this.day = s.day;
      } catch { /* first run */ }
    }
  }

  _rollDay(ts) { const k = dayKey(ts); if (k !== this.day.key) this.day = { key: k, list: [] }; }

  _insert(list, e) {
    const i = list.findIndex((x) => norm(x.text) === norm(e.text));
    if (i >= 0) { if (list[i].peak >= e.peak) return false; list.splice(i, 1); }
    list.push(e);
    list.sort(better);
    if (list.length > this.size) list.length = this.size;
    return list.includes(e);
  }

  /** Add a finished message. Returns {changed, record: null | 'day' | 'all'}. */
  add({ id, text, by, peak, ts = Date.now() }) {
    this._rollDay(ts);
    if (!(peak > 0)) return { changed: false, record: null };
    const e = { id, text, by, peak, ts };
    const prevAll = this.all[0], prevDay = this.day.list[0];
    const inAll = this._insert(this.all, { ...e }), inDay = this._insert(this.day.list, { ...e });
    if (!inAll && !inDay) return { changed: false, record: null };
    this._save();
    let record = null;
    if (prevAll && this.all[0].id === id && peak > prevAll.peak) record = 'all';
    else if (prevDay && this.day.list[0].id === id && peak > prevDay.peak) record = 'day';
    return { changed: true, record };
  }

  /** Remove entries (e.g. a message the mods hid). */
  remove(pred) {
    const nAll = this.all.length, nDay = this.day.list.length, nTug = this.tugs.length;
    this.all = this.all.filter((e) => !pred(e));
    this.day.list = this.day.list.filter((e) => !pred(e));
    this.tugs = this.tugs.filter((e) => !pred(e));
    const changed = nAll !== this.all.length || nDay !== this.day.list.length || nTug !== this.tugs.length;
    if (changed) this._save();
    return changed;
  }

  /** Remember a finished tug (most recent 20). */
  addTug({ id, a, b, by, result, ts = Date.now() }) {
    this.tugs.unshift({ id, a, b, by, result, ts });
    if (this.tugs.length > 20) this.tugs.length = 20;
    this._save();
  }

  snapshot(now = Date.now()) {
    this._rollDay(now);
    return { day: this.day.key, today: this.day.list, all: this.all, tugs: this.tugs };
  }

  _save() {
    if (!this.file || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      fs.writeFile(this.file, JSON.stringify({ model: this.model, day: this.day, all: this.all, tugs: this.tugs }), () => {});
    }, 1000);
    this._saveTimer.unref?.();
  }

  flush() {
    if (!this.file) return;
    clearTimeout(this._saveTimer); this._saveTimer = null;
    try { fs.writeFileSync(this.file, JSON.stringify({ model: this.model, day: this.day, all: this.all, tugs: this.tugs })); } catch { /* disk gone */ }
  }
}
