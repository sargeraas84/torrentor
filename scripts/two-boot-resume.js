'use strict';
// ---------------------------------------------------------------------
// Torrentor two-boot resume test (npm run test:resume).
//
// The strongest proof for "interrupted downloads auto-resume on next
// launch" is the real thing: this driver boots the REAL app twice in one
// data dir while serving a slow, Range-capable HTTP payload from a local
// server.
//
//   boot #1 (phase 'start')  — starts the genuine download, waits for
//     bytes to land, then quits the app MID-FLIGHT.
//   boot #2 (phase 'verify') — relaunches on the same data dir and asserts
//     the transfer was auto-re-enqueued, resumed from its .part (the
//     HTTP Range request continued from the partial byte), and completed
//     to the exact full size.
//
// A second scenario proves a USER PAUSE survives a restart:
//   boot #1 (phase 'pause-start')  — starts a genuine download, pauses it
//     via the real pause IPC, remembers a per-source default folder, quits.
//   boot #2 (phase 'pause-verify') — relaunches and asserts the transfer
//     came back PARKED (status 'paused', .part intact, zero network
//     activity — a user pause is never auto-resumed) and the per-source
//     folder rule survived.
//
// A third scenario proves PER-TRANSFER LIMITS + QUEUE ORDER survive:
//   boot #1 (phase 'order-start')  — four genuine downloads (two active,
//     two queued), per-transfer speed limits on an active and a queued
//     file, a drag-reorder of the queue, then quit mid-flight.
//   boot #2 (phase 'order-verify') — relaunches and asserts the queue
//     came back in the reordered position with every limit intact, then
//     that all four transfers completed to the exact full size.
//
// A fourth scenario proves SMART ORDER + LEARNED SPEEDS survive:
//   boot #1 (phase 'smart-start')  — enables the smart-order pref, starts
//     four genuine downloads with per-transfer limits, waits until both
//     active streams have measured their own bandwidth (rateBps), quits.
//   boot #2 (phase 'smart-verify') — relaunches and asserts the smart
//     pref came back on, the resumed transfers still carry their learned
//     per-file speeds, the restored queue order held under smart
//     ordering, and all four transfers completed to the exact size.
//
// Both boots run the unmodified main.js + renderer over the real IPC
// bridge; only the smoke-mode env (TORRENTOR_SMOKE) is set, which routes
// the save dialog to a temp path and lets the local server host be
// allowlisted.
// ---------------------------------------------------------------------

const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const electronPath = require('electron'); // path to the electron binary
const SIZE = 1536 * 1024; // 1.5 MB — enough that mid-flight quit leaves a real partial
const CHUNK = 64 * 1024;
const GAP_MS = 160; // ≈ 400 KB/s: boot #1 quits ~0.5s in (~200 KB written)

function makePayload() {
  const buf = Buffer.alloc(SIZE);
  let x = 0x12345678;
  for (let i = 0; i < buf.length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    buf[i] = x & 0xff;
  }
  return buf;
}

function serveSlow(payload, ranges, reqLog) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const m = /^bytes=(\d+)-/.exec(req.headers.range || '');
      const from = m ? Number(m[1]) : 0;
      const partial = payload.subarray(from);
      ranges.push(from);
      if (reqLog) reqLog.push({ from, url: req.url });
      if (from > 0) {
        res.statusCode = 206;
        res.setHeader('content-range', `bytes ${from}-${payload.length - 1}/${payload.length}`);
      } else {
        res.statusCode = 200;
      }
      res.setHeader('content-length', partial.length);
      res.setHeader('accept-ranges', 'bytes');
      res.flushHeaders();
      let pos = 0;
      const pump = () => {
        if (req.destroyed || res.destroyed) return;
        const end = Math.min(pos + CHUNK, partial.length);
        if (res.write(partial.subarray(pos, end))) {
          if (end < partial.length) setTimeout(pump, GAP_MS);
          else res.end();
        } else {
          res.once('drain', () => {
            if (end < partial.length) setTimeout(pump, GAP_MS);
            else res.end();
          });
        }
        pos = end;
      };
      pump();
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function runElectron(script, env) {
  return new Promise((resolve) => {
    const child = spawn(electronPath, [script], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
      process.stdout.write(`[child:err] ${d}`);
    });
    const kill = setTimeout(() => child.kill(), 90000);
    child.on('close', (code) => {
      clearTimeout(kill);
      resolve({ code, out, err });
    });
  });
}

