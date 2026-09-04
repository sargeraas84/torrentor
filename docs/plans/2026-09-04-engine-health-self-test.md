# Engine Health Self-Test — Implementation Plan

> **For Hermes:** implement this plan task-by-task. (Note: no git repository exists in this workspace — every "Commit" step below is replaced by "leave changes uncommitted"; do not run git commands.)

**Goal:** Give users a per-engine health view in Settings → Search sources that runs each real engine's known-good probe query and marks it healthy only when it returns ≥ 1 result, so silent regressions (site redesigns, parser blindness → ok/0) become visible red dots instead of green chips.

**Architecture:** A main-process-only `lib/health.js` runner executes each probe-bearing engine's `search(engine.probe, ctx)` in parallel through the same proxy-bound `network` the orchestrator uses; verdicts persist via `lib/storage.js` and reach Settings through three IPC additions (`health:get`, `health:run`, `health:progress`). App.jsx owns the health state and progress subscription (matching its existing `onSearchProgress` pattern); SettingsModal renders per-row dots + a "Test all sources" button.

**Tech Stack:** Node 20+, Electron, React 18 (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-09-04-engine-health-self-test-design.md`

**Validation commands used throughout** (all from `torrentor/`):
- Pure Node suite: `node scripts/smoke-test.js` (currently 40 checks)
- Electron IPC suite: `npm run test:electron` (currently 7 checks)
- Real-window suite: `npx electron scripts/ui-playtest.js` (currently 16 steps)

---

### Task 1: Add `probe` terms to the three real engine definitions

**Objective:** Each real engine declares the known-good query its source always answers; the demo engine deliberately has none.

**Files:**
- Modify: `indexers/archive-org.js` (ENGINE object)
- Modify: `indexers/distro-releases.js` (ENGINE object)
- Modify: `indexers/arch-releases.js` (ENGINE object)

**Step 1:** In each file's `const ENGINE = { ... }`, add one field:
- archive-org: `probe: 'big buck bunny',`
- distro-releases: `probe: 'ubuntu 24.04',`
- arch-releases: `probe: 'archlinux',`

(demo-curated: no change.)

**Step 2:** Verify — `grep -n "probe:" indexers/*.js` shows exactly 3 hits (archive-org, distro-releases, arch-releases).

**Step 3:** Confirm registry integrity still passes — `node scripts/smoke-test.js | tail -1` → `40 checks passed ✔`.

---

### Task 2: Extend the registry-integrity test to require probes

**Objective:** A future real engine without a probe fails the suite loudly.

**Files:**
- Modify: `scripts/smoke-test.js` (registry section, ~line 107)

**Step 1 (write failing test):** In the `ok('registry allowlist integrity', ...)` block, after the existing loop over `registry.meta()`, add:

```js
const engines = registry.ENGINES;
for (const e of engines) {
  if (e.demo) continue;
  assert.ok(e.probe && typeof e.probe === 'string' && e.probe.trim().length > 0, `${e.id} declares a probe term`);
}
```

**Step 2:** Run `node scripts/smoke-test.js | grep -A4 "registry allowlist"` — passes once Task 1 is in; if you skipped Task 1 it fails, which is the point.

---

### Task 3: Create `lib/health.js` runner

**Objective:** One pure-Node file owning the health-check semantics, testable with a fake registry and zero network.

**Files:**
- Create: `lib/health.js`

**Step 1 (write failing test first — add to `scripts/smoke-test.js` after the distro section, before the orchestrator section):**

```js
// ---------------------------- engine health ---------------------------
const { runHealthChecks } = require('../lib/health');
function fakeEngine(id, impl) {
  return { id, name: id, tagline: '', kind: 'official', demo: false, probe: 'probe-' + id, search: async () => impl() };
}
ok('health: healthy engine reports ok with count + latency shape', async () => {
  const out = await runHealthChecks({
    registry: { ENGINES: [fakeEngine('a', () => [{ title: 'match', sourceId: 'a', itemId: 'x' }])] },
    network: null, signal: null,
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].engineId, 'a');
  assert.strictEqual(out[0].ok, true);
  assert.strictEqual(out[0].count, 1);
  assert.ok(out[0].latencyMs >= 0 && out[0].at > 0, 'latency + timestamp present');
});
ok('health: zero-result probe is a FAILURE (silent ok/0 tripwire)', async () => {
  const out = await runHealthChecks({
    registry: { ENGINES: [fakeEngine('a', () => [])] },
    network: null, signal: null,
  });
  assert.strictEqual(out[0].ok, false);
  assert.match(out[0].error, /returned 0 results/);
});
ok('health: throwing engine fails with its message; demo (no probe) is excluded; others still run', async () => {
  const out = await runHealthChecks({
    registry: {
      ENGINES: [
        fakeEngine('good', () => [{ title: 'm' }]),
        Object.assign(fakeEngine('bad', () => { throw new Error('boom'); })),
        { id: 'demo', name: 'Demo', kind: 'demo', demo: true, search: async () => [] }, // no probe
      ],
    },
    network: null, signal: null,
  });
  assert.deepStrictEqual(out.map((r) => r.engineId), ['good', 'bad'], 'order follows ENGINES, demo excluded');
  assert.strictEqual(out[1].ok, false);
  assert.match(out[1].error, /boom/);
  assert.strictEqual(out[0].ok, true);
});
```

**Step 2:** Run `node scripts/smoke-test.js | grep -B1 -A2 "engine health"` — the suite fails (`Cannot find module '../lib/health'`). Expected.

**Step 3 (implement):** Create `lib/health.js`:

```js
'use strict';
// ---------------------------------------------------------------------
// Torrentor — engine health self-test (main process only).
//
// Runs each probe-bearing engine's search() with its own known-good probe
// term through the SAME ctx the orchestrator uses (proxy-bound network),
// and marks an engine healthy ONLY when the probe returns >= 1 result.
// A reachable source whose parser silently yields nothing (site redesign,
// layout change) therefore reports FAILING here instead of a green chip.
// Engines without a probe (the offline demo index) are excluded.
// ---------------------------------------------------------------------

const HEALTH_TIMEOUT_MS = 10000;

function healthResult(engine, verdict) {
  return Object.assign({ engineId: engine.id, ok: false, count: 0, latencyMs: 0, error: null, at: Date.now() }, verdict);
}

/**
 * @param {object} opts { registry (ENGINES array), network (proxy-bound),
 *   signal, onProgress(partialResults) }
 * @returns Promise<healthRecord[]> — one record per probe-bearing engine,
 *   in ENGINES order.
 */
async function runHealthChecks(opts) {
  const { registry, network, signal } = opts;
  const onProgress = opts.onProgress || (() => {});
  const engines = (registry.ENGINES || []).filter((e) => e && !e.demo && typeof e.probe === 'string' && e.probe.trim());
  const results = [];
  await Promise.all(
    engines.map(async (engine) => {
      const startedAt = Date.now();
      const record = healthResult(engine, {});
      try {
        const ctx = { query: engine.probe, signal, network, timeoutMs: HEALTH_TIMEOUT_MS };
        const list = await engine.search(engine.probe, ctx);
        const count = Array.isArray(list) ? list.filter((r) => r && r.title).length : 0;
        Object.assign(record, { count, latencyMs: Date.now() - startedAt });
        if (count > 0) {
          record.ok = true;
        } else {
          record.error = `returned 0 results for probe '${engine.probe}'`;
        }
      } catch (err) {
        Object.assign(record, { latencyMs: Date.now() - startedAt, error: String((err && err.message) || err).slice(0, 160) });
      }
      results.push(record);
      onProgress(results.slice());
    })
  );
  return results.sort((a, b) => engines.findIndex((e) => e.id === a.engineId) - engines.findIndex((e) => e.id === b.engineId));
}

module.exports = { runHealthChecks, HEALTH_TIMEOUT_MS };
```

**Step 4:** Run `node scripts/smoke-test.js | tail -1` → `43 checks passed ✔`.

**Note:** do not import the real `network` here — callers pass it in (same as the orchestrator).

---

### Task 4: Persist health results in storage

**Objective:** Cached verdicts survive restarts so dots paint instantly.

**Files:**
- Modify: `lib/storage.js`

**Step 1 (inspect):** Read `lib/storage.js` and mirror exactly how favorites are persisted (field name, `getFavorites`/`setFavorites`, the debounced write). Add `health` as a sibling collection.

**Step 2 (implement):** Add `getHealth()` returning the stored array (default `[]`) and `setHealth(list)` that validates an array then persists, using the same write path as favorites.

**Step 3 (test):** Add a smoke-test block near the favorites round-trip test:

```js
ok('health storage round-trips', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-health-'));
  const s = new Storage(tmp);
  assert.deepStrictEqual(s.getHealth(), []);
  const recs = [{ engineId: 'archive-org', ok: true, count: 4, latencyMs: 900, error: null, at: Date.now() }];
  s.setHealth(recs);
  assert.deepStrictEqual(s.getHealth(), recs);
  fs.rmSync(tmp, { recursive: true, force: true });
});
```

**Step 4:** Run `node scripts/smoke-test.js | tail -1` → `44 checks passed ✔`.

---

### Task 5: IPC — `health:get`, `health:run`, `health:progress`

**Objective:** Main process exposes health over the existing secure bridge.

**Files:**
- Modify: `main.js` (registerIpc + the broadcast helper usage)
- Modify: `preload.js`

**Step 1 (main.js):** Inside `registerIpc()`, after the favorites handlers, add:

```js
handle('health:get', () => storage.getHealth());
handle('health:run', async () => {
  const list = await runHealthChecks({
    registry,
    network,
    onProgress: (partial) => broadcast('health:progress', partial),
  });
  storage.setHealth(list);
  return list;
});
```

Require `runHealthChecks` at the top of main.js alongside the other lib imports. Confirm `registry` is in scope in `registerIpc` (it is — `registry.meta()` is used by `app:getState`).

**Step 2 (preload.js):** Mirror the existing `getFavorites`/`onSearchProgress` patterns:

```js
getHealth: bridge('health:get'),
runHealth: bridge('health:run'),
onHealthProgress: (cb) => subscribe('health:progress', cb),
```

**Step 3 (electron smoke):** In `scripts/smoke-test-electron.js` add a step: `api.getHealth()` returns an array (initially empty); `api.runHealth()` resolves with exactly **3** records (`archive-org`, `distro-releases`, `arch-releases` — demo excluded), each with the full `{ engineId, ok, count, latencyMs, error, at }` shape and `ok === true`; `api.getHealth()` after the run returns the same 3.

**Step 4:** Run `npm run test:electron 2>&1 | tail -1` → `8 checks passed ✔`.

---

### Task 6: App.jsx — health state ownership + subscription

**Objective:** App owns the health list, the run flag, and the progress subscription; SettingsModal stays a props consumer.

**Files:**
- Modify: `renderer/App.jsx`

**Step 1:** Add state `const [health, setHealth] = useState([]);` and `const [healthRunning, setHealthRunning] = useState(false);`.

**Step 2:** In the mount effect (where `onSearchProgress`/`onMaximized` are subscribed), add:

```js
const offHealth = window.torrentor.onHealthProgress((list) => setHealth(list || []));
```

and include `offHealth()` in the cleanup.

**Step 3:** Add callbacks:

```js
const loadHealth = useCallback(async () => {
  try {
    setHealth((await window.torrentor.getHealth()) || []);
  } catch { /* non-fatal */ }
}, []);
const runHealth = useCallback(async () => {
  if (healthRunning) return;
  setHealthRunning(true);
  try {
    setHealth((await window.torrentor.runHealth()) || []);
  } catch (err) {
    showToast((err && err.error) || 'Health check failed');
  } finally {
    setHealthRunning(false);
  }
}, [healthRunning, showToast]);
```

**Step 4:** Pass to SettingsModal: `health={health}` `healthRunning={healthRunning}` `onLoadHealth={loadHealth}` `onRunHealth={runHealth}`.

**Step 5:** Rebuild and sanity check: `npm run build:renderer 2>&1 | tail -1` → `Done in …`.

---

### Task 7: SettingsModal — per-engine health rows + Test-all button

**Objective:** Users see and re-run health checks in Settings → Search sources.

**Files:**
- Modify: `renderer/components/SettingsModal.jsx`

**Step 1:** Add props `health, healthRunning, onLoadHealth, onRunHealth` to the destructure.

**Step 2:** Add an effect — when the active tab is `'engines'`, on first activation paint the cached list then trigger a run in the background:

```js
const healthRequested = useRef(false);
useEffect(() => {
  if (tab === 'engines' && !healthRequested.current) {
    healthRequested.current = true;
    onLoadHealth();
    onRunHealth();
  }
}, [tab, onLoadHealth, onRunHealth]);
```

(import `useRef` from react — check the file's existing react imports).

**Step 3:** In the engines-tab toolbar, add a "Test all sources" button (`data-testid="health-run-all"`) next to the tab header, disabled while `healthRunning`, label `healthRunning ? 'Testing…' : 'Test all sources'`.

**Step 4:** Per engine row (the `engines.map` block), render a status line under the tagline from `health.find((h) => h.engineId === e.id)`:

- no record → gray `not tested yet`
- `healthRunning` → spinner + `testing…` (give the row `data-testid="health-row-<id>"` and the status line `data-testid="health-status-<id>"`)
- `ok` → green `healthy · N results · (latency/1000).toFixed(1)s · relativeTime(at)`
- `!ok` → red `failing — <error>` + last-tested time

Use `fmt.relativeTime` (already imported in the renderer via `lib/format` elsewhere — import it here if not present).

**Step 5:** Demo row: render a static gray note `offline · always available` instead of a status dot.

**Step 6:** Rebuild: `npm run build:renderer 2>&1 | tail -1`.

---

### Task 8: UI playtest — health flows through the real window

**Objective:** The regression is visible in Settings, and re-runs work.

**Files:**
- Modify: `scripts/ui-playtest.js`

**Step 1:** Extend the settings section (before the VPN steps or after — keep the existing step order) with a new step 4b "health self-test":

1. `click('[data-testid="open-settings"]')` (reuse the existing open in the current flow; if inserting elsewhere, open settings and click the sources tab — it is the default).
2. `waitFor('Linux releases health row reports healthy', "(() => { const s = document.querySelector('[data-testid=\"health-status-distro-releases\"]'); return s && /healthy/.test(s.textContent); })()", 20000)` — this is the Ubuntu-regression tripwire.
3. Assert at least one more row healthy: `document.querySelectorAll('[data-testid^=\"health-row-\"] [data-testid^=\"health-status-\"]')` filtered by text `healthy` length ≥ 1, and the demo row's `offline` note exists.
4. `click('[data-testid="health-run-all"]')` → rows flip to `testing…` → after completion at least one row shows `healthy` again.

**Step 2:** Run the full real-window suite: `npx electron scripts/ui-playtest.js 2>&1 | tail -6` → `18 playtest steps passed` (16 + 2 new ok/defect pairs if implemented as two; count accordingly).

---

### Task 9: Live proof + README

**Objective:** Documented, independently verified.

**Files:**
- Modify: `README.md`

**Step 1 (live proof):** Run once against the real network:

```bash
node -e "const {runHealthChecks}=require('./lib/health');const registry=require('./indexers/registry');const network=require('./lib/network');(async()=>{const r=await runHealthChecks({registry,network});console.log(r.map(x=>x.engineId+':'+(x.ok?'ok':'FAIL')+' count='+x.count+' '+(x.latencyMs/1000).toFixed(1)+'s'+(x.error?' '+x.error:'')).join('\n'));})()"
```

Expected: all three of `archive-org`, `distro-releases`, `arch-releases` print `ok` with count ≥ 1 (demo absent).

**Step 2 (README):** Add a line to the Settings/features area: health self-test in Settings → Search sources (each source probed with a known-good term; red = source returned nothing or errored). Update the Features table row count if a "🩺 Source health" row is added (keep it to one row).

**Step 3 (final full sweep):** From `torrentor/`:

```bash
npm test 2>&1 | tail -1      # 44 checks passed
npm run test:electron 2>&1 | tail -1   # 8 checks passed
npx electron scripts/ui-playtest.js 2>&1 | tail -6   # all steps pass (count per Task 8)
```

---

## Review checklist

- [ ] Tasks sequential; each 2–5 minutes of focused work
- [ ] Exact paths everywhere; code complete and copy-pasteable
- [ ] TDD cycle (failing test → implement → pass) on the pure-Node pieces
- [ ] No git commands — this workspace has no repository; leave changes uncommitted
- [ ] DRY: probe terms live once on each engine; health semantics live only in `lib/health.js`; no new abstractions (no `probe()` methods, no auto-disable)
