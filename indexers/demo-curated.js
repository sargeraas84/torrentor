'use strict';
// ---------------------------------------------------------------------
// Torrentor — Demo engine (offline).
//
// A small, clearly-labeled sample corpus so the whole search → merge →
// magnet flow works with zero network. Every entry is marked demo and
// the infohashes are synthetic (deterministic, but NOT real torrents) —
// the UI shows a "Demo" badge on these cards so nobody mistakes them
// for downloadable content.
// ---------------------------------------------------------------------

const { normalizeResult, queryTokens, tokenHitScore } = require('./base');
const { hashSeed } = require('../lib/format');
const { normalizeInfohash } = require('../lib/magnet');

const ENGINE = {
  id: 'demo-curated',
  name: 'Demo index',
  tagline: 'Offline sample corpus — always works, clearly labeled. Infohashes are synthetic.',
  kind: 'demo',
  demo: true,
};

// [title, category, sizeBytes, keywords, uploadedAtDaysAgo]
const CATALOG = [
  ['Ubuntu 24.04.1 LTS Desktop (Noble Numbat) — official ISO', 'apps', 5.6 * 1024 ** 3, ['ubuntu', 'linux', 'iso', 'os', '24.04', 'desktop', 'official'], 40],
  ['Debian 12.5 netinst amd64 — official CD image', 'apps', 650 * 1024 ** 2, ['debian', 'linux', 'netinst', 'installer'], 60],
  ['Fedora Workstation 40 Live amd64 — official release', 'apps', 2.1 * 1024 ** 3, ['fedora', 'linux', 'workstation', 'live'], 80],
  ['Big Buck Bunny (2008) — Blender open movie, 1080p', 'video', 1.4 * 1024 ** 3, ['big buck bunny', 'blender', 'movie', '1080p', 'open movie', 'cc'], 500],
  ['Sintel (2010) — Blender open movie, 4K', 'video', 2.6 * 1024 ** 3, ['sintel', 'blender', '4k', 'short film'], 420],
  ['Tears of Steel (2012) — Blender open movie, 1080p', 'video', 1.9 * 1024 ** 3, ['tears of steel', 'blender', 'sci-fi'], 380],
  ['Spring (2019) — Blender open movie, 4K HDR', 'video', 3.1 * 1024 ** 3, ['spring', 'blender', '4k', 'hdr'], 160],
  ['Elephants Dream (2006) — Blender open movie', 'video', 780 * 1024 ** 2, ['elephants dream', 'blender'], 700],
  ['NASA Apollo 11 4K restoration — public domain', 'video', 4.2 * 1024 ** 3, ['nasa', 'apollo 11', '4k', 'space', 'documentary', 'public domain'], 300],
  ['Prelinger Archives: "A Trip Down Market Street" (1906)', 'video', 340 * 1024 ** 2, ['prelinger', 'archive', '1906', 'san francisco'], 900],
  ['Internet Archive: LibreOffice 24.2 portable (win64)', 'apps', 480 * 1024 ** 2, ['libreoffice', 'portable', 'office'], 90],
  ['GIMP 2.10.38 installer for Windows (official)', 'apps', 250 * 1024 ** 2, ['gimp', 'image editor'], 100],
  ['Blender 4.2 LTS installer for Windows (official)', 'apps', 310 * 1024 ** 2, ['blender', '3d', 'installer'], 30],
  ['Kevin MacLeod — "Fluffing a Duck" (CC-BY, lossless)', 'audio', 28 * 1024 ** 2, ['kevin macleod', 'fluffing a duck', 'cc', 'royalty free'], 650],
  ['Chad Crouch — "Path to the Sun" (CC-BY, FLAC)', 'audio', 52 * 1024 ** 2, ['chad crouch', 'path to the sun', 'flac', 'podington bear'], 400],
  ['Project Gutenberg: Moby Dick audiobook (PD)', 'audio', 240 * 1024 ** 2, ['moby dick', 'audiobook', 'gutenberg', 'public domain'], 550],
  ['OpenStax "College Algebra" textbook PDF (CC)', 'documents', 120 * 1024 ** 2, ['openstax', 'college algebra', 'textbook', 'pdf', 'math'], 350],
  ['Wikipedia EN dumps (2025-05) — full-text XML', 'documents', 92 * 1024 ** 3, ['wikipedia', 'dump', 'dataset', 'xml'], 20],
  ['Wikimedia Commons: "The Blue Marble" hi-res (PD)', 'other', 46 * 1024 ** 2, ['blue marble', 'earth', 'photo', 'public domain'], 200],
  ['SuperTuxKart 1.4 — open-source kart racer (win64)', 'games', 700 * 1024 ** 2, ['supertuxkart', 'kart racer', 'open source', 'game'], 120],
  ['Xonotic 0.8.6 — open-source arena FPS (full)', 'games', 1.1 * 1024 ** 3, ['xonotic', 'fps', 'open source', 'game'], 90],
  ['0 A.D. Alpha 26 — open-source RTS (win64 installer)', 'games', 1.6 * 1024 ** 3, ['0 a.d.', 'rts', 'open source', 'empire earth'], 140],
];

function fakeInfohash(title) {
  // 40 hex chars, deterministic per title, clearly non-functional.
  const seed = hashSeed(`torrentor-demo|${title}`);
  const a = (seed >>> 0).toString(16).padStart(8, '0');
  const b = (Math.imul(seed, 2654435761) >>> 0).toString(16).padStart(8, '0');
  const c = (Math.imul(seed, 2246822519) >>> 0).toString(16).padStart(8, '0');
  const d = (Math.imul(seed, 3266489917) >>> 0).toString(16).padStart(8, '0');
  const e = ((seed ^ 0x85ebca6b) >>> 0).toString(16).padStart(8, '0');
  const f = ((seed ^ 0xc2b2ae35) >>> 0).toString(16).padStart(8, '0');
  return normalizeInfohash(`${a}${b}${c}${d}${e}${f}`.slice(0, 40));
}

async function search(query, ctx) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const tokens = queryTokens(q);
  const out = [];
  for (let i = 0; i < CATALOG.length; i++) {
    const [title, category, sizeBytes, keywords, daysAgo] = CATALOG[i];
    const titleScore = tokenHitScore(q, `${title} ${keywords.join(' ')}`);
    if (titleScore <= 0 && !keywords.some((k) => tokens.some((t) => k.includes(t)))) continue;
    const ih = fakeInfohash(title);
    const seed = hashSeed(`seeder|${title}`);
    out.push(
      normalizeResult(
        {
          itemId: `demo-${i + 1}`,
          title,
          category,
          sizeBytes,
          seeders: 2 + (seed % 900),
          leechers: 1 + (seed % 60),
          uploadedAt: Date.now() - daysAgo * 86400e3,
          infohash: ih,
          thumbnail: null,
          demo: true,
          relevance: titleScore,
        },
        ENGINE
      )
    );
  }
  return out.sort((a, b) => b.relevance - a.relevance).slice(0, 40);
}

module.exports = { engine: ENGINE, search, fakeInfohash };
