(function (scope) {
  'use strict';
  const MINUTES = [0, 1, 5, 10];
  const minutes = value => MINUTES.includes(value) ? value : 5;
  class FetchSchedule {
    constructor(clock = () => performance.now()) { this.clock = clock; this.entries = new Map(); }
    key(dir, remote) { return JSON.stringify([dir, remote]); }
    entry(dir, remote) {
      const key = this.key(dir, remote);
      if (!this.entries.has(key)) this.entries.set(key, { next: this.clock(), last: null, failures: 0, pending: false });
      return this.entries.get(key);
    }
    seed(dir, remote, fetchedAt, interval) {
      const key = this.key(dir, remote);
      if (this.entries.has(key)) return;
      const elapsed = Date.now() - Date.parse(fetchedAt);
      const wait = Number.isFinite(elapsed) ? Math.max(0, interval - Math.max(0, elapsed)) : 0;
      this.entries.set(key, { next: this.clock() + wait, last: Number.isFinite(elapsed) ? this.clock() - Math.max(0, elapsed) : null, failures: 0, pending: false });
    }
    due(dir, remote, enabled) { const e = this.entry(dir, remote); return !!enabled && !e.pending && this.clock() >= e.next; }
    begin(dir, remote) { const e = this.entry(dir, remote); if (e.pending) return false; e.pending = true; return true; }
    finish(dir, remote, interval, success) {
      const e = this.entry(dir, remote); e.pending = false;
      if (success) { e.failures = 0; e.last = this.clock(); }
      else e.failures++;
      e.next = this.clock() + (success ? interval : Math.max(interval, Math.min(15 * 60000, 60000 * 2 ** Math.min(e.failures - 1, 4))));
    }
    reconfigure(interval) {
      for (const e of this.entries.values()) e.next = e.last === null ? this.clock() : e.last + interval;
    }
  }
  scope.GitFetchSchedule = { FetchSchedule, minutes };
  if (typeof module !== 'undefined') module.exports = scope.GitFetchSchedule;
})(typeof window !== 'undefined' ? window : globalThis);
