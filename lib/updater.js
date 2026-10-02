'use strict';
// ---------------------------------------------------------------------
// Torrentor — in-app update manager (main process).
//
// Wraps electron-updater with Torrentor's conventions:
//   • inert unless the app is packaged (dev + smoke runs never phone
//     home — the module is safe to require from plain-Node tests);
//   • electron-updater itself is required lazily for the same reason;
//   • status snapshots flow to the renderer through an onStatus callback
//     so the UI owns the banner while main owns the download.
//
// Release-side requirements (already wired): the `publish` provider in
// package.json points at this repo, and release.yml attaches the
// latest*.yml metadata (+ blockmaps) next to the installers, which is
// what the updater feed reads.
// ---------------------------------------------------------------------

const status = {
  available: false,
  version: null,
  downloading: false,
  progress: 0,
  downloaded: false,
  error: null,
};

let started = false;

function snapshot() {
  return { ...status };
}

function loadImpl() {
  try {
    // eslint-disable-next-line global-require
    return require('electron-updater').autoUpdater;
  } catch {
    return null; // dev checkout / plain-Node test — updater unavailable
  }
}

/**
 * @param {object} opts { packaged: boolean, onStatus(status) }
 * @returns {boolean} whether the updater is live.
 */
function init(opts) {
  const { packaged, onStatus } = opts || {};
  const emit = () => {
    try {
      if (typeof onStatus === 'function') onStatus(snapshot());
    } catch {
      /* renderer gone — non-fatal */
    }
  };
  if (!packaged) return false;
  const au = loadImpl();
  if (!au) return false;
  if (started) return true;
  started = true;
  au.autoDownload = true;
  au.on('checking-for-update', () => emit());
  au.on('update-available', (info) => {
    status.available = true;
    status.version = (info && info.version) || null;
    status.error = null;
    emit();
  });
  au.on('update-not-available', () => emit());
  au.on('download-progress', (p) => {
    status.downloading = true;
    status.progress = p && Number.isFinite(p.percent) ? Math.round(p.percent) : status.progress;
    emit();
  });
  au.on('update-downloaded', (info) => {
    status.downloading = false;
    status.progress = 100;
    status.downloaded = true;
    if (info && info.version) status.version = info.version;
    emit();
  });
  au.on('error', (err) => {
    status.error = String((err && err.message) || err).slice(0, 160);
    status.downloading = false;
    emit();
  });
  return true;
}

/** Ask the feed for updates now. Quietly resolves to a snapshot when inert. */
async function checkForUpdates() {
  const au = started ? loadImpl() : null;
  if (!au) return snapshot();
  try {
    await au.checkForUpdates();
  } catch (err) {
    status.error = String((err && err.message) || err).slice(0, 160);
  }
  return snapshot();
}

/** Quit and install the downloaded update. No-op until one is downloaded. */
function installAndRestart() {
  if (!status.downloaded) return false;
  const au = loadImpl();
  if (!au) return false;
  au.quitAndInstall(false, true);
  return true;
}

/** Test hook: reset module state between isolated checks. */
function __reset() {
  status.available = false;
  status.version = null;
  status.downloading = false;
  status.progress = 0;
  status.downloaded = false;
  status.error = null;
  started = false;
}

module.exports = { init, snapshot, checkForUpdates, installAndRestart, __reset };
