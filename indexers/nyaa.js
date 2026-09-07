'use strict';
// ---------------------------------------------------------------------
// Torrentor — Nyaa engine (community index, OPT-IN).
//
// Nyaa publishes a lightweight RSS search feed with torrent metadata,
// including info hashes, seeders, size and upload date. The adapter uses
// only the proxy-aware network client and keeps its default disabled: the
// operator should review the source and each result before downloading.
// ---------------------------------------------------------------------

const { normalizeResult, queryTokens, tokenHitScore } = require('./base');

const ENGINE = {
  id: 'nyaa',
  name: 'Nyaa',
  homepage: 'https://nyaa.si/',
  tagline: 'Community anime/media index via its RSS feed — opt-in, off by default.',
  kind: 'community',
  demo: false,
  probe: 'one piece',
  defaultEnabled: false,
};

const RSS_URL = 'https://nyaa.si/?page=rss&c=0_0&f=0';
const MAX_RESULTS = 50;

function decodeEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x2f;/gi, '/')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function tag(block, name) {
  const re = new RegExp(`<[^>]*${name}[^>]*>([\\s\\S]*?)<\\/[^>]*${name}\\s*>`, 'i');
  const m = re.exec(block);
  return m ? decodeEntities(m[1]) : '';
}

function parseSize(value) {
  const m = String(value || '').trim().match(/^([\d.,]+)\s*(B|Ki?B|Mi?B|Gi?B|Ti?B)$/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  const multiplier = unit === 'b' ? 1 : unit.startsWith('k') ? 1024 : unit.startsWith('m') ? 1024 ** 2 : unit.startsWith('g') ? 1024 ** 3 : 1024 ** 4;
  return Math.round(n * multiplier);
}

function allowedCategory(categoryId) {
  // Nyaa's 1_5 category is Anime → Hentai. Never surface it regardless
  // of the user's query; the source remains opt-in for all other rows.
  return String(categoryId || '') !== '1_5';
}

function matchesQuery(title, query) {
  const tokens = queryTokens(query);
  if (!tokens.length) return false;
  const hay = String(title || '').toLowerCase();
  return tokens.some((token) => hay.includes(token));
}

function normalizeItem(block, query) {
  const title = tag(block, 'title');
  const categoryId = tag(block, 'categoryId');
  const infohash = tag(block, 'infoHash').toLowerCase();
  if (!title || !matchesQuery(title, query) || !allowedCategory(categoryId)) return null;
  if (!/^[0-9a-f]{40}$/.test(infohash)) return null;
  const link = tag(block, 'link') || tag(block, 'guid');
  const seeders = Number(tag(block, 'seeders'));
  const leechers = Number(tag(block, 'leechers'));
  const downloads = Number(tag(block, 'downloads'));
  const uploadedAt = Date.parse(tag(block, 'pubDate'));
  return {
    itemId: link || infohash,
    title,
    category: 'other',
    sizeBytes: parseSize(tag(block, 'size')),
    seeders: Number.isInteger(seeders) && seeders >= 0 ? seeders : null,
    leechers: Number.isInteger(leechers) && leechers >= 0 ? leechers : null,
    downloads: Number.isInteger(downloads) && downloads >= 0 ? downloads : null,
    uploadedAt: Number.isFinite(uploadedAt) ? uploadedAt : null,
    infohash,
    pageUrl: link || null,
    torrentUrl: link || null,
    relevance: tokenHitScore(query, title),
  };
}

function cleanFeed(xml, query) {
  const out = [];
  const blocks = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const item = normalizeItem(block, query);
    if (item) out.push(item);
  }
  out.sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1) || (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0));
  return out.slice(0, MAX_RESULTS);
}

async function search(query, ctx) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  let xml;
  try {
    xml = await ctx.network.getText(`${RSS_URL}&q=${encodeURIComponent(q)}`, {
      timeoutMs: ctx.timeoutMs,
      maxBytes: 2 * 1024 * 1024,
      signal: ctx.signal,
    });
  } catch (err) {
    if (ctx.signal && ctx.signal.aborted) throw err;
    throw new Error(`Nyaa RSS unreachable (${String((err && err.message) || err).slice(0, 80)})`);
  }
  return cleanFeed(xml, q).map((item) => normalizeResult(item, ENGINE));
}

module.exports = { engine: ENGINE, search, decodeEntities, parseSize, allowedCategory, matchesQuery, normalizeItem, cleanFeed };
