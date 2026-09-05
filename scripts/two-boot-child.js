'use strict';
// ---------------------------------------------------------------------
// Torrentor two-boot resume test — CHILD (run under Electron by
// scripts/two-boot-resume.js).
//
// Phase 'start'  (boot #1): boots the real app, starts a genuine HTTP
//   download of the driver's slow Range-capable payload, confirms bytes
//   are flowing, then quits mid-flight (the driver kills nothing — the
//   app's own before-quit path persists the in-flight transfer).
// Phase 'verify' (boot #2): boots the real app on the SAME data dir and
//   asserts the interrupted download was auto-re-enqueued, resumed from
//   its .part (resumed === true) and completed to the full size.
//
// Pause scenario (a user pause must survive a restart):
// Phase 'pause-start'  (boot #1): starts a genuine download, pauses it
//   through the real pause IPC, remembers a per-source default folder,
//   then quits.
// Phase 'pause-verify' (boot #2): asserts the transfer came back PARKED
//   (status 'paused', .part intact, no auto-resume), and the per-source
//   folder rule is still in prefs.
//
// Order scenario (per-transfer limits + a drag-reordered queue must
// survive a restart):
// Phase 'order-start'  (boot #1): starts four genuine downloads (two
//   active, two queued), sets per-transfer speed limits on an active and
//   a queued file, drag-reorders the queue, then quits.
// Phase 'order-verify' (boot #2): asserts the queue came back in the
//   reordered position with every limit intact, then that all four
//   transfers completed to the exact full size.
// ---------------------------------------------------------------------

const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PHASE = process.env.TORRENTOR_RESUME_PHASE || '';
const DL_URL = process.env.TORRENTOR_RESUME_URL || '';
const BASE = process.env.TORRENTOR_RESUME_BASE || '';
const EXPECTED = Number(process.env.TORRENTOR_RESUME_EXPECTED_BYTES) || 0;
const PAUSE_DIR = process.env.TORRENTOR_PAUSE_DIR || '';

process.env.TORRENTOR_SMOKE = '1';
if (!process.env.TORRENTOR_DATA_DIR) {
  process.env.TORRENTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-resume-'));
}

function fail(msg) {
  console.error('✗ two-boot', PHASE, '-', String(msg).slice(0, 1200));
  setTimeout(() => app.exit(1), 300);
}

async function getWindow() {
  require('../main.js');
  await app.whenReady();
  let win = null;
  for (let i = 0; i < 150 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await new Promise((r) => setTimeout(r, 100));
  }
  if (!win) throw new Error('App window never appeared');
  await new Promise((resolve) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve);
    else resolve();
  });
  await new Promise((r) => setTimeout(r, 400)); // let React + bridge settle
  return win;
}

