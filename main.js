'use strict';
// =====================================================================
// Torrentor — Electron main process.
//
//   • Single-instance frameless search window (custom titlebar)
//   • Engine registry + parallel search orchestration (lib/orchestrator)
//   • VPN/proxy-aware networking for EVERY outbound request (lib/network)
//   • JSON persistence: prefs, history, favorites (lib/storage)
//   • Secure IPC surface; the renderer never touches the network
//
// The renderer is fully sandboxed (nodeIntegration: false,
// contextIsolation: true, CSP in renderer/index.html) and talks only
// through the typed bridge in preload.js.
// =====================================================================

const { app, BrowserWindow, clipboard, ipcMain, shell } = require('electron');
const path = require('path');
const network = require('./lib/network');
const { Storage } = require('./lib/storage');
const registry = require('./indexers/registry');
const { runSearch, keyOf, mergeIncremental, ENGINE_TIMEOUT_MS } = require('./lib/orchestrator');
const { runHealthChecks } = require('./lib/health');
const { isSafeExternalUrl } = require('./lib/magnet');
const { validateProxyConfig } = network;

// ------------------------------------------------------------ constants

// Curated entry points into public-domain & CC media (idle "Explore" tiles).
// Each fires the normal archive search — the tiles are pure navigation.
const EXPLORE_TILES = [
  { q: 'public domain films', label: 'Public domain films' },
  { q: 'old time radio', label: 'Old time radio' },
  { q: 'librivox audiobooks', label: 'LibriVox audiobooks' },
  { q: 'silent cinema', label: 'Silent cinema' },
  { q: '78rpm records', label: '78rpm records' },
  { q: 'nasa imagery', label: 'NASA imagery' },
];

const APP_ID = 'com.torrentor.app';
const SMOKE_MODE = !!process.env.TORRENTOR_SMOKE;
const dataDir = () => (SMOKE_MODE && process.env.TORRENTOR_DATA_DIR) || app.getPath('userData');

let mainWindow = null;
let storage = null;
let currentAbort = null; // AbortController for the in-flight search
let runCounter = 0; // monotonically increasing run id (stale-result guard)
let quitting = false;

// ------------------------------------------------------------- lifecycle

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(bootstrap);
}

async function bootstrap() {
  app.setAppUserModelId(APP_ID);
  storage = new Storage(dataDir());
  applyProxyPrefs();

  createWindow();
  registerIpc();
  registerEvents();

  // Re-apply the proxy route if the process outlives a config change.
  app.on('before-quit', () => {
    quitting = true;
    if (storage) storage.flush();
  });
}

function applyProxyPrefs() {
  const cfg = storage ? storage.getPrefs().proxy : { enabled: false };
  network.setProxyConfig(cfg);
}

// --------------------------------------------------------------- window

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 920,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: '#060b14',
    icon: path.join(__dirname, 'resources', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (SMOKE_MODE) return; // the smoke harness drives the window itself
    mainWindow.show();
  });

  mainWindow.on('maximize', () => broadcast('win:maximized', true));
  mainWindow.on('unmaximize', () => broadcast('win:maximized', false));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Never navigate away from the bundled page; external links open in the
  // OS default browser/torrent client only through the validated bridge.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

