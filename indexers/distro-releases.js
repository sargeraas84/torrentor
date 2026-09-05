'use strict';
// ---------------------------------------------------------------------
// Torrentor — Linux distro release engine (legal-friendly, live).
//
// Pulls the .torrent files that Ubuntu and Debian publish for their
// official ISOs and matches them against the query. Releases pages are
// static auto-index listings, so this adapter parses them on a short
// in-memory cache (10 min) and then scores candidate filenames against
// the query tokens — exact queries like "ubuntu 24.04 desktop" score
// highest, vague queries return the top of the feed instead.
// ---------------------------------------------------------------------

const { normalizeResult, queryTokens, tokenHitScore } = require('./base');

const ENGINE = {
  id: 'distro-releases',
  name: 'Linux releases',
  tagline: 'Official Ubuntu & Debian ISO torrents straight from the projects.',
  kind: 'official',
  demo: false,
  probe: 'ubuntu 24.04',
  directFiles: true, // official ISO downloads straight from the mirror
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // url -> { at, text }

// ------------------------------------------------------------------ feed

function listingUrls() {
  return [
    'https://releases.ubuntu.com/',
    'https://cdimage.debian.org/debian-cd/current/amd64/bt-cd/',
    'https://cdimage.debian.org/debian-cd/current/arm64/bt-cd/',
    'https://cdimage.debian.org/debian-cd/current/source/bt-cd/',
  ];
}

/** Parse an Apache-style auto-index page into [{ href, label, size }]. */
function parseListing(html, baseUrl) {
  const rows = [];
  // Apache listing rows look like:
  //   <a href="ubuntu-24.04-desktop-amd64.iso.torrent">…</a> … <td>2.0G</td>
  // but exact markup varies, so we scan anchors + nearby size tokens.
  const anchorRe = /<a[^>]+href="([^"#?][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1];
    // Skip root-relative, absolute, parent-dir and sort links. Directory
    // rows (trailing '/') are KEPT — release indexes like the redesigned
    // releases.ubuntu.com top page contain only directory links, and
    // callers filter rows by .torrent label or numeric dir pattern.
    if (href.startsWith('/') || href.includes('://') || href === '../' || href.startsWith('?')) continue;
    const label = m[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim() || decodeURIComponent(href.split('/').pop() || '');
    if (!label) continue;
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 600);
    const sizeMatch = after.match(/<td[^>]*>\s*([\d.,]+\s*[KMGTP]?B?)\s*<\/td>/i);
    const size = sizeMatch ? parseSize(sizeMatch[1]) : null;
    rows.push({
      href: href.startsWith('http') ? href : new URL(href, baseUrl).href,
      label,
      size,
    });
  }
  return rows;
}

function parseSize(text) {
  const m = String(text || '').match(/^([\d.,]+)\s*([KMGTP]?)(i?B)?$/i);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  if (!isFinite(v)) return null;
  const unit = (m[2] || '').toUpperCase();
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 }[unit];
  if (!mult) return null;
  return Math.round(v * mult);
}

async function fetchCached(url, ctx) {
  // Cache only real-network calls. Test suites stub ctx.network and must
  // stay hermetic per case; a stubbed context never shares the live cache
  // (two consecutive stub tests would otherwise bleed into each other).
  const realNetwork = require('../lib/network');
  const isReal = !!ctx && !!ctx.network && ctx.network === realNetwork;
  const hit = isReal ? cache.get(url) : null;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.text;
  const text = await ctx.network.getText(url, { timeoutMs: 7000, maxBytes: 2 * 1024 * 1024, signal: ctx.signal });
  if (isReal) cache.set(url, { at: Date.now(), text });
  return text;
}

/**
 * From one parsed listing page, keep only the .torrent rows but report
 * the payload size: when the listing also carries the sibling ISO row
 * (label minus '.torrent'), use its size — otherwise the .torrent file's
 * own size (Debian's bt-cd pages list torrents only).
 */
function torrentRowsWithSizes(listingRows) {
  const payloadSize = new Map(
    listingRows.filter((r) => !/\.torrent$/i.test(r.label)).map((r) => [r.label, r.size])
  );
  return listingRows
    .filter((r) => /\.torrent$/i.test(r.label))
    .map((r) => {
      const payload = payloadSize.get(r.label.replace(/\.torrent$/i, ''));
      return { url: r.href, label: r.label, size: payload != null ? payload : r.size };
    });
}

/**
 * Choose which numeric release subfolders to crawl from the Ubuntu
 * top-page rows. Newest point release per series (major.minor), then the
 * most recent series first — NOT document order, which on the redesigned
 * page runs oldest → newest. Codename dirs (noble/, …) and non-release
 * rows never match the numeric pattern.
 */
