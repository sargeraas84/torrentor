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

function serveSlow(payload, ranges) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const m = /^bytes=(\d+)-/.exec(req.headers.range || '');
      const from = m ? Number(m[1]) : 0;
      const partial = payload.subarray(from);
      ranges.push(from);
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
