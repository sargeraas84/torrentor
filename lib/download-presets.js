'use strict';
// ---------------------------------------------------------------------
// Download speed-limit presets (bytes/second), shared by the per-transfer
// tray control and the Settings → default limit select so the two can
// never drift. 0 = unlimited.
// ---------------------------------------------------------------------

const fmt = require('./format');

const LIMIT_PRESETS = [0, 100 * 1024, 256 * 1024, 512 * 1024, 1024 * 1024];

/** Next preset after `current` (wraps from the last back to unlimited). */
function nextPreset(current) {
  const v = Number(current) || 0;
  let i = LIMIT_PRESETS.indexOf(v);
  if (i < 0) i = 0; // out-of-band value → wrap from unlimited
  return LIMIT_PRESETS[(i + 1) % LIMIT_PRESETS.length];
}

/** Compact tray label: '∞' (unlimited) or '100KB/s'. */
function limitLabel(bps) {
  const v = Number(bps) || 0;
  return v > 0 ? `${fmt.formatBytes(v).replace(/\s+/g, '')}/s` : '∞';
}

/** Human option labels for the Settings select: 'Unlimited', '100 KB/s', … */
function limitOptionLabel(bps) {
  const v = Number(bps) || 0;
  return v > 0 ? fmt.formatBytes(v).replace(/\.0\s/, ' ') + '/s' : 'Unlimited';
}

module.exports = { LIMIT_PRESETS, nextPreset, limitLabel, limitOptionLabel };