function pickReleaseDirs(rows) {
  const point = (h) => {
    const m = String(h).match(/\/(\d+)\.(\d+)\.(\d+)\/?$/);
    return m ? m.slice(1).map(Number) : null;
  };
  const seen = new Map(); // 'major.minor' -> { href, ver }
  for (const r of rows || []) {
    const ver = point(r.href);
    if (!ver) continue;
    const key = `${ver[0]}.${ver[1]}`;
    const prev = seen.get(key);
    if (!prev || ver[2] > prev.ver[2]) seen.set(key, { href: r.href, ver });
  }
  return [...seen.values()]
    .sort((a, b) => b.ver[0] - a.ver[0] || b.ver[1] - a.ver[1] || b.ver[2] - a.ver[2])
    .slice(0, 4)
    .map((d) => d.href);
}

/** Collect every .torrent row from all listing feeds (fresh or cached). */
async function collectTorrents(ctx) {
  const out = [];
  const feeds = listingUrls();
  const settled = await Promise.allSettled(
    feeds.map(async (url) => {
      const text = await fetchCached(url, ctx);
      out.push(...torrentRowsWithSizes(parseListing(text, url)));
    })
  );
  const fetchedAny = settled.some((s) => s.status === 'fulfilled');
  // The top-level Ubuntu page is a directory-of-directories: descend into
  // the newest numeric release subfolders to reach the iso torrents.
  const top = settled[0];
  if (top.status === 'fulfilled') {
    const text = await fetchCached('https://releases.ubuntu.com/', ctx);
    for (const dir of pickReleaseDirs(parseListing(text, 'https://releases.ubuntu.com/'))) {
      try {
        // Cached like the top feeds: release listings are static, and
        // uncached refetches on every search/health probe hammer the server
        // and made the crawl flaky under repeated probing.
        const page = await fetchCached(dir, ctx);
        out.push(...torrentRowsWithSizes(parseListing(page, dir)));
      } catch {
        /* subfolder failure is non-fatal */
      }
    }
  }
  // Loud failure beats a silent green chip: a catalog that yields ZERO
  // torrent entries means the feeds are unreachable or a site redesign
  // outran the parser — surface it as an engine error, never ok/0.
  if (!out.length) {
    throw new Error(
      fetchedAny
        ? 'Release feeds returned no torrent entries — the site layout may have changed.'
        : 'Release feeds are unreachable right now.'
    );
  }
  return out;
}

// --------------------------------------------------------------- search

async function search(query, ctx) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const tokens = queryTokens(q);
  let torrents;
  try {
    torrents = await collectTorrents(ctx);
  } catch (err) {
    if (ctx.signal && ctx.signal.aborted) throw err;
    throw new Error(`Release feeds unavailable (${String((err && err.message) || err).slice(0, 80)})`);
  }
  if (!torrents.length) return [];

  const scored = torrents
    .map((t) => {
      const label = t.label.replace(/\.torrent$/i, '');
      const title = `${label.replace(/_/g, ' ')} — official release`;
      const relevance = tokenHitScore(q, label);
      const hasAllTokens = tokens.every((tok) => label.toLowerCase().includes(tok));
      return { t, title, relevance, hasAllTokens };
    })
    // Honesty: every significant query token must appear in the filename.
    // (A bare "iso"/"linux" hit on an otherwise unrelated release is NOT a
    // match — partial-token leaks like "archlinux iso" → Ubuntu ISOs are
    // exactly what this gate exists to prevent.)
    .filter((s) => s.hasAllTokens)
    .sort((a, b) => (b.relevance - a.relevance) || a.t.label.localeCompare(b.t.label))
    .slice(0, 30);

  // Honesty: when nothing genuinely matches the query tokens we return
  // nothing — never fabricate results for unrelated releases.
  if (!scored.length) return [];

  return scored.map(({ t, title, relevance }) =>
    normalizeResult(
      {
        itemId: t.url,
        title,
        category: 'apps',
        sizeBytes: t.size,
        uploadedAt: null,
        // Ubuntu hosts the ISO next to its .torrent in the same directory,
        // so the direct file URL is the torrent URL minus the suffix.
        // (Debian's bt-cd/ dirs hold only torrents — no direct ISO there.)
        fileUrl: /^https:\/\/releases\.ubuntu\.com\//i.test(t.url)
          ? t.url.replace(/\.torrent$/i, '')
          : null,
        torrentUrl: t.url,
        pageUrl: t.url,
        relevance,
      },
      ENGINE
    )
  );
}

module.exports = { engine: ENGINE, search, parseListing, parseSize, listingUrls, pickReleaseDirs, torrentRowsWithSizes, collectTorrents };
