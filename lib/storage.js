'use strict';
// ---------------------------------------------------------------------
// Torrentor — tiny JSON persistence (main process).
//
// Everything the app remembers (search history, favorites, engine
// toggles, the VPN/proxy route) lives in plain JSON files under the
// userData directory. No native modules — install stays light and the
// data stays human-readable/portable. Writes are debounced + atomic
// (tmp file + rename) so a crash never corrupts state.
// ---------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const HISTORY_LIMIT = 200;
const FAVORITES_LIMIT = 500;

const DEFAULTS = {
  prefs: {
    engines: {
      'demo-curated': true,
      'archive-org': true,
      'distro-releases': true,
    },
    proxy: { enabled: false, type: 'socks5', host: '127.0.0.1', port: 1080, username: '', password: '' },
    theme: 'dark',
    // Last folder the user saved a direct download into (next save
    // dialog opens there; a resumed download lands on its .part).
    downloadDir: '',
    // Default speed limit (bytes/sec) applied to every NEW direct download.
    // 0 = unlimited; the per-transfer tray control overrides individual
    // transfers without touching this default.
    downloadSpeedLimit: 0,
  },
  history: [],
  favorites: [],
  // In-flight direct downloads (url + approved destination) persisted at
  // quit so interrupted files auto-resume on next launch.
  transfers: [],
};

class Storage {
  constructor(dir) {
    this.dir = dir;
    this.paths = {
      prefs: path.join(dir, 'prefs.json'),
      history: path.join(dir, 'history.json'),
      favorites: path.join(dir, 'favorites.json'),
      health: path.join(dir, 'health.json'),
      transfers: path.join(dir, 'transfers.json'),
    };
    fs.mkdirSync(dir, { recursive: true });
    this.prefs = this._load('prefs', DEFAULTS.prefs);
    this.history = this._load('history', []);
    this.favorites = this._load('favorites', []);
    this.health = this._load('health', []);
    this.transfers = this._load('transfers', []);
    this._debounce = {};
  }

  _load(key, fallback) {
    try {
      const raw = fs.readFileSync(this.paths[key], 'utf8');
      const parsed = JSON.parse(raw);
      if (key === 'prefs') return this._mergePrefs(DEFAULTS.prefs, parsed);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return JSON.parse(JSON.stringify(fallback));
    }
  }

  /** Deep-merge stored prefs over defaults so new keys survive upgrades. */
  _mergePrefs(defaults, stored) {
    const out = JSON.parse(JSON.stringify(defaults));
    if (!stored || typeof stored !== 'object') return out;
    for (const [k, v] of Object.entries(stored)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
        out[k] = Object.assign({}, out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  _write(key) {
    const file = this.paths[key];
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this[key === 'prefs' ? 'prefs' : key], null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn(`[torrentor] could not persist ${key}:`, err.message);
    }
  }

  _schedule(key) {
    if (this._debounce[key]) clearTimeout(this._debounce[key]);
    this._debounce[key] = setTimeout(() => {
      this._debounce[key] = null;
      this._write(key);
    }, 250);
  }

  // ------------------------------------------------------------- prefs

  getPrefs() {
    return this.prefs;
  }

  /** Shallow/deep update. { proxy: {...} } merges proxy; others replace. */
  updatePrefs(partial) {
    const p = partial || {};
    for (const [k, v] of Object.entries(p)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && this.prefs[k] && typeof this.prefs[k] === 'object' && !Array.isArray(this.prefs[k])) {
        this.prefs[k] = Object.assign({}, this.prefs[k], v);
      } else {
        this.prefs[k] = v;
      }
    }
    this._schedule('prefs');
    return this.prefs;
  }

  // ------------------------------------------------------------ history

  getHistory() {
    return this.history;
  }

  clearHistory() {
    this.history = [];
    this._schedule('history');
  }

  pushHistory(entry) {
    if (!entry || !entry.q) return;
    this.history = this.history.filter((h) => h.q !== entry.q);
    this.history.unshift({ q: entry.q, ts: entry.ts || Date.now(), count: entry.count || 0, engines: entry.engines || [] });
    if (this.history.length > HISTORY_LIMIT) this.history = this.history.slice(0, HISTORY_LIMIT);
    this._schedule('history');
  }

  // ---------------------------------------------------------- favorites

  getFavorites() {
    return this.favorites;
  }

  toggleFavorite(result) {
    if (!result || !result.key) throw new Error('Favorite needs a keyed result.');
    const idx = this.favorites.findIndex((f) => f.key === result.key);
    if (idx >= 0) {
      this.favorites.splice(idx, 1);
      this._schedule('favorites');
      return { added: false, key: result.key };
    }
    this.favorites.unshift({
      key: result.key,
      title: result.title || '',
      category: result.category || 'other',
      sizeBytes: result.sizeBytes ?? null,
      seeders: result.seeders ?? null,
      sources: result.sources || [],
      infohash: result.infohash || null,
      // kept so keyOf(favorite) reproduces the same key on later toggles
      sourceId: result.sourceId || (result.sources && result.sources[0] && result.sources[0].sourceId) || null,
      itemId: result.itemId || null,
      magnet: result.magnet || null,
      torrentUrl: result.torrentUrl || null,
      pageUrl: result.pageUrl || null,
      thumbnail: result.thumbnail || null,
      demo: !!result.demo,
      addedAt: Date.now(),
    });
    if (this.favorites.length > FAVORITES_LIMIT) this.favorites = this.favorites.slice(0, FAVORITES_LIMIT);
    this._schedule('favorites');
    return { added: true, key: result.key };
  }

  // ------------------------------------------------------------ health

  getHealth() {
    return this.health;
  }

  setHealth(list) {
    this.health = Array.isArray(list) ? list : [];
    this._schedule('health');
    return this.health;
  }

  // ------------------------------------------------- transfers

  getTransfers() {
    return this.transfers;
  }

  /** Replace the persisted in-flight download records (for auto-resume). */
  setTransfers(list) {
    this.transfers = Array.isArray(list) ? list : [];
    this._schedule('transfers');
    return this.transfers;
  }

  /** Immediate flush (used on quit / in tests). */
  flush() {
    for (const key of ['prefs', 'history', 'favorites', 'health', 'transfers']) this._write(key);
  }
}

module.exports = { Storage, DEFAULTS };
