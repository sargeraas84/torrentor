# Engine Health Self-Test — Design

**Date:** 2026-09-04
**Status:** Approved for implementation planning
**Project:** Torrentor (Windows Electron meta-search)

## Problem

Engine failures come in two flavors. Network failures already surface loudly
(per-engine error chips, "4/4 sources" degrades). But the *silent regression*
class does not: a source stays reachable while a site redesign outruns its
parser, and the engine reports `ok` with 0 results behind a green chip. The
Ubuntu release crawl suffered exactly this (releases.ubuntu.com redesign →
every ubuntu query returned ok/0 for the "Linux releases" engine), and no
user-facing signal existed — only a suite assertion added after the fact.

Users need to see, without running a search, whether each enabled source is
actually returning results right now.

## Decisions (from brainstorming)

1. **Placement:** Settings → Search sources tab. Each engine row gets a health
   status; the check auto-runs when the tab opens, and a **"Test all sources"**
   button re-runs on demand.
2. **Health criterion:** the engine's probe query must return **≥ 1 real
   result**. Reachability alone is not enough — it cannot catch the silent
   ok/0 class. Count and latency are displayed alongside the verdict.
3. **Failure behavior: informational only.** No auto-disable, no search
   behavior change. Engine chips already surface per-run errors; health is a
   diagnostic view.
4. **Freshness:** results persist with a timestamp. The tab paints cached dots
   instantly (`health:get`), then re-probes in the background (`health:run`)
   and flips rows as engines answer (`health:progress`).

## Architecture

### New file: `lib/health.js` (main process; pure Node, testable without Electron)

- Exports `runHealthChecks({ registry, network, signal, onProgress })`.
- Iterates every engine in the registry that declares a `probe` term; engines
  without one (the demo index) are skipped by design.
- Runs each `engine.search(engine.probe, ctx)` **in parallel** with the same
  `ctx` the orchestrator uses: `{ query, signal, network, timeoutMs }` where
  `network` is the proxy-bound `lib/network`. A health check therefore honors
  the user's VPN/proxy route and cannot bypass it.
- Per-engine cap ~10 s; engines settle independently (`Promise.allSettled`) —
  one dead engine never blocks the others.
- Verdict: `ok: true` iff the probe returned ≥ 1 result. Zero results →
  `ok: false` with `error: "returned 0 results for probe '<term>'"`. Engine
  exceptions/timeouts → `ok: false` with the message.
- Result record per engine: `{ engineId, ok, count, latencyMs, error, at }`.
- `onProgress(partial)` fires with the accumulated results as each engine
  lands, so the UI can flip rows live.

### Probe terms (one field per engine definition)

| Engine | `probe` | Notes |
| --- | --- | --- |
| `demo-curated` | *(none)* | Offline by design; excluded from testing; UI shows a static "offline · always available" note |
| `archive-org` | `big buck bunny` | Always-present catalog item |
| `distro-releases` | `ubuntu 24.04` | Targets the current series; would have caught the releases.ubuntu.com redesign |
| `arch-releases` | `archlinux` | Feed is always populated |

`probe` is runtime metadata: never sent to the renderer via registry meta
(meta already whitelists id/name/tagline/kind/demo). A future engine without a
`probe` is skipped like demo, never a crash.

### Persistence (`lib/storage.js`)

A `health` list stored alongside favorites/history in the same plain-JSON
store (atomic, debounced writes). Methods: `getHealth()` / `setHealth(list)`.
No new file format or native modules.

### IPC surface (`main.js` + `preload.js`)

- `health:get` → cached list (instant paint on tab open).
- `health:run` → runs checks via `lib/health`, persists results, resolves the
  final list.
- `health:progress` → broadcast of partial results.

All three are used; the bridge stays 1:1 like the existing surface.

**Event/subscription ownership:** App.jsx subscribes to `health:progress` and
holds the health list in state (mirroring how it already owns the
`onSearchProgress`/`onMaximized` subscriptions and passes engines/favorites to
SettingsModal as props). SettingsModal receives `health` + an `onRunHealth`
callback; it invokes `onRunHealth()` when its tab becomes `'engines'` (the
default tab on open) and the Test-all button calls the same callback. Because
App owns the subscription, a run finishing after Settings closes is harmless —
App simply holds the updated state.

## UI (SettingsModal — Search sources tab)

Per engine row, under the tagline:

- Gray `not tested yet` (no cached result).
- Spinner `testing…` (in flight).
- Green `healthy · N results · 1.2s · just now`.
- Red `failing — <error or "returned 0 results for probe …">` plus last-tested
  time.

**Demo index** row shows a static `offline · always available` note — never
tested, no dot, no test affordance.

**"Test all sources"** button at the top of the tab. On tab open: paint cached
dots → fire `health:run` in the background → flip rows on `health:progress` →
persist. Button does the same on demand.

Enabled/disabled toggles are orthogonal: health tests **all** real engines
regardless of toggle state, so a user can see a source is dead before enabling
it.

## Error handling & edge cases

- **Settings closed mid-run:** runner finishes and persists; the modal drops
  late progress events behind a mounted ref. No abort plumbing.
- **One engine down or flaky:** others still report; the failing row carries
  its message. A misconfigured proxy fails every real engine with connection
  errors — health doubles as a VPN-config check.
- **Storage write failure:** non-fatal; dots still show for the session.
- **Engine without a `probe`:** skipped (demo semantics), not a crash.
- **Zero-result probe is `ok: false`, not "healthy, nothing matched"**: probe
  terms are chosen to always match on a working source, so 0 results means the
  source is broken — this is the check that makes silent regressions loud.

## Testing & validation

1. **Node suite** (pure, no network) — fake registry, same pattern as the
   orchestrator tests:
   - healthy engine → `ok: true` with count/latency/at shape;
   - zero-result engine → `ok: false` with the "returned 0 results" error;
   - throwing engine → `ok: false` with its message;
   - parallel isolation — one failing/hanging engine doesn't block others;
   - demo/no-probe engines excluded;
   - storage `getHealth`/`setHealth` round-trip;
   - registry-integrity check extended: every non-demo engine declares a
     non-empty `probe`.
   Expect the count to rise ~40 → 43.
2. **Electron smoke:** `health:get` empty on first boot → `health:run` over IPC
   returns exactly 3 entries (demo excluded) with the full record shape →
   persisted so `health:get` returns them.
3. **UI playtest (real window):** open Settings → Search sources → cached dots
   paint → background run flips rows; assert **≥ 1 row healthy and the
   Linux-releases row healthy with count > 0** (the Ubuntu-regression
   tripwire, now user-visible in Settings); click **Test all sources** → rows
   go `testing…` then healthy again; demo row shows the offline note.
   Steps ~16 → ~18.
4. **Live proof:** one real-network run of `runHealthChecks` asserting all
   three real engines report `ok` and demo is excluded.

## Out of scope

- Auto-disabling failing engines.
- Health checks for the user's OS torrent client or VPN exit.
- Proactive health pings outside Settings (no background network traffic on
  app start).