const waitFor = async (desc, cond, timeoutMs = 30000) => {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await cond().catch(() => null);
    if (last) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for: ${desc} (last=${JSON.stringify(last).slice(0, 200)})`);
};

async function phaseStart(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const started = await js(`window.torrentor.downloadFile(${JSON.stringify(DL_URL)})`);
  const t0 = started && started.transfer;
  if (!t0 || started.cancelled || t0.status !== 'downloading') {
    throw new Error(`download did not start cleanly: status=${t0 && t0.status} error=${t0 && t0.error} url=${DL_URL}`);
  }
  const id = started.transfer.id;
  // Wait until real bytes have landed on disk (progress may not broadcast
  // for the first 500ms; the snapshot's received counter is live).
  const seen = await waitFor(
    'boot#1 partial bytes flowing',
    () => js(`window.torrentor.getDownloads().then((l) => { const t = l.find((x) => x.id === ${id}); return t && t.received > 0 ? { id: t.id, received: t.received, status: t.status } : null; })`)
  );
  console.log(`RESUME_BOOT1_DOWNLOADING id=${id} received=${seen.received}`);
  // Let a bit more of the payload stream, then quit MID-FLIGHT. The app's
  // before-quit path flushes the persisted in-flight transfer.
  await new Promise((r) => setTimeout(r, 350));
  console.log('RESUME_BOOT1_QUITTING');
  setTimeout(() => app.exit(0), 4000); // hard stop if the quit stalls
  app.quit();
}

async function phaseOrderStart(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const urls = [0, 1, 2, 3].map((i) => `${BASE}seed-${i}.bin`);
  const results = [];
  for (const u of urls) results.push(await js(`window.torrentor.downloadFile(${JSON.stringify(u)})`));
  const ts = results.map((r) => r && r.transfer);
  if (!ts.every((t) => t && (t.status === 'downloading' || t.status === 'queued'))) throw new Error('seed transfers did not start cleanly');
  const [a, b, c, d] = ts;
  // Per-transfer limits: a (active) at 128 KB/s, b (active) at 256 KB/s,
  // c (queued) at 256 KB/s — each must survive the restart on its entry.
  await js(`Promise.all([window.torrentor.setDownloadLimit(${a.id}, 131072), window.torrentor.setDownloadLimit(${b.id}, 262144), window.torrentor.setDownloadLimit(${c.id}, 262144)])`);
  // Drag-reorder the queue: d jumps above c (the tray's moveTo path).
  await js(`window.torrentor.moveDownloadTo(${d.id}, 0)`);
  const snap = await js(`window.torrentor.getDownloads()`);
  const queued = snap.filter((t) => t.status === 'queued').sort((x, y) => x.queuePos - y.queuePos);
  if (queued.length !== 2 || queued[0].id !== d.id || queued[1].id !== c.id) throw new Error(`queue order wrong: ${JSON.stringify(queued.map((t) => [t.id, t.queuePos]))}`);
  if (snap.find((t) => t.id === c.id).maxBytesPerSec !== 262144) throw new Error('queued limit not applied');
  console.log('ORDER_BOOT1_QUEUE order=seed-3,seed-2 limits=131072,262144,262144');
  console.log('ORDER_BOOT1_QUITTING');
  setTimeout(() => app.exit(0), 4000);
  app.quit();
}

async function phaseOrderVerify(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const state = await waitFor(
    'boot#2 restored queue order + limits',
    () =>
      js(`(async () => {
        const list = await window.torrentor.getDownloads();
        const mine = list.filter((t) => t.url.startsWith(${JSON.stringify(BASE)}));
        if (mine.length < 4) return null;
        const queued = mine.filter((t) => t.status === 'queued').sort((x, y) => x.queuePos - y.queuePos);
        if (queued.length < 2) return null;
        const byName = Object.fromEntries(mine.map((t) => [t.url.split('/').pop(), t]));
        if (!byName['seed-0.bin'] || !byName['seed-2.bin']) return null;
        return {
          queuedOrder: queued.slice(0, 2).map((t) => t.url.split('/').pop()),
          aLimit: byName['seed-0.bin'].maxBytesPerSec,
          bLimit: byName['seed-1.bin'].maxBytesPerSec,
          cLimit: byName['seed-2.bin'].maxBytesPerSec,
          files: mine.map((t) => t.filePath),
        };
      })()`),
    25000
  );
  if (state.queuedOrder[0] !== 'seed-3.bin' || state.queuedOrder[1] !== 'seed-2.bin') throw new Error(`queue order lost: ${JSON.stringify(state.queuedOrder)}`);
  if (state.aLimit !== 131072 || state.bLimit !== 262144 || state.cLimit !== 262144) throw new Error(`limits lost: a=${state.aLimit} b=${state.bLimit} c=${state.cLimit}`);
  console.log('ORDER_BOOT2_QUEUE_OK order=seed-3,seed-2 limits=a:131072,b:262144,c:262144');
  await waitFor(
    'boot#2 all four resumed transfers complete',
    () =>
      js(`(async () => {
        const list = await window.torrentor.getDownloads();
        const mine = list.filter((t) => t.url.startsWith(${JSON.stringify(BASE)}));
        return mine.length === 4 && mine.every((t) => t.status === 'done') ? mine : null;
      })()`),
    120000
  );
  const sizes = state.files.map((fp) => (fs.existsSync(fp) ? fs.statSync(fp).size : -1));
  if (sizes.some((s) => s !== EXPECTED)) throw new Error(`final sizes ${JSON.stringify(sizes)} !== ${EXPECTED}`);
  console.log('ORDER_BOOT2_DONE bytes=' + EXPECTED);
  try {
    fs.rmSync(process.env.TORRENTOR_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  app.exit(0);
}

async function phasePauseStart(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const started = await js(`window.torrentor.downloadFile(${JSON.stringify(DL_URL)})`);
  const t0 = started && started.transfer;
  if (!t0 || started.cancelled || t0.status !== 'downloading') {
    throw new Error(`download did not start cleanly: status=${t0 && t0.status} error=${t0 && t0.error}`);
  }
  const id = started.transfer.id;
  const seen = await waitFor(
    'boot#1 pause-bytes flowing',
    () => js(`window.torrentor.getDownloads().then((l) => { const t = l.find((x) => x.id === ${id}); return t && t.received > 0 ? { id: t.id, received: t.received, status: t.status } : null; })`)
  );
  console.log(`PAUSE_BOOT1_DOWNLOADING id=${id} received=${seen.received}`);
  // Pause mid-stream through the SAME IPC the tray's pause button uses.
  const statusAfter = await js(
    `window.torrentor.pauseDownload(${id}).then((l) => { const t = (l || []).find((x) => x.id === ${id}); return t ? t.status : null; })`
  );
  if (statusAfter !== 'paused') throw new Error(`pause failed: status=${statusAfter}`);
  console.log('PAUSE_BOOT1_PAUSED');
  // Remember a per-source default folder (Settings → Library semantics).
  const saved = await js(
    `window.torrentor.setPrefs({ downloadDir: ${JSON.stringify(PAUSE_DIR)}, downloadDirs: { 'archive-org': ${JSON.stringify(PAUSE_DIR)} } })`
  );
  if (!saved || (saved.downloadDirs || {})['archive-org'] !== PAUSE_DIR) throw new Error('per-source folder pref did not save');
  // Let the debounced persistence + the pause transition settle, then quit
  // (before-quit flushes prefs + the paused transfer record).
  await new Promise((r) => setTimeout(r, 600));
  console.log('PAUSE_BOOT1_QUITTING');
  setTimeout(() => app.exit(0), 4000);
  app.quit();
}

async function phasePauseVerify(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const found = await waitFor(
    'boot#2 paused transfer restored from persistence',
    () =>
      js(`(async () => {
        const list = await window.torrentor.getDownloads();
        const t = list.find((x) => x.url === ${JSON.stringify(DL_URL)});
        if (!t || t.status !== 'paused') return null;
        return { id: t.id, status: t.status, filePath: t.filePath };
      })()`)
  );
  // Give it real time to prove it does NOT auto-resume — an auto-resume
  // would Range-continue the .part within a moment.
  await new Promise((r) => setTimeout(r, 1500));
  const still = await js(
    `(async () => { const list = await window.torrentor.getDownloads(); const t = list.find((x) => x.url === ${JSON.stringify(DL_URL)}); return t ? t.status : null; })()`
  );
  if (still !== 'paused') throw new Error(`paused transfer auto-resumed or vanished: status=${still}`);
  if (!fs.existsSync(found.filePath + '.part')) throw new Error('partial file missing after restart');
  console.log('PAUSE_BOOT2_PAUSED status=paused partial=kept');
  const prefs = await js(`window.torrentor.getState().then((s) => s.prefs || {})`);
  const dir = (prefs.downloadDirs || {})['archive-org'];
  if (dir !== PAUSE_DIR) throw new Error(`downloadDirs['archive-org'] = ${dir}, expected ${PAUSE_DIR}`);
  console.log(`PAUSE_BOOT2_FOLDER_OK dir=${dir}`);
  try {
    fs.rmSync(process.env.TORRENTOR_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  app.exit(0);
}

async function phaseVerify(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const found = await waitFor(
    'boot#2 auto-resumed the interrupted download to Done',
    () =>
      js(`(async () => {
        const list = await window.torrentor.getDownloads();
        const t = list.find((x) => x.url === ${JSON.stringify(DL_URL)});
        if (!t || t.status !== 'done') return null;
        return { id: t.id, resumed: !!t.resumed, received: t.received, total: t.total, filePath: t.filePath };
      })()`)
  );
  if (!found.resumed) throw new Error('transfer completed but resumed flag is false (started from zero?)');
  const size = fs.existsSync(found.filePath) ? fs.statSync(found.filePath).size : -1;
  if (size !== EXPECTED) throw new Error(`final file size ${size} !== expected ${EXPECTED}`);
  console.log(`RESUME_BOOT2_OK resumed=${found.resumed} bytes=${size} transferId=${found.id}`);
  try {
    fs.rmSync(process.env.TORRENTOR_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  app.exit(0);
}

async function main() {
  console.log(`\nTorrentor two-boot resume test — phase: ${PHASE}\n`);
  try {
    const win = await getWindow();
    if (PHASE === 'start') await phaseStart(win);
    else if (PHASE === 'verify') await phaseVerify(win);
    else if (PHASE === 'pause-start') await phasePauseStart(win);
    else if (PHASE === 'pause-verify') await phasePauseVerify(win);
    else if (PHASE === 'order-start') await phaseOrderStart(win);
    else if (PHASE === 'order-verify') await phaseOrderVerify(win);
    else throw new Error(`Unknown phase ${PHASE}`);
  } catch (err) {
    fail(String((err && err.message) || err).slice(0, 300));
  }
}

main();
