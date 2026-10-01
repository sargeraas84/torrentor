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

/** Return true when two tokens are identical or differ by one character. */
function tokensMatch(queryToken, candidateToken) {
  if (queryToken === candidateToken) return true;
  if (/^\d+$/.test(queryToken) || /^\d+$/.test(candidateToken)) return false;
  if (queryToken.length < 4 || candidateToken.length < 4 || Math.abs(queryToken.length - candidateToken.length) > 1) return false;

  // Bounded Damerau-Levenshtein check: one insertion, deletion, substitution,
  // or adjacent transposition. This catches common typos without turning
  // short words or arbitrary substrings into matches.
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < queryToken.length && j < candidateToken.length) {
    if (queryToken[i] === candidateToken[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (i + 1 < queryToken.length && j + 1 < candidateToken.length &&
        queryToken[i] === candidateToken[j + 1] && queryToken[i + 1] === candidateToken[j]) {
      i += 2;
      j += 2;
    } else if (queryToken.length > candidateToken.length) {
      i++;
    } else if (queryToken.length < candidateToken.length) {
      j++;
    } else {
      i++;
      j++;
    }
  }
  if (i < queryToken.length || j < candidateToken.length) edits++;
  return edits === 1;
}

function matchQueryTokens(tokens, candidateTokens) {
  const qualities = tokens.map(() => 0);
  const used = new Set();

  // Reserve exact matches first so a nearby fuzzy token can't consume the
  // only candidate available to another query token.
  for (let q = 0; q < tokens.length; q++) {
    const match = candidateTokens.findIndex((candidateToken, i) => !used.has(i) && tokens[q] === candidateToken);
    if (match >= 0) {
      used.add(match);
      qualities[q] = 1;
    }
  }
  for (let q = 0; q < tokens.length; q++) {
    if (qualities[q]) continue;
    const match = candidateTokens.findIndex((candidateToken, i) => !used.has(i) && tokensMatch(tokens[q], candidateToken));
    if (match >= 0) {
      used.add(match);
      qualities[q] = 0.45;
    }
  }
  return qualities;
}

function queryMatches(query, candidate) {
  const tokens = queryTokens(query);
  const candidateTokens = queryTokens(candidate);
  return matchQueryTokens(tokens, candidateTokens).some((quality) => quality > 0);
}

function allQueryTokensMatch(query, candidate) {
  const tokens = queryTokens(query);
  const candidateTokens = queryTokens(candidate);
  return tokens.length > 0 && matchQueryTokens(tokens, candidateTokens).every((quality) => quality > 0);
}

/**
 * Score title relevance on a stable 0–1 scale. Whole-token coverage is the
 * foundation; a one-character typo remains a partial match, while matching
 * in order and as a phrase raises confidence. Incidental substrings ("art"
 * in "party") never count as matches.
 */
function tokenHitScore(query, candidate) {
  const tokens = queryTokens(query);
  const titleTokens = queryTokens(candidate);
  if (!tokens.length || !titleTokens.length) return 0;

  const qualities = matchQueryTokens(tokens, titleTokens);
  const coverage = qualities.reduce((sum, quality) => sum + quality, 0) / tokens.length;
  let ordered = 0;
  let cursor = 0;
  for (let i = 0; i < tokens.length; i++) {
    const next = titleTokens.findIndex((titleToken, titleIndex) => titleIndex >= cursor && tokensMatch(tokens[i], titleToken));
    if (next < 0) continue;
    ordered += tokens[i] === titleTokens[next] ? 1 : 0.45;
    cursor = next + 1;
  }
  let phrase = false;
  for (let start = 0; start <= titleTokens.length - tokens.length && !phrase; start++) {
    phrase = tokens.every((token, i) => titleTokens[start + i] === token);
  }
  const exactTitle = titleTokens.length === tokens.length && phrase;
  return Math.min(1, coverage * 0.62 + (ordered / tokens.length) * 0.12 + (phrase ? 0.2 : 0) + (exactTitle ? 0.06 : 0));
}

module.exports = { normalizeResult, sanitizeList, queryTokens, tokensMatch, queryMatches, allQueryTokensMatch, tokenHitScore, categorizeTitle };
