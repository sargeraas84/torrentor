'use strict';
// ---------------------------------------------------------------------
// Torrentor — The Pirate Bay engine (community index, OPT-IN).
//
// Uses the community-maintained apibay.org JSON mirror of The Pirate
// Bay's search API: one GET returns rows with name, 40-hex infohash,
// seeders/leechers, size and upload time — every card gets a magnet
// built from the infohash, so this is the richest community source the
// app ships.
//
// Honest notes — read before shipping, the operator owns this decision:
//  • This is an UNOFFICIAL third-party mirror of a site whose content
//    policy is permissive. It is deliberately NOT a legal-friendly
//    source like the other shipped engines, so the engine ships
//    DISABLED BY DEFAULT (`defaultEnabled: false`) — the user opts in
//    from Settings → Search sources.
//  • apibay.org is not affiliated with the app and the domain can move;
//    health-check failures surface as red dots in Settings.
//  • The adult section (categories 500–599) is filtered out client-side,
//    always, regardless of what the user searches for.
// ---------------------------------------------------------------------

const { normalizeResult, queryTokens, tokenHitScore } = require('./base');

const ENGINE = {
  id: 'piratebay',
  name: 'The Pirate Bay',
  tagline: 'Community index via the apibay mirror — opt-in source, off by default.',
  kind: 'community',
  demo: false,
  probe: 'ubuntu',
  defaultEnabled: false,
};

const API = 'https://apibay.org/q.php';
const MAX_RESULTS = 50;

/**
 * apibay category code → Torrentor category. Returns null for the adult
 * section (500–599), which is never surfaced. Codes follow the classic
 * Pirate Bay taxonomy (100s audio, 200s video, 300s apps, 400s games,
 * 600s other).
 */
function mapCategory(code) {
  const n = Number(code);
  if (!Number.isInteger(n)) return 'other';
  if (n >= 100 && n < 200) return 'audio';
  if (n >= 200 && n < 300) return 'video';
  if (n >= 300 && n < 400) return 'apps';
  if (n >= 400 && n < 500) return 'games';
  if (n >= 500 && n < 600) return null; // adult section — excluded
  if (n === 601 || n === 602) return 'documents'; // e-books, comics
  return 'other';
}

/** Decode the HTML entities the mirror sometimes leaves in titles. */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** Honesty gate: a row counts only when a significant token hits its name. */
function matchesQuery(name, query) {
  const tokens = queryTokens(query);
  if (!tokens.length) return false;
  const hay = String(name || '').toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

/**
 * Convert one apibay row into a normalized-result partial, or null when
 * it is junk ('No results returned' sentinel, missing infohash), in the
 * adult section, or fails the honesty gate.
 */
function normalizeRow(row, query) {
  const name = decodeEntities(row && row.name);
  if (!name || !matchesQuery(name, query)) return null;
  const ih = String(row.info_hash || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(ih)) return null;
  const category = mapCategory(row.category);
  if (!category) return null; // adult section — excluded
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const seeders = toNum(row.seeders);
  const leechers = toNum(row.leechers);
  const sizeBytes = toNum(row.size);
  const added = toNum(row.added);
  const id = String(row.id || '').trim();
  return {
    itemId: id || ih,
    title: name,
    category,
    sizeBytes,
    seeders,
    leechers,
    uploadedAt: added > 0 ? Math.round(added * 1000) : null, // API uses unix seconds
    infohash: ih,
    // apibay serves the .torrent binary at t.php?id=…; the magnet (built
    // by normalizeResult from the infohash) is the primary action anyway.
    torrentUrl: id ? `https://apibay.org/t.php?id=${encodeURIComponent(id)}` : null,
    pageUrl: null,
    relevance: tokenHitScore(query, name),
  };
}

/**
 * Clean + honesty-gate a raw apibay response into normalized partials,
 * most-seeded first (the mirror returns rows in arbitrary order).
 */
function cleanRows(raw, query) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    const item = normalizeRow(row, query);
    if (item) out.push(item);
  }
  out.sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1));
  return out.slice(0, MAX_RESULTS);
}

// --------------------------------------------------------------- search

async function search(query, ctx) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  let raw;
  try {
    raw = await ctx.network.getJson(`${API}?q=${encodeURIComponent(q)}&cat=0`, {
      timeoutMs: ctx.timeoutMs,
      maxBytes: 2 * 1024 * 1024,
      signal: ctx.signal,
    });
  } catch (err) {
    if (ctx.signal && ctx.signal.aborted) throw err;
    throw new Error(`Pirate Bay mirror unreachable (${String((err && err.message) || err).slice(0, 80)})`);
  }
  return cleanRows(raw, q).map((item) => normalizeResult(item, ENGINE));
}

module.exports = { engine: ENGINE, search, mapCategory, decodeEntities, matchesQuery, normalizeRow, cleanRows };