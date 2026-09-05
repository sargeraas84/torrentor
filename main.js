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

const { app, BrowserWindow, Tray, Menu, clipboard, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const network = require('./lib/network');
const downloads = require('./lib/downloads');
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
// Host allowlist for direct downloads. Smoke mode additionally trusts
// loopback so the two-boot resume test can serve a genuine Range-capable
// HTTP download from a local test server (never in a normal run).
const downloadAllowHosts = () =>
  SMOKE_MODE ? [...network.DOWNLOAD_ALLOW_HOSTS, '127.0.0.1', 'localhost'] : network.DOWNLOAD_ALLOW_HOSTS;

let mainWindow = null;
let splashWindow = null; // animated launcher shown while the UI boots
let splashShownAt = 0; // when the launcher appeared (for the min intro time)
const SPLASH_MIN_MS = 2600; // let the logo intro visibly play before handoff
let tray = null; // taskbar/menu-bar presence with Show/Quit actions
let mainReady = false; // main window rendered and safe to show
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
  // Default speed limit for new downloads (Settings → Library). Per-transfer
  // tray controls override individual files; the smoke-mode loopback host is
  // registered for the two-boot auto-resume test.
  downloads.setDefaultSpeedLimit(Number(storage.getPrefs().downloadSpeedLimit) || 0);
  downloads.setDefaultAllowHosts(downloadAllowHosts());
  // Lifetime per-source download tallies for the Library views.
  downloads.setStats(storage.getStats() || {});
  // Bandwidth-aware queue scheduling (tray toggle, persisted in prefs).
  downloads.setSmartOrder(!!storage.getPrefs().smartOrder);

  // Live speed schedules: the Settings 'night mode' cap applies on boot, and
  // the LAST APPLIED queue plan is re-armed exactly as the user left it —
  // its name badge + any schedule window come back across a relaunch.
  downloads.setGlobalSchedule(normalizeSchedule(storage.getPrefs().nightMode));
  downloads.setNightOverride(null); // session override resets on every boot
  const appliedAtBoot = storage.getPrefs().appliedQueuePlan;
  if (appliedAtBoot && appliedAtBoot.name) downloads.setActivePlan(String(appliedAtBoot.name), normalizeSchedule(appliedAtBoot.schedule));

  // Auto-resume interrupted downloads: transfers that were in flight when
  // the app last quit were persisted (url + approved destination). They
  // re-enter the queue here — before the window loads — so the tray shows
  // them from the first paint and the .part continues via HTTP Range.
  try {
    const pending = storage.getTransfers();
    if (Array.isArray(pending) && pending.length) {
      storage.setTransfers([]); // consumed; the live queue re-persists below
      downloads.restorePending(pending, (entry, kind) => broadcastDownloads(kind, entry.id));
    }
  } catch (err) {
    console.error('[torrentor] could not restore interrupted downloads:', err && err.message ? err.message : err);
  }

  createSplash();
  createWindow();
  createTray();
  registerIpc();
  registerEvents();

  // Clock-boundary re-evaluation: the applied plan's window and the night
  // mode window are hour-shaped, so poll the clock; when a boundary flips
  // either one active/inactive, broadcast so the tray header hints + chip
  // basis words update WITHOUT waiting for a download to tick.
  const scheduleTimer = setInterval(() => {
    const t = downloads.scheduleBoundaryTick();
    if (t.changed) broadcastDownloads('plan', null);
  }, 10000);
  scheduleTimer.unref && scheduleTimer.unref();

  // Safety net: if the renderer ever stalls, never leave the splash up.
  if (!SMOKE_MODE) {
    setTimeout(() => {
      if (mainReady) return;
      closeSplash();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    }, 10000);
  }

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

/**
 * Normalize a clock-window schedule ({ from, to, bytesPerSec }) to a
 * validated shape, or null. Shared by the queue-plan save path, the night
 * mode pref, and the boot restore of an applied plan.
 */
function normalizeSchedule(s) {
  if (!s) return null;
  const from = String(s.from || '').trim();
  const to = String(s.to || '').trim();
  const bps = Math.max(0, Math.floor(Number(s.bytesPerSec) || 0));
  if (!(from && to && bps > 0)) return null;
  const out = { from, to, bytesPerSec: bps };
  const days = downloads.normalizeDays(s.days);
  if (days) out.days = days;
  return out;
}

/** A saved plan record may be { entries, schedule } or a legacy plain array. */
function planRecord(rec) {
  if (!rec) return null;
  if (Array.isArray(rec)) return { entries: rec, schedule: null };
  return { entries: rec.entries || [], schedule: rec.schedule || null };
}

// --------------------------------------------------------------- window

/** Animated launcher (resources/splash.html) shown while the UI boots. */
function createSplash() {
  if (SMOKE_MODE) return; // the test harness drives the window itself
  splashWindow = new BrowserWindow({
    width: 440,
    height: 330,
    frame: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    backgroundColor: '#060b14',
    icon: path.join(__dirname, 'resources', 'icon.ico'),
  });
  splashWindow.loadFile(path.join(__dirname, 'resources', 'splash.html'));
  splashWindow.once('ready-to-show', () => {
    splashShownAt = Date.now();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
  });
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

/** Fade the launcher out (main is ready) and destroy it. */
function closeSplash() {
  const w = splashWindow;
  if (!w || w.isDestroyed()) return;
  splashWindow = null;
  w.webContents
    .executeJavaScript("document.body.classList.add('closing')")
    .catch(() => {});
  setTimeout(() => {
    if (!w.isDestroyed()) w.destroy();
  }, 420);
}

/**
 * Taskbar / menu-bar presence so the mark stays visible while the app
 * runs. Windows uses the multi-size .ico (crisp 16px small / 32px large
 * at every DPI); macOS uses the black template mask the system tints and
 * scales (the @2x sibling is picked up automatically for retina bars).
 * Window-close behavior is unchanged — this is presence, not minimize-
 * to-tray.
 */
function createTray() {
  if (SMOKE_MODE) return; // keep the test harness's process shape intact
  try {
    const icon =
      process.platform === 'darwin'
        ? path.join(__dirname, 'resources', 'icons', 'trayTemplate.png')
        : path.join(__dirname, 'resources', 'icon.ico');
    tray = new Tray(icon);
    tray.setToolTip('Torrentor');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Torrentor', click: () => showWindow() },
        { type: 'separator' },
        { label: 'Quit', click: () => {
            quitting = true;
            if (storage) storage.flush();
            app.quit();
          } },
      ])
    );
    // Windows/Linux: single click raises the app (macOS opens the menu).
    if (process.platform !== 'darwin') tray.on('click', () => showWindow());
  } catch (err) {
    // A missing tray must never prevent the app from starting.
    console.error('[torrentor] tray unavailable:', err && err.message ? err.message : err);
    tray = null;
  }
}

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
    mainReady = true;
    if (SMOKE_MODE) return; // the smoke harness drives the window itself
    // Hold the handoff until the animated logo intro has had its moment —
    // on a fast machine the UI is ready in under a second, which would cut
    // the ring/magnet draw off before it plays.
    const elapsed = splashShownAt ? Date.now() - splashShownAt : SPLASH_MIN_MS;
    setTimeout(() => {
      closeSplash();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    }, Math.max(0, SPLASH_MIN_MS - elapsed));
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
  if (!mainWindow || !mainReady) return; // never surface an unrendered window
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/** Broadcast the current download list to every window. */
function broadcastDownloads(kind, id) {
  broadcast('downloads:changed', {
    snapshot: downloads.snapshot(),
    appliedPlan: downloads.appliedPlanInfo(),
    nightMode: downloads.globalScheduleInfo(),
    kind: kind || 'changed',
    id: id || null,
  });
  // Persist whatever is still in flight so an interrupted download
  // auto-resumes on next launch (finished/cancelled entries drop out of
  // the resumable set on their final transition) — and keep the lifetime
  // per-source tallies on disk too.
  try {
    if (storage) {
      storage.setTransfers(downloads.resumableSnapshot());
      storage.setStats(downloads.statsSnapshot());
    }
  } catch {
    /* persistence is best-effort */
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

/** Effective on/off for an engine: explicit prefs win, else the engine's
 *  shipped default (opt-in engines like The Pirate Bay default to off). */
const engineEnabled = (e, prefs) => {
  const v = prefs.engines[e.id];
  return v === undefined ? e.defaultEnabled !== false : v === true;
};

const enabledEngineIds = () => {
  const prefs = storage.getPrefs();
  return registry.list().filter((id) => {
    const e = registry.get(id);
    return !!e && engineEnabled(e, prefs);
  });
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
    engines: registry.meta().map((e) => ({ ...e, enabled: engineEnabled(e, storage.getPrefs()) })),
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
    // Night mode is a live cap — apply it the moment Settings changes it
    // (Settings → Library stores it as prefs.nightMode).
    if (partial && partial.nightMode !== undefined) downloads.setGlobalSchedule(normalizeSchedule(out.nightMode));
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

  // ----------------------------------------------- direct downloads

  handle('downloads:list', () => downloads.snapshot());  handle('downloads:appliedPlan', () => downloads.appliedPlanInfo());
  handle('downloads:globalSchedule', () => downloads.globalScheduleInfo());
  // Session-only night-mode override: the tray pill click flips night mode
  // on/off for THIS session (true = forced on, false = forced off, null =
  // follow the clock window again). Not persisted — boot resets it.
  handle('downloads:nightOverride', ({ on }) => {
    const info = downloads.setNightOverride(on === true ? true : on === false ? false : null);
    broadcastDownloads('plan', null); // night pill + chip cap breakdowns refresh
    return info;
  });

  // Lifetime per-source download tallies (count + bytes + timestamped
  // events per engine id) for the Library views. Live from the manager,
  // which main seeded from storage at boot and persists on every download
  // transition.
  handle('downloads:stats', () => downloads.statsSnapshot());

  // Bandwidth-aware queue scheduling: re-sorts the waiting queue by
  // estimated finish time (smallest remaining first). Persisted in prefs
  // so the setting survives a relaunch.
  handle('downloads:smartOrder', ({ on }) => {
    downloads.setSmartOrder(!!on);
    storage.updatePrefs({ smartOrder: !!on });
    return downloads.snapshot();
  });

  // What-if queue preview: how the waiting queue WOULD rank if the given
  // per-transfer speed limits were real. Purely hypothetical — nothing is
  // applied until the tray's Apply calls download:limit per id.
  handle('downloads:previewQueue', ({ limits }) => downloads.previewQueueOrder(limits || {}));

  // Named queue plans: a saved what-if patch, persisted keyed by
  // destination path (ids are transient across restarts) so a plan can be
  // recalled and re-applied whenever the same files are queued again.
  // A saved plan is { entries, schedule } — entries are the per-file /
  // per-folder limits, schedule (optional) is an active-window rule like
  // { from: '23:00', to: '07:00', bytesPerSec: 102400 } that throttles the
  // WHOLE queue while the local clock is inside the window. Plans saved
  // before schedules existed (plain entry arrays) are tolerated everywhere.
  handle('queuePlans:save', ({ name, patch, folderPatch, schedule }) => {
    const key = String(name || '').trim();
    if (!key) throw new Error('Give the plan a name first.');
    const plans = Object.assign({}, storage.getPrefs().queuePlans || {});
    plans[key] = { entries: downloads.planEntries(patch || {}, folderPatch || {}), schedule: normalizeSchedule(schedule) };
    storage.replacePrefs('queuePlans', plans);
    return plans;
  });

  handle('queuePlans:list', () => storage.getPrefs().queuePlans || {});

  handle('queuePlans:apply', ({ name }) => {
    const key = String(name || '').trim();
    const plans = storage.getPrefs().queuePlans || {};
    const rec = planRecord(plans[key]);
    // A plan may be schedule-ONLY (0 entries — its whole purpose is the
    // active-window cap), so only a missing record is an error here.
    if (!rec) throw new Error('No such plan.');
    // Arming the plan first surfaces its name (tray badge) and enforces
    // any schedule window on the whole queue; then the per-file limits
    // land for real (folder rules cover files queued later too).
    downloads.setActivePlan(key, rec.schedule);
    const applied = downloads.applyPlanEntries(rec.entries, (entry, kind) => broadcastDownloads(kind, entry.id));
    // Remember the armed plan so the next launch restores it (name badge +
    // any schedule window) exactly as the user left it.
    storage.updatePrefs({ appliedQueuePlan: { name: key, schedule: rec.schedule } });
    return { applied, appliedPlan: downloads.appliedPlanInfo(), snapshot: downloads.snapshot() };
  });

  handle('queuePlans:delete', ({ name }) => {
    const key = String(name || '').trim();
    const plans = Object.assign({}, storage.getPrefs().queuePlans || {});
    delete plans[key];
    storage.replacePrefs('queuePlans', plans);
    // Deleting the armed plan disarms it — its badge and window cap must
    // not outlive the plan it came from.
    if (downloads.activePlanNameOf() === key) {
      downloads.clearActivePlan();
      storage.updatePrefs({ appliedQueuePlan: null });
      broadcastDownloads('plan', null);
    }
    return plans;
  });

  handle('queuePlans:clearApplied', () => {
    downloads.clearActivePlan();
    storage.updatePrefs({ appliedQueuePlan: null });
    broadcastDownloads('plan', null);
    return { appliedPlan: downloads.appliedPlanInfo(), snapshot: downloads.snapshot() };
  });

  handle('downloads:clear', () => {
    downloads.clearFinished();
    return downloads.snapshot();
  });

  // List the files a result offers for direct download. Archive items
  // fetch their real file list (metadata API with a *_files.xml fallback);
  // the Demo engine returns locally-generated sample files so the whole
  // picker → download flow is exercisable offline.
  handle('download:itemFiles', ({ sourceId, itemId }) => {
    if (sourceId === 'demo-curated') return downloads.demoFiles();
    if (sourceId !== 'archive-org') throw new Error('Direct files are not available for this source.');
    return downloads.itemFiles(String(itemId || ''));
  });

  // Stream a content URL to a user-chosen path. The host allowlist is
  // enforced here AND on every redirect hop inside streamToFile; demo:
  // URLs are local synthetic payloads and never touch the network. The
  // chosen folder is remembered (prefs.downloadDir) so the next save
  // dialog opens there — resuming an interrupted file lands on the same
  // .part and continues with an HTTP Range request.
  handle('download:start', async ({ url }, event) => {
    const href = String(url || '').trim();
    const isDemo = /^demo:/i.test(href);
    if (!isDemo) {
      let parsed;
      try {
        parsed = new URL(href);
      } catch {
        throw new Error('Invalid download URL.');
      }
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) downloads are supported.');
      if (!network.hostAllowed(parsed.hostname, downloadAllowHosts())) throw new Error('That download host is not on the allowlist.');
    }

    const label = isDemo ? downloads.demoLabel(href) : downloads.suggestedName(href);
    // Per-source default folder (Settings → Library) wins over the shared
    // last-used folder when the URL maps to a direct-file engine. The
    // winning rule is recorded on the transfer so tray chips can explain
    // where the file went.
    const engineId = downloads.engineForUrl(href);
    const prefs0 = storage.getPrefs();
    const dirs0 = prefs0.downloadDirs || {};
    const sourceDir = engineId && dirs0[engineId];
    const lastDir = prefs0.downloadDir;
    let folderRule = '';
    if (engineId) {
      const sourceName = (registry.get(engineId) || {}).name || engineId;
      folderRule = sourceDir
        ? `${sourceName} default folder`
        : lastDir
          ? 'Last-used folder'
          : 'Folder chosen in the save dialog';
    } else if (lastDir) {
      folderRule = 'Last-used folder';
    }
    let destPath;
    if (SMOKE_MODE) {
      destPath = path.join(os.tmpdir(), `torrentor-dl-${Date.now()}-${label}`);
    } else {
      const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
      const dir = sourceDir || lastDir || undefined;
      const res = await dialog.showSaveDialog(win, {
        title: 'Save download',
        defaultPath: dir ? path.join(dir, label) : label,
      });
      if (res.canceled || !res.filePath) return { cancelled: true, transfer: null };
      destPath = res.filePath;
      try {
        const folder = path.dirname(destPath);
        // Remember both: the shared last-used folder AND this source's own
        // folder, so next time Archive files skip straight to their dir.
        const patch = { downloadDir: folder };
        if (engineId) patch.downloadDirs = { [engineId]: folder };
        storage.updatePrefs(patch);
      } catch {
        /* remembering the folder is best-effort */
      }
    }

    // New transfers inherit the Settings → default speed limit (bytes/sec).
    const transfer = downloads.startDownload(href, destPath, (entry, kind) => broadcastDownloads(kind, entry.id), {
      maxBytesPerSec: Number(storage.getPrefs().downloadSpeedLimit) || 0,
      folderRule,
    });
    return { cancelled: false, transfer };
  });

  // Resume/retry a finished or PAUSED transfer (error, cancelled, paused):
  // it keeps its already-approved destination and the .part continues via
  // Range. Pause frees its queue slot without dropping the transfer.
  handle('download:retry', ({ id }) => {
    downloads.retryDownload(Number(id), (entry, kind) => broadcastDownloads(kind, entry.id));
    return downloads.snapshot();
  });

  // Pause a running download: aborts the stream, keeps the .part, frees
  // the queue slot; the entry parks as 'paused' for a manual resume.
  handle('download:pause', ({ id }) => {
    downloads.pauseDownload(Number(id), (entry, kind) => broadcastDownloads(kind, entry.id));
    broadcastDownloads('paused', Number(id));
    return downloads.snapshot();
  });

  // Native folder picker for Settings → Library per-source download folders.
  handle('downloads:chooseDir', async ({ engineId }, event) => {
    const id = String(engineId || '').trim();
    if (!id) throw new Error('Choose a source first.');
    const prefs = storage.getPrefs();
    const startDir = (prefs.downloadDirs && prefs.downloadDirs[id]) || prefs.downloadDir || undefined;
    if (SMOKE_MODE) {
      // The real-window playtest can't drive a native dialog: return a
      // deterministic per-engine temp folder, exactly like download:start
      // bypasses the save dialog under TORRENTOR_SMOKE.
      return { cancelled: false, path: path.join(os.tmpdir(), `torrentor-dir-${id}`) };
    }
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const res = await dialog.showOpenDialog(win, {
      title: `Default download folder — ${id}`,
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: startDir,
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { cancelled: true, path: null };
    return { cancelled: false, path: res.filePaths[0] };
  });

  // Bulk actions for the tray header when several transfers are paused.
  handle('download:pausedResume', () => {
    downloads.resumeAllPaused((entry, kind) => broadcastDownloads(kind, entry.id));
    broadcastDownloads('paused', null);
    return downloads.snapshot();
  });

  handle('download:pausedRemove', () => {
    const n = downloads.removeAllPaused();
    broadcastDownloads('removed', null);
    return downloads.snapshot();
  });

  // Per-transfer speed limit (bytes/sec, 0 = unlimited). The rate is read
  // live by the active stream, so the change applies immediately.
  handle('download:limit', ({ id, bytesPerSec }) => {
    downloads.setSpeedLimit(Number(id), Number(bytesPerSec), (entry, kind) => broadcastDownloads(kind, entry.id));
    return downloads.snapshot();
  });

  // Manual queue reordering: 'up' starts the transfer sooner, 'down' later.
  handle('download:move', ({ id, dir }) => {
    downloads.moveQueued(Number(id), String(dir || ''), (entry, kind) => broadcastDownloads(kind, entry.id));
    return downloads.snapshot();
  });

  // Drag-and-drop queue reordering: move a queued transfer to an absolute
  // queue position (the dropped-on sibling's index).
  handle('download:moveTo', ({ id, toIndex }) => {
    downloads.moveQueuedTo(Number(id), Number(toIndex), (entry, kind) => broadcastDownloads(kind, entry.id));
    return downloads.snapshot();
  });

  handle('download:cancel', ({ id }) => {
    downloads.cancelDownload(Number(id));
    broadcastDownloads('cancelled', Number(id));
    return downloads.snapshot();
  });

  // Open the OS file manager with the finished transfer selected.
  handle('downloads:reveal', ({ id }) => {
    const t = downloads.getDownload(Number(id));
    if (!t || t.status !== 'done' || !t.filePath) throw new Error('Nothing to reveal yet.');
    if (!fs.existsSync(t.filePath)) throw new Error('That file is no longer on disk.');
    shell.showItemInFolder(t.filePath);
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
