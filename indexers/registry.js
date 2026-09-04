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

const ENGINES = [
  { ...demoEngine, search: searchDemo },
  // Archive additionally exposes searchPage() so the main process can
  // fetch later pages for the "load more" flow.
  { ...archiveEngine, search: searchArchive, searchPage: searchArchivePage },
  { ...distroEngine, search: searchDistro },
  { ...archEngine, search: searchArch },
];

const byId = new Map(ENGINES.map((e) => [e.id, e]));

/** Registry metadata for the UI (never includes the search fn). */
function meta() {
  return ENGINES.map((e) => ({
    id: e.id,
    name: e.name,
    tagline: e.tagline,
    kind: e.kind,
    demo: !!e.demo,
  }));
}

function get(id) {
  return byId.get(id) || null;
}

function list() {
  return ENGINES.map((e) => e.id);
}

module.exports = { ENGINES, meta, get, list };
