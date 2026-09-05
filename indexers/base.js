'use strict';
// ---------------------------------------------------------------------
// Torrentor — shared indexer helpers.
//
// Every engine adapter has the same shape:
//
//   const engine = {
//     id: 'my-source',                // unique, URL-safe
//     name: 'My Source',              // shown in chips + badges
//     tagline: 'one-line description',// shown in Settings
//     kind: 'official'|'community'|'demo', // controls badge styling
//     demo: false,
//     search(query, ctx) -> Promise<normalizedResult[]>
//   };
//
// ctx = { query, signal, network, timeoutMs } where network is
// lib/network (getJson/getText) already bound to the user's proxy route.
// Adapters must NEVER make their own network calls — routing engines
// around lib/network is what keeps the VPN/proxy option trustworthy.
//
// Each result is normalized with normalizeResult():
//   { title, itemId, sourceId, sourceLabel, kind, category, sizeBytes,
//     seeders, leechers, uploadedAt, downloads, infohash, magnet,
//     torrentUrl, pageUrl, thumbnail, demo }
// ---------------------------------------------------------------------

const { categorizeTitle } = require('../lib/format');
const { normalizeInfohash, buildMagnet } = require('../lib/magnet');

/** Fill defaults + validate the minimal contract of a result. */
function normalizeResult(partial, engine) {
  const p = partial || {};
  const title = String(p.title || '').trim();
  const sourceId = engine.id;
  const ih = normalizeInfohash(p.infohash);
  return {
    title,
    itemId: String(p.itemId || title || 'unknown').slice(0, 300),
    sourceId,
    sourceLabel: p.sourceLabel || engine.name,
    kind: p.kind || engine.kind || 'community',
    category: p.category || categorizeTitle(title, p.hints),
    sizeBytes: Number.isFinite(p.sizeBytes) && p.sizeBytes >= 0 ? Math.round(p.sizeBytes) : null,
    seeders: Number.isInteger(p.seeders) && p.seeders >= 0 ? p.seeders : null,
    leechers: Number.isInteger(p.leechers) && p.leechers >= 0 ? p.leechers : null,
    uploadedAt: Number.isFinite(p.uploadedAt) ? p.uploadedAt : null,
    downloads: Number.isInteger(p.downloads) && p.downloads >= 0 ? p.downloads : null,
    infohash: ih,
    magnet: ih && !p.magnet ? buildMagnet({ infoHash: ih, name: title }) : p.magnet || null,
    torrentUrl: p.torrentUrl || null,
    pageUrl: p.pageUrl || null,
    thumbnail: p.thumbnail || null,
    // Direct-download support: fileUrl = plain HTTP(S) content URL the
    // app may stream (hosts re-validated in lib/network at download time);
    // fileSource = capability tag the UI routes on ('archive-item').
    fileUrl: typeof p.fileUrl === 'string' && /^https?:\/\//i.test(p.fileUrl) ? p.fileUrl : null,
    fileSource: p.fileSource || null,
    demo: !!(engine.demo || p.demo),
    relevance: p.relevance ?? 0,
    hints: Array.isArray(p.hints) ? p.hints : [],
    // Rich catalog metadata (Archive.org etc.): nullable, first-seen-wins on
    // merge. Kept small — description is display-clipped here.
    creator: p.creator ? String(p.creator).slice(0, 120) : null,
    year: p.year != null && p.year !== '' ? String(p.year).slice(0, 20) : null,
    description: p.description ? String(p.description).replace(/\s+/g, ' ').trim().slice(0, 220) : null,
    mediatype: p.mediatype ? String(p.mediatype).toLowerCase() : null,
  };
}

/** Guard against a runaway engine returning junk (used pre-merge). */
function sanitizeList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r && typeof r.title === 'string' && r.title.trim().length > 0)
    .slice(0, 200);
}

/** Split a query into significant tokens (shared by all engines). */
function queryTokens(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length >= 2);
}

/** Simple scorer: fraction of query tokens present in a candidate string. */
function tokenHitScore(query, candidate) {
  const tokens = queryTokens(query);
  if (!tokens.length) return 0;
  const hay = String(candidate || '').toLowerCase();
  let hits = 0;
  for (const t of tokens) if (hay.includes(t)) hits++;
  return hits / tokens.length;
}

module.exports = { normalizeResult, sanitizeList, queryTokens, tokenHitScore, categorizeTitle };
