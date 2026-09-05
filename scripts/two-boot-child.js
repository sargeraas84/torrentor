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
//
// Smart scenario (smart order + learned per-file speeds must survive):
// Phase 'smart-start'  (boot #1): enables the smart-order pref, starts
//   four genuine downloads (two active, two queued) with per-transfer
//   limits, waits until each active has MEASURED its own bandwidth (its
//   learned rateBps — equal to its enforced limit), then quits.
// Phase 'smart-verify' (boot #2): asserts the smart-order pref survived,
//   the resumed transfers still carry their learned per-file speeds, the
//   restored queue keeps its (folder-batched, eta-stable) order under
//   smart ordering, and all four complete to the exact full size.
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

async function phaseSmartStart(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  // Enable smart ordering exactly like the tray toggle does (persisted).
  await js(`window.torrentor.setSmartOrder(true)`);
  const prefs = await js(`window.torrentor.getState().then((s) => s.prefs || {})`);
  if (!prefs.smartOrder) throw new Error('smart order pref did not enable');
  const urls = [0, 1, 2, 3].map((i) => `${BASE}smart-${i}.bin`);
  const results = [];
  for (const u of urls) results.push(await js(`window.torrentor.downloadFile(${JSON.stringify(u)})`));
  const ts = results.map((r) => r && r.transfer);
  if (!ts.every((t) => t && (t.status === 'downloading' || t.status === 'queued'))) throw new Error('smart seed transfers did not start cleanly');
  const [a, b, c, d] = ts;
  // a/b (active) at 96/128 KB/s, c (queued) at 256 KB/s. Each active's own
  // measured bandwidth becomes exactly its limit after the first 500 ms
  // progress tick — that learned per-file speed is what must survive the
  // restart and feed the smart-order estimates next boot.
  await js(`Promise.all([window.torrentor.setDownloadLimit(${a.id}, 98304), window.torrentor.setDownloadLimit(${b.id}, 131072), window.torrentor.setDownloadLimit(${c.id}, 262144)])`);
  const measured = await waitFor(
    'boot#1 both actives measured their own speed',
    () =>
      js(`(async () => {
        const list = await window.torrentor.getDownloads();
        const A = list.find((x) => x.id === ${a.id});
        const B = list.find((x) => x.id === ${b.id});
        if (!A || !B || A.rateBps !== 98304 || B.rateBps !== 131072) return null;
        return { a: A.rateBps, b: B.rateBps };
      })()`),
    20000
  );
  console.log(`SMART_BOOT1_MEASURED a=${measured.a} b=${measured.b} c=${262144} order=smart-2,smart-3`);
  console.log('SMART_BOOT1_QUITTING');
  setTimeout(() => app.exit(0), 4000);
  app.quit();
}

