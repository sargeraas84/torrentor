'use strict';
// ---------------------------------------------------------------------
// Torrentor — YTS engine (community index, OPT-IN).
//
// YTS exposes a small public JSON catalog for movie releases. The adapter
// returns one card per movie/torrent, uses the proxy-aware network client,
// and is disabled by default because this is a third-party community
// source whose operator and content policy should be reviewed before use.
// ---------------------------------------------------------------------

const { normalizeResult, queryTokens, tokenHitScore } = require('./base');

const ENGINE = {
  id: 'yts',
  name: 'YTS',
  homepage: 'https://yts.proxyninja.org/',
  tagline: 'HD movie catalog via the requested ProxyNinja mirror — opt-in, off by default.',
  kind: 'community',
  demo: false,
  probe: 'open movie',
  defaultEnabled: false,
};

const API = 'https://yts.proxyninja.org/api/v2/list_movies.json';
const HOMEPAGE = 'https://yts.proxyninja.org/';
const MAX_RESULTS = 50;
const ADULT_WORDS = /(?:porn|xxx|hentai|sex\s*film|adult\s*film)/i;

function matchesQuery(title, query) {
  const tokens = queryTokens(query);
  if (!tokens.length) return false;
  const hay = String(title || '').toLowerCase();
  return tokens.some((token) => hay.includes(token));
}

function isAllowedTitle(title) {
  return !!String(title || '').trim() && !ADULT_WORDS.test(String(title));
}

function bestTorrent(torrents) {
  const list = Array.isArray(torrents) ? torrents.filter((t) => t && t.hash && t.url) : [];
  // Prefer a smaller 720p/1080p release when several qualities exist, but
  // preserve stable API order as the final tie-breaker.
  const score = (t) => {
    const q = String(t.quality || '').toLowerCase();
    return q === '720p' ? 3 : q === '1080p' ? 2 : q === '2160p' || q === '4k' ? 1 : 0;
  };
  return list.slice().sort((a, b) => score(b) - score(a) || Number(b.seeds || 0) - Number(a.seeds || 0))[0] || null;
}

function normalizeMovie(movie, query) {
  const title = String(movie && movie.title || '').trim();
  if (!title || !matchesQuery(title, query) || !isAllowedTitle(title)) return null;
  const torrent = bestTorrent(movie.torrents);
  if (!torrent) return null;
  const infohash = String(torrent.hash || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(infohash)) return null;
  const sizeBytes = Number(torrent.size_bytes);
  const seeds = Number(torrent.seeds);
  const peers = Number(torrent.peers);
  const year = movie.year == null ? null : String(movie.year);
  const quality = torrent.quality ? ` ${torrent.quality}` : '';
  return {
    itemId: `${movie.id || title}:${infohash}`,
    title: `${title}${year ? ` (${year})` : ''}${quality}`,
    category: 'video',
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes >= 0 ? Math.round(sizeBytes) : null,
    seeders: Number.isInteger(seeds) && seeds >= 0 ? seeds : null,
    leechers: Number.isInteger(peers) && peers >= 0 ? peers : null,
    uploadedAt: movie.date_uploaded ? Date.parse(movie.date_uploaded) : null,
    infohash,
    torrentUrl: torrent.url,
    pageUrl: movie.url || (movie.slug ? `https://yts.proxyninja.org/movies/${movie.slug}` : 'https://yts.proxyninja.org/'),
    thumbnail: movie.medium_cover_image || movie.large_cover_image || null,
    relevance: tokenHitScore(query, title),
  };
}

function cleanResponse(data, query) {
  const movies = data && data.data && Array.isArray(data.data.movies) ? data.data.movies : [];
  return movies.map((movie) => normalizeMovie(movie, query)).filter(Boolean).slice(0, MAX_RESULTS);
}

async function search(query, ctx) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  let data;
  try {
    data = await ctx.network.getJson(`${API}?query_term=${encodeURIComponent(q)}&limit=${MAX_RESULTS}`, {
      timeoutMs: ctx.timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      signal: ctx.signal,
    });
  } catch (err) {
    if (ctx.signal && ctx.signal.aborted) throw err;
    throw new Error(`YTS API unreachable (${String((err && err.message) || err).slice(0, 80)})`);
  }
  return cleanResponse(data, q).map((item) => normalizeResult(item, ENGINE));
}

module.exports = { engine: ENGINE, search, matchesQuery, isAllowedTitle, bestTorrent, normalizeMovie, cleanResponse };
