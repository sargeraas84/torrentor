# Open Culture M1 — Implementation Plan

> Spec: `docs/superpowers/specs/2026-09-04-open-culture-m1-design.md`
> Repo: torrentor/ (branch master, remote origin; commit per task; user pushes.)

**Goal:** Make the archive-lover flow excellent: Archive cards carry creator/year,
filterable by real Archive mediatype, and the idle screen offers curated visual
entry points into public-domain & CC media — all through the existing legal
engine paths.

**Architecture:** Metadata flows Archive API → engine normalization (`base.js`
whitelist + `archive-org.js`) → orchestrator merge (first-seen-wins) → ResultCard.
Mediatype filtering is pure renderer state in App.jsx (one new filter state).
Explore tiles are served by one new main-side IPC that lazily pulls the first
result's thumbnail per curated query (cached), rendered by the idle component.

**Validation:** `node scripts/smoke-test.js` (44), `npm run test:electron` (8),
`npx electron scripts/ui-playtest.js` (20). Expected: Node → ~47, UI → ~24.

---

### Task 1: Metadata through the pipeline (base whitelist + archive engine + merge)

**Files:** Modify `indexers/base.js`, `indexers/archive-org.js`, `lib/orchestrator.js`;
Test `scripts/smoke-test.js`.

1. `base.js normalizeResult`: pass through four new nullable fields —
   `creator`, `year`, `description` (string, clipped to 220), `mediatype`.
2. `archive-org.js`: map from advancedsearch docs — `creator: doc.creator?.[0] || null`,
   `year: doc.year ?? null`, `description: (doc.description?.[0] || '').slice(0, 220) || null`,
   `mediatype: doc.mediatype || null`.
3. `orchestrator.js mergeInto`: carry each new field first-seen-wins (guard
   `if (!existing.creator && result.creator) …`, same for year/description/mediatype).
4. Tests (Node): a fixture doc normalizes with all four fields; missing fields
   stay null; merge keeps the first card's creator/mediatype when a duplicate
   arrives. Run suite → 47 checks.

### Task 2: ResultCard — creator/year line + mediatype-authoritative glyph

**Files:** Modify `renderer/components/ResultCard.jsx`.

1. When the card's representative source is `archive-org` and `creator` (or
   `year`) exists, render a dim meta line `creator — year` under the title.
2. Category glyph: when `mediatype` is present use it as the authoritative hint
   (movies→video, audio|etree→audio, texts→documents, software→apps,
   image|data→other) instead of the keyword-derived category for the glyph only.
   Rebuild renderer.

### Task 3: Archive mediatype filter chips

**Files:** Modify `renderer/App.jsx`.

1. New state `archiveFilter` ('all' | mediatype); reset on each new search.
2. Derived: `archivesPresent = results.some(r => r.mediatype)`; distinct
   mediatypes in results, labeled Movies/Audio/Texts/Software/Other.
3. When `archivesPresent`, render an Archive chip row (All + one per distinct
   mediatype). Active chip filters the shown list to archive-backed cards with
   that mediatype (non-archive cards hidden while active — honest rule). Chips
   compose with existing category pills (both filters AND together).
4. Rebuild renderer.

### Task 4: Explore tiles (main IPC + idle UI)

**Files:** Modify `main.js`, `preload.js`, `renderer/App.jsx`.

1. `main.js`: const `EXPLORE = ['public domain films','old time radio','librivox
   audiobooks','silent cinema','78rpm records','nasa imagery']` (labeled);
   handler `explore:tiles` returns `[{q,label,thumb}]` by running the archive
   engine's search for each term (results[0]?.thumbnail), cached ~30 min,
   abort-tolerant, never throws (empty tiles on failure).
2. `preload.js`: `exploreTiles: bridge('explore:tiles')`.
3. App idle: when phase idle, load tiles once (lazy) into state; render a
   "Explore open culture" tile row under the suggestions — each tile is a
   button (thumb background or label-only fallback) firing `runSearch(q)`.
4. Rebuild renderer.

### Task 5: Copy pass

**Files:** Modify `renderer/App.jsx` (idle/empty copy), `README.md` (features).

### Task 6: Tests + commits

1. UI playtest additions: idle Explore tiles render (≥1) and clicking one
   starts a real search that completes; a public-domain query shows a
   `creator — year` meta line on at least one Archive card; Archive mediatype
   chip filters the list and All restores it. → ~24 steps.
2. Run all suites green (Node ~47, Electron 8, UI ~24).
3. Commit: `feat: open-culture M1 — archive metadata, mediatype filters, explore tiles`.
