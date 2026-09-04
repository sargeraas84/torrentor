'use strict';
// ---------------------------------------------------------------------
// Torrentor icon generator — zero dependencies, pure Node.
// Produces resources/icon.ico (16/24/32/48/64/128/256) plus PNGs, all
// derived from one supersampled, anti-aliased drawing routine.
//
// The mark: a dark rounded tile with a cyan→emerald neon ring and a
// magnet — a U whose two legs point down with bright pole tips. "Torrent
// + magnetic", readable at 16px.
//
// Also emits macOS menu-bar template images (black alpha masks named
// trayTemplate.png / trayTemplate@2x.png) so the mark renders crisply in
// the macOS menu bar at every DPI.
//
// Runs automatically during `npm run build`; safe to re-run anytime.
// ---------------------------------------------------------------------

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'resources');
const ICONS = path.join(RES, 'icons');

// ----------------------------- PNG encoder -----------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ----------------------------- ICO encoder -----------------------------
function encodeICO(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach((e, i) => {
    const d = dir.slice(i * 16, i * 16 + 16);
    d[0] = e.size >= 256 ? 0 : e.size;
    d[1] = e.size >= 256 ? 0 : e.size;
    d[2] = 0;
    d[3] = 0;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(e.png.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ------------------------------ Drawing --------------------------------
function hexToRgb(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const qx = Math.abs(px - (x0 + x1) / 2) - (x1 - x0) / 2 + r;
  const qy = Math.abs(py - (y0 + y1) / 2) - (y1 - y0) / 2 + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Coverage for a shape: 1 inside, 0 outside, ~1px smooth edge. */
function cover(d) {
  return Math.min(1, Math.max(0, 0.5 - d));
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function grad(a, b, t) {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

/** Signed distance from a point to a ring band (annulus tube). */
function sdTube(px, py, cx, cy, midR, halfW) {
  return Math.abs(Math.hypot(px - cx, py - cy) - midR) - halfW;
}

/**
 * Render the mark at `size`px. When `mono` is set, every shape is painted
 * opaque black so the result is a pure alpha mask — the macOS menu-bar
 * template-image format (the system tints it for light/dark menu bars and
 * scales it crisply at every DPI via the @2x variant).
 */
function renderIcon(size, ss, mono) {
  const SS = ss || 4;
  const S = size * SS;
  const acc = new Float32Array(S * S * 4);
  const u = SS;
  const monoCol = [0, 0, 0];

  const cyan = hexToRgb('#22d3ee');
  const teal = hexToRgb('#2dd4bf');
  const emerald = hexToRgb('#34d399');
  const white = hexToRgb('#f8fafc');
  const darkTop = hexToRgb('#0d1526');
  const darkBot = hexToRgb('#060a13');
  const tiny = size < 48;

  // tile geometry
  const inset = size * 0.06 * u;
  const radius = size * 0.22 * u;
  const borderW = size * (tiny ? 0.09 : 0.055) * u;
  const tileX0 = inset;
  const tileY0 = inset;
  const tileX1 = size * u - inset;
  const tileY1 = size * u - inset;

  // magnet geometry (opening downward, like the classic glyph)
  const barW = size * (tiny ? 0.135 : 0.115) * u;
  const barHalf = barW / 2;
  const barTop = size * (tiny ? 0.30 : 0.28) * u;
  const barBot = size * 0.80 * u;
  const legL = size * 0.5 * u - size * (tiny ? 0.175 : 0.19) * u; // left leg centre x
  const legR = size * 0.5 * u + size * (tiny ? 0.175 : 0.19) * u; // right leg centre x
  const arcCx = size * 0.5 * u;
  const arcCy = barTop;
  const arcMid = size * (tiny ? 0.165 : 0.19) * u;
  const arcHalf = barHalf * 1.05;
  const tipH = size * (tiny ? 0.20 : 0.17) * u; // bright pole tip height

  const bodyT0 = barTop;
  const bodyT1 = barBot;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let a = 0;

      const paint = (cov, rgb) => {
        if (cov <= 0) return;
        if (mono) rgb = monoCol; // alpha mask only — macOS tints it
        const keep = 1 - cov;
        pr = rgb[0] * cov + pr * keep;
        pg = rgb[1] * cov + pg * keep;
        pb = rgb[2] * cov + pb * keep;
        a = cov + a * keep;
      };

      // 1) neon ring — gradient cyan (top) → emerald (bottom)
      const frameA = cover(sdRoundRect(px, py, tileX0, tileY0, tileX1, tileY1, radius));
      if (frameA > 0) {
        const t = clamp01((py - tileY0) / (tileY1 - tileY0));
        paint(frameA, grad(cyan, emerald, t));
      }

      // 2) dark interior
      const inA = cover(
        sdRoundRect(px, py, tileX0 + borderW, tileY0 + borderW, tileX1 - borderW, tileY1 - borderW, Math.max(0, radius - borderW))
      );
      if (inA > 0) {
        const t = clamp01((py - tileY0) / (tileY1 - tileY0));
        paint(inA, grad(darkTop, darkBot, t));
      }

      // 3) magnet body: top arc band + two legs (cyan → teal down the body)
      const bodyCol = grad(cyan, teal, clamp01((py - bodyT0) / (bodyT1 - bodyT0)));
      const arcA = py <= arcCy + arcHalf ? cover(sdTube(px, py, arcCx, arcCy, arcMid, arcHalf)) : 0;
      const leftLegA = cover(sdRoundRect(px, py, legL - barHalf, barTop, legL + barHalf, barBot, barHalf));
      const rightLegA = cover(sdRoundRect(px, py, legR - barHalf, barTop, legR + barHalf, barBot, barHalf));
      const bodyA = Math.max(arcA, Math.max(leftLegA, rightLegA));
      if (bodyA > 0) paint(bodyA, bodyCol);

      // 4) pole tips: bright caps on the bottom of both legs
      const tipY0 = barBot - tipH;
      const leftTipA = cover(sdRoundRect(px, py, legL - barHalf + size * 0.012 * u, tipY0, legL + barHalf - size * 0.012 * u, barBot - size * 0.01 * u, barHalf * 0.8));
      const rightTipA = cover(sdRoundRect(px, py, legR - barHalf + size * 0.012 * u, tipY0, legR + barHalf - size * 0.012 * u, barBot - size * 0.01 * u, barHalf * 0.8));
      const tipA = Math.max(leftTipA, rightTipA);
      if (tipA > 0) paint(tipA, white);

      const idx = (y * S + x) * 4;
      acc[idx] = pr;
      acc[idx + 1] = pg;
      acc[idx + 2] = pb;
      acc[idx + 3] = a;
    }
  }

  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const idx = ((y * SS + sy) * S + (x * SS + sx)) * 4;
          sr += acc[idx];
          sg += acc[idx + 1];
          sb += acc[idx + 2];
          sa += acc[idx + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = sa > 0 ? Math.round(sr / sa) : 0;
      out[o + 1] = sa > 0 ? Math.round(sg / sa) : 0;
      out[o + 2] = sa > 0 ? Math.round(sb / sa) : 0;
      out[o + 3] = Math.round((sa / n) * 255);
    }
  }
  return { size, png: encodePNG(size, size, out) };
}

// ------------------------------ Entry point ----------------------------
function main() {
  fs.mkdirSync(ICONS, { recursive: true });

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const rendered = sizes.map((s) => renderIcon(s, 4));

  const ico = encodeICO(rendered);
  fs.writeFileSync(path.join(RES, 'icon.ico'), ico);

  const png256 = rendered.find((r) => r.size === 256);
  const png32 = rendered.find((r) => r.size === 32);
  // 512px macOS app icon (electron-builder converts it to .icns).
  // Supersample 2x to keep the build fast; the flat-shaded mark scales cleanly.
  const png512 = renderIcon(512, 2);
  // macOS menu-bar template images: 16pt (@1x) + 32px (@2x), black alpha masks.
  // Electron/NSImage picks up the @2x sibling automatically for retina menu bars.
  const tpl1x = renderIcon(16, 4, true);
  const tpl2x = renderIcon(32, 4, true);
  fs.writeFileSync(path.join(ICONS, 'app.png'), png512.png);
  fs.writeFileSync(path.join(ICONS, 'tray.png'), png32.png);
  fs.writeFileSync(path.join(ICONS, 'trayTemplate.png'), tpl1x.png);
  fs.writeFileSync(path.join(ICONS, 'trayTemplate@2x.png'), tpl2x.png);
  fs.writeFileSync(path.join(RES, 'torrentor-mark.png'), png256.png);

  console.log('[generate-icon] wrote resources/icon.ico (16/24/32/48/64/128/256) + icons/app.png (512), tray.png, trayTemplate.png(+@2x), torrentor-mark.png');
}

main();
