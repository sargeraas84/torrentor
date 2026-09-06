# Torrentor

[![Release](https://img.shields.io/github/v/release/sargeraas84/torrentor?label=download&color=22d3ee)](https://github.com/sargeraas84/torrentor/releases/latest)
[![Website](https://img.shields.io/badge/website-sargeraas84.github.io%2Ftorrentor-2dd4bf)](https://sargeraas84.github.io/torrentor/)

> 🌐 **Website:** <https://sargeraas84.github.io/torrentor/> — landing page and full docs.  
> ⬇️ **Download:** Windows installer + portable `.exe`, and macOS `.dmg` (Intel & Apple Silicon), on the [latest release](https://github.com/sargeraas84/torrentor/releases/latest).

A privacy-first **torrent meta-search engine for Windows**, built with Electron.

One query. Many torrent sources at once. One window.

Torrentor fans your query out to every enabled source **in parallel**, then merges
everything into a single list — **deduped by infohash** — with source badges, live
per-source progress, seeders/size/date filtering and one-click magnet handling.
Every outbound request runs in the main process and honors your **VPN/proxy route**.

> Torrentor is *search-first software*. Torrent/magnet results hand off to your own
> torrent client; for sources that expose plain files over HTTPS — Internet Archive
> items and official Linux ISOs — cards can also **download the file directly** into
> a folder you pick (streamed in main through the same proxy-aware client).
> Please only download and share content you are legally entitled to.

---

## Features

| Area | What you get |
| --- | --- |
| ⚡ Parallel search | One query runs against every enabled source at once; results **stream in as each source answers**, not after the slowest finishes |
| 🔀 Smart merge | Results are deduped by infohash (duplicates from different sources collapse into one card with an *"also on …"* badge); a watchdog guarantees no engine can hang a search |
| 🗂 Rich cards | Category, size, seeders/leechers/downloads, age, infohash preview, source badges, **Demo** labeling on synthetic entries; Archive items carry **creator — year** and a poster |
| 🧲 Magnet actions | Copy magnet · Open in torrent client (OS hand-off) · Copy `.torrent` URL · Download `.torrent` · Open source page — all scheme-validated in main |
| ⬇️ Direct download | Archive items open an **in-app file picker** and stream the chosen file to disk; Ubuntu/Arch official ISOs download straight from the mirror. Hosts are allowlisted, every redirect hop re-validated, progress lives in a downloads tray — no torrent client needed for file-based sources. Downloads are **resumable**: at most two stream at once (the rest queue FIFO, **reorderable with drag-and-drop or arrows**, or **smart-ordered** — a tray toggle starts the fastest-finishing file first, using known sizes, your speed limits, and each file's **own measured speed**, which the queue learns as streams progress and re-ranks on the fly; equal-ETA files batch by destination folder, and every queued chip shows the ETA and the speed basis — limit / measured / live network — behind it), an interrupted file continues from its partial via HTTP Range, a **user pause survives a restart** (it parks, never auto-resumes), the save dialog **remembers your folder** (per-source defaults too), and finished transfers offer **reveal in folder**. Tray chips say which folder rule landed each file, and the Library views show **per-source download tallies with all-time / this-week / this-month windows** and a **Copy CSV** button that exports the selected period to the clipboard. **Queue plans** bottle the whole pacing setup: a what-if preview re-ranks hypothetical per-file and **per-folder** limits before you apply them, the applied patch saves as a **named plan** (folder rules keep covering files queued into that folder later), a plan can carry an **active-window schedule** that caps the entire queue at set hours (a "night" plan throttling to 100 KB/s between 23:00 and 07:00), and the applied plan's name rides every tray chip with **one-click switching from the tray header** — an armed plan even **survives a relaunch**. Standalone **night mode** in Settings applies the same clock-window cap to every download with no plan at all, its active state shows in the tray header, and both kinds of window can be restricted to **specific weekdays** (a Mon–Fri "night" plan) — with one-click **presets** (Weekdays / Weekends / Every day) next to the manual day toggles. The tray's night pill is a **one-click session override** — click it to force the cap on or off for this session without opening Settings (the clock window returns next launch; the override never survives a restart) — and whenever a plan window or night cap is what's actually binding a transfer, hovering the chip shows the full **effective-speed breakdown**: own limit vs plan window vs night cap, and which one wins. If the applied plan's window and night mode are **both active at once with different caps**, the tray warns about the overlap, names which tighter cap actually wins, and **clicking the warning jumps straight into the what-if popover** to reconcile them. A schedule-only plan's row has an **"apply this schedule now"** button that starts (or stops) its window on demand — a per-plan session force like the night pill, so a 23:00–07:00 plan is testable at noon — and the tray popover notes **where the applied plan came from**: "applied 11:52" for a live apply versus "restored at boot · last applied …" when a relaunch re-armed it. Demo cards exercise the whole flow **offline** with clearly-labeled sample files |
| 🛡 VPN / proxy route | Route **every** search request through your own VPN/proxy (HTTP, SOCKS4/5, auth supported) with a one-click **Check my IP** verification (settings → VPN & privacy) |
| 🩺 Source health | Settings → Search sources probes every real source with a known-good query and shows healthy / failing per engine — silent regressions (site redesigns that return 0 results) appear as red dots, not green chips |
| 🔖 Local library | Favorites + recent searches stored as plain JSON in the app-data folder. No account, no cloud, no telemetry |
| 🔍 Filtering | Category chips (Video/Audio/Apps/Games/Docs/Other) + **Archive mediatype chips** (Movies/Audio/Texts/Software/…, from Archive's own classification) that AND together; sort by seeders / size / newest / relevance |
| 🎬 Open-culture browse | Idle-screen **Explore tiles** (public-domain films, old-time radio, LibriVox, silent cinema, 78rpm, NASA) that fire the same honest search — broad catalog phrases fall back to a title-scoped Archive query so literal matches are never buried |
| 🔒 Secure shell | Sandboxed renderer (CSP, `contextIsolation`, no `nodeIntegration`), whitelisted IPC bridge, allowlist-only engine registry |

## Shipped sources (the allowlist)

Engines are reviewed before they ship; the app never loads search plugins from the
network. Default sources are **legal-friendly**, so a fresh install is useful and safe:

1. **Demo index** *(offline, always works)* — a clearly-labeled sample corpus so the
   whole flow works with zero network. Every card carries a **Demo** badge and its
   infohash is synthetic — treat it as a UI fixture, not a download.
2. **Internet Archive** — real full-text search of Archive.org's catalog
   (public-domain & CC media, books, software, data; tens of millions of items) via its
   public `advancedsearch` API. Every item card offers a **file picker + direct
   download** (no torrent client needed); the official `_archive.torrent` is also one
   click away.
3. **Linux releases** — official Ubuntu & Debian ISO `.torrent` files pulled straight
   from the projects' release pages.
4. **Arch Linux** — official Arch Linux monthly ISO torrents (infohash, magnet and
   `.torrent` URL per release) from Arch's public release feed (`releng/releases/json`).
5. **The Pirate Bay** *(opt-in, off by default)* — the classic community index via
   the apibay JSON mirror: rich cards (infohash, seeders, size, age). This is **not**
   a legal-friendly source, so it ships **disabled** — enable it in Settings → Search
   sources if you want it. Adult categories are always filtered client-side.

### Adding more providers

The registry (`indexers/registry.js`) is the **allowlist**. Any provider you want —
community indexes, trackers, a self-hosted indexer — is a small adapter:

```js
// indexers/my-source.js  (see indexers/base.js for the full contract)
const { normalizeResult } = require('./base');
const ENGINE = { id: 'my-source', name: 'My Source', tagline: '…', kind: 'community' };

async function search(query, ctx) {
  const data = await ctx.network.getJson('https://my-index.example/api?q=' + encodeURIComponent(query), {
    timeoutMs: ctx.timeoutMs, signal: ctx.signal,           // ctx.network = the proxy-aware client
  });
  return data.items.map((it) =>
    normalizeResult({ itemId: it.id, title: it.name, infohash: it.infoHash,
                      sizeBytes: it.size, seeders: it.seeders, pageUrl: it.url }, ENGINE)
  );
}
module.exports = { engine: ENGINE, search };
```

…then register it in `indexers/registry.js`. **Review the source's terms, rate limits
and content policy before adding it** — you (the operator) own that decision.

## VPN / proxy option (how it works)

Torrentor deliberately **does not bundle or sell a VPN**. Instead it makes any VPN you
already run enforceable for search traffic:

1. Run any VPN client or local proxy — WireGuard/OpenVPN/Tailscale apps, Tor
   (`socks5://127.0.0.1:9050`), or `ssh -D 1080` all work.
2. Open **Settings → VPN & privacy**, pick the proxy type (SOCKS5 recommended), enter
   host/port (and credentials if needed), hit **Save & check IP**.
3. Torrentor routes **every outbound engine request** through that route — the demo
   engine is the only source that works without a network at all. The IP check shows
   the exit address the world sees, so you can confirm the VPN is actually on.

Notes, honestly stated:

- The proxy route governs Torrentor's own traffic — engine queries **and direct file
  downloads** (Internet Archive files / official ISOs stream through the same route).
  Torrent/magnet hand-offs still download in your torrent client, whose own network
  settings govern them.
- The app can't detect your VPN by itself — the exit-IP check is the source of truth.

## Quick start

Requires **Node.js 20+**.

```bash
npm install        # installs deps (Electron included)
npm run dev        # build + launch the app
npm test           # 91 pure-Node checks (no window, no network)
npm run test:electron   # boots the real app headlessly and drives it over IPC
npm run test:resume # boots the real app TWICE over a slow Range server: starts
                    #   a genuine download, quits mid-flight, relaunches, and
                    #   asserts the .part auto-resumed to the full file — plus a
                    #   paused transfer that parks across a restart, a
                    #   drag-reordered queue with per-transfer limits that
                    #   survive a relaunch, smart-order learned speeds that
                    #   survive, a saved queue plan (folder rule + override)
                    #   re-applied to the restored queue, and an ARMED
                    #   schedule-only plan (weekday selector included) whose
                    #   window keeps capping the whole queue in boot #2
                    #   (measured pacing) — and the night-pill session
                    #   override resets to follow the clock again in boot #2
npm run test:ui    # 76-step real-window playtest (real engines): search,
                    #   favorites, VPN check, paging, thumbnails, paced demo
                    #   (paused & resumed, queue reordered by drag-and-drop
                    #   + smart order with per-chip ETA/bytes + a popover
                    #   that previews limits (per-file and per-folder
                    #   steppers), saves named queue plans — including one
                    #   with an active-window schedule (weekday-restricted,
                    #   via the one-click presets) — applies it, forces its
                    #   window on/off with the row's "apply this schedule
                    #   now" button, notes the applied plan's provenance,
                    #   and switches/clears it from the tray header), Settings
                    #   night mode (weekday presets), a one-click night-pill
                    #   session override, chip tooltips that break down own
                    #   limit vs plan window vs night cap, a clickable tray
                    #   warning when the plan window and night mode overlap
                    #   at different caps (opens the what-if popover
                    #   pre-selected), per-source save folder, and a real
                    #   Archive direct download — needs network
npm run dist       # electron-builder → Windows installer + portable .exe in dist-exe/
```

On **macOS**, the same `npm run dist` produces a universal (Intel + Apple
Silicon) `.dmg` and `.zip`. The macOS build is **unsigned** — the first launch
requires right-click → **Open** (Gatekeeper), which is normal for open-source
apps without an Apple Developer account.

**Automated releases:** first make sure the `ci` workflow is green on
`master` — it runs actionlint over every workflow, the pure-Node suite, and
(on Windows runners) the Electron IPC + two-boot auto-resume suites, so a
workflow mistake or a real-app regression can't slip into a release. Then
push a `v*` tag and CI (`.github/workflows/release.yml`) builds both platforms — Windows
installer + portable `.exe` on a Windows runner, macOS universal `.dmg` +
`.zip` on a macOS runner — and opens a **draft release** with everything
attached. Verify the four artifacts, then Publish it from the Releases page
when ready (a `workflow_dispatch` run builds the same artifacts without a tag):

```bash
git tag v1.4.8 && git push origin v1.4.8
```

**Site deploys:** pushing to `master` also republishes `site/` to the `gh-pages`
branch automatically (`.github/workflows/deploy-site.yml`) — no more manual
`git subtree push`.

## Project structure

```
torrentor/
├── main.js                 # Electron main: window, secure IPC, search + library wiring
├── preload.js              # contextBridge → window.torrentor (payload-mapped, envelope-safe)
├── indexers/               # engine adapters + allowlist registry
│   ├── registry.js         #   the allowlist — everything derives from this list
│   ├── base.js             #   adapter contract + result normalization
│   ├── demo-curated.js     #   offline sample corpus (clearly labeled, synthetic infohashes)
│   ├── archive-org.js      #   Internet Archive advancedsearch → _archive.torrent URLs
│   ├── distro-releases.js  #   Ubuntu/Debian official ISO torrents
│   └── arch-releases.js    #   Arch Linux official ISO torrents (releng JSON feed)
├── lib/
│   ├── orchestrator.js     # parallel fan-out, live snapshots, dedupe/merge by infohash, sort
│   ├── health.js           # per-source health self-test (known-good probe queries)
│   ├── network.js          # proxy/VPN-aware HTTP client (main only) + streaming downloader
│   ├── downloads.js        # direct-download manager: transfers, Archive item file picker
│   ├── magnet.js           # magnet build/parse, infohash normalization (hex + base32)
│   ├── format.js           # bytes/time/category/seed helpers (shared with tests)
│   └── storage.js          # JSON persistence: prefs (incl. proxy), history, favorites
├── renderer/               # React UI (bundled by esbuild; Tailwind CSS)
│   ├── App.jsx             # state machine, live result streaming, views
│   └── components/         # TitleBar, EngineChips, ResultCard, LibraryView, SettingsModal, icons
├── resources/              # generated icon.ico + PNGs (scripts/generate-icon.js)
└── scripts/
    ├── generate-icon.js    # zero-dependency magnet-mark icon generator
    ├── smoke-test.js       # npm test — pure-Node checks, no network
    ├── smoke-test-electron.js  # npm run test:electron — boots the real app over IPC
    └── ui-playtest.js      # npm run test:ui — drives the real window with live engines
```

## Architecture notes

- **All networking is main-process.** The renderer has `connect-src 'none'`; every
  request goes through `lib/network`, which applies the user's proxy route to *every*
  engine. Engines can't silently bypass it because they never create sockets
  themselves.
- **One registry, many views.** Engine metadata, the UI chips, settings toggles, the
  orchestrator and the smoke tests all derive from `indexers/registry.js` — adding an
  engine is one file + one line.
- **Dedupe keys.** Results with a 40-hex infohash dedupe globally by `btih:<hash>`.
  Archive.org's API doesn't expose infohashes (its torrents would need a full download
  to hash), so those dedupe by `source:identifier` — see the engine source for the
  honest notes.
- **Cancellation.** Every new query aborts the previous run; aborted runs resolve
  `null` and the UI drops stale responses via a run sequence number.
- **Persistence is plain JSON** (no native modules) — prefs, up to 200 recent
  searches and 500 favorites, written atomically with a debounce.

## Legal & responsible scope

- Torrenting is a technology: the same magnets carry Linux ISOs, Blender open movies,
  public-domain books and (yes) things you shouldn't download. Torrentor searches
  whatever sources its operator allowlists; the shipped defaults are legal-friendly.
- No tracking, no telemetry, no accounts. Query history stays in your app-data folder
  and is deletable from Settings → Library.
- Sources are fetched politely (UA header, short timeouts, small page caps, cached
  listings) and each engine fails *soft* — an unreachable source never blocks the
  others.
- Direct downloads only ever write bytes from allowlisted source hosts (Archive.org +
  the official distro mirrors), re-checked after every redirect — the app never
  downloads from torrent peers itself; that stays in your torrent client.
