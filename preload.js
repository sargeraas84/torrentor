'use strict';
// =====================================================================
// Torrentor preload — the only bridge between the sandboxed renderer
// and the main process. Exposes a typed, whitelisted API on
// window.torrentor; no arbitrary channel access leaks to the page.
// All networking, proxy routing and storage live in main.
//
// Every invoke goes through the envelope { ok, data, error } that main
// returns; `bridge` unwraps it so the UI gets plain data and rejected
// promises on failure, and maps method arguments onto the payload
// shape each main handler expects.
// =====================================================================

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function bridge(channel, toPayload) {
  return (...args) =>
    ipcRenderer.invoke(channel, (toPayload ? toPayload(...args) : args[0]) || {}).then((env) => {
      if (!env) throw new Error(`No response from ${channel}`);
      if (!env.ok) {
        const err = new Error(env.error || 'Request failed');
        err.error = env.error;
        throw err;
      }
      return env.data;
    });
}

contextBridge.exposeInMainWorld('torrentor', {
  platform: process.platform,

  // ----- state / search
  getState: bridge('app:getState'),
  search: bridge('search:run', (query, engineIds) => ({ query, engineIds })),
  loadMore: bridge('search:loadMore', (query, page, current) => ({ query, page, current })),
  onSearchProgress: (cb) => subscribe('search:progress', cb),
  retryEngine: bridge('search:retry', (engineId, query, current) => ({ engineId, query, current })),

  // ----- engines / prefs
  setEngines: bridge('engines:set', (ids) => ({ ids })),
  setPrefs: bridge('prefs:update', (partial) => ({ partial })),

  // ----- library (favorites + history)
  getFavorites: bridge('favorites:list'),
  toggleFavorite: bridge('favorites:toggle', (result) => ({ result })),
  clearHistory: bridge('history:clear'),

  // ----- source health
  getHealth: bridge('health:get'),
  runHealth: bridge('health:run'),
  onHealthProgress: (cb) => subscribe('health:progress', cb),

  // ----- idle explore tiles
  exploreTiles: bridge('explore:tiles'),

  // ----- network / VPN
  checkIp: bridge('net:checkIp'),
  validateProxy: bridge('net:validateProxy', (cfg) => ({ cfg })),

  // ----- actions
  copy: bridge('app:copy', (text) => ({ text })),
  openExternal: bridge('app:openExternal', (url) => ({ url })),

  // ----- direct downloads (main-process streaming; hosts allowlisted)
  getDownloads: bridge('downloads:list'),
  getDownloadStats: bridge('downloads:stats'),
  setSmartOrder: bridge('downloads:smartOrder', (on) => ({ on })),
  previewQueue: bridge('downloads:previewQueue', (limits) => ({ limits })),
  saveQueuePlan: bridge('queuePlans:save', (name, patch) => ({ name, patch })),
  listQueuePlans: bridge('queuePlans:list'),
  applyQueuePlan: bridge('queuePlans:apply', (name) => ({ name })),
  deleteQueuePlan: bridge('queuePlans:delete', (name) => ({ name })),
  clearDownloads: bridge('downloads:clear'),
  onDownloadsChanged: (cb) => subscribe('downloads:changed', cb),
  itemFiles: bridge('download:itemFiles', (sourceId, itemId) => ({ sourceId, itemId })),
  downloadFile: bridge('download:start', (url) => ({ url })),
  retryDownload: bridge('download:retry', (id) => ({ id })),
  pauseDownload: bridge('download:pause', (id) => ({ id })),
  cancelDownload: bridge('download:cancel', (id) => ({ id })),
  setDownloadLimit: bridge('download:limit', (id, bytesPerSec) => ({ id, bytesPerSec })),
  moveDownload: bridge('download:move', (id, dir) => ({ id, dir })),
  moveDownloadTo: bridge('download:moveTo', (id, toIndex) => ({ id, toIndex })),
  resumePausedDownloads: bridge('download:pausedResume'),
  removePausedDownloads: bridge('download:pausedRemove'),
  revealDownload: bridge('downloads:reveal', (id) => ({ id })),
  chooseDownloadDir: bridge('downloads:chooseDir', (engineId) => ({ engineId })),

  // ----- window controls
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
  close: () => ipcRenderer.send('win:close'),
  onMaximized: (cb) => subscribe('win:maximized', cb),
});