async function phaseSmartVerify(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  // Boot #2 must still be in smart order (the pref survived) AND the
  // resumed transfers must carry the per-file speeds they measured before
  // quitting — both prerequisites for the restored queue's folder-batched,
  // eta-based ordering to mean anything.
  const prefs = await js(`window.torrentor.getState().then((s) => s.prefs || {})`);
  if (!prefs.smartOrder) throw new Error('smart order pref did not survive the restart');
  const state = await waitFor(
    'boot#2 restored the queue under smart order with learned speeds',
    () =>
      js(`(async () => {
        const list = await window.torrentor.getDownloads();
        const mine = list.filter((t) => t.url.startsWith(${JSON.stringify(BASE)}));
        if (mine.length < 4) return null;
        const queued = mine.filter((t) => t.status === 'queued').sort((x, y) => x.queuePos - y.queuePos);
        if (queued.length < 2) return null;
        const byName = Object.fromEntries(mine.map((t) => [t.url.split('/').pop(), t]));
        if (!byName['smart-0.bin'] || !byName['smart-1.bin'] || !byName['smart-2.bin'] || !byName['smart-3.bin']) return null;
        return {
          queuedOrder: queued.slice(0, 2).map((t) => t.url.split('/').pop()),
          aLimit: byName['smart-0.bin'].maxBytesPerSec,
          bLimit: byName['smart-1.bin'].maxBytesPerSec,
          cLimit: byName['smart-2.bin'].maxBytesPerSec,
          aRate: byName['smart-0.bin'].rateBps,
          bRate: byName['smart-1.bin'].rateBps,
          cEtaBasis: queued[0].etaBasis,
          files: mine.map((t) => t.filePath),
        };
      })()`),
    25000
  );
  if (state.queuedOrder[0] !== 'smart-2.bin' || state.queuedOrder[1] !== 'smart-3.bin') throw new Error(`queue order lost under smart order: ${JSON.stringify(state.queuedOrder)}`);
  if (state.aLimit !== 98304 || state.bLimit !== 131072 || state.cLimit !== 262144) throw new Error(`limits lost: a=${state.aLimit} b=${state.bLimit} c=${state.cLimit}`);
  if (state.aRate !== 98304 || state.bRate !== 131072) throw new Error(`learned per-file speeds lost: a=${state.aRate} b=${state.bRate}`);
  console.log('SMART_BOOT2_QUEUE_OK smart=on learned=a:98304,b:131072 order=smart-2,smart-3');
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
  console.log('SMART_BOOT2_DONE bytes=' + EXPECTED);
  try {
    fs.rmSync(process.env.TORRENTOR_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  app.exit(0);
}

async function phasePlanStart(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  // Smart order on so applying the plan visibly re-ranks the queue.
  await js(`window.torrentor.setSmartOrder(true)`);
  const urls = [0, 1, 2, 3].map((i) => `${BASE}plan-${i}.bin`);
  const results = [];
  for (const u of urls) results.push(await js(`window.torrentor.downloadFile(${JSON.stringify(u)})`));
  const ts = results.map((r) => r && r.transfer);
  if (!ts.every((t) => t && (t.status === 'downloading' || t.status === 'queued'))) throw new Error('plan seed transfers did not start cleanly');
  const [a, b, c, d] = ts;
  // Actives at 96/128 KB/s (they measure their own speed); both queued at
  // 256 KB/s so the restored queue comes back with equal ETAs. The plan
  // then pins c's FOLDER at 100 KB/s and overrides d at 512 KB/s — boot #2
  // must restore the plan and re-apply it to the restored queue.
  await js(`Promise.all([window.torrentor.setDownloadLimit(${a.id}, 98304), window.torrentor.setDownloadLimit(${b.id}, 131072), window.torrentor.setDownloadLimit(${c.id}, 262144), window.torrentor.setDownloadLimit(${d.id}, 262144)])`);
  const snap = await js(`window.torrentor.getDownloads()`);
  const cDir = (snap.find((t) => t.id === c.id) || {}).dir;
  const dPath = (snap.find((t) => t.id === d.id) || {}).filePath;
  if (!cDir || !dPath) throw new Error('queued transfers missing dir/filePath');
  const saved = await js(`window.torrentor.saveQueuePlan('boot-plan', { ${d.id}: 524288 }, { ${JSON.stringify(cDir)}: 102400 })`);
  const entries = (saved && saved['boot-plan']) || [];
  if (entries.length !== 2 || !entries.some((e) => e.dir === cDir) || !entries.some((e) => e.filePath === dPath && e.bytesPerSec === 524288)) {
    throw new Error(`plan did not save as folder rule + override: ${JSON.stringify(entries)}`);
  }
  // Let the debounced prefs write + quit-flush persist the plan.
  await new Promise((r) => setTimeout(r, 600));
  console.log(`PLAN_BOOT1_SAVED folder=${102400} override=${d.id}:524288`);
  console.log('PLAN_BOOT1_QUITTING');
  setTimeout(() => app.exit(0), 4000);
  app.quit();
}

async function phasePlanVerify(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  // The plan itself must have survived the relaunch (persisted in prefs
  // keyed by destination folder/path — transfer ids are transient).
  const plans = await waitFor(
    'boot#2 queue plan restored from prefs',
    () => js(`window.torrentor.listQueuePlans().then((p) => { const e = (p || {})['boot-plan']; return e && e.length === 2 ? e : null; })`)
  );
  const folderEntry = plans.find((e) => e.dir);
  const fileEntry = plans.find((e) => e.filePath);
  if (!folderEntry || !fileEntry) throw new Error(`plan shape lost across restart: ${JSON.stringify(plans)}`);
  if (folderEntry.bytesPerSec !== 102400 || fileEntry.bytesPerSec !== 524288) throw new Error(`plan limits lost across restart: ${JSON.stringify(plans)}`);
  console.log('PLAN_BOOT2_PLAN_OK folder=100KB/s override=512KB/s');
  // The restored queue must still carry boot #1's 256 KB/s limits (so
  // applying the plan visibly CHANGES them), then Apply re-pins via the
  // real queuePlans:apply IPC and the queue re-ranks under smart order.
  const state0 = await waitFor(
    'boot#2 restored the four transfers',
    () =>
      js(`(async () => {
        const list = await window.torrentor.getDownloads();
        const mine = list.filter((t) => t.url.startsWith(${JSON.stringify(BASE)}));
        if (mine.length < 4) return null;
        const byName = Object.fromEntries(mine.map((t) => [t.url.split('/').pop(), t]));
        if (!byName['plan-2.bin'] || !byName['plan-3.bin']) return null;
        return { cLimit: byName['plan-2.bin'].maxBytesPerSec, files: mine.map((t) => t.filePath) };
      })()`),
    25000
  );
  if (state0.cLimit !== 262144) throw new Error(`restored c limit unexpected: ${state0.cLimit}`);
  const res = await js(`window.torrentor.applyQueuePlan('boot-plan')`);
  const applied = res && res.applied;
  const state = await waitFor(
    'boot#2 plan limits applied + queue re-ranked',
    () =>
      js(`(async () => {
        const list = await window.torrentor.getDownloads();
        const mine = list.filter((t) => t.url.startsWith(${JSON.stringify(BASE)}));
        const byName = Object.fromEntries(mine.map((t) => [t.url.split('/').pop(), t]));
        if (!byName['plan-2.bin'] || !byName['plan-3.bin']) return null;
        const queued = mine.filter((t) => t.status === 'queued').sort((x, y) => x.queuePos - y.queuePos);
        if (queued.length < 2) return null;
        return {
          cLimit: byName['plan-2.bin'].maxBytesPerSec,
          dLimit: byName['plan-3.bin'].maxBytesPerSec,
          queuedOrder: queued.slice(0, 2).map((t) => t.url.split('/').pop()),
        };
      })()`),
    25000
  );
  if (state.cLimit !== 102400 || state.dLimit !== 524288) throw new Error(`plan limits not applied: c=${state.cLimit} d=${state.dLimit}`);
  // Note: these queued files are unknown-size HTTP transfers (their
  // Content-Length arrives only once a slot frees and they start), so under
  // smart order they rank by arrival — the ETA-based re-rank of limits is
  // proven by unit tests with known-size files. What this scenario proves
  // is that the plan survived the relaunch and its limits landed on the
  // restored transfers.
  if (typeof applied !== 'number' || applied < 2) throw new Error(`plan apply touched too few transfers: applied=${applied}`);
  console.log(`PLAN_BOOT2_APPLIED_OK c=${state.cLimit} d=${state.dLimit} applied=${applied}`);
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
  const sizes = state0.files.map((fp) => (fs.existsSync(fp) ? fs.statSync(fp).size : -1));
  if (sizes.some((s) => s !== EXPECTED)) throw new Error(`final sizes ${JSON.stringify(sizes)} !== ${EXPECTED}`);
  console.log('PLAN_BOOT2_DONE bytes=' + EXPECTED);
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
    else if (PHASE === 'smart-start') await phaseSmartStart(win);
    else if (PHASE === 'smart-verify') await phaseSmartVerify(win);
    else if (PHASE === 'plan-start') await phasePlanStart(win);
    else if (PHASE === 'plan-verify') await phasePlanVerify(win);
    else throw new Error(`Unknown phase ${PHASE}`);
  } catch (err) {
    fail(String((err && err.message) || err).slice(0, 300));
  }
}

main();
