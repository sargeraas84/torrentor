'use strict';
// ---------------------------------------------------------------------
// Torrentor — magnet URI helpers (pure Node).
// ---------------------------------------------------------------------

const INFOHASH_V1_HEX = /^[0-9a-f]{40}$/i;

const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Decode a base32 string into a Buffer (RFC 4648, no padding). */
function base32Decode(input) {
  const clean = String(input).replace(/=+$/, '').toLowerCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Normalize any infohash-ish input to a lowercase 40-hex v1 infohash.
 * Accepts 40-hex, 32-char base32 (as seen in magnet xt=urn:btih:), or a
 * magnet URI / btih: prefix. Returns null when unparseable.
 */
function normalizeInfohash(value) {
  if (!value) return null;
  let v = String(value).trim();
  const m = v.match(/btih:([0-9a-zA-Z]{32,40})/i);
  if (m) v = m[1];
  if (INFOHASH_V1_HEX.test(v)) return v.toLowerCase();
  if (v.length === 32) {
    try {
      const bytes = base32Decode(v);
      if (bytes.length === 20) return bytes.toString('hex');
    } catch {
      /* fallthrough */
    }
  }
  return null;
}

const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'https://tracker.tamersunion.org:443/announce',
];

/** Build a magnet:?xt=urn:btih:<ih>&dn=<name>&tr=... URI. */
function buildMagnet({ infoHash, name, trackers = DEFAULT_TRACKERS }) {
  const ih = normalizeInfohash(infoHash);
  if (!ih) throw new Error('A valid 40-hex (or 32-char base32) infohash is required to build a magnet.');
  const parts = [`magnet:?xt=urn:btih:${ih}`];
  if (name) parts.push(`dn=${encodeURIComponent(String(name).slice(0, 300))}`);
  for (const tr of trackers || []) {
    if (tr) parts.push(`tr=${encodeURIComponent(tr)}`);
  }
  return parts.join('&');
}

/** Parse a magnet URI into { infoHash, name, trackers }. */
function parseMagnet(uri) {
  if (!uri || !String(uri).startsWith('magnet:?')) return null;
  const params = new URLSearchParams(String(uri).slice('magnet:?'.length));
  const xt = params.getAll('xt').find((x) => x.startsWith('urn:btih:'));
  const infoHash = normalizeInfohash(xt ? xt.slice('urn:btih:'.length) : '');
  if (!infoHash) return null;
  return {
    infoHash,
    name: params.get('dn') || '',
    trackers: params.getAll('tr'),
  };
}

/** Whether a URL is safe for shell.openExternal from the app. */
function isSafeExternalUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'magnet:';
  } catch {
    return false;
  }
}

module.exports = { normalizeInfohash, buildMagnet, parseMagnet, isSafeExternalUrl, INFOHASH_V1_HEX };
