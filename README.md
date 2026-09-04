# Torrentor

> 🌐 **Website:** <https://sargeraas84.github.io/torrentor/> — landing page and full docs.

A privacy-first **torrent meta-search engine for Windows**, built with Electron.

One query. Many torrent sources at once. One window.

Torrentor fans your query out to every enabled source **in parallel**, then merges
everything into a single list — **deduped by infohash** — with source badges, live
per-source progress, seeders/size/date filtering and one-click magnet handling.
Every outbound request runs in the main process and honors your **VPN/proxy route**.

> Torrentor is *search software*. It stores no files and downloads nothing — it finds
> magnet links and `.torrent` URLs, then hands them to your own torrent client.
> Please only download and share content you are legally entitled to.

---

## Features

| Area | What you get |
| --- | --- |
| ⚡ Parallel search | One query runs against every enabled source at once; results **stream in as each source answers**, not after the slowest finishes |
| 🔀 Smart merge | Results are deduped by infohash (duplicates from different sources collapse into one card with an *"also on …"* badge); a watchdog guarantees no engine can hang a search |
| 🗂 Rich cards | Category, size, seeders/leechers/downloads, age, infohash preview, source badges, **Demo** labeling on synthetic entries; Archive items carry **creator — year** and a poster |
| 🧲 Magnet actions | Copy magnet · Open in torrent client (OS hand-off) · Copy `.torrent` URL · Download `.torrent` · Open source page — all scheme-validated in main |
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
   (public-domain & CC media, books, software, data; tens of millions of items, nearly
   all with official `_archive.torrent` downloads) via its public `advancedsearch` API.
3. **Linux releases** — official Ubuntu & Debian ISO `.torrent` files pulled straight
   from the projects' release pages.
4. **Arch Linux** — official Arch Linux monthly ISO torrents (infohash, magnet and
   `.torrent` URL per release) from Arch's public release feed (`releng/releases/json`).

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

- The proxy applies to Torrentor's own search traffic. Actual file downloads happen in
  your torrent client, whose network settings govern them.
- The app can't detect your VPN by itself — the exit-IP check is the source of truth.

## Quick start

Requires **Node.js 20+**.

```bash
npm install        # installs deps (Electron included)
npm run dev        # build + launch the app
npm test           # 49 pure-Node checks (no window, no network)
npm run test:electron   # boots the real app headlessly and drives it over IPC
npm run test:ui    # drives the real window (real engines): search, favorites,
                    #   VPN check, paging, thumbnails — needs network
npm run dist       # electron-builder → portable .exe in dist-exe/
npm run dist:installer  # NSIS installer
```

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
│   ├── network.js          # proxy/VPN-aware HTTP client (main only) + exit-IP check
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
