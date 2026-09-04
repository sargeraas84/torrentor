'use strict';
// ---------------------------------------------------------------------
// Torrentor Electron smoke test (npm run test:electron).
//
// Boots the REAL app (main.js) inside Electron with a temp data dir and
// an invisible window, then drives it through the actual preload bridge
// (window.torrentor) via executeJavaScript — the same path the UI uses:
//   getState → enable only the offline demo engine → run a search →
//   assert merged results stream in → toggle a favorite → check IP
//   validation plumbing (validation only; no outbound calls).
// ---------------------------------------------------------------------

const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.TORRENTOR_SMOKE = '1';
process.env.TORRENTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-e2e-'));

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  console.log('\nTorrentor Electron smoke tests\n');

  // Boot the real main process (window creation, IPC, registry).
  require('../main.js');
  await app.whenReady();

  // Wait for the window the app created for us.
  let win = null;
  for (let i = 0; i < 100 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await new Promise((r) => setTimeout(r, 100));
  }
  if (!win) throw new Error('App window never appeared');

  await new Promise((resolve, reject) => {
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', resolve);
    } else resolve();
  });

  const js = (code) => win.webContents.executeJavaScript(code, true);

  // Capture renderer errors as early as possible (attach before load ends).
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('preload-error', (_e, p, err) => console.log('[preload-error]', p, String(err)));

  // ----- UI mounted (React shell rendered without crashing) ---------------
  await new Promise((r) => setTimeout(r, 400));
  const rootLen = await js(`document.getElementById('root').innerHTML.length`);
  if (!(rootLen > 200)) throw new Error(`React did not mount (root length ${rootLen})`);
  ok('UI mounts — React rendered the app shell');

  // ----- state / engines ------------------------------------------------
  const state = await js(`window.torrentor.getState()`);
  if (!state || !state.engines || state.engines.length < 3) {
    console.error('[debug] getState raw:', JSON.stringify(state).slice(0, 800));
    throw new Error('getState did not return engine metadata');
  }
  if (!Array.isArray(state.history) || !Array.isArray(state.favorites)) throw new Error('library arrays missing');
  ok('getState returns engines + library via preload bridge');

  // ----- demo-only search over the real IPC + orchestrator --------------
  const demoId = state.engines.find((e) => e.id === 'demo-curated').id;
  await js(`window.torrentor.setEngines(['${demoId}'])`);
  const searched = await js(`(async () => {
    const out = { progress: 0, done: null };
    window.torrentor.onSearchProgress((snap) => { out.progress++; out.last = snap; });
    out.done = await window.torrentor.search('ubuntu desktop', ['${demoId}']);
    return out;
  })()`);
  if (!searched.done || !searched.done.results || !searched.done.results.length) throw new Error('Demo search returned no results');
  if (searched.done.stats.okEngines !== 1) throw new Error(`Expected 1 ok engine, got ${JSON.stringify(searched.done.perEngine)}`);
  const first = searched.done.results[0];
  if (!first.title || !first.magnet || !first.infohash || !first.sources.length) throw new Error('Result card shape incomplete');
  if (searched.done.results.some((r) => !r.demo)) throw new Error('Non-demo results leaked into a demo-only run');
  ok(`demo search merged ${searched.done.results.length} cards over real IPC`);

  // ----- streaming progress fired before resolve ------------------------
  if (!(searched.progress >= 1)) throw new Error('No progress events observed');
  ok('per-engine progress events streamed to the renderer');

  // ----- favorite round-trip --------------------------------------------
  const fav = await js(`window.torrentor.toggleFavorite(${JSON.stringify(first)})`);
  if (!fav.added) throw new Error('Favorite did not save');
  const favorites = await js(`window.torrentor.getFavorites()`);
  if (favorites.length !== 1 || favorites[0].key !== first.key) throw new Error('Favorite list mismatch');
  const unfav = await js(`window.torrentor.toggleFavorite(${JSON.stringify(first)})`);
  if (unfav.added) throw new Error('Second toggle should remove');
  ok('favorites toggle + list round-trip over IPC');

  // ----- proxy validation plumbing (no network) -------------------------
  const bad = await js(`window.torrentor.validateProxy({ enabled: true, host: '', port: 1080, type: 'socks5' })`);
  if (bad.ok) throw new Error('Empty host should not validate');
  const good = await js(`window.torrentor.validateProxy({ enabled: true, host: '127.0.0.1', port: 9050, type: 'socks5' })`);
  if (!good.ok) throw new Error('Valid proxy config rejected');
  ok('proxy validation exposed through the bridge');

  // ----- history recorded ------------------------------------------------
  const hist = await js(`window.torrentor.getState().then((s) => s.history)`);
  if (!hist.some((h) => h.q === 'ubuntu desktop')) throw new Error('Search not recorded in history');
  ok('completed search recorded in history');

  // ----- source health self-test (live probes over the real bridge) -----
  const health0 = await js(`window.torrentor.getHealth()`);
  if (!Array.isArray(health0) || health0.length !== 0) throw new Error('getHealth should start empty');
  const healthRun = await js(`window.torrentor.runHealth()`);
  const healthIds = (healthRun || []).map((h) => h.engineId);
  if (healthRun.length !== 3 || !healthIds.includes('archive-org') || !healthIds.includes('distro-releases') || !healthIds.includes('arch-releases')) {
    throw new Error('health:run did not test the 3 real engines: ' + JSON.stringify(healthIds));
  }
  for (const h of healthRun) {
    if (!('ok' in h) || !Number.isInteger(h.count) || typeof h.latencyMs !== 'number' || !h.at) {
      throw new Error('health record shape incomplete: ' + JSON.stringify(h));
    }
    if (!h.ok) throw new Error(`${h.engineId} unhealthy: ${h.error}`);
  }
  const health1 = await js(`window.torrentor.getHealth()`);
  if (health1.length !== 3) throw new Error('health results not persisted after run');
  ok(`health self-test probed ${healthRun.length} real engines over IPC and persisted verdicts`);

  console.log(`\n${passed} checks passed ✔\n`);
  try {
    fs.rmSync(process.env.TORRENTOR_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  app.exit(0);
}

main().catch((err) => {
  console.error('\n✗ ELECTRON SMOKE TEST FAILED:', err);
  try {
    fs.rmSync(process.env.TORRENTOR_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  app.exit(1);
});
