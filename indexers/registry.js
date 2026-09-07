'use strict';
// ---------------------------------------------------------------------
// Torrentor — engine registry (the allowlist).
//
// An engine only exists here if it ships with the app AND its source has
// been reviewed (terms of service, rate limits, content policy). To add
// a provider: write an adapter in indexers/ with the documented shape
// (see base.js), require it below, and register it in ENGINES. The UI,
// settings, orchestrator and smoke tests all derive from this one list.
//
// Extending the registry is a code change, not a runtime escape hatch —
// the app never loads engines from the network or from user-supplied
// script files.
// ---------------------------------------------------------------------

const { engine: demoEngine, search: searchDemo } = require('./demo-curated');
const { engine: archiveEngine, search: searchArchive, searchPage: searchArchivePage } = require('./archive-org');
const { engine: distroEngine, search: searchDistro } = require('./distro-releases');
const { engine: archEngine, search: searchArch } = require('./arch-releases');
const { engine: piratebayEngine, search: searchPiratebay } = require('./piratebay');
const { engine: nyaaEngine, search: searchNyaa } = require('./nyaa');
const { engine: ytsEngine, search: searchYts } = require('./yts');
const { engine: x1337Engine, search: searchX1337 } = require('./1337x');
const { engine: eztvEngine, search: searchEztv } = require('./eztv');
const { engine: torrentDownloadsEngine, search: searchTorrentDownloads } = require('./torrentdownloads');
const { engine: limeEngine, search: searchLime } = require('./limetorrents');
const { engine: fitgirlEngine, search: searchFitgirl } = require('./fitgirl');

const ENGINES = [
  { ...demoEngine, search: searchDemo },
  // Archive additionally exposes searchPage() so the main process can
  // fetch later pages for the "load more" flow.
  { ...archiveEngine, search: searchArchive, searchPage: searchArchivePage },
  { ...distroEngine, search: searchDistro },
  { ...archEngine, search: searchArch },
  // Community index (apibay mirror). Opt-in: ships disabled by default
  // so fresh installs keep legal-friendly defaults — see the adapter's
  // header notes; the operator owns this content-policy decision.
  { ...piratebayEngine, search: searchPiratebay },
  // Additional community indexes are explicitly opt-in and disabled by
  // default; users enable them in Settings after reviewing the source.
  { ...nyaaEngine, search: searchNyaa },
  { ...ytsEngine, search: searchYts },
  { ...x1337Engine, search: searchX1337 },
  { ...eztvEngine, search: searchEztv },
  { ...torrentDownloadsEngine, search: searchTorrentDownloads },
  { ...limeEngine, search: searchLime },
  { ...fitgirlEngine, search: searchFitgirl },
];

const byId = new Map(ENGINES.map((e) => [e.id, e]));

/** Registry metadata for the UI (never includes the search fn). */
function meta() {
  return ENGINES.map((e) => ({
    id: e.id,
    name: e.name,
    tagline: e.tagline,
    homepage: e.homepage || null,
    kind: e.kind,
    demo: !!e.demo,
    defaultEnabled: e.defaultEnabled !== false,
    // Sources whose results expose direct HTTPS files (Internet Archive
    // items, official distro ISOs, offline demo fixtures). Drives the
    // per-source default-folder rows in Settings.
    directFiles: !!e.directFiles,
  }));
}

function get(id) {
  return byId.get(id) || null;
}

function list() {
  return ENGINES.map((e) => e.id);
}

module.exports = { ENGINES, meta, get, list };
