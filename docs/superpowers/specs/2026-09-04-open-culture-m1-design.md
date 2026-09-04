# Torrentor 1.1 "Open culture" — M1 Design

**Date:** 2026-09-04
**Status:** Approved for planning
**Project:** Torrentor (Windows Electron meta-search)

## Purpose & decisions (from brainstorming)

The app's real user is the **open-culture & archive lover**: someone searching for
public-domain and Creative Commons media across legal torrent sources, with
Archive.org as the crown-jewel catalog (tens of millions of torrentable items).
Milestone 1 makes the archive-lover flow excellent — browse → search → filter →
card. It deliberately does NOT add new catalogs (Archive depth is the win) — that
is a later milestone.

Sequencing agreed with the user: **M1 app polish → M2 landing/docs website →
M3 GitHub release** (repo initialized now; the user creates the GitHub remote;
no pushes without explicit go-ahead).

## Workstreams

### 1. Rich archive metadata on cards

`indexers/archive-org.js` currently drops API fields the advancedsearch response
already carries. Capture them per item:

- `creator` (string, first creator)
- `year` (string/number)
- `description` (clipped to ~220 chars for display)
- `mediatype` (the authoritative Archive classification: `movies`, `audio`,
  `texts`, `software`, `etree`, `image`, `data`, …)

Normalization additions in the engine follow the existing `normalizeResult`
pattern (nullable-safe). The merge in `lib/orchestrator.js` carries these
first-seen-wins like `title`/`uploadedAt`; merged cards keep the representative
item's fields.

UI (`ResultCard.jsx`): Archive items (any card whose representative source is
`archive-org`) render a `creator — year` meta line under the title when present.
Where `mediatype` is present it is authoritative for the category glyph:
`movies→video`, `audio/etree→audio`, `texts→documents`, `software→apps`,
`image/data→other` (matches the existing hint map; mediatype simply feeds the
same mapping so the keyword guess is bypassed for Archive items).

### 2. Archive mediatype filter chips

When a search's results include Archive-backed cards, the results toolbar gains
an Archive-native chip row next to the existing category pills:

**Movies · Audio · Texts · Software · Data · Mixed**

- Chips filter `results` by the Archive mediatype of archive-backed cards.
- Honest interaction rule (stated here so behavior is unambiguous): mediatype
  chips apply **only to Archive-backed cards**; cards from other engines are
  hidden while an Archive mediatype chip is active (they cannot be classified
  authoritatively). "All" restores everything. The existing keyword category
  pills remain and operate as today on all cards.
- The chips only render when ≥ 1 result carries an Archive mediatype; otherwise
  the row is absent (no UI change for non-archive searches).

### 3. Curated open-culture browse (idle screen)

The idle state keeps the search box but becomes visual beneath it: curated
**Explore tiles** (thumbnail + label) that fire the standard real search — same
engine fan-out path, zero fabricated data. Initial tile set (all real Archive
queries, chosen for evergreen public-domain/CC content):

`Public domain films · Old time radio · LibriVox audiobooks · Silent cinema ·
78rpm records · NASA imagery`

Tile sources: Archive `advancedsearch` `page=1` first item's thumbnail for each
curated query, fetched lazily when the idle screen shows (main process, cached,
abort-safe). On tile click → `runSearch(tileQuery)` like any suggestion. The
existing suggestion chips remain beneath the tiles.

### 4. Copy + empty states tuned to the niche

Small text pass: idle headline/body, empty-state hint, and README Features copy
lean into "public-domain & Creative Commons media" rather than generic torrent
language. No structural change.

## Out of scope (M1)

- New catalogs/sources beyond Archive depth (M-later).
- The landing/docs website (M2).
- The GitHub release flow (M3).

## Testing & validation

1. **Node suite** — engine normalization: a fixture advancedsearch doc with
   `creator`/`year`/`description`/`mediatype` produces the new fields; missing
   fields stay null-safe; `mediatype` maps to the right category. Merge test:
   metadata carries first-seen-wins across duplicate collapse. Mediatype filter
   helper (if extracted pure) unit-tested. Expect the count to rise ~44 → 47.
2. **Electron smoke** — unchanged flows stay green (8).
3. **UI playtest (real window)** — idle tiles render and clicking one starts a
   real search that completes; a public-domain/archive query shows `creator —
   year` on Archive cards; an Archive mediatype chip filters the list (count
   drops to archive-only rows) and "All" restores it. Steps 20 → ~24.
4. **Live proof** — one real query confirming Archive cards carry creator/year
   and mediatype in the merged payload.

## Acceptance

- An open-culture query returns Archive cards that show creator/year where the
  item has them, filterable by real Archive mediatype.
- The idle screen offers genuine entry points into public-domain content, all
  going through the real engine path.
- All suites green (Node, Electron, UI) with the stated count expectations.