// ------------------------------------------------------------ IPC helpers

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      return { ok: true, data: await fn(payload || {}, event) };
    } catch (err) {
      console.error(`[torrentor] ${channel} failed:`, err && err.message ? err.message : err);
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

const enabledEngineIds = () => {
  const prefs = storage.getPrefs();
  return registry.list().filter((id) => prefs.engines[id] !== false);
};

// ------------------------------------------------------- search pipeline

/** Run one query across the enabled engines, streaming progress. */
async function performSearch(query, engineIds) {
  if (currentAbort) currentAbort.abort();
  currentAbort = new AbortController();
  const runId = ++runCounter;
  const signal = currentAbort.signal;

  const ids = Array.isArray(engineIds) && engineIds.length ? engineIds.filter((id) => registry.get(id)) : enabledEngineIds();
  if (!ids.length) throw new Error('No search engines enabled — open Settings and enable at least one.');

  const startedAt = Date.now();
  const payload = await runSearch({
    query,
    engineIds: ids,
    registry,
    signal,
    network, // bound module — every engine routes through the proxy config
    onProgress: (snapshot) => {
      if (runId === runCounter && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('search:progress', { runId, ...snapshot });
      }
    },
  });

  if (signal.aborted || runId !== runCounter) return null; // superseded
  if (storage) {
    storage.pushHistory({
      q: payload.query,
      ts: startedAt,
      count: payload.stats.unique,
      engines: payload.stats.engineIds,
    });
  }
  return payload;
}

// ------------------------------------------------------------- IPC surface

function registerIpc() {
  handle('app:getState', () => ({
    version: app.getVersion(),
    engines: registry.meta().map((e) => ({ ...e, enabled: storage.getPrefs().engines[e.id] !== false })),
    prefs: storage.getPrefs(),
    history: storage.getHistory(),
    favorites: storage.getFavorites(),
  }));

  handle('search:run', async ({ query, engineIds }) => {
    // May resolve null when superseded by a newer query — the renderer
    // ignores stale invokes via its own request sequence number.
    return performSearch(String(query || ''), engineIds);
  });

  // Single-engine retry: re-run ONLY the failed engine and merge its fresh
  // results into the list already shown (deduped, honesty sort intact).
  handle('search:retry', async ({ engineId, query, current }) => {
    const engine = engineId ? registry.get(engineId) : null;
    if (!engine || typeof engine.search !== 'function') throw new Error('Unknown engine.');
    const q = String(query || '').trim();
    if (q.length < 2) throw new Error('Enter at least 2 characters to search.');
    try {
      const list = await engine.search(q, { signal: null, network, timeoutMs: ENGINE_TIMEOUT_MS });
      const merged = mergeIncremental(Array.isArray(current) ? current.slice(0, 400) : [], list);
      return { engineId, ok: true, results: merged.results, added: merged.added };
    } catch (err) {
      return { engineId, ok: false, error: String((err && err.message) || err).slice(0, 160) };
    }
  });

  // Archive-only "load more": fetch the next page of the SAME query and
  // merge it into the results already shown, deduped by key. Demo and
  // distro engines have no paging and are never touched here.
  handle('search:loadMore', async ({ query, page, current }) => {
    const engine = registry.get('archive-org');
    if (!engine || typeof engine.searchPage !== 'function') throw new Error('Archive engine unavailable.');
    const q = String(query || '').trim();
    if (q.length < 2) throw new Error('Enter at least 2 characters to search.');
    const pageN = Math.max(2, Math.floor(Number(page) || 2));
    const fetched = await engine.searchPage(q, { signal: null, network, timeoutMs: ENGINE_TIMEOUT_MS, page: pageN });
    const merged = mergeIncremental(Array.isArray(current) ? current.slice(0, 400) : [], fetched.results);
    return { results: merged.results, added: merged.added, page: pageN, hasMore: !!fetched.hasMore };
  });

  handle('engines:set', ({ ids }) => {
    const allowed = new Set(registry.list());
    const next = {};
    for (const id of allowed) next[id] = ids.includes(id);
    storage.updatePrefs({ engines: next });
    return next;
  });

  handle('prefs:update', ({ partial }) => {
    const out = storage.updatePrefs(partial || {});
    if (partial && partial.proxy) {
      const check = validateProxyConfig(out.proxy);
      if (!check.ok) throw new Error(check.error);
      applyProxyPrefs();
    }
    return out;
  });

  handle('favorites:list', () => storage.getFavorites());
  handle('favorites:toggle', ({ result }) => {
    if (!result) throw new Error('Missing result.');
    // Recompute the key in main so favorites always dedupe identically.
    const keyed = { ...result, key: keyOf(result) };
    return storage.toggleFavorite(keyed);
  });
  handle('history:clear', () => {
    storage.clearHistory();
    return true;
  });

  handle('net:checkIp', () => network.checkIp(8000));
  handle('net:validateProxy', ({ cfg }) => validateProxyConfig(cfg || {}));

  // Source health self-test (Settings → Search sources). Runs every
  // probe-bearing engine's known-good query through the proxy-bound
  // network; verdicts persist so dots paint instantly on revisit.
  handle('health:get', () => storage.getHealth());
  handle('health:run', async () => {
    const list = await runHealthChecks({
      registry,
      network,
      onProgress: (partial) => broadcast('health:progress', partial),
    });
    storage.setHealth(list);
    return list;
  });

  // Idle-screen "Explore open culture" tiles: for each curated query, pull
  // the first Archive item's poster (cached). Failures degrade to a
  // label-only tile in the renderer — this endpoint never throws.
  const exploreCache = new Map(); // q -> { at, thumb }
  const EXPLORE_TTL_MS = 30 * 60 * 1000;
  handle('explore:tiles', async () => {
    const engine = registry.get('archive-org');
    if (!engine || typeof engine.search !== 'function') return [];
    const tiles = await Promise.all(
      EXPLORE_TILES.map(async (t) => {
        const hit = exploreCache.get(t.q);
        if (hit && Date.now() - hit.at < EXPLORE_TTL_MS) return { ...t, thumb: hit.thumb };
        let thumb = null;
        try {
          const res = await engine.search(t.q, { signal: null, network, timeoutMs: 9000 });
          thumb = (res && res[0] && res[0].thumbnail) || null;
        } catch {
          /* non-fatal — label-only tile */
        }
        exploreCache.set(t.q, { at: Date.now(), thumb });
        return { q: t.q, label: t.label, thumb };
      })
    );
    return tiles;
  });

  handle('app:copy', ({ text }) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  handle('app:openExternal', ({ url }) => {
    if (!isSafeExternalUrl(url)) throw new Error('That link type is not allowed.');
    shell.openExternal(String(url));
    return true;
  });
}

// -------------------------------------------------- renderer -> main events

function registerEvents() {
  ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.on('win:toggleMaximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('win:close', () => {
    quitting = true;
    app.quit();
  });

  // Give the renderer a moment to flush anything, then persist state.
  app.on('window-all-closed', () => {
    if (quitting && storage) storage.flush();
    app.quit();
  });
}

app.on('activate', () => {
  if (mainWindow) showWindow();
});
