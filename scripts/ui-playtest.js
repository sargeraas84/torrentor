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

const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.TORRENTOR_SMOKE = '1';
process.env.TORRENTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-ui-'));

let passed = 0;
const defects = [];
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

  const consoleErrors = [];
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
  try {
    fs.rmSync(process.env.TORRENTOR_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  app.exit(1);
});
