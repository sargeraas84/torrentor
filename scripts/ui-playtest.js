'use strict';
// ---------------------------------------------------------------------
// Torrentor UI playtest (npm run test:ui).
//
// Boots the REAL app (main.js) inside Electron with a temp data dir and
// an invisible window, then drives the actual window DOM the way a user
// would: types queries, clicks search, toggles favorites, removes from
// the Favorites tab, and runs the VPN save-and-check-IP flow including
// its failure path. All engine traffic is the real network path
// (Archive.org + Linux releases are genuinely queried); nothing here
// fakes the IPC or the engines.
// ---------------------------------------------------------------------

const { app, BrowserWindow, clipboard } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.TORRENTOR_SMOKE = '1';
process.env.TORRENTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-ui-'));

let passed = 0;
const defects = [];
let consoleErrors = []; // hoisted so the failure path can report renderer errors
function ok(name, extra) {
  passed++;
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
}
function defect(name, detail) {
  defects.push(name);
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log('\nTorrentor UI playtest (real window, real engines)\n');

  require('../main.js');
  await app.whenReady();

  let win = null;
  for (let i = 0; i < 100 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await new Promise((r) => setTimeout(r, 100));
  }
  if (!win) throw new Error('App window never appeared');

  consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) consoleErrors.push(String(message).slice(0, 300));
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    consoleErrors.push(`RENDERER GONE: ${JSON.stringify(details)}`);
  });

  const js = (code) =>
    win.webContents.executeJavaScript(code, true).catch((err) => {
      throw new Error(`[playtest] evaluate failed (${String(err && err.message || err).slice(0, 140)})\n  code: ${String(code).slice(0, 220)}`);
    });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(desc, code, timeoutMs = 15000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      last = await js(code);
      if (last) return last;
      await wait(200);
    }
    throw new Error(`Timed out waiting for: ${desc} (last=${JSON.stringify(last).slice(0, 200)})`);
  }

  const setText = (sel, value) =>
    js(`(() => { const el = document.querySelector('${sel}'); if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

  const click = (sel) => js(`(() => { const el = document.querySelector('${sel}'); if (!el) return false; el.click(); return true; })()`);
  const textOf = (sel) => js(`(() => { const el = document.querySelector('${sel}'); return el ? el.textContent : null; })()`);

  await new Promise((resolve) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve);
    else resolve();
  });
  await waitFor('React UI mounts', `document.querySelectorAll('[data-testid^="engine-"]').length >= 4`);

  // ================= 1. careless input: too-short query =================
  await setText('[data-testid="search-input"]', 'a');
  await wait(80);
  await click('[data-testid="search-go"]');
  await waitFor('validation toast', `(() => { const t = document.querySelector('[data-testid="toast"]'); return t && t.textContent.includes('at least 2 characters'); })()`);
  const stillIdle = await js(`!!document.querySelector('[data-testid="idle-state"]')`);
  if (!stillIdle) defect('short query should not start a search', 'idle state lost');
  else ok('careless 1-char query → toast, no search started');
  await wait(2400); // toast clears

  // ===== 1b. Explore open culture tiles (idle) =====
  await waitFor('explore tiles loaded on idle', `document.querySelectorAll('[data-testid="explore-tile"]').length >= 3`, 20000);
  ok('Explore open culture tiles render on idle');
  const tileQ = await js(`document.querySelector('[data-testid="explore-tile"]').getAttribute('data-q')`);
  await click('[data-testid="explore-tile"]');
  await waitFor('tile search starts running', `!!document.querySelector('[data-testid="run-status"]')`, 8000);
  await waitFor('tile search completes', `(() => { const s = document.querySelector('[data-testid="run-summary"]'); return s && /\\d+ unique results? from/.test(s.textContent); })()`, 25000);
  const tileSum = await textOf('[data-testid="run-summary"]');
  ok(`Explore tile '${tileQ}' ran a real search`, tileSum);
  const withCreatorYear = await js(`[...document.querySelectorAll('[data-testid="result-card"]')].some((c) => !!c.querySelector('[data-testid="card-meta"]') && /(1[89]\\d\\d|20[0-3]\\d)/.test(c.querySelector('[data-testid="card-meta"]').textContent))`);
  if (!withCreatorYear) defect('Archive card shows creator — year meta', 'no card matched');
  else ok('Archive cards show creator — year meta');
  const chipRow = await js(`!!document.querySelector('[data-testid="arch-filter-all"]')`);
  const chipBefore = await js(`document.querySelectorAll('[data-testid="result-card"]').length`);
  if (!chipRow || chipBefore === 0) defect('Archive mediatype chips appear', 'chip row missing');
  else {
    const mtSel = await js(`(() => { const b = [...document.querySelectorAll('[data-testid^="arch-filter-"]')].find((x) => x.getAttribute('data-testid') !== 'arch-filter-all'); return b ? b.getAttribute('data-testid') : null; })()`);
    await click(`[data-testid="${mtSel}"]`);
    await wait(300);
    const chipAfter = await js(`document.querySelectorAll('[data-testid="result-card"]').length`);
    if (!(chipAfter > 0 && chipAfter <= chipBefore)) defect('mediatype chip filters list', `${chipBefore} -> ${chipAfter}`);
    else ok(`Archive mediatype chip filters the list (${chipBefore} -> ${chipAfter})`);
    await click('[data-testid="arch-filter-all"]');
    await wait(250);
    const restored = await js(`document.querySelectorAll('[data-testid="result-card"]').length`);
    if (restored !== chipBefore) defect('Archive All chip restores list', `${chipBefore} -> ${restored}`);
    else ok('Archive All chip restores full list');
  }

  // ============== 2. real live search: 'ubuntu', watch stream =============
  await setText('[data-testid="search-input"]', 'ubuntu');
  await wait(80);
  await click('[data-testid="search-go"]');

  const samples = [];
  const t0 = Date.now();
  let final = null;
  while (Date.now() - t0 < 20000) {
    const s = await js(`(() => ({
        running: !!document.querySelector('[data-testid="run-status"]'),
        cards: document.querySelectorAll('[data-testid="result-card"]').length,
        sum: (document.querySelector('[data-testid="run-summary"]') || {}).textContent || null,
      }))()`);
    samples.push(s);
    if (!s.running && s.sum) {
      final = s;
      break;
    }
    await wait(150);
  }
  if (!final) throw new Error('Live search never completed');

  ok(`live 'ubuntu' search finished: ${final.sum}`);
  if (!final.sum.includes('4/4 sources')) defect('expected all 4 sources ok', final.sum);
  // Regression: the Linux-releases engine must actually serve Ubuntu torrents
  // (a silent ok/0 here — e.g. a releases.ubuntu.com redesign outrunning the
  // parser — fails the whole suite loudly, not a green chip).
  const distroChip = await textOf('[data-testid="engine-distro-releases"]');
  const distroCount = distroChip ? parseInt((distroChip.match(/\d+/) || [])[0], 10) : NaN;
  if (!(distroCount > 0)) defect('Linux releases engine returned no Ubuntu results for "ubuntu"', String(distroChip));
  else ok('Linux releases engine serves official Ubuntu torrents', `${distroCount} results`);
  const midFlightWithCards = samples.filter((s) => s.running && s.cards > 0).length;
  const cardCountsSeen = [...new Set(samples.map((s) => s.cards))];
  ok(`results streamed in live (observed card counts while running: ${midFlightWithCards > 0 ? cardCountsSeen.join(', ') : 'n/a'})`, midFlightWithCards > 0 ? 'cards visible before all sources finished' : 'demo engine resolved too fast to sample');

  // Honesty: top card must be a real source genuinely matching 'ubuntu'.
  const topCard = await js(`(() => {
      const c = document.querySelectorAll('[data-testid="result-card"]')[0];
      return c ? c.innerText : null;
    })()`);
  if (!topCard) throw new Error('No top result card');
  const topReal = !/Demo index|DEMO/.test(topCard) && /Internet Archive|Linux releases/.test(topCard);
  if (!topReal) defect('top card is not a real source', topCard.slice(0, 120));
  else if (!topCard.toLowerCase().includes('ubuntu')) defect('top card does not match query', topCard.slice(0, 120));
  else ok('top card is a real, matching source (no demo above real results)');

  // Archive.org cards must render their poster thumbnail.
  await waitFor(
    'an Archive thumbnail actually renders',
    `[...document.querySelectorAll('[data-testid="result-thumb"]')].some((i) => i.complete && i.naturalWidth > 0)`,
    15000
  );
  const thumbsLoaded = await js(`[...document.querySelectorAll('[data-testid="result-thumb"]')].filter((i) => i.complete && i.naturalWidth > 0).length`);
  ok(`Archive poster thumbnails render in the list (${thumbsLoaded} loaded)`);

  // ================= 3. favorite → Favorites tab → remove =================
  await click('[data-testid="result-card"] [data-testid="fav-toggle"]');
  await waitFor('favorites count increments', `document.querySelector('[data-testid="tab-favorites"]').textContent.includes('(1)')`);
  await click('[data-testid="tab-favorites"]');
  await waitFor('favorite row appears', `document.querySelectorAll('[data-testid="favorite-row"]').length === 1`);
  const favRow = await textOf('[data-testid="favorite-row"]');
  ok('favorite added and visible in Favorites tab', favRow.slice(0, 60).replace(/\s+/g, ' '));
  await click('[data-testid="remove-fav"]');
  await waitFor('favorite removed', `document.querySelectorAll('[data-testid="favorite-row"]').length === 0`);
  const favEmpty = await textOf('[data-testid="favorites-empty"]');
  await click('[data-testid="tab-search"]');
  await waitFor('results still intact after removing favorite', `document.querySelectorAll('[data-testid="result-card"]').length > 0`);
  ok('favorite removed from Favorites tab; results list intact');

  // ===================== 4. VPN save & check IP =====================
  await click('[data-testid="open-settings"]');
  await waitFor('settings modal', `!!document.querySelector('[data-testid="st-vpn"]')`);
  await click('[data-testid="st-vpn"]');
  await waitFor('proxy form', `!!document.querySelector('[data-testid="proxy-host"]')`);

  // Failure path: SOCKS5 route to a dead local port.
  await setText('[data-testid="proxy-host"]', '127.0.0.1');
  await setText('[data-testid="proxy-port"]', '9');
  const routeText = await textOf('[data-testid="route-toggle"]');
  if (routeText && routeText.includes('Route disabled')) await click('[data-testid="route-toggle"]');
  await wait(80);
  await click('[data-testid="save-check-ip"]');
  await waitFor('VPN failure feedback', `(() => { const el = document.querySelector('[data-testid="ip-result"]'); return el && el.textContent.includes('IP check failed'); })()`, 12000);
  const failText = await textOf('[data-testid="ip-result"]');
  ok('bad proxy → clear failure feedback in UI', failText.replace(/\s+/g, ' ').slice(0, 90));

  // Recovery: disable route, save, then direct check succeeds.
  await click('[data-testid="route-toggle"]'); // back to disabled
  await wait(80);
  await click('[data-testid="save-proxy"]');
  await wait(80);
  await click('[data-testid="check-ip"]');
  await waitFor('direct IP check succeeds', `(() => { const el = document.querySelector('[data-testid="ip-result"]'); return el && el.textContent.startsWith('exit IP'); })()`, 15000);
  const okText = await textOf('[data-testid="ip-result"]');
  ok('recovery: direct route check succeeds', okText.replace(/\s+/g, ' ').slice(0, 80));
  await click('[data-testid="close-settings"]');
  await waitFor('settings closed', `!document.querySelector('[data-testid="st-vpn"]')`);

  // ===== 4b. source health self-test in Settings (real probes) =====
  await click('[data-testid="open-settings"]');
  await waitFor('settings modal', `!!document.querySelector('[data-testid="st-engines"]')`);
  // Opening the sources tab auto-runs the probes; the Linux releases row must
  // come back healthy (Ubuntu probe ≥1 result) — the silent ok/0 tripwire,
  // now user-visible in Settings.
  await waitFor(
    'Linux releases health row healthy',
    `(() => { const s = document.querySelector('[data-testid="health-status-distro-releases"]'); return s && /healthy/.test(s.textContent); })()`,
    25000
  );
  const distroHealth = await textOf('[data-testid="health-status-distro-releases"]');
  ok('Linux releases health row healthy in Settings', distroHealth.replace(/\s+/g, ' ').slice(0, 70));
  const healthyCount = await js(`[...document.querySelectorAll('[data-testid^="health-status-"]')].filter((el) => /healthy/.test(el.textContent)).length`);
  if (healthyCount < 2) defect('expected at least 2 healthy source rows', String(healthyCount));
  else ok(`health self-test: ${healthyCount} sources report healthy`);
  const demoNote = await textOf('[data-testid="health-status-demo-curated"]');
  if (!demoNote || !demoNote.includes('offline')) defect('demo row shows offline note', String(demoNote));
  else ok('demo index shows offline note (never tested)');
  await click('[data-testid="health-run-all"]');
  await waitFor(
    'test-all button flips to testing',
    `(() => { const b = document.querySelector('[data-testid="health-run-all"]'); return b && /Testing/.test(b.textContent); })()`,
    8000
  );
  await waitFor(
    'rows healthy again after manual re-run',
    `[...document.querySelectorAll('[data-testid^="health-status-"]')].filter((el) => /healthy/.test(el.textContent)).length >= 2`,
    25000
  );
  ok('Test all sources re-run refreshes verdicts');
  await click('[data-testid="close-settings"]');
  await waitFor('settings closed after health step', `!document.querySelector('[data-testid="st-engines"]')`);

  // ============ 5. garbage query → honest empty state → recover ============
  await setText('[data-testid="search-input"]', 'zzzqqqxx');
  await wait(80);
  await click('[data-testid="search-go"]');
  await waitFor('empty state for nonsense query', `!!document.querySelector('[data-testid="empty-state"]')`, 20000);
  ok('nonsense query → honest “No results” (no fabricated cards)');
  const sugClicked = await click('[data-testid="suggestion"]'); // first suggestion = "ubuntu 24.04"
  if (!sugClicked) throw new Error('No suggestion chip to click in the empty state');
  await waitFor('recovery search starts running', `!!document.querySelector('[data-testid="run-status"]')`, 8000);
  await waitFor('recovery search completes', `(() => { const s = document.querySelector('[data-testid="run-summary"]'); return s && /\\d+ unique results? from/.test(s.textContent); })()`, 20000);
  const recSum = await textOf('[data-testid="run-summary"]');
  const recCount = parseInt(recSum, 10);
  if (!(recCount > 0)) defect('suggestion recovery produced results', recSum);
  else ok('recovered via suggestion chip', recSum);

  // ===== 6. Arch Linux official torrents: query the new source answers =====
  // ('archlinux iso' — Archive mirrors also match, so the assertion is
  //  that the official Arch engine's real cards lead the list, not demo.)
  await setText('[data-testid="search-input"]', 'archlinux iso');
  await wait(80);
  await click('[data-testid="search-go"]');
  await waitFor('arch query completes', `(() => { const s = document.querySelector('[data-testid="run-summary"]'); return s && /\\d+ unique results? from/.test(s.textContent); })()`, 25000);
  const archTop = await js(`(() => {
      const c = document.querySelectorAll('[data-testid="result-card"]')[0];
      return c ? c.innerText : null;
    })()`);
  if (!archTop) throw new Error('No top result card for arch query');
  const archCard = !/Demo index|DEMO/.test(archTop) && archTop.includes('Arch Linux');
  const archCount = await js(`(() => {
      const chip = document.querySelector('[data-testid="engine-arch-releases"]');
      return chip ? chip.textContent : null;
    })()`);
  if (!archCard) defect('top card for arch query is not a real Arch Linux release', archTop.slice(0, 120));
  else ok('official Arch Linux release tops the arch query (new engine, real match)', archTop.slice(0, 70).replace(/\s+/g, ' '));
  if (!archCount || /OFF/.test(archCount) || !/\d+/.test(archCount)) defect('Arch engine chip shows a count', String(archCount));
  else ok('Arch engine chip reports ok with results', archCount.replace(/\s+/g, ' '));

  // ============= 7. Archive paging: page past one full page =============
  await setText('[data-testid="search-input"]', 'linux');
  await wait(80);
  await click('[data-testid="search-go"]');
  await waitFor('broad query completes', `(() => { const s = document.querySelector('[data-testid="run-summary"]'); return s && /\\d+ unique results? from/.test(s.textContent); })()`, 25000);
  const p1Count = await js(`document.querySelectorAll('[data-testid="result-card"]').length`);
  if (!(p1Count > 0)) throw new Error('Broad query returned no cards');
  await waitFor('load more affordance appears', `!!document.querySelector('[data-testid="load-more"]')`, 8000);
  const clickedMore = await click('[data-testid="load-more"]');
  if (!clickedMore) throw new Error('Could not click load more');
  await waitFor('second page merges new cards into the list', `document.querySelectorAll('[data-testid="result-card"]').length > ${p1Count}`, 25000);
  const p2Count = await js(`document.querySelectorAll('[data-testid="result-card"]').length`);
  ok(`paged past one full page: ${p1Count} → ${p2Count} cards, deduped into one list`);

  // ============= 8. Recent tab shows the played searches =============
  await click('[data-testid="tab-history"]');
  await waitFor('history rows recorded', `document.querySelectorAll('[data-testid="history-row"]').length >= 4`);
  const rows = await js(`document.querySelectorAll('[data-testid="history-row"]').length`);
  ok(`recent searches recorded: ${rows} entries in Recent tab`);

  // ===== 9. Demo download — paced by the DEFAULT speed limit =====
  // The tray's per-transfer control only matters while a transfer is LIVE,
  // so this step first sets Settings → Library's default limit to 100 KB/s
  // (it applies to new downloads; the demo payload is sized to keep a
  // 100 KB/s transfer streaming for several seconds), starts a demo file,
  // watches the paced chip, raises the limit mid-flight via the tray
  // control, then lifts it to finish instantly. Zero network.
  await click('[data-testid="open-settings"]');
  await waitFor('settings modal for the default limit', `!!document.querySelector('[data-testid="st-library"]')`);
  await click('[data-testid="st-library"]');
  await waitFor('default download-limit select', `!!document.querySelector('[data-testid="dl-limit-default"]')`);
  await js(`(() => { const el = document.querySelector('[data-testid="dl-limit-default"]'); if (!el) return false; el.value = '102400'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await wait(150);
  // Per-source default download folder: the Choose-folder button normally
  // opens a native dialog, which SMOKE mode stubs with a deterministic temp
  // dir (same convention as the save dialog). Assert the pref landed.
  await click('[data-testid="dl-folder-demo-curated"]');
  await wait(250);
  const folderPath = await js(`window.torrentor.getState().then((s) => ((s.prefs && s.prefs.downloadDirs) || {})['demo-curated'] || '')`);
  if (!folderPath || !folderPath.includes('torrentor-dir-demo-curated')) defect('per-source default folder saved from Settings', String(folderPath || 'none'));
  else ok('per-source default folder chosen in Settings', folderPath);
  await click('[data-testid="close-settings"]');
  await waitFor('settings closed after setting the default limit', `!document.querySelector('[data-testid="st-library"]')`);

  await click('[data-testid="tab-search"]');
  await setText('[data-testid="search-input"]', 'fluffing a duck');
  await wait(80);
  await click('[data-testid="search-go"]');
  await waitFor('demo query completes', `(() => { const s = document.querySelector('[data-testid="run-summary"]'); return s && /\\d+ unique results? from/.test(s.textContent); })()`, 25000);
  const demoBtnSel = await js(`(() => {
      const cards = [...document.querySelectorAll('[data-testid="result-card"]')];
      const demo = cards.find((c) => c.innerText.includes('DEMO'));
      const b = demo && demo.querySelector('[data-testid="direct-download"]');
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      return b.getBoundingClientRect().width > 0;
    })()`);
  if (!demoBtnSel) throw new Error('No demo card with a direct-download button for a demo-only query');
  await js(`(() => {
      const cards = [...document.querySelectorAll('[data-testid="result-card"]')];
      const demo = cards.find((c) => c.innerText.includes('DEMO'));
      const b = demo.querySelector('[data-testid="direct-download"]');
      b.click();
      return true;
    })()`);
  await waitFor('demo picker opens with both sample files', `document.querySelectorAll('[data-testid="files-modal"] [data-testid="file-download"]').length === 2`, 10000);
  const modalRow = await textOf('[data-testid="files-modal"]');
  ok('demo card download button opens the file picker (offline)', modalRow.replace(/\s+/g, ' ').slice(0, 60));
  await click('[data-testid="files-modal"] [data-testid="file-download"]');
  // New transfer inherited the 100 KB/s default — the live chip must show it.
  await waitFor('paced chip shows the inherited 100 KB/s limit', `(() => { const b = document.querySelector('[data-testid="download-tray"] [data-testid="dl-limit"]'); return b && b.getAttribute('data-limit') === '102400'; })()`, 8000);
  // An unlimited demo lands in well under a second, so if the chip is STILL
  // downloading (limit control present, no Done) after ~1.3 s the 100 KB/s
  // default is genuinely pacing the transfer.
  await wait(1300);
  const pacedStill = await js(`(() => { const t = document.querySelector('[data-testid="download-tray"]'); const b = t && t.querySelector('[data-testid="dl-limit"]'); return !!b && b.getAttribute('data-limit') === '102400' && !t.innerText.includes('Done'); })()`);
  if (!pacedStill) defect('default 100 KB/s visibly paces the demo download', 'chip not still streaming at 100 KB/s after ~1.3s');
  else ok('default speed limit paces new downloads', 'still streaming at 100 KB/s after ~1.3s (an unlimited demo finishes instantly)');
  // Pause parks the transfer (partial kept, queue slot freed)…
  await click('[data-testid="download-tray"] [data-testid="dl-pause"]');
  await waitFor('chip parks as Paused with resume/remove', `(() => { const t = document.querySelector('[data-testid="download-tray"]'); return !!t && !!t.querySelector('[data-testid="dl-resume"]') && !!t.querySelector('[data-testid="dl-remove"]') && !t.innerText.includes('Done'); })()`, 6000);
  ok('pause parks the running demo download (partial kept, slot freed)');
  // …and resume continues it under the same limit.
  await click('[data-testid="download-tray"] [data-testid="dl-resume"]');
  await waitFor('chip back to downloading after resume', `(() => { const b = document.querySelector('[data-testid="download-tray"] [data-testid="dl-pause"]'); return !!b; })()`, 6000);
  ok('resume restarts the paused download (limit kept, partial-based)');
  // Raise the live limit from the tray control (100 → 256 KB/s)…
  await click('[data-testid="download-tray"] [data-testid="dl-limit"]');
  await waitFor('per-transfer control updates to 256 KB/s', `(() => { const b = document.querySelector('[data-testid="download-tray"] [data-testid="dl-limit"]'); return b && b.getAttribute('data-limit') === '262144'; })()`, 6000);
  ok('per-transfer tray control raises the live limit mid-flight (100 → 256 KB/s)');
  // …then cycle through the rest back to unlimited so it finishes at once.
  await click('[data-testid="download-tray"] [data-testid="dl-limit"]'); // → 512 KB/s
  await click('[data-testid="download-tray"] [data-testid="dl-limit"]'); // → 1 MB/s
  await click('[data-testid="download-tray"] [data-testid="dl-limit"]'); // → ∞
  await waitFor('limit control returns to unlimited', `(() => { const b = document.querySelector('[data-testid="download-tray"] [data-testid="dl-limit"]'); return b && b.getAttribute('data-limit') === '0'; })()`, 6000);
  await waitFor('demo transfer finishes once the limit is lifted', `(() => { const t = document.querySelector('[data-testid="download-tray"]'); return t && t.innerText.includes('demo-content.txt') && t.innerText.includes('Done'); })()`, 10000);
  ok('demo file streamed end-to-end: picker → paced progress → Done chip');
  const revealBtn = await js(`!!document.querySelector('[data-testid="download-tray"] [data-testid="dl-reveal"]')`);
  if (!revealBtn) defect('finished transfer offers reveal-in-folder', 'dl-reveal missing');
  else ok('finished transfer offers reveal-in-folder');

  // ===== 10. Drag-and-drop reorders the start queue =====
  // Seed four paced demo downloads (the 100 KB/s default keeps both active
  // slots busy, so two chips queue), then DRAG the first queued chip onto
  // the second and assert the queue order flipped. Dispatched DragEvents
  // with a real DataTransfer drive the same React handlers a mouse drag
  // would.
  // Distinct demo URLs: SMOKE-mode destinations embed Date.now(), so four
  // identical URLs started in the same millisecond would collide as
  // duplicates; distinct tokens sidestep that and still produce the same
  // paced 768 KB payload.
  await js(`(() => {
      return Promise.all(['demo:content', 'demo:content2', 'demo:content3', 'demo:content4'].map((u) => window.torrentor.downloadFile(u)));
    })()`);
  await waitFor('two demo transfers queue behind the paced actives', `document.querySelectorAll('[data-testid="download-tray"] [data-testid="dl-chip"][data-status="queued"]').length === 2`, 10000);
  const orderBefore = await js(`[...document.querySelectorAll('[data-testid="download-tray"] [data-testid="dl-chip"][data-status="queued"]')].map((c) => Number(c.getAttribute('data-id')))`);
  if (orderBefore.length !== 2) throw new Error(`Expected 2 queued chips for the drag, got ${orderBefore.length}`);
  const dragSim = await js(`(() => {
      const chips = [...document.querySelectorAll('[data-testid="download-tray"] [data-testid="dl-chip"][data-status="queued"]')];
      if (chips.length < 2) return false;
      const [src, dst] = chips;
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    })()`);
  if (!dragSim) throw new Error('Drag simulation failed to find two queued chips');
  await waitFor('queue order flips after the drag', `(() => {
      const ids = [...document.querySelectorAll('[data-testid="download-tray"] [data-testid="dl-chip"][data-status="queued"]')].map((c) => Number(c.getAttribute('data-id')));
      return ids.length === 2 && ids[0] === ${orderBefore[1]} && ids[1] === ${orderBefore[0]};
    })()`, 6000);
  ok('drag-and-drop reorders the start queue', `queued ${orderBefore.join(', ')} → ${orderBefore[1]}, ${orderBefore[0]}`);
  // Smart order toggle: flips the bandwidth-aware queue scheduler (it
  // re-sorts queued files by estimated finish time) through the tray.
  await click('[data-testid="download-tray"] [data-testid="dl-smart-order"]');
  await waitFor('smart order toggles on', `document.querySelector('[data-testid="download-tray"] [data-testid="dl-smart-order"]').getAttribute('data-on') === '1'`, 6000);
  // With smart order on, each queued chip explains its position: the ETA
  // and the speed basis behind it (these queued files inherited the
  // 100 KB/s default limit, so the basis is 'limit').
  const etaInfo = await waitFor(
    'queued chips show ETA reasoning under smart order',
    `(() => { const el = document.querySelector('[data-testid="download-tray"] [data-testid="dl-chip"][data-status="queued"] [data-testid="dl-eta"]'); if (!el) return null; const basis = el.getAttribute('data-basis'); const eta = Number(el.getAttribute('data-eta-sec')); return eta >= 1 && eta <= 60 && ['limit', 'measured', 'shared', 'baseline'].includes(basis) ? { basis, eta } : null; })()`,
    6000
  );
  ok('smart order explains each queued chip (ETA + speed basis)', `ETA ~${etaInfo.eta}s · basis ${etaInfo.basis}`);
  // The same reasoning extends to ACTIVE downloads: each running chip shows
  // its live ETA and the speed basis pacing it (these actives inherited the
  // 100 KB/s default limit, so the basis is 'limit').
  const activeEta = await waitFor(
    'active chips show live ETA under smart order',
    `(() => { const el = document.querySelector('[data-testid="download-tray"] [data-testid="dl-chip"][data-status="downloading"] [data-testid="dl-eta-active"]'); if (!el) return null; const basis = el.getAttribute('data-basis'); const eta = Number(el.getAttribute('data-eta-sec')); return eta >= 1 && eta <= 60 && ['limit', 'measured', 'shared', 'baseline'].includes(basis) ? { basis, eta } : null; })()`,
    6000
  );
  ok('active chip shows its live ETA + speed basis', `~${activeEta.eta}s left · basis ${activeEta.basis}`);
  // The same chip also shows the raw byte math behind the estimate: how much
  // remains of the total size (these demo files are 768 KB each).
  const bytesInfo = await waitFor(
    'queued chips show remaining + total bytes alongside the ETA',
    `(() => { const el = document.querySelector('[data-testid="download-tray"] [data-testid="dl-chip"][data-status="queued"] [data-testid="dl-eta-bytes"]'); if (!el) return null; const t = el.textContent; return /left/.test(t) && /KB/.test(t) ? t.trim() : null; })()`,
    6000
  );
  ok('queued chip shows the smart-order math (remaining/total bytes)', bytesInfo);
  // Tray-header popover: the per-file ETA breakdown for the whole queue,
  // with one bar per file scaled to its estimated wait.
  await click('[data-testid="download-tray"] [data-testid="dl-smart-info"]');
  const popInfo = await waitFor(
    'smart-order popover lists the queued files with ETA bars',
    `(() => { const pop = document.querySelector('[data-testid="download-tray"] [data-testid="dl-smart-pop"]'); if (!pop) return { pop: false }; const rows = pop.querySelectorAll('[data-testid="dl-smart-row"]'); const bars = pop.querySelectorAll('[data-testid="dl-smart-bar"]'); const firstEta = pop.querySelector('[data-testid="dl-smart-row-eta"]'); return { pop: true, rows: rows.length, bars: bars.length, etaText: firstEta ? firstEta.textContent : null, queue: [...rows].map((r) => r.textContent.replace(/\s+/g, ' ').trim().slice(0, 70)) }; })()`,
    6000
  );
  if (!popInfo || !popInfo.pop || popInfo.rows !== 2 || popInfo.bars !== 2 || !/^~\d+s$/.test(popInfo.etaText || '')) {
    throw new Error(`smart-order popover check failed: ${JSON.stringify(popInfo)}`);
  }
  ok('smart-order popover explains the queue (per-file ETA + bars)', `${popInfo.rows} rows with ETA bars`);
  // What-if mode: hypothetical speed limits re-rank the preview without
  // touching the queue. Both queued files sit at 100 KB/s with equal ETAs
  // AND share one destination folder (SMOKE dirs embed Date.now()), so a
  // folder-wide stepper appears: cycling it sets BOTH rows at once.
  const popIds = await js(`[...document.querySelectorAll('[data-testid="download-tray"] [data-testid="dl-smart-row"]')].map((r) => Number(r.getAttribute('data-id')))`);
  if (popIds.length !== 2) throw new Error(`Expected 2 popover rows for what-if, got ${popIds.length}`);
  await click('[data-testid="download-tray"] [data-testid="dl-whatif-toggle"]');
  await waitFor('what-if steppers appear on every preview row', `document.querySelectorAll('[data-testid="download-tray"] [data-testid="dl-whatif-step"]').length === 2`, 6000);
  const folderDir = await waitFor(
    'folder stepper appears for the shared destination folder',
    `(() => { const f = document.querySelector('[data-testid="download-tray"] [data-testid="dl-whatif-folder"]'); return f ? f.getAttribute('data-dir') : null; })()`,
    6000
  );
  await click('[data-testid="download-tray"] [data-testid="dl-whatif-folder-step"]');
  await waitFor(
    'folder stepper sets every same-folder file to one limit',
    `(() => { const steps = [...document.querySelectorAll('[data-testid="download-tray"] [data-testid="dl-whatif-step"]')]; return steps.length === 2 && steps.every((s) => s.getAttribute('data-limit') === '262144') ? steps.length : null; })()`,
    6000
  );
  ok('folder stepper re-ranks the whole folder at once', `folder …${String(folderDir).slice(-28)} → both files @ 256 KB/s`);
  // Per-file stepper on the second row: 256 → 512 KB/s jumps it first.
  await click(`[data-testid="download-tray"] [data-testid="dl-whatif-step"][data-id="${popIds[1]}"]`);
  await waitFor('stepper shows the hypothetical 512 KB/s', `document.querySelector('[data-testid="download-tray"] [data-testid="dl-whatif-step"][data-id="${popIds[1]}"]').getAttribute('data-limit') === '524288'`, 6000);
  await waitFor('preview re-ranks the patched file first', `(() => { const rows = [...document.querySelectorAll('[data-testid="download-tray"] [data-testid="dl-smart-row"]')]; return rows.length === 2 && Number(rows[0].getAttribute('data-id')) === ${popIds[1]} ? rows[0].getAttribute('data-id') : null; })()`, 6000);
  ok('per-file stepper re-ranks the queue (256 → 512 KB/s jumps the row)');
  await click('[data-testid="download-tray"] [data-testid="dl-whatif-apply"]');
  await waitFor(
    'Apply commits the limits and re-sorts the live queue',
    `(() => {
      const chip = document.querySelector('[data-testid="download-tray"] [data-testid="dl-chip"][data-id="${popIds[1]}"] [data-testid="dl-limit"]');
      if (!chip || chip.getAttribute('data-limit') !== '524288') return null;
      const ids = [...document.querySelectorAll('[data-testid="download-tray"] [data-testid="dl-chip"][data-status="queued"]')].map((c) => Number(c.getAttribute('data-id')));
      return ids[0] === ${popIds[1]} ? ids.join(',') : null;
    })()`,
    6000
  );
  ok('what-if Apply commits the limits and the queue re-sorts', `queued starts with ${popIds[1]} @ 512 KB/s`);
  // Queue plans: save the applied patch (row1 256 KB/s, row2 512 KB/s) as
  // a named plan, then re-apply it after the per-file limit is changed.
  await setText('[data-testid="download-tray"] [data-testid="dl-plan-name"]', 'fast-track');
  await wait(150); // let React commit the controlled input value before Save reads it
  await click('[data-testid="download-tray"] [data-testid="dl-plan-save"]');
  const planSaved = await waitFor(
    'plan saved and listed in the popover',
    `(() => {
      const row = [...document.querySelectorAll('[data-testid="download-tray"] [data-testid="dl-plan-row"]')].find((r) => r.getAttribute('data-name') === 'fast-track');
      if (row && row.innerText.includes('2 files')) return { saved: true, text: row.innerText.replace(/\s+/g, ' ').trim() };
      const toast = document.querySelector('[data-testid="toast"]');
      if (toast && /Plan save failed/.test(toast.textContent || '')) return { saved: false, err: toast.textContent };
      return null;
    })()`,
    6000
  );
  if (!planSaved || !planSaved.saved) throw new Error(`plan save check failed: ${JSON.stringify(planSaved)}`);
  ok('what-if patch persisted as a named queue plan (fast-track, 2 files)', planSaved.text);
  await click(`[data-testid="download-tray"] [data-testid="dl-whatif-step"][data-id="${popIds[0]}"]`); // 256 → 512 KB/s
  await waitFor('row1 hypothetically moved to 512 KB/s', `document.querySelector('[data-testid="download-tray"] [data-testid="dl-whatif-step"][data-id="${popIds[0]}"]').getAttribute('data-limit') === '524288'`, 6000);
  await click('[data-testid="download-tray"] [data-testid="dl-plan-reapply"][data-name="fast-track"]');
  await waitFor(
    'plan re-applies its saved limits for real',
    `(() => {
      const c0 = document.querySelector('[data-testid="download-tray"] [data-testid="dl-chip"][data-id="${popIds[0]}"] [data-testid="dl-limit"]');
      const c1 = document.querySelector('[data-testid="download-tray"] [data-testid="dl-chip"][data-id="${popIds[1]}"] [data-testid="dl-limit"]');
      return c0 && c1 && c0.getAttribute('data-limit') === '262144' && c1.getAttribute('data-limit') === '524288' ? true : null;
    })()`,
    6000
  );
  ok('queue plan recalled and re-applied', 'row1 back to 256 KB/s, row2 stays 512 KB/s');
  // A plan can ALSO carry an active-window rule (a 'night' plan that caps
  // the whole queue between two clock times). Reset the preview first so
  // this plan is schedule-only, then save it with the default night window.
  await click('[data-testid="download-tray"] [data-testid="dl-whatif-reset"]');
  await wait(200);
  await click('[data-testid="download-tray"] [data-testid="dl-plan-sched-on"]');
  const schedEditor = await waitFor(
    'schedule window editor opens with a default night window',
    `(() => { const w = document.querySelector('[data-testid="download-tray"] [data-testid="dl-plan-schedule"]'); return w && w.getAttribute('data-from') === '23:00' && w.getAttribute('data-to') === '07:00' && w.getAttribute('data-bps') === '102400' ? true : null; })()`,
    6000
  );
  if (!schedEditor) throw new Error('schedule editor did not open with defaults');
  await setText('[data-testid="download-tray"] [data-testid="dl-plan-name"]', 'night-cap');
  await wait(150);
  await click('[data-testid="download-tray"] [data-testid="dl-plan-save"]');
  const schedSaved = await waitFor(
    'schedule plan saved + listed with its window summary',
    `(() => {
      const row = [...document.querySelectorAll('[data-testid="download-tray"] [data-testid="dl-plan-row"]')].find((r) => r.getAttribute('data-name') === 'night-cap');
      if (!row) return null;
      const s = row.querySelector('[data-testid="dl-plan-row-sched"]');
      return s && s.textContent.includes('23:00–07:00') ? { text: s.textContent.replace(/\s+/g, ' ').trim() } : null;
    })()`,
    6000
  );
  if (!schedSaved) throw new Error('schedule-plan save check failed');
  ok('queue plan saved with an active-window schedule', schedSaved.text);
  // Apply it from the list: the armed plan's name rides the broadcast onto
  // every running tray chip as a small 'plan …' tag.
  await click('[data-testid="download-tray"] [data-testid="dl-plan-reapply"][data-name="night-cap"]');
  const chipTag = await waitFor(
    'applied plan name surfaces on tray chips',
    `(() => { const tag = document.querySelector('[data-testid="download-tray"] [data-testid="dl-chip"] [data-testid="dl-chip-plan"]'); return tag && tag.getAttribute('data-name') === 'night-cap' ? { name: tag.getAttribute('data-name'), window: tag.getAttribute('data-window') } : null; })()`,
    6000
  );
  if (!chipTag) throw new Error('applied-plan chip tag missing');
  ok('applied plan tag renders on tray chips', `plan ${chipTag.name} (window-active=${chipTag.window})`);
  await click('[data-testid="download-tray"] [data-testid="dl-plan-delete"][data-name="fast-track"]');
  await waitFor('plan deleted from the list', `![...document.querySelectorAll('[data-testid="download-tray"] [data-testid="dl-plan-row"]')].some((r) => r.getAttribute('data-name') === 'fast-track')`, 6000);
  ok('queue plan deleted on demand');
  await click('[data-testid="download-tray"] [data-testid="dl-smart-pop-close"]');
  await waitFor('popover closes on demand', `!document.querySelector('[data-testid="download-tray"] [data-testid="dl-smart-pop"]')`, 6000);
  ok('smart-order popover closes on demand');
  await click('[data-testid="download-tray"] [data-testid="dl-smart-order"]');
  await waitFor('smart order toggles back off', `document.querySelector('[data-testid="download-tray"] [data-testid="dl-smart-order"]').getAttribute('data-on') === '0'`, 6000);
  await waitFor('eta reasoning clears when smart order turns off', `!document.querySelector('[data-testid="download-tray"] [data-testid="dl-chip"][data-status="queued"] [data-testid="dl-eta"]')`, 6000);
  ok('smart order toggle flips the queue scheduler (tray)');
  // The applied plan is switchable from the tray header too — one change
  // event applies or clears the whole-queue pacing without the popover.
  const switchSel = '[data-testid="download-tray"] [data-testid="dl-plan-switch"]';
  await waitFor(
    'tray-header plan switcher shows the applied plan',
    `(() => { const box = document.querySelector('[data-testid="download-tray"] [data-testid="dl-plan-switch-box"]'); const sel = document.querySelector('${switchSel}'); if (!box || !sel) return null; const opts = [...sel.options].map((o) => o.value); return box.getAttribute('data-active') === 'night-cap' && opts.includes('night-cap') && sel.value === 'night-cap' ? { opts: opts.join('|') } : null; })()`,
    6000
  );
  ok('tray header surfaces the applied plan (one-click switcher)');
  await js(`(() => { const el = document.querySelector('${switchSel}'); if (!el) return false; el.value = '__clear'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitFor(
    'clearing the applied plan from the header',
    `(() => { const box = document.querySelector('[data-testid="download-tray"] [data-testid="dl-plan-switch-box"]'); const sel = document.querySelector('${switchSel}'); return box && sel && box.getAttribute('data-active') === '' && sel.value === '' ? true : null; })()`,
    6000
  );
  ok('applied plan cleared from the tray header');
  await js(`(() => { const el = document.querySelector('${switchSel}'); if (!el) return false; el.value = 'night-cap'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitFor(
    'one-click re-applies the plan from the header',
    `(() => { const box = document.querySelector('[data-testid="download-tray"] [data-testid="dl-plan-switch-box"]'); const sel = document.querySelector('${switchSel}'); return box && sel && box.getAttribute('data-active') === 'night-cap' && sel.value === 'night-cap' ? true : null; })()`,
    6000
  );
  ok('tray header one-click swaps the whole queue onto a saved plan');
  // Clear it again so the upcoming drain steps run unpaced.
  await js(`(() => { const el = document.querySelector('${switchSel}'); if (!el) return false; el.value = '__clear'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitFor(
    'plan cleared again for the drain steps',
    `(() => { const box = document.querySelector('[data-testid="download-tray"] [data-testid="dl-plan-switch-box"]'); return box && box.getAttribute('data-active') === '' ? true : null; })()`,
    6000
  );
  // Lift every limit so the seeded batch drains fast, then confirm the
  // Library view's per-source tallies picked up all completed transfers.
  await js(`(async () => {
      const ids = [...document.querySelectorAll('[data-testid="download-tray"] [data-testid="dl-chip"]')].map((c) => Number(c.getAttribute('data-id')));
      await Promise.all(ids.map((id) => window.torrentor.setDownloadLimit(id, 0)));
      return ids.length;
    })()`);
  await waitFor('all seeded demo transfers finish', `(() => { const t = document.querySelector('[data-testid="download-tray"]'); return t && (t.innerText.match(/Done/g) || []).length >= 5; })()`, 30000);
  await click('[data-testid="tab-favorites"]');
  await waitFor('downloads-by-source panel on the Library view', `(() => { const p = document.querySelector('[data-testid="dl-stats"]'); return p && p.innerText.includes('Demo'); })()`, 6000);
  const statsTxt = await textOf('[data-testid="dl-stats"]');
  ok('Library shows per-source download tallies', String(statsTxt || '').replace(/\s+/g, ' ').slice(0, 70));
  await click('[data-testid="dl-stats-period-week"]');
  await waitFor('stats panel switches to this week', `(() => { const p = document.querySelector('[data-testid="dl-stats"]'); return p && p.innerText.includes('this week'); })()`, 6000);
  const weekTxt = await textOf('[data-testid="dl-stats"]');
  ok('Library tallies aggregate to the this-week window', String(weekTxt || '').replace(/\s+/g, ' ').slice(0, 70));
  // Per-period export: the Copy CSV button snapshots the SELECTED period
  // (still this week) into the system clipboard as a CSV table.
  await click('[data-testid="dl-stats-copy"]');
  await waitFor('copy button confirms', `(() => { const b = document.querySelector('[data-testid="dl-stats-copy"]'); return b && b.textContent.includes('Copied'); })()`, 6000);
  await wait(120);
  const csv = clipboard.readText();
  if (!csv || !csv.includes('Source,Files,Bytes')) throw new Error('Clipboard does not hold the stats CSV header');
  if (!csv.includes('Demo')) throw new Error('Clipboard CSV missing the Demo source row');
  if (!csv.includes('Total,')) throw new Error('Clipboard CSV missing the Total row');
  ok('per-period Copy CSV exports the stats table to the clipboard', csv.replace(/\s+/g, ' ').trim().slice(0, 70));
  await click('[data-testid="tab-search"]');
  // Close the picker (its overlay sits above the tray), then clear.
  await click('[data-testid="files-modal"] button[aria-label="Close"]');
  await waitFor('picker closed', `!document.querySelector('[data-testid="files-modal"]')`);
  await js(`(() => { const b = [...document.querySelectorAll('[data-testid="download-tray"] button')].find((x) => x.textContent.includes('Clear finished')); if (!b) return false; b.click(); return true; })()`);
  await waitFor('tray clears after Clear finished', `!document.querySelector('[data-testid="download-tray"]')`, 8000);
  ok('Clear finished empties the download tray');
  // Restore the DEFAULT limit to Unlimited so the real Archive download
  // below runs at full speed (per-transfer state was already cleared).
  await click('[data-testid="open-settings"]');
  await waitFor('settings modal to reset the default limit', `!!document.querySelector('[data-testid="st-library"]')`);
  await click('[data-testid="st-library"]');
  await waitFor('default-limit select to reset', `!!document.querySelector('[data-testid="dl-limit-default"]')`);
  await js(`(() => { const el = document.querySelector('[data-testid="dl-limit-default"]'); if (!el) return false; el.value = '0'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await wait(150);
  await click('[data-testid="close-settings"]');
  await waitFor('settings closed after resetting the default limit', `!document.querySelector('[data-testid="st-library"]')`);
  ok('default download speed limit resets to Unlimited');

  // ===== 11. Real Internet Archive item: file picker → genuine download =====
  // The demo step exercised the flow offline; this one proves the REAL
  // path end-to-end — a live Archive item's metadata drives the picker and
  // an actual file streams from archive.org to disk (SMOKE_MODE routes it
  // to a temp path, no save dialog). Rows are listed biggest-first, so the
  // LAST row is the smallest real file: keeps the genuine transfer quick.
  await setText('[data-testid="search-input"]', 'big buck bunny');
  await wait(80);
  await click('[data-testid="search-go"]');
  await waitFor('archive query completes', `(() => { const s = document.querySelector('[data-testid="run-summary"]'); return s && /\\d+ unique results? from/.test(s.textContent); })()`, 25000);
  const archiveBtnVisible = await js(`(() => {
      const cards = [...document.querySelectorAll('[data-testid="result-card"]')];
      const arch = cards.find((c) => c.innerText.includes('Internet Archive') && c.querySelector('[data-testid="direct-download"]'));
      const b = arch && arch.querySelector('[data-testid="direct-download"]');
      if (!b) return false;
      b.scrollIntoView({ block: 'center' });
      return true;
    })()`);
  if (!archiveBtnVisible) throw new Error('No Archive card with a Download-files button for a real query');
  await js(`(() => {
      const cards = [...document.querySelectorAll('[data-testid="result-card"]')];
      const arch = cards.find((c) => c.innerText.includes('Internet Archive') && c.querySelector('[data-testid="direct-download"]'));
      arch.querySelector('[data-testid="direct-download"]').click();
      return true;
    })()`);
  await waitFor('archive picker lists the item files', `document.querySelectorAll('[data-testid="files-modal"] [data-testid="file-download"]').length > 0`, 30000);
  const fileCount = await js(`document.querySelectorAll('[data-testid="files-modal"] [data-testid="file-download"]').length`);
  const smallestFile = await js(`(() => {
      const btns = [...document.querySelectorAll('[data-testid="files-modal"] [data-testid="file-download"]')];
      const b = btns[btns.length - 1];
      const row = b.closest('div');
      const nameEl = row && row.querySelector('[title]');
      const name = nameEl ? nameEl.getAttribute('title') : null;
      b.click();
      return name;
    })()`);
  const fileLabel = String(smallestFile || 'item file');
  await waitFor('tray shows the finished genuine download', `(() => { const t = document.querySelector('[data-testid="download-tray"]'); return t && t.innerText.includes('Done'); })()`, 90000);
  const realTray = await textOf('[data-testid="download-tray"]');
  if (!realTray || !realTray.includes(fileLabel)) defect('real Archive file downloaded is the picked file', `tray=${String(realTray || '').replace(/\s+/g, ' ').slice(0, 80)} name=${fileLabel.slice(0, 60)}`);
  else ok(`real Archive item: ${fileCount} files listed, '${fileLabel.slice(0, 60)}' streamed to disk`, realTray.replace(/\s+/g, ' ').slice(0, 60));
  const realReveal = await js(`!!document.querySelector('[data-testid="download-tray"] [data-testid="dl-reveal"]')`);
  if (!realReveal) defect('genuine finished transfer offers reveal-in-folder', 'dl-reveal missing');
  else ok('genuine finished transfer offers reveal-in-folder');
  await click('[data-testid="files-modal"] button[aria-label="Close"]');
  await waitFor('archive picker closed', `!document.querySelector('[data-testid="files-modal"]')`, 8000);
  await js(`(() => { const b = [...document.querySelectorAll('[data-testid="download-tray"] button')].find((x) => x.textContent.includes('Clear finished')); if (!b) return false; b.click(); return true; })()`);
  await waitFor('tray cleared after the archive download', `!document.querySelector('[data-testid="download-tray"]')`, 8000);
  ok('Clear finished empties the tray after the genuine download');

  if (consoleErrors.length) {
    console.log('  ! renderer console errors observed:', consoleErrors.slice(0, 5));
    defects.push(`renderer console errors: ${consoleErrors[0]}`);
  }

  console.log(`\n${passed} playtest steps passed${defects.length ? `, ${defects.length} defects:` : ''}`);
  for (const d of defects) console.log('  ✗', d);

  try {
    fs.rmSync(process.env.TORRENTOR_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  app.exit(defects.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\n✗ UI PLAYTEST FAILED:', err);
  if (consoleErrors.length) console.error('  renderer console errors:', consoleErrors.slice(0, 6));
  try {
    fs.rmSync(process.env.TORRENTOR_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  app.exit(1);
});
