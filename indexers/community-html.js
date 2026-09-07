'use strict';

const { queryTokens, tokenHitScore } = require('./base');

function decodeEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&#x2f;/gi, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

function stripTags(value) {
  return decodeEntities(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

function parseSize(value) {
  const m = String(value || '').replace(/,/g, '').match(/([\d.]+)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  const mult = unit === 'b' ? 1 : unit.startsWith('k') ? 1024 : unit.startsWith('m') ? 1024 ** 2 : unit.startsWith('g') ? 1024 ** 3 : 1024 ** 4;
  return Math.round(n * mult);
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(decodeEntities(href), baseUrl).href;
  } catch {
    return null;
  }
}

function matchesQuery(text, query) {
  const hay = String(text || '').toLowerCase();
  const tokens = queryTokens(query);
  return tokens.length > 0 && tokens.some((token) => hay.includes(token));
}

function extractInfohash(text) {
  const magnet = String(text || '').match(/magnet:\?[^"'\s<>]*urn:btih:([a-z0-9]{32,40})/i);
  if (magnet) return magnet[1].toLowerCase();
  const hash = String(text || '').match(/\b[a-f0-9]{40}\b/i);
  return hash ? hash[0].toLowerCase() : null;
}

function extractAnchors(html, baseUrl) {
  const out = [];
  const re = /<a\b([^>]*)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || ''))) !== null) {
    const url = absoluteUrl(match[2], baseUrl);
    if (!url || !/^https?:/i.test(url)) continue;
    const title = stripTags(match[4]);
    if (!title || title.length < 2) continue;
    out.push({ url, title, offset: match.index, raw: match[0] });
  }
  return out;
}

/**
 * Parse a public search page without assuming a site's private API. The
 * caller supplies a link predicate so navigation and unrelated cards stay
 * out of the result set. Detail pages are deliberately not fetched here;
 * a page URL is still useful when a source does not publish hashes inline.
 */
function parseSearchPage(html, query, options) {
  const opts = options || {};
  const anchors = extractAnchors(html, opts.baseUrl);
  const seen = new Set();
  const results = [];
  for (const anchor of anchors) {
    if (opts.link && !opts.link(anchor.url, anchor.title)) continue;
    if (!matchesQuery(`${anchor.title} ${anchor.url}`, query)) continue;
    const key = anchor.url.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const nearby = String(html).slice(Math.max(0, anchor.offset - 200), anchor.offset + anchor.raw.length + 900);
    const infohash = extractInfohash(nearby);
    const seedMatch = nearby.match(/(?:seed(?:er|s)|seeds)\D{0,30}(\d[\d,]*)/i);
    const peerMatch = nearby.match(/(?:peer|leech(?:er|s))\D{0,30}(\d[\d,]*)/i);
    const dateMatch = nearby.match(/(20\d{2}[-/]\d{1,2}[-/]\d{1,2})/);
    results.push({
      itemId: key,
      title: anchor.title,
      category: opts.category || null,
      sizeBytes: parseSize(nearby),
      seeders: seedMatch ? Number(seedMatch[1].replace(/,/g, '')) : null,
      leechers: peerMatch ? Number(peerMatch[1].replace(/,/g, '')) : null,
      uploadedAt: dateMatch ? Date.parse(dateMatch[1]) : null,
      infohash,
      torrentUrl: /\.torrent(?:$|[?#])/i.test(anchor.url) ? anchor.url : null,
      pageUrl: anchor.url,
      relevance: tokenHitScore(query, anchor.title),
    });
  }
  results.sort((a, b) => (b.relevance - a.relevance) || ((b.seeders ?? -1) - (a.seeders ?? -1)) || a.title.localeCompare(b.title));
  return results.slice(0, opts.maxResults || 50);
}

module.exports = { decodeEntities, stripTags, parseSize, absoluteUrl, matchesQuery, extractInfohash, extractAnchors, parseSearchPage };
