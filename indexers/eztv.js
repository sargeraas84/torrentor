'use strict';

const { normalizeResult, queryTokens, tokenHitScore } = require('./base');

const ENGINE = {
  id: 'eztv',
  name: 'EZTV',
  homepage: 'https://eztvx.to/',
  tagline: 'Community TV-show index via its public API — opt-in, off by default.',
  kind: 'community',
  demo: false,
  probe: 'the office',
  defaultEnabled: false,
};

const API = 'https://eztvx.to/api/get-torrents';
const MAX_RESULTS = 50;

function matchesQuery(title, query) {
  const hay = String(title || '').toLowerCase();
  return queryTokens(query).some((token) => hay.includes(token));
}

function normalizeTorrent(row, query) {
  const title = String(row && (row.title || row.name) || '').trim();
  if (!title || !matchesQuery(title, query)) return null;
  const hash = String(row.hash || row.info_hash || row.infoHash || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash)) return null;
  const size = Number(row.size_bytes ?? row.size);
  const seeds = Number(row.seeds ?? row.seeders);
  const peers = Number(row.peers ?? row.leechers);
  const unix = Number(row.date_released_unix ?? row.added);
  return {
    itemId: String(row.id || hash),
    title,
    category: 'video',
    sizeBytes: Number.isFinite(size) && size >= 0 ? Math.round(size) : null,
    seeders: Number.isInteger(seeds) && seeds >= 0 ? seeds : null,
    leechers: Number.isInteger(peers) && peers >= 0 ? peers : null,
    uploadedAt: Number.isFinite(unix) && unix > 0 ? Math.round(unix * 1000) : null,
    infohash: hash,
    torrentUrl: row.torrent_url || row.torrentUrl || null,
    pageUrl: row.episode_url || row.episodeUrl || row.url || null,
    relevance: tokenHitScore(query, title),
  };
}

function cleanResponse(data, query) {
  const rows = data && Array.isArray(data.torrents) ? data.torrents : Array.isArray(data) ? data : [];
  return rows.map((row) => normalizeTorrent(row, query)).filter(Boolean)
    .sort((a, b) => (b.relevance - a.relevance) || ((b.seeders ?? -1) - (a.seeders ?? -1)))
    .slice(0, MAX_RESULTS);
}

async function search(query, ctx) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  try {
    const data = await ctx.network.getJson(`${API}?limit=${MAX_RESULTS}&keywords=${encodeURIComponent(q)}`, {
      timeoutMs: ctx.timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      signal: ctx.signal,
    });
    return cleanResponse(data, q).map((item) => normalizeResult(item, ENGINE));
  } catch (err) {
    if (ctx.signal && ctx.signal.aborted) throw err;
    throw new Error(`EZTV API unreachable (${String((err && err.message) || err).slice(0, 80)})`);
  }
}

module.exports = { engine: ENGINE, search, matchesQuery, normalizeTorrent, cleanResponse };
