'use strict';
// ---------------------------------------------------------------------
// Torrentor — shared formatting + classification helpers.
// Pure Node (no Electron), so scripts/smoke-test.js can require it and
// esbuild can bundle it into the renderer.
// ---------------------------------------------------------------------

/** Human bytes: 1536 -> "1.5 KB". Returns "—" for null/undefined. */
function formatBytes(n) {
  if (n === null || n === undefined || !isFinite(n) || n < 0) return '—';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  const fixed = v >= 100 ? String(Math.round(v)) : v.toFixed(v >= 10 ? 1 : 2).replace(/\.?0+$/, '');
  return `${fixed} ${units[i]}`;
}

/** Compact number: 12345 -> "12.3k" */
function formatCompact(n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  const one = (v) => String(v.toFixed(1)).replace(/\.?0+$/, '');
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${one(n / 1e3)}k`;
  if (n < 1e9) return `${one(n / 1e6)}M`;
  return `${one(n / 1e9)}B`;
}

/** Relative time from epoch ms (or Date). */
function relativeTime(ts) {
  if (!ts) return '';
  const d = ts instanceof Date ? ts.getTime() : ts;
  const diff = Date.now() - d;
  const min = 60e3;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return 'just now';
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  const date = new Date(d);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

const EXT_MAP = {
  mp4: 'video', mkv: 'video', avi: 'video', mov: 'video', wmv: 'video', flv: 'video', webm: 'video', m4v: 'video', mpg: 'video', mpeg: 'video', ts: 'video', vob: 'video', ogv: 'video',
  mp3: 'audio', flac: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', aac: 'audio', m4a: 'audio', wma: 'audio', opus: 'audio', ape: 'audio',
  exe: 'apps', msi: 'apps', appimage: 'apps', deb: 'apps', rpm: 'apps', apk: 'apps', dmg: 'apps', pkg: 'apps', iso: 'apps', zip: 'apps', rar: 'apps', '7z': 'apps', tar: 'apps', gz: 'apps', xz: 'apps', nupkg: 'apps', dll: 'apps',
  pdf: 'documents', epub: 'documents', mobi: 'documents', djvu: 'documents', doc: 'documents', docx: 'documents', txt: 'documents', md: 'documents',
};

const KEYWORD_MAP = [
  ['games', ['ps4', 'ps5', 'xbox', 'switch', 'nsp', 'xci', 'repack', 'fitgirl', 'dodi', 'steam', 'gog', 'rom', 'roms', 'nes', 'snes', 'nds', '3ds', 'gba', 'iso-game']],
  ['apps', ['windows', 'macos', 'linux', 'ubuntu', 'debian', 'fedora', 'arch', 'mint', 'kali', 'android', 'ios', 'apk', 'portable', 'crack', 'patch', 'software', 'os ', 'iso', 'installer', 'amd64', 'x64', 'arm64', 'dvd', 'bluray-rip-software']],
  ['video', ['1080p', '720p', '2160p', '4k', 'bluray', 'blu-ray', 'web-dl', 'webdl', 'webrip', 'hdtv', 'x264', 'x265', 'hevc', 'h264', 'avc', 'remux', 'dvdrip', 'hdr', 'dolby', 'yify', 'proper', 'repack-video', 'season', 's01', 'episode', 'ep ', 'e01', 'documentary', 'movie', 'film', 'series', 'trailer']],
  ['audio', ['flac', 'mp3', '320kbps', 'lossless', 'album', 'audiobook', 'soundtrack', 'ost', 'remaster', 'vinyl', 'live', 'bootleg', 'mixtape', 'ep ']],
  ['documents', ['pdf', 'epub', 'book', 'ebook', 'magazine', 'manual', 'tutorial', 'course', 'packt', 'oreilly', 'comic', 'manga', 'novel', 'textbook', 'paper', 'thesis']],
];

/**
 * Guess a category for a result. `hints` may include mediatype-like
 * strings (e.g. Archive.org "movies" / "audio" / "texts" / "software").
 * Extension wins, then hints, then keyword scoring.
 */
function categorizeTitle(title, hints) {
  const name = String(title || '');
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (EXT_MAP[ext]) return EXT_MAP[ext];
  const hintText = (hints || []).join(' ').toLowerCase();
  const hintMap = { movies: 'video', audio: 'audio', music: 'audio', etree: 'audio', texts: 'documents', software: 'apps', data: 'other', image: 'other' };
  for (const [key, cat] of Object.entries(hintMap)) {
    if (hintText.includes(key)) return cat;
  }
  const hay = ` ${name.toLowerCase()} `;
  let best = { cat: 'other', score: 0 };
  for (const [cat, words] of KEYWORD_MAP) {
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += w.length >= 5 ? 2 : 1;
    if (score > best.score) best = { cat, score };
  }
  return best.cat;
}

/** Stable deterministic pseudo-random from a string (for demo seeders etc). */
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

module.exports = {
  formatBytes,
  formatCompact,
  relativeTime,
  categorizeTitle,
  hashSeed,
};
