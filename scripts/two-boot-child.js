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
// ---------------------------------------------------------------------

const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PHASE = process.env.TORRENTOR_RESUME_PHASE || '';
const DL_URL = process.env.TORRENTOR_RESUME_URL || '';
const EXPECTED = Number(process.env.TORRENTOR_RESUME_EXPECTED_BYTES) || 0;

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
    else throw new Error(`Unknown phase ${PHASE}`);
  } catch (err) {
    fail(String((err && err.message) || err).slice(0, 300));
  }
}

main();