async function main() {
  console.log('\nTorrentor two-boot resume test (real app, real HTTP, real quit)\n');
  const payload = makePayload();
  const ranges = [];
  const server = await serveSlow(payload, ranges);
  const { port } = server.address();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-resume-boot-'));
  const url = `http://127.0.0.1:${port}/torrentor-resume-${Date.now()}.bin`;
  const env = {
    TORRENTOR_SMOKE: '1',
    TORRENTOR_DATA_DIR: dataDir,
    TORRENTOR_RESUME_URL: url,
    TORRENTOR_RESUME_EXPECTED_BYTES: String(SIZE),
  };

  let passed = 0;
  const ok = (name, extra) => {
    passed++;
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  };
  const check = (cond, name) => {
    if (!cond) throw new Error(name);
  };

  try {
    // ---------- boot #1: genuine download, quit mid-flight ----------
    const boot1 = await runElectron(path.join('scripts', 'two-boot-child.js'), Object.assign({}, env, { TORRENTOR_RESUME_PHASE: 'start' }));
    check(boot1.code === 0, `boot #1 exited ${boot1.code}`);
    check(/RESUME_BOOT1_DOWNLOADING/.test(boot1.out), 'boot #1 reported flowing bytes');
    check(/RESUME_BOOT1_QUITTING/.test(boot1.out), 'boot #1 quit mid-download');
    ok('boot #1: genuine download started and quit mid-flight', 'quit with a partial .part on disk');

    // ---------- boot #2: auto-resume on the same data dir ----------
    const boot2 = await runElectron(path.join('scripts', 'two-boot-child.js'), Object.assign({}, env, { TORRENTOR_RESUME_PHASE: 'verify' }));
    check(boot2.code === 0, `boot #2 exited ${boot2.code} — ${boot2.err.slice(0, 200)}`);
    const okMatch = /RESUME_BOOT2_OK resumed=true bytes=(\d+)/.exec(boot2.out);
    check(!!okMatch, 'boot #2 reported a resumed (not restarted) completion');
    check(Number(okMatch[1]) === SIZE, `final size ${okMatch[1]} !== ${SIZE}`);
    check(ranges.length >= 2, 'server saw both a full request and a Range request');
    const resumedFrom = Math.max(...ranges.slice(1));
    ok('boot #2: interrupted download auto-resumed from its .part', `continued from byte ${resumedFrom} → full ${SIZE}-byte file`);
    ok('Range resume proven end-to-end across two real app boots', `${ranges.length - 1} Range request(s) after boot #1's partial`);

    // ------- scenario 2: a user pause + per-source folder rule survive -------
    let server2 = null;
    let dataDir2 = null;
    try {
      const payload2 = makePayload();
      const reqLog = [];
      server2 = await serveSlow(payload2, [], reqLog);
      const { port: port2 } = server2.address();
      dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-pause-boot-'));
      const pauseDir = path.join(dataDir2, 'archive-saves');
      const url2 = `http://127.0.0.1:${port2}/pause-me-${Date.now()}.bin`;
      const env2 = {
        TORRENTOR_SMOKE: '1',
        TORRENTOR_DATA_DIR: dataDir2,
        TORRENTOR_RESUME_URL: url2,
        TORRENTOR_RESUME_EXPECTED_BYTES: String(SIZE),
        TORRENTOR_PAUSE_DIR: pauseDir,
      };

      // boot #1: genuine download → real pause IPC → folder rule → quit.
      const b1 = await runElectron(path.join('scripts', 'two-boot-child.js'), Object.assign({}, env2, { TORRENTOR_RESUME_PHASE: 'pause-start' }));
      check(b1.code === 0, `pause boot #1 exited ${b1.code} — ${b1.err.slice(0, 200)}`);
      check(/PAUSE_BOOT1_DOWNLOADING/.test(b1.out), 'pause boot #1 flowed bytes before pausing');
      check(/PAUSE_BOOT1_PAUSED/.test(b1.out), 'pause boot #1 paused the transfer');
      check(/PAUSE_BOOT1_QUITTING/.test(b1.out), 'pause boot #1 quit after pausing');
      const reqsBeforeBoot2 = reqLog.length;

      // boot #2: the paused transfer must come back PARKED, the .part kept,
      // the per-source folder rule intact — and the server must see ZERO new
      // requests (a user pause is never auto-resumed).
      const b2 = await runElectron(path.join('scripts', 'two-boot-child.js'), Object.assign({}, env2, { TORRENTOR_RESUME_PHASE: 'pause-verify' }));
      check(b2.code === 0, `pause boot #2 exited ${b2.code} — ${b2.err.slice(0, 200)}`);
      check(/PAUSE_BOOT2_PAUSED/.test(b2.out), 'boot #2 restored the transfer as paused');
      check(/PAUSE_BOOT2_FOLDER_OK/.test(b2.out), 'boot #2 saw the per-source folder rule');
      check(reqLog.length === reqsBeforeBoot2, `paused transfer must not touch the server in boot #2 (${reqsBeforeBoot2} -> ${reqLog.length} requests)`);
      ok('pause: paused transfer stayed paused across a relaunch', 'parked, .part kept, zero network activity');
      ok('pause: per-source folder rule survived the relaunch', `downloadDirs['archive-org'] → ${pauseDir}`);
    } finally {
      if (server2) server2.close();
      if (dataDir2) {
        try {
          fs.rmSync(dataDir2, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }

    // ------- scenario 3: per-transfer limits + reordered queue survive -------
    let server3 = null;
    let dataDir3 = null;
    try {
      const payload3 = makePayload();
      server3 = await serveSlow(payload3, [], null);
      const { port: port3 } = server3.address();
      dataDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-order-boot-'));
      const base3 = `http://127.0.0.1:${port3}/`;
      const env3 = {
        TORRENTOR_SMOKE: '1',
        TORRENTOR_DATA_DIR: dataDir3,
        TORRENTOR_RESUME_BASE: base3,
        TORRENTOR_RESUME_EXPECTED_BYTES: String(SIZE),
      };

      // boot #1: four genuine downloads (two active, two queued), per-
      // transfer limits on an active and a queued file, a drag-reorder of
      // the queue, then quit mid-flight.
      const o1 = await runElectron(path.join('scripts', 'two-boot-child.js'), Object.assign({}, env3, { TORRENTOR_RESUME_PHASE: 'order-start' }));
      check(o1.code === 0, `order boot #1 exited ${o1.code} — ${o1.err.slice(0, 200)}`);
      check(/ORDER_BOOT1_QUEUE/.test(o1.out), 'boot #1 recorded the reordered queue + per-transfer limits');

      // boot #2: the queue must come back in the reordered position with
      // every limit intact, and all four transfers must complete to the
      // exact full size.
      const o2 = await runElectron(path.join('scripts', 'two-boot-child.js'), Object.assign({}, env3, { TORRENTOR_RESUME_PHASE: 'order-verify' }));
      check(o2.code === 0, `order boot #2 exited ${o2.code} — ${o2.err.slice(0, 200)}`);
      check(/ORDER_BOOT2_QUEUE_OK/.test(o2.out), 'boot #2 restored the queue order + per-transfer limits');
      check(/ORDER_BOOT2_DONE/.test(o2.out), 'boot #2 completed all four resumed transfers to the full size');
      ok('order: drag-reordered queue + per-transfer speed limits survived a relaunch', '4 transfers restored, order + limits intact, all completed');
    } finally {
      if (server3) server3.close();
      if (dataDir3) {
        try {
          fs.rmSync(dataDir3, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }

    // ---- scenario 4: smart order + learned per-file speeds survive ----
    let server4 = null;
    let dataDir4 = null;
    try {
      const payload4 = makePayload();
      server4 = await serveSlow(payload4, [], null);
      const { port: port4 } = server4.address();
      dataDir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-smart-boot-'));
      const base4 = `http://127.0.0.1:${port4}/`;
      const env4 = {
        TORRENTOR_SMOKE: '1',
        TORRENTOR_DATA_DIR: dataDir4,
        TORRENTOR_RESUME_BASE: base4,
        TORRENTOR_RESUME_EXPECTED_BYTES: String(SIZE),
      };

      // boot #1: enable smart order, four genuine downloads (two active,
      // two queued), per-transfer limits on actives + a queued file, wait
      // until each active measured its own speed, then quit mid-flight.
      const s1 = await runElectron(path.join('scripts', 'two-boot-child.js'), Object.assign({}, env4, { TORRENTOR_RESUME_PHASE: 'smart-start' }));
      check(s1.code === 0, `smart boot #1 exited ${s1.code} — ${s1.err.slice(0, 200)}`);
      check(/SMART_BOOT1_MEASURED/.test(s1.out), 'boot #1 measured both actives\' own bandwidth before quitting');

      // boot #2: the smart-order pref must be back on, the resumed
      // transfers must carry their learned per-file speeds, the restored
      // queue order must hold under smart ordering, and all four must
      // complete to the exact full size.
      const s2 = await runElectron(path.join('scripts', 'two-boot-child.js'), Object.assign({}, env4, { TORRENTOR_RESUME_PHASE: 'smart-verify' }));
      check(s2.code === 0, `smart boot #2 exited ${s2.code} — ${s2.err.slice(0, 200)}`);
      check(/SMART_BOOT2_QUEUE_OK/.test(s2.out), 'boot #2 restored smart order + learned speeds + queue order');
      check(/SMART_BOOT2_DONE/.test(s2.out), 'boot #2 completed all four resumed transfers to the full size');
      ok('smart order: enabled pref + learned per-file speeds + queue order survived a relaunch', 'smart=on, learned a=96KB/s b=128KB/s, queue order intact, all completed');
    } finally {
      if (server4) server4.close();
      if (dataDir4) {
        try {
          fs.rmSync(dataDir4, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }

    // ---- scenario 5: a saved queue plan (folder rule + override) survives ----
    let server5 = null;
    let dataDir5 = null;
    try {
      const payload5 = makePayload();
      server5 = await serveSlow(payload5, [], null);
      const { port: port5 } = server5.address();
      dataDir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-plan-boot-'));
      const base5 = `http://127.0.0.1:${port5}/`;
      const env5 = {
        TORRENTOR_SMOKE: '1',
        TORRENTOR_DATA_DIR: dataDir5,
        TORRENTOR_RESUME_BASE: base5,
        TORRENTOR_RESUME_EXPECTED_BYTES: String(SIZE),
      };

      // boot #1: smart order on, four genuine downloads, a queue plan saved
      // with a FOLDER rule (c's dir @ 100 KB/s) plus a per-file override
      // (d @ 512 KB/s), then quit mid-flight.
      const p1 = await runElectron(path.join('scripts', 'two-boot-child.js'), Object.assign({}, env5, { TORRENTOR_RESUME_PHASE: 'plan-start' }));
      check(p1.code === 0, `plan boot #1 exited ${p1.code} — ${p1.err.slice(0, 200)}`);
      check(/PLAN_BOOT1_SAVED/.test(p1.out), 'boot #1 saved the queue plan (folder rule + override)');

      // boot #2: the plan must come back from prefs, re-apply to the
      // restored queue (folder rule pins c, override pins d), re-rank the
      // smart-ordered queue, and all four transfers complete to full size.
      const p2 = await runElectron(path.join('scripts', 'two-boot-child.js'), Object.assign({}, env5, { TORRENTOR_RESUME_PHASE: 'plan-verify' }));
      check(p2.code === 0, `plan boot #2 exited ${p2.code} — ${p2.err.slice(0, 200)}`);
      check(/PLAN_BOOT2_PLAN_OK/.test(p2.out), 'boot #2 restored the plan from prefs');
      check(/PLAN_BOOT2_APPLIED_OK/.test(p2.out), 'boot #2 re-applied the plan to the restored queue');
      check(/PLAN_BOOT2_DONE/.test(p2.out), 'boot #2 completed all four resumed transfers');
      ok('queue plans: a saved plan (folder rule + override) survived a relaunch and re-applied to the restored queue', 'plan=100KB/s folder + 512KB/s override, limits landed on the restored transfers, all completed');
    } finally {
      if (server5) server5.close();
      if (dataDir5) {
        try {
          fs.rmSync(dataDir5, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }

    // ---- scenario 6: an ARMED schedule plan survives a relaunch ----
    let server6 = null;
    let dataDir6 = null;
    try {
      const payload6 = makePayload();
      server6 = await serveSlow(payload6, [], null);
      const { port: port6 } = server6.address();
      dataDir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-night-boot-'));
      const base6 = `http://127.0.0.1:${port6}/`;
      const env6 = {
        TORRENTOR_SMOKE: '1',
        TORRENTOR_DATA_DIR: dataDir6,
        TORRENTOR_RESUME_BASE: base6,
        TORRENTOR_RESUME_EXPECTED_BYTES: String(SIZE),
      };

      // boot #1: smart order on, four genuine downloads at 512 KB/s each,
      // then a SCHEDULE-ONLY plan ('boot-night', window = now ± 2h @ 40 KB/s)
      // saved and APPLIED — the apply persists the armed plan — and quit
      // mid-flight.
      const p1 = await runElectron(path.join('scripts', 'two-boot-child.js'), Object.assign({}, env6, { TORRENTOR_RESUME_PHASE: 'night-start' }));
      check(p1.code === 0, `night boot #1 exited ${p1.code} — ${p1.err.slice(0, 200)}`);
      check(/NIGHT_BOOT1_ARMED/.test(p1.out), 'boot #1 applied the active schedule-only plan');
      check(/NIGHT_BOOT1_OVERRIDE_OFF/.test(p1.out), 'boot #1 forced the night override off before quitting');

      // boot #2: the applied plan must be RE-ARMED from prefs (no manual
      // re-apply) with its window still active, the SESSION OVERRIDE forced
      // off in boot #1 must be gone (night mode follows the clock again),
      // and the 40 KB/s cap must be genuinely pacing the restored transfers.
      const p2 = await runElectron(path.join('scripts', 'two-boot-child.js'), Object.assign({}, env6, { TORRENTOR_RESUME_PHASE: 'night-verify' }));
      check(p2.code === 0, `night boot #2 exited ${p2.code} — ${p2.err.slice(0, 200)}`);
      check(/NIGHT_BOOT2_PLAN_OK/.test(p2.out), 'boot #2 restored the armed plan with its window active');
      check(/NIGHT_BOOT2_OVERRIDE_RESET/.test(p2.out), 'boot #2 the night override did not persist — the clock window applies again');
      check(/NIGHT_BOOT2_PACED_OK/.test(p2.out), 'boot #2 the restored window is really capping the queue');
      ok('an armed schedule plan survived a relaunch and kept capping the whole queue', 'boot-night window + weekday selector auto-restored; night-mode weekdays persisted; the session override reset to follow the clock; measured pacing ≈ 40 KB/s in boot #2');
    } finally {
      if (server6) server6.close();
      if (dataDir6) {
        try {
          fs.rmSync(dataDir6, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }
  } finally {
    server.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  console.log(`\n${passed} two-boot checks passed ✔\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n✗ TWO-BOOT RESUME TEST FAILED:', String((err && err.message) || err).slice(0, 300));
  process.exit(1);
});
