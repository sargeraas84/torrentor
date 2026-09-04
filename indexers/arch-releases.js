'use strict';
// ---------------------------------------------------------------------
// Torrentor — Arch Linux release engine (legal-friendly, live).
//
// Arch publishes an official JSON feed of every monthly release ISO with
// its .torrent metadata embedded (infohash, announce, file length) plus
// magnet and .torrent URLs:
//   https://archlinux.org/releng/releases/json/
// This adapter fetches that feed (short in-memory cache), then scores
// release filenames against the query tokens — the same honesty rules as
// the other real engines: a release only ships when a query token
// genuinely matches its filename, never fabricated for unrelated queries.
// ---------------------------------------------------------------------

const { normalizeResult, queryTokens, tokenHitScore } = require('./base');

const ENGINE = {
  id: 'arch-releases',
  name: 'Arch Linux',
  tagline: 'Official Arch Linux ISO torrents straight from the Arch release feed.',
  kind: 'official',
  demo: false,
  probe: 'archlinux',
};

const FEED_URL = 'https://archlinux.org/releng/releases/json/';
const SITE = 'https://archlinux.org';
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = null; // { at, releases }

const ISO_VERSION_RE = /^\d{4}\.\d{2}\.\d{2}$/;

/** Keep only releases that look like real monthly ISO builds. */
function parseFeed(raw) {
  const releases = (raw && raw.releases) || [];
  return releases
    .filter((r) => r && ISO_VERSION_RE.test(String(r.version || '')) && r.magnet_uri && r.torrent_url)
    .map((r) => ({
      version: String(r.version),
      fileName: String((r.torrent && r.torrent.file_name) || `archlinux-${r.version}-x86_64.iso`),
      fileLength: Number.isFinite(r.torrent && r.torrent.file_length) ? r.torrent.file_length : null,
      infoHash: (r.torrent && r.torrent.info_hash) || null,
      magnet: String(r.magnet_uri),
      torrentUrl: SITE + String(r.torrent_url),
      created: Date.parse(r.created || r.release_date || '') || null,
    }));
}

async function fetchFeed(ctx) {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.releases;
  const text = await ctx.network.getText(FEED_URL, { timeoutMs: 9000, maxBytes: 4 * 1024 * 1024, signal: ctx.signal });
  const releases = parseFeed(JSON.parse(text));
  cache = { at: Date.now(), releases };
  return releases;
}

// --------------------------------------------------------------- search

async function search(query, ctx) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const tokens = queryTokens(q);
  let releases;
  try {
    releases = await fetchFeed(ctx);
  } catch (err) {
    if (ctx.signal && ctx.signal.aborted) throw err;
    throw new Error(`Arch release feed unavailable (${String((err && err.message) || err).slice(0, 80)})`);
  }
  if (!releases.length) return [];

  const scored = releases
    .map((r) => {
      // Match against the FULL filename (extension included) so queries
      // like "archlinux iso" genuinely match; only the display title
      // strips the extension.
      const relevance = tokenHitScore(q, r.fileName);
      // Honesty: every significant query token must appear in the release
      // filename — a bare "linux"/"iso" hit on an unrelated release is not
      // a match.
      const hasAllTokens = tokens.every((tok) => r.fileName.toLowerCase().includes(tok));
      return { r, relevance, hasAllTokens };
    })
    .filter((s) => s.hasAllTokens)
    .sort((a, b) => (b.relevance - a.relevance) || (b.r.created || 0) - (a.r.created || 0) || a.r.fileName.localeCompare(b.r.fileName))
    .slice(0, 30);

  // Honesty: when nothing genuinely matches the query we return nothing —
  // never fabricate results for unrelated queries.
  if (!scored.length) return [];

  return scored.map(({ r, relevance }) =>
    normalizeResult(
      {
        itemId: `archlinux-${r.version}`,
        title: `${r.fileName.replace(/\.iso$/i, '').replace(/_/g, ' ')} — official Arch Linux ISO`,
        category: 'apps',
        sizeBytes: r.fileLength,
        uploadedAt: r.created,
        infohash: r.infoHash,
        magnet: r.magnet,
        torrentUrl: r.torrentUrl,
        pageUrl: 'https://archlinux.org/releng/releases/',
        relevance,
      },
      ENGINE
    )
  );
}

module.exports = { engine: ENGINE, search, parseFeed };
