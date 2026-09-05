'use strict';
// ---------------------------------------------------------------------
// Torrentor — per-source download tallies (pure helpers).
//
// Lifetime per-source tallies ({ count, bytes }) shown on the Library
// views, extended with a bounded, timestamped `events` list so the panel
// can also answer "this week" / "this month". Zero dependencies — this
// module is required by BOTH the main-process manager (lib/downloads)
// and the renderer bundle (LibraryView), so it must stay dependency-free.
//
// Retention: at most RETAIN_EVENTS completions per source, and events
// older than RETAIN_DAYS are pruned — the tallies stay bounded forever
// while lifetime counters keep their exact totals.
// ---------------------------------------------------------------------

const RETAIN_EVENTS = 200; // max events kept per source
const RETAIN_DAYS = 90; // events older than this are dropped
const WEEK_MS = 7 * 24 * 3600 * 1000;
const MONTH_MS = 30 * 24 * 3600 * 1000;

/**
 * Coerce a persisted/seed tally object into the canonical shape
 * { engineId: { count, bytes, events: [{ ts, bytes }] } }. Missing or
 * malformed fields are normalized away; old-format records (no events)
 * gain an empty list.
 */
function normalizeStats(seed) {
  const out = {};
  if (!seed || typeof seed !== 'object') return out;
  for (const [k, v] of Object.entries(seed)) {
    if (!v || typeof v !== 'object') continue;
    const count = Math.max(0, Math.floor(Number(v.count) || 0));
    const bytes = Math.max(0, Math.floor(Number(v.bytes) || 0));
    const events = Array.isArray(v.events)
      ? v.events
          .filter((e) => e && Number.isFinite(Number(e.bytes)) && Number.isFinite(Number(e.ts)))
          .map((e) => ({ ts: Math.floor(Number(e.ts)), bytes: Math.max(0, Math.floor(Number(e.bytes))) }))
      : [];
    if (count > 0 || bytes > 0 || events.length) out[String(k)] = { count, bytes, events: pruneEvents(events) };
  }
  return out;
}

/** Drop events outside the retention window, newest first. */
function pruneEvents(events) {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 3600 * 1000;
  return events.filter((e) => e.ts >= cutoff).slice(0, RETAIN_EVENTS);
}

/** Credit one completed download: bump lifetime counters + push an event. */
function addEvent(stats, engineId, bytes) {
  const rec = stats[engineId] || { count: 0, bytes: 0, events: [] };
  const n = Math.max(0, Math.floor(Number(bytes) || 0));
  rec.count += 1;
  rec.bytes += n;
  rec.events = pruneEvents([{ ts: Date.now(), bytes: n }, ...rec.events]).slice(0, RETAIN_EVENTS);
  stats[engineId] = rec;
  return rec;
}

/**
 * Aggregate tallies for a period: 'all' (lifetime counters), 'week' or
 * 'month' (summed from timestamped events). Returns the same
 * { engineId: { count, bytes } } shape for every period so the panel
 * renders uniformly.
 */
function statsForPeriod(stats, period) {
  const out = {};
  const windowMs = period === 'week' ? WEEK_MS : period === 'month' ? MONTH_MS : null;
  const now = Date.now();
  for (const [k, rec] of Object.entries(stats || {})) {
    if (!rec || typeof rec !== 'object') continue;
    if (windowMs == null) {
      out[k] = { count: rec.count || 0, bytes: rec.bytes || 0 };
    } else {
      let count = 0;
      let bytes = 0;
      for (const e of rec.events || []) {
        if (e && now - e.ts <= windowMs) {
          count += 1;
          bytes += e.bytes || 0;
        }
      }
      out[k] = { count, bytes };
    }
  }
  return out;
}

/**
 * Render aggregated rows as CSV text for the panel's "Copy" button.
 * rows: [{ source, count, bytes }] (already resolved to display names and
 * filtered to the selected period). Bytes are raw integers so a paste
 * into a spreadsheet stays machine-usable; a Total row is appended.
 * Pure and dependency-free so it is unit-testable from the Node suite.
 */
function statsCsv(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && r.source != null) : [];
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const countOf = (r) => Math.max(0, Math.floor(Number(r.count) || 0));
  const bytesOf = (r) => Math.max(0, Math.floor(Number(r.bytes) || 0));
  const lines = ['Source,Files,Bytes'];
  for (const r of list) lines.push(`${esc(r.source)},${countOf(r)},${bytesOf(r)}`);
  if (list.length) {
    const totalCount = list.reduce((s, r) => s + countOf(r), 0);
    const totalBytes = list.reduce((s, r) => s + bytesOf(r), 0);
    lines.push(`Total,${totalCount},${totalBytes}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = { normalizeStats, addEvent, statsForPeriod, statsCsv, RETAIN_EVENTS, RETAIN_DAYS };