'use strict';
// ---------------------------------------------------------------------
// Torrentor — Internet Archive engine (legal-friendly, real network).
//
// Searches the Archive's public catalog (advancedsearch API) and returns
// items as torrent results: nearly every public item ships an official
// "_archive.torrent" file on its download server, so the "Download as
// torrent" URL is deterministic from the identifier.
//
// Notes / honest limitations:
//  • Archive items are metadata-searchable, not torrent-tracked: there
//    are no seeders/leechers or real infohashes exposed by the API, so
//    cards carry the item's download count instead, and their dedupe
//    key is source-scoped (identifier), not an infohash.
//  • One item may exist in several media collections (audio/movies...);
//    we show the mediatype-derived category.
//  • We cap per-run items and sort by popularity so the page stays
//    relevant even for broad queries.
// ---------------------------------------------------------------------

const { normalizeResult, sanitizeList, tokenHitScore } = require('./base');

const ENGINE = {
  id: 'archive-org',
  name: 'Internet Archive',
  tagline: 'Official torrents for Archive.org items (public-domain & CC media, books, software, data).',
  kind: 'official',
  demo: false,
  probe: 'big buck bunny',
};

const SEARCH_URL = 'https://archive.org/advancedsearch.php';
const ROWS = 50;
// No explicit sort: advancedsearch's native relevance ranking is the
// default, which is the right ordering for a search engine. Raw download
// counts stay on the card as metadata only.
const FIELDS = ['identifier', 'title', 'creator', 'year', 'mediatype', 'item_size', 'downloads', 'date', 'publicdate', 'description'].map((f) => `fl[]=${f}`).join('&');

const MEDIATYPE_HINTS = { movies: ['movies'], audio: ['audio'], etree: ['audio', 'music'], texts: ['texts'], software: ['software'], image: ['image'], data: ['data'] };

function buildSearchUrl(query, page = 1, scope) {
  const q = String(query || '').trim();
  const qp = encodeURIComponent(scope === 'title' ? titleScopedQuery(q) : q);
  const pg = Math.max(1, Math.floor(Number(page) || 1));
  // (A numeric fq range like "downloads:[1 TO *]" is rejected by the API —
  // we filter empty records client-side in normalizeItem instead.)
  return `${SEARCH_URL}?q=${qp}&${FIELDS}&rows=${ROWS}&page=${pg}&output=json`;
}

/**
 * Title-scoped variant of a query: constrains Archive's fuzzy relevance
 * search to items whose TITLE contains at least one significant query
 * token, so literal matches cluster on page 1 instead of being buried
 * below metadata-mention chaff. Only tokens are used (alnum, >= 2 chars)
 * so the Lucene query can't be broken by odd user punctuation.
 */
function titleScopedQuery(query) {
  const tokens = significantTokens(query);
  if (!tokens.length) return String(query || '').trim();
  return `(${tokens.join(' ')}) AND title:(${tokens.join(' OR ')})`;
}

/** Significant (>=2 char) alphanumeric query tokens. */
function significantTokens(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length >= 2);
}

/**
 * Honesty gate: an item only counts as a hit if the query actually
 * matches its title or identifier (word-level containment). Popularity
 * must never promote items whose metadata merely mentions the term.
 */
function matchesQuery(doc, query) {
  const tokens = significantTokens(query);
  if (!tokens.length) return false;
  const title = String(doc.title || '').toLowerCase();
  const id = String(doc.identifier || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return tokens.some((t) => title.includes(t) || id.includes(t));
}

function normalizeItem(doc, query) {
  const id = String(doc.identifier || '').trim();
  const title = String(doc.title || doc.identifier || '').trim();
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  if (!id || !title) return null;
  // Gate: only genuine title/identifier matches pass through.
  if (!matchesQuery(doc, query)) return null;
  const downloads = Number.isInteger(Number(doc.downloads)) ? Number(doc.downloads) : null;
  const sizeBytes = Number.isFinite(Number(doc.item_size)) ? Number(doc.item_size) : null;
  // Items with no downloads and no files won't have an _archive.torrent.
  if (!downloads && !sizeBytes) return null;
  const mediatype = String(doc.mediatype || '').toLowerCase();
  const hints = MEDIATYPE_HINTS[mediatype] || [];
  let uploadedAt = null;
  const pub = String(doc.publicdate || doc.date || '').trim();
  const m = pub.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) uploadedAt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getTime();

  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  // Relevance bias: exact/prefix identifier hits and title-token coverage.
  const identBonus = id.toLowerCase().includes(String(query).toLowerCase()) ? 0.35 : 0;
  const relevance = Math.min(1, tokenHitScore(query, cleanTitle) + identBonus);

  return {
    itemId: id,
    title: cleanTitle,
    category: undefined, // derived from hints by normalizeResult
    hints,
    creator: first(doc.creator) ? String(first(doc.creator)).slice(0, 120) : null,
    year: first(doc.year) != null && first(doc.year) !== '' ? String(first(doc.year)).slice(0, 20) : null,
    description: first(doc.description) ? String(first(doc.description)).replace(/\s+/g, ' ').trim().slice(0, 220) : null,
    mediatype,
    sizeBytes,
    seeders: null,
    leechers: null,
    uploadedAt,
    downloads,
    infohash: null, // not exposed by the API — dedupe key is source-scoped
    // The item bundles real files over plain HTTPS → the card offers an
    // in-app file picker + direct download (torrentUrl stays as-is).
    fileSource: 'archive-item',
    torrentUrl: `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(id)}_archive.torrent`,
    pageUrl: `https://archive.org/details/${encodeURIComponent(id)}`,
    thumbnail: `https://archive.org/services/img/${encodeURIComponent(id)}?w=200`,
    relevance,
  };
}

/**
 * Search one page of the Archive for the query. Returns
 * { results, total, page, hasMore } so callers can page deeper.
 */
/** Fetch + honest-gate one page of results for a (possibly scoped) query. */
async function fetchPage(qstr, q, page, ctx) {
  const data = await ctx.network.getJson(buildSearchUrl(qstr, page, qstr !== q ? 'title' : undefined), {
    timeoutMs: ctx.timeoutMs,
    maxBytes: 4 * 1024 * 1024,
    signal: ctx.signal,
  });
  const resp = (data && data.response) || {};
  const docs = resp.docs || [];
  const total = Number.isFinite(Number(resp.numFound)) ? Number(resp.numFound) : 0;
  const results = sanitizeList(
    docs.map((doc) => normalizeItem(doc, q)).filter(Boolean).map((item) => normalizeResult(item, ENGINE))
  );
  // More exists while the API still returns a full page and we haven't
  // reached numFound yet (even if post-gate results are thin).
  const hasMore = docs.length >= ROWS && page * ROWS < total;
  return { results, total, page, hasMore };
}

/**
 * Search one page of the Archive for the query. Returns
 * { results, total, page, hasMore } so callers can page deeper.
 */
async function searchPage(query, ctx = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return { results: [], total: 0, page: 1, hasMore: false };
  const page = Math.max(1, Math.floor(Number(ctx.page) || 1));
  let out = await fetchPage(q, q, page, ctx);
  // Broad catalog phrases ('public domain films') bury literal title
  // matches below fuzzy relevance, so page 1 can gate to ~0 honest hits
  // even when the catalog is full of them. When the honest page is thin,
  // refetch once with the title-scoped query (cheap, only on page 1) and
  // keep whichever list is richer — both are honest-gated the same way.
  if (page === 1 && out.results.length < 6) {
    try {
      const alt = await fetchPage(titleScopedQuery(q), q, 1, ctx);
      if (alt.results.length > out.results.length) out = alt;
    } catch {
      /* fallback is best-effort — keep the natural page */
    }
  }
  return out;
}

/** Engine-contract wrapper: returns just the normalized result list. */
async function search(query, ctx = {}) {
  return (await searchPage(query, ctx)).results;
}

module.exports = { engine: ENGINE, search, searchPage, buildSearchUrl, titleScopedQuery, normalizeItem, matchesQuery, significantTokens, ROWS };
