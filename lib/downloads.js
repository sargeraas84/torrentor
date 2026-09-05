'use strict';
// ---------------------------------------------------------------------
// Torrentor — download manager (main process only).
//
// Direct file downloads for sources that expose plain files over HTTP(S)
// (Internet Archive items, official distro ISOs, offline demo fixtures).
// Every transfer streams through lib/network.streamToFile, so the user's
// VPN/proxy route and the host allowlist apply exactly like search
// traffic. Torrent/magnet results are NOT downloaded here — they keep
// handing off to the user's own torrent client.
//
//  • Queue — at most MAX_ACTIVE transfers stream at once; the rest wait
//    with status 'queued' and start FIFO as slots free up. Queued entries
//    can be manually reordered (moveQueued); snapshot() reports them in
//    queue order with a queuePos for the UI.
//  • Resume — bytes always land in `<file>.part`; a retry of the same
//    URL auto-continues from the partial with an HTTP Range request.
//  • Persistence — in-flight (downloading/queued) transfers are exposed
//    via resumableSnapshot() for main to persist; restorePending() puts
//    them back in the queue on next launch so interrupted files resume.
//  • Speed limit — each transfer carries maxBytesPerSec (0 = unlimited);
//    the active stream's rate is read live per chunk, so changing it
//    mid-download takes effect immediately.
//  • Demo — URLs of the form `demo:<token>` generate a local sample file
//    (clearly labeled) so the whole flow works with zero network.
// ---------------------------------------------------------------------

const fs = require('fs');
const network = require('./network');
const { normalizeStats, addEvent, statsForPeriod } = require('./dl-stats');

// Maximum simultaneous transfers streaming to disk.
const MAX_ACTIVE = 2;
// Maximum number of finished transfers kept for the UI.
const TRANSFER_LIMIT = 30;

const transfers = new Map(); // id -> transfer entry (incl. queued)
const controllers = new Map(); // id -> AbortController for the active stream
let waiting = []; // queue of ids whose status is 'queued' (FIFO, or eta-sorted with smart order)
let active = 0;
let idSeq = 1;
// Module-wide defaults applied to every NEW transfer (main sets these
// from Settings prefs / smoke mode). Per-transfer values always win.
let defaultSpeedLimit = 0; // bytes/sec, 0 = unlimited
let defaultAllowHosts = null; // host-allowlist override (smoke test loopback)
// Lifetime download tallies per source (engine id, 'other' for unmapped
// hosts), accumulated across sessions: main seeds these from storage at
// boot and persists statsSnapshot() alongside the transfer records. Each
// record carries a bounded, timestamped `events` list so the Library
// panel can aggregate by week/month (see lib/dl-stats).
let stats = {}; // engineId -> { count, bytes, events: [{ ts, bytes }] }
// Bandwidth-aware queue scheduling: when ON, the waiting queue is kept
// sorted by estimated finish time (smallest remaining bytes / rate first),
// so the fastest-finishing file starts next. When OFF, FIFO + manual
// reorder as before.
let smartOrder = false;
// Rolling bandwidth (bytes/sec) observed from live UNLIMITED streams
// (app-limited streams run at exactly their limit, so they say nothing
// about the network and never update this); smart order uses it as the
// assumed rate for transfers without their own measured history so its
// estimates are in seconds, not raw bytes.
let measuredBps = 0;

// ------------------------------------------------------- plan schedules
//
// A queue plan may carry an ACTIVE-WINDOW schedule (e.g. a 'night' plan
// throttling the whole queue to 100 KB/s between 23:00 and 07:00). The
// applied plan (set via setActivePlan on queuePlans:apply) arms it here:
// while the local clock is inside the window, EVERY transfer is capped at
// the schedule's bytesPerSec (its own lower limit still wins) — enforced
// live at the same per-chunk read that honors per-transfer limits.
let activePlanName = '';
let activePlanSchedule = null; // { from: 'HH:MM', to: 'HH:MM', bytesPerSec } | null
// Settings-level 'night mode': a GLOBAL clock-window speed cap that applies
// to every transfer regardless of which queue plan (if any) is armed. Both
// caps stack — the tighter one wins — but night mode needs no plan.
let globalSchedule = null; // { from: 'HH:MM', to: 'HH:MM', bytesPerSec } | null
// Last active-state seen by scheduleBoundaryTick (plan window vs night
// window), so main only broadcasts when a clock boundary actually flips.
let lastTickActive = { plan: false, night: false };
let tickInitialized = false;

/** 'HH:MM' (24h) → minutes-of-day, or null when malformed. */
function parseClock(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Is `minute` (minutes-of-day) inside the schedule's window? Overnight
 * windows wrap (23:00→07:00 stays active past midnight until 07:00); from
 * === to means a whole-day window (always active). End-exclusive at `to`.
 */
function scheduleWindowActive(schedule, minute) {
  const s = schedule || null;
  if (!s) return false;
  const from = parseClock(s.from);
  const to = parseClock(s.to);
  if (from == null || to == null) return false;
  const m = ((Number(minute) % 1440) + 1440) % 1440;
  if (from === to) return true; // whole-day window
  if (from < to) return m >= from && m < to;
  return m >= from || m < to;
}

/** Current local minutes-of-day (pure-Node tests call scheduleWindowActive with explicit minutes). */
function nowMinute() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/** The applied schedule's cap right now (0 = no window active / no schedule). */
function scheduleCapNow() {
  const s = activePlanSchedule;
  if (!s) return 0;
  if (!scheduleWindowActive(s, nowMinute())) return 0;
  return s.bytesPerSec;
}

/**
 * Set (or clear) the Settings-level night-mode schedule. Same window
 * semantics as a queue-plan schedule — while the local clock is inside it,
 * every transfer is capped at bytesPerSec — but it lives in prefs and needs
 * no queue plan. Returns the current state (see globalScheduleInfo).
 */
function setGlobalSchedule(schedule) {
  const s = schedule || null;
  const from = s ? parseClock(s.from) : null;
  const to = s ? parseClock(s.to) : null;
  const bps = s ? Math.max(0, Math.floor(Number(s.bytesPerSec) || 0)) : 0;
  globalSchedule = from != null && to != null && bps > 0 ? { from: s.from, to: s.to, bytesPerSec: bps } : null;
  if (smartOrder && waiting.length > 1) sortQueue(); // cap changes ETAs → re-rank
  return globalScheduleInfo();
}

/** Night-mode cap binding right now (0 = window inactive / not set). */
function globalCapNow() {
  const s = globalSchedule;
  if (!s) return 0;
  if (!scheduleWindowActive(s, nowMinute())) return 0;
  return s.bytesPerSec;
}

/** Night-mode state for the tray header hint + broadcasts. */
function globalScheduleInfo() {
  const capNow = globalCapNow();
  return {
    schedule: globalSchedule ? { from: globalSchedule.from, to: globalSchedule.to, bytesPerSec: globalSchedule.bytesPerSec } : null,
    windowActive: capNow > 0,
    capNow,
  };
}

/**
 * Which speed source is the BINDING cap for a transfer right now:
 * 'limit' (its own per-file limit), 'window' (the applied plan's schedule),
 * 'night' (the Settings night-mode schedule), or null (unlimited). Ties
 * resolve to the more specific source: own limit, then plan window, then
 * night mode.
 */
function bindingCap(t) {
  const own = Math.max(0, Math.floor(Number(t && t.maxBytesPerSec) || 0));
  const pc = scheduleCapNow();
  const nc = globalCapNow();
  let best = Infinity;
  let src = null;
  if (own > 0 && own <= best) {
    best = own;
    src = 'limit';
  }
  if (pc > 0 && pc < best) {
    best = pc;
    src = 'window';
  }
  if (nc > 0 && nc < best) {
    best = nc;
    src = 'night';
  }
  return src;
}

/**
 * Called by main on a clock tick: reports whether the active-state of any
 * window (applied plan schedule or night mode) changed since the last call
 * — so the UI hints (plan badge / night pill) flip at the window boundary
 * without waiting for a download to tick. Also seeds the comparison on the
 * first call.
 */
function scheduleBoundaryTick() {
  const state = { plan: scheduleCapNow() > 0, night: globalCapNow() > 0 };
  if (!tickInitialized) {
    tickInitialized = true;
    lastTickActive = state;
    return { changed: false, ...state };
  }
  const changed = state.plan !== lastTickActive.plan || state.night !== lastTickActive.night;
  lastTickActive = state;
  return { changed, ...state };
}

/** Reset runtime tick state (test isolation). */
function resetScheduleTicks() {
  tickInitialized = false;
  lastTickActive = { plan: false, night: false };
}

/**
 * Arm a queue plan as the CURRENT one (its name is surfaced on chips and
 * in the tray header) and, if it carries a schedule, enforce the
 * schedule's active-window cap on the WHOLE queue — every transfer is
 * throttled to no more than `bytesPerSec` while the clock is inside the
 * window (its own lower limit still wins). Passing null schedule disarms
 * a previously armed window; re-ranking happens because the cap changes
 * every queued file's effective ETA.
 */
function setActivePlan(name, schedule) {
  activePlanName = String(name || '').trim();
  const s = schedule || null;
  const from = s ? parseClock(s.from) : null;
  const to = s ? parseClock(s.to) : null;
  const bps = s ? Math.max(0, Math.floor(Number(s.bytesPerSec) || 0)) : 0;
  activePlanSchedule = from != null && to != null && bps > 0 ? { from: s.from, to: s.to, bytesPerSec: bps } : null;
  if (smartOrder && waiting.length > 1) sortQueue(); // cap changes ETAs → re-rank
  return { name: activePlanName, schedule: activePlanSchedule ? { from: s.from, to: s.to, bytesPerSec: bps } : null };
}

/** Drop the applied plan (name badge + any schedule cap). */
function clearActivePlan() {
  activePlanName = '';
  activePlanSchedule = null;
  if (smartOrder && waiting.length > 1) sortQueue();
  return true;
}

/** Name of the currently applied plan ('' when none). */
function activePlanNameOf() {
  return activePlanName;
}

/**
 * What the renderer needs to surface the applied plan: its name, the
 * schedule it armed (null when none), and whether the window cap is
 * binding RIGHT NOW (recomputed at read time — the tray header shows a
 * live 'throttling' hint when inside the window).
 */
function appliedPlanInfo() {
  const capNow = scheduleCapNow();
  return {
    name: activePlanName,
    schedule: activePlanSchedule ? { from: activePlanSchedule.from, to: activePlanSchedule.to, bytesPerSec: activePlanSchedule.bytesPerSec } : null,
    windowActive: capNow > 0,
    capNow,
  };
}

/**
 * The speed a transfer will ACTUALLY stream at now: its own limit (0 =
 * unlimited) additionally capped by whichever of the applied plan's
 * schedule window or the Settings night-mode window is active and tighter.
 * This is what stream pacing honors per chunk.
 */
function effectiveLimitBps(t) {
  const own = Math.max(0, Math.floor(Number(t && t.maxBytesPerSec) || 0));
  const pc = scheduleCapNow();
  const nc = globalCapNow();
  let best = own > 0 ? own : Infinity;
  if (pc > 0 && pc < best) best = pc;
  if (nc > 0 && nc < best) best = nc;
  return best === Infinity ? 0 : best;
}

/** Default speed limit (bytes/sec) for transfers started without an explicit one. */
function setDefaultSpeedLimit(bytesPerSec) {
  defaultSpeedLimit = Math.max(0, Math.floor(Number(bytesPerSec) || 0));
}

/** Host-allowlist override used when a transfer carries no explicit list. */
function setDefaultAllowHosts(list) {
  defaultAllowHosts = Array.isArray(list) && list.length ? list.slice() : null;
}

// -------------------------------------------------- bandwidth-aware queue
//
// Smart order: when enabled, the waiting queue is kept sorted by estimated
// seconds-to-finish (remaining bytes / rate), so the transfer that will
// finish first starts first. Files whose size is unknown (fresh HTTP
// transfers, whose Content-Length arrives only once they stream) sort
// AFTER known-size files, preserving arrival order among themselves.

/** Turn smart ordering on/off. Returns the new state. */
function setSmartOrder(on) {
  smartOrder = !!on;
  return smartOrder;
}

/**
 * Smart-order reasoning for a transfer, surfaced on its queued tray chip:
 * the estimated seconds-to-finish (null while the total size is unknown)
 * plus the rate and its basis — 'limit' (an enforced speed limit, exact),
 * 'measured' (this transfer's own learned bandwidth), 'shared' (the
 * rolling measurement from live unlimited streams), 'baseline' (a nominal
 * fallback) or 'size-unknown'. etaScore() derives the plain number from
 * this, so the queue and the UI always agree. remainingBytes/totalBytes are
 * the raw byte math behind the estimate, so a chip can show the size too.
 */
function etaDetail(t) {
  if (!t) return { etaSeconds: null, rateBps: 0, basis: 'size-unknown', remainingBytes: null, totalBytes: null };
  const limit = effectiveLimitBps(t);
  if (t.total == null || !(t.total > 0)) return { etaSeconds: null, rateBps: limit || 0, basis: 'size-unknown', remainingBytes: null, totalBytes: null };
  const remaining = Math.max(0, (t.total || 0) - (t.received || 0));
  let rate;
  let basis;
  if (limit > 0) {
    rate = limit;
    // Which cap is actually binding? Say so on the chip instead of
    // claiming the file chose that speed — 'window' is the applied plan's
    // schedule, 'night' the Settings night-mode schedule.
    basis = bindingCap(t) || 'limit';
  } else if (t.rateBps > 0) {
    rate = t.rateBps;
    basis = 'measured';
  } else if (measuredBps > 0) {
    rate = measuredBps;
    basis = 'shared';
  } else {
    rate = 102400;
    basis = 'baseline';
  }
  return { etaSeconds: remaining / rate, rateBps: rate, basis, remainingBytes: remaining, totalBytes: t.total };
}

/** Estimated seconds-to-finish for a queued transfer (Infinity = unknown). */
function etaScore(t) {
  const d = etaDetail(t);
  return d.etaSeconds == null ? Infinity : d.etaSeconds;
}

/**
 * Order a set of scored queue entries: fastest-finishing first, with
 * equal-ETA runs re-grouped by destination folder (same-folder files batch
 * together instead of interleaving by arrival; within a group arrival
 * order is preserved, and a strictly-earlier score is never demoted — only
 * genuine ties are touched). Shared by the live queue (sortQueue) and the
 * what-if preview, so a previewed order is exactly what Apply produces.
 * Entries carry { id, dir, score, at }; returns the ordered entries.
 */
function rankQueue(entries) {
  const scored = entries.slice().sort((a, b) => a.score - b.score || a.at - b.at);
  const out = [];
  for (let i = 0; i < scored.length; ) {
    let j = i;
    while (j < scored.length && scored[j].score === scored[i].score) j++;
    const run = scored.slice(i, j);
    if (run.length > 1) {
      const groups = [];
      const groupOf = new Map();
      for (const x of run) {
        if (!groupOf.has(x.dir)) {
          groupOf.set(x.dir, groups.length);
          groups.push([]);
        }
        groups[groupOf.get(x.dir)].push(x);
      }
      for (const g of groups) out.push(...g);
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out;
}

/**
 * Re-sort the waiting queue by eta when smart order is active.
 */
function sortQueue() {
  if (!smartOrder || waiting.length < 2) return;
  const idx = new Map(waiting.map((id, i) => [id, i]));
  const entries = waiting.map((id) => {
    const t = transfers.get(id);
    return { id, dir: (t && t.dir) || '', score: etaScore(t), at: idx.get(id) };
  });
  waiting = rankQueue(entries).map((x) => x.id);
}

/**
 * What-if queue preview: return the waiting queue exactly as it WOULD rank
 * under smart order if the given per-transfer speed limits were real —
 * without mutating anything. `limitsPatch` is { transferId: bytesPerSec };
 * ids not listed keep their current limit (0 = unlimited). Each row carries
 * the same fields a snapshot chip exposes (etaSeconds, etaRateBps,
 * etaBasis, etaRemaining, etaTotal) plus name/dir/current limit, in
 * preview order. Returns null when smart order is off (the order is then
 * simply the manual FIFO order).
 */
function previewQueueOrder(limitsPatch) {
  if (!smartOrder) return null;
  const patch = limitsPatch && typeof limitsPatch === 'object' ? limitsPatch : {};
  const idx = new Map(waiting.map((id, i) => [id, i]));
  const entries = [];
  for (const id of waiting) {
    const t = transfers.get(id);
    if (!t) continue;
    const patched = Number(patch[id]);
    const hypothetical = patched >= 0 ? Object.assign({}, t, { maxBytesPerSec: patched }) : t;
    const d = etaDetail(hypothetical);
    entries.push({
      id,
      name: t.name,
      dir: t.dir || '',
      limit: Math.max(0, Math.floor(Number(t.maxBytesPerSec) || 0)),
      // Same field names a snapshot chip exposes, so the popover renders
      // live rows and preview rows through one code path.
      etaSeconds: d.etaSeconds,
      etaRateBps: d.rateBps,
      etaBasis: d.basis,
      etaRemaining: d.remainingBytes,
      etaTotal: d.totalBytes,
      score: d.etaSeconds == null ? Infinity : d.etaSeconds,
      at: idx.get(id),
    });
  }
  return rankQueue(entries).map(({ score, at, ...row }) => row);
}

// -------------------------------------------------------- download stats
//
// Cumulative per-source tallies ({ count, bytes }) for the Library views.
// They are intentionally lifetime counters — clearFinished drops transfers
// from the tray, never from the stats.

/** Replace the in-memory tallies with a persisted seed (boot). */
function setStats(seed) {
  stats = normalizeStats(seed);
  return statsSnapshot();
}

/** Copy of the tallies for persistence (count/bytes/events). */
function statsSnapshot() {
  const out = {};
  for (const [k, v] of Object.entries(stats)) {
    out[k] = {
      count: v.count,
      bytes: v.bytes,
      events: (v.events || []).map((e) => ({ ts: e.ts, bytes: e.bytes })),
    };
  }
  return out;
}

/** Credit one completed download (called from runTransfer on 'done'). */
function recordStats(url, bytes) {
  const engineId = engineForUrl(url) || 'other';
  addEvent(stats, engineId, bytes);
}

function snapshot() {
  // Display order: active downloads first, then queued transfers in queue
  // order (top of the queue starts next), then finished transfers newest
  // first. Shallow copies carry a queuePos (-1 when not queued) for the UI.
  const qPos = new Map();
  waiting.forEach((id, i) => qPos.set(id, i));
  const running = [];
  const queued = [];
  const rest = [];
  const paused = [];
  for (const t of transfers.values()) {
    if (t.status === 'downloading') running.push(t);
    else if (t.status === 'queued' && qPos.has(t.id)) queued.push(t);
    else if (t.status === 'paused') paused.push(t);
    else rest.push(t);
  }
  running.sort((a, b) => b.startedAt - a.startedAt);
  queued.sort((a, b) => qPos.get(a.id) - qPos.get(b.id));
  paused.sort((a, b) => b.finishedAt - a.finishedAt);
  rest.sort((a, b) => b.startedAt - a.startedAt);
  return [...running, ...queued, ...paused, ...rest].slice(0, TRANSFER_LIMIT).map((t) => {
    const copy = Object.assign({}, t);
    copy.queuePos = qPos.has(t.id) ? qPos.get(t.id) : -1;
    // With smart order on, each queued chip explains WHY it sits where it
    // does — and each ACTIVE chip shows the live ETA its stream is
    // actually pacing to: the estimated time to finish and the speed
    // behind it (limit / measured / shared / assumed).
    if (smartOrder && (t.status === 'queued' || t.status === 'downloading')) {
      const d = etaDetail(t);
      copy.etaSeconds = d.etaSeconds;
      copy.etaRateBps = d.rateBps;
      copy.etaBasis = d.basis;
      copy.etaRemaining = d.remainingBytes;
      copy.etaTotal = d.totalBytes;
    }
    return copy;
  });
}

/**
 * Move a queued transfer one step earlier ('up') or later ('down') in the
 * queue. Returns the moved entry, or null when it is not queued / at an
 * edge / unknown. Emits a 'reorder' event through onEvent for the UI.
 */
function moveQueued(id, dir, onEvent) {
  const idx = waiting.indexOf(Number(id));
  if (idx < 0) return null;
  const target = dir === 'up' ? idx - 1 : dir === 'down' ? idx + 1 : -1;
  if (target < 0 || target >= waiting.length) return null;
  const [moved] = waiting.splice(idx, 1);
  waiting.splice(target, 0, moved);
  sortQueue(); // smart order re-applies; manual order sticks when it is off
  const t = transfers.get(moved);
  if (t && onEvent) onEvent(t, 'reorder');
  return t || null;
}

/**
 * Move a queued transfer to an absolute queue position (drag-and-drop).
 * The dragged item is spliced in at `toIndex` — dropping above/below a
 * sibling passes that sibling's queuePos, matching visual expectations.
 * Returns the moved entry, or null when it is not queued / unknown.
 */
function moveQueuedTo(id, toIndex, onEvent) {
  const idx = waiting.indexOf(Number(id));
  if (idx < 0) return null;
  const target = Math.max(0, Math.min(waiting.length - 1, Math.floor(Number(toIndex)) || 0));
  if (target === idx) return null;
  const [moved] = waiting.splice(idx, 1);
  waiting.splice(target, 0, moved);
  sortQueue(); // smart order re-applies; manual order sticks when it is off
  const t = transfers.get(moved);
  if (t && onEvent) onEvent(t, 'reorder');
  return t || null;
}

/**
 * Change a transfer's speed limit (bytes/second, 0 = unlimited). Applies
 * immediately to an active stream (the rate is read per chunk) and is
 * carried into a retry. Returns the updated entry, or null when unknown.
 */
function setSpeedLimit(id, bytesPerSec, onEvent) {
  const t = transfers.get(Number(id));
  if (!t) return null;
  t.maxBytesPerSec = Math.max(0, Math.floor(Number(bytesPerSec) || 0));
  // A changed limit changes the estimate — re-sort a smart-ordered queue.
  if (t.status === 'queued') sortQueue();
  if (onEvent) onEvent(t, 'limit');
  return t;
}

// ------------------------------------------------------- queue plans
//
// A queue plan is a saved what-if patch: per-transfer speed limits keyed
// by DESTINATION PATH (transfer ids are transient — a relaunch recreates
// transfers with fresh ids), so a plan can be recalled and re-applied
// whenever the same files are queued again.

/**
 * Normalize a what-if patch ({ transferId: bytesPerSec }) plus optional
 * folder rules ({ dir: bytesPerSec }) into stable plan entries
 * [{ filePath, bytesPerSec } | { dir, bytesPerSec }]. Unknown ids are
 * dropped, and a per-file entry is omitted when a folder rule already
 * pins that file to the same value — only genuine per-file overrides are
 * kept. A folder entry applies to EVERY file headed to that folder, so a
 * plan stays meaningful when new files are queued into it later.
 */
function planEntries(patch, folderPatch) {
  const out = [];
  const folders = folderPatch && typeof folderPatch === 'object' ? folderPatch : {};
  for (const [dir, bps] of Object.entries(folders)) {
    if (!dir) continue;
    out.push({ dir, bytesPerSec: Math.max(0, Math.floor(Number(bps) || 0)) });
  }
  for (const [id, bps] of Object.entries(patch || {})) {
    const t = transfers.get(Number(id));
    if (!t || !t.filePath) continue;
    const v = Math.max(0, Math.floor(Number(bps) || 0));
    if (t.dir && folders[t.dir] !== undefined && Math.max(0, Math.floor(Number(folders[t.dir]) || 0)) === v) continue;
    out.push({ filePath: t.filePath, bytesPerSec: v });
  }
  return out;
}

/**
 * Apply saved plan entries to the current transfers: a filePath entry
 * matches one transfer, a dir entry matches EVERY transfer headed to that
 * folder (queued, downloading or paused) — so a folder rule also covers
 * files queued into it after the plan was saved. Sets each listed file's
 * speed limit for real and re-sorts a smart-ordered queue. Returns how
 * many limits were applied (per-file overrides apply last, so they win).
 */
function applyPlanEntries(entries, onEvent) {
  let applied = 0;
  const touch = (t, bytesPerSec) => {
    if (!t || (t.status !== 'queued' && t.status !== 'downloading' && t.status !== 'paused')) return;
    t.maxBytesPerSec = Math.max(0, Math.floor(Number(bytesPerSec) || 0));
    if (t.status === 'queued') sortQueue(); // re-rank like any live limit change
    applied++;
    if (onEvent) onEvent(t, 'limit');
  };
  for (const e of entries || []) {
    if (!e) continue;
    if (e.dir) {
      for (const t of transfers.values()) {
        if (t.dir === e.dir) touch(t, e.bytesPerSec);
      }
    } else if (e.filePath) {
      touch([...transfers.values()].find((x) => x.filePath === e.filePath), e.bytesPerSec);
    }
  }
  return applied;
}

/** Suggested file name for a URL (last path segment, decoded + sanitized). */
function suggestedName(url) {
  try {
    const seg = decodeURIComponent(String(new URL(url).pathname).split('/').filter(Boolean).pop() || '');
    const clean = seg.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
    return clean || 'download';
  } catch {
    return 'download';
  }
}

// ------------------------------------------------------------- scheduler

/** Fresh transfer entry (status 'queued'; scheduler decides next). */
function makeEntry(url, destPath, extra) {
  const src = extra || {};
  const isDemo = /^demo:/i.test(String(url || ''));
  const maxBps = src.maxBytesPerSec === undefined || src.maxBytesPerSec === null ? defaultSpeedLimit : Math.max(0, Math.floor(Number(src.maxBytesPerSec) || 0));
  return {
    id: idSeq++,
    url: String(url),
    name: isDemo ? demoLabel(url) : suggestedName(url),
    demo: isDemo,
    dir: destPath ? destPath.slice(0, Math.max(0, destPath.lastIndexOf('/'), destPath.lastIndexOf('\\'))) : '',
    filePath: destPath || '',
    status: 'queued',
    received: 0,
    // Demo payloads know their exact size up front, which lets smart
    // ordering rank queued demo files by remaining size without a probe.
    total: isDemo ? demoPayload(url).length : null,
    speedBytesPerSec: 0,
    resumed: false,
    error: null,
    maxBytesPerSec: maxBps,
    // Own measured bandwidth from a previous stream of this file (seeded
    // on restore); 0 until the transfer actually streams and measures.
    rateBps: Math.max(0, Math.floor(Number(src.rateBps) || 0)),
    allowHosts: src.allowHosts || defaultAllowHosts || null,
    // Human note of WHY this destination folder was chosen (per-source
    // default vs last-used), set by main at start so chips can show it.
    folderRule: String(src.folderRule || '').slice(0, 80),
    startedAt: Date.now(),
    finishedAt: null,
  };
}

/**
 * Start a direct download of `url` into `destPath`. Returns the transfer
 * entry immediately (streaming happens in the background); transitions
 * are reported through onEvent(entry, kind) with kind one of
 * 'queued' | 'start' | 'progress' | 'done' | 'error'. Resolves nothing —
 * callers must not await completion.
 *
 * opts: { maxBytesPerSec, allowHosts } — initial speed limit (defaults to
 * the module-wide default set via setDefaultSpeedLimit/setDefaultAllowHosts)
 * and host-allowlist override for the stream.
 */
function startDownload(url, destPath, onEvent, opts) {
  const t = makeEntry(url, destPath, opts || {});
  const id = t.id;
  // Refuse duplicates of the same URL to the same destination.
  for (const other of transfers.values()) {
    if (other.status === 'queued' || other.status === 'downloading') {
      if (other.url === t.url && other.filePath === t.filePath) {
        t.status = 'error';
        t.error = 'Already downloading this file.';
        t.finishedAt = Date.now();
        transfers.set(id, t);
        if (onEvent) onEvent(t, 'error');
        return t;
      }
    }
  }
  transfers.set(id, t);
  if (active < MAX_ACTIVE) {
    active++;
    t.status = 'downloading';
    if (onEvent) onEvent(t, 'start');
    runTransfer(id, onEvent);
  } else {
    waiting.push(id);
    sortQueue();
    if (onEvent) onEvent(t, 'queued');
  }
  return t;
}

function pump(onEvent) {
  while (active < MAX_ACTIVE && waiting.length) {
    const id = waiting.shift();
    const t = transfers.get(id);
    if (!t || t.status !== 'queued') continue;
    t.status = 'downloading';
    active++;
    if (onEvent) onEvent(t, 'start');
    runTransfer(id, onEvent);
  }
}

function emit(t, onEvent, kind) {
  if (onEvent) onEvent(t, kind);
}

/**
 * Speed-throttled progress emitter (>=500ms between broadcasts). Each
 * tick also records the transfer's OWN measured bandwidth (rateBps,
 * smoothed): a transfer's true per-file speed is learned from how it
 * actually streams, and that history feeds smart-order estimates — for
 * this very transfer across a retry/restart (persisted via
 * resumableSnapshot) and for the queue as a whole. App-limited streams
 * run at exactly their limit, so they record the limit and never pollute
 * the shared network measurement.
 */
function throttled(onEvent, t) {
  let lastTick = Date.now();
  let lastBytes = 0;
  return (received, total) => {
    t.received = received;
    if (total != null) t.total = total;
    const now = Date.now();
    const dt = now - lastTick;
    if (dt >= 500) {
      const bps = ((received - lastBytes) * 1000) / dt;
      t.speedBytesPerSec = bps;
      const limit = effectiveLimitBps(t);
      if (limit > 0) {
        t.rateBps = limit; // app-limited: the limit (or window cap) IS the achieved rate
      } else {
        // True network speed, exponentially smoothed per transfer; the
        // shared measurement takes the latest unlimited value.
        t.rateBps = t.rateBps > 0 ? Math.round(t.rateBps * 0.7 + bps * 0.3) : Math.round(bps);
        measuredBps = t.rateBps;
      }
      lastTick = now;
      lastBytes = received;
      emit(t, onEvent, 'progress');
      // Measured speeds change ETAs — re-rank a smart-ordered queue as
      // streams progress (stable ties mean this is a cheap no-op when
      // nothing actually reorders).
      if (smartOrder && waiting.length > 1) sortQueue();
    }
  };
}

async function runTransfer(id, onEvent) {
  const t = transfers.get(id);
  const ac = new AbortController();
  controllers.set(id, ac);
  try {
    if (t.demo) {
      await writeDemoFile(t, ac.signal);
      t.status = 'done';
      t.finishedAt = Date.now();
      recordStats(t.url, t.received);
      emit(t, onEvent, 'done');
      return;
    }
    // Auto-resume: a leftover .part from an interrupted attempt is
    // continued with a Range request instead of starting over.
    const partPath = t.filePath + '.part';
    let resumeFrom = 0;
    try {
      if (fs.existsSync(partPath)) {
        const st = fs.statSync(partPath);
        if (st.size > 0) resumeFrom = st.size;
        else fs.unlinkSync(partPath);
      }
    } catch {
      resumeFrom = 0;
    }
    if (resumeFrom > 0) t.resumed = true;
    // Live effective limit (0 = unlimited) re-read each chunk — a per-file
    // speed limit AND/OR the applied plan's active-window cap both count.
    const limitBps = () => effectiveLimitBps(t);
    const streamOpts = {
      url: t.url,
      destPath: t.filePath,
      signal: ac.signal,
      resumeFrom,
      rateLimit: limitBps,
      onBytes: throttled(onEvent, t),
    };
    // Host-allowlist override (main sets a smoke-mode default that adds
    // loopback for the two-boot resume test).
    if (t.allowHosts) streamOpts.allowHosts = t.allowHosts;
    const out = await network.streamToFile(streamOpts);
    t.status = 'done';
    t.total = out.resumedFrom + out.bytes;
    t.received = t.total;
    t.speedBytesPerSec = 0;
    t.finishedAt = Date.now();
    recordStats(t.url, t.received);
    emit(t, onEvent, 'done');
  } catch (err) {
    const cancelled = String((err && err.message) || err) === 'cancelled';
    if (cancelled && t.status === 'paused') {
      // User paused mid-stream: the .part is kept and the slot freed. The
      // transfer stays parked — resumableSnapshot lists it with status
      // 'paused', so a relaunch restores it paused (a user pause is
      // respected) rather than auto-resuming it.
      t.error = null;
      t.speedBytesPerSec = 0;
      t.finishedAt = Date.now();
      emit(t, onEvent, 'paused');
    } else {
      t.status = cancelled ? 'cancelled' : 'error';
      t.error = cancelled ? null : String((err && err.message) || err).slice(0, 160);
      t.speedBytesPerSec = 0;
      t.finishedAt = Date.now();
      emit(t, onEvent, cancelled ? 'done' : 'error');
    }
  } finally {
    controllers.delete(id);
    active = Math.max(0, active - 1);
    pump(onEvent);
  }
}

/**
 * Re-queue a finished transfer (error/cancelled) under its ORIGINAL id
 * and destination. The leftover `.part` is picked up by runTransfer and
 * continued with an HTTP Range request, so an interrupted download
 * resumes instead of restarting. Returns the entry, or null when the
 * transfer is not retryable (still active or unknown).
 */
function retryDownload(id, onEvent) {
  const t = transfers.get(Number(id));
  if (!t || t.status === 'downloading' || t.status === 'queued') return null;
  t.status = 'queued';
  t.error = null;
  t.received = 0;
  t.total = null;
  t.speedBytesPerSec = 0;
  t.resumed = false; // runTransfer re-detects the .part and sets this
  t.startedAt = Date.now();
  t.finishedAt = null;
  emit(t, onEvent, 'queued');
  if (active < MAX_ACTIVE) {
    active++;
    t.status = 'downloading';
    emit(t, onEvent, 'start');
    runTransfer(id, onEvent);
  } else {
    waiting.push(id);
    sortQueue();
  }
  return t;
}

// ------------------------------------------------------- persistence
//
// In-flight transfers (downloading/queued) are meant to SURVIVE an app
// restart: main persists resumableSnapshot() and calls restorePending()
// at boot, so a download interrupted by quitting resumes from its .part
// (the new transfer re-derives the byte offset from the file on disk —
// never from stale bookkeeping). Finished/cancelled/failed transfers are
// deliberately NOT persisted: they have no automatic second life.

function resumeRecord(t) {
  return {
    url: t.url,
    filePath: t.filePath,
    demo: !!t.demo,
    maxBytesPerSec: t.maxBytesPerSec || 0,
    // The transfer's own measured speed (if it streamed before quitting)
    // survives the relaunch, so a restored queue is ranked by the speeds
    // actually observed last session rather than a generic guess.
    rateBps: Math.max(0, Math.floor(Number(t.rateBps) || 0)),
    folderRule: t.folderRule || '',
    status: t.status === 'paused' ? 'paused' : '',
  };
}

/**
 * Minimal records for the transfers that survive a restart: downloading /
 * queued entries auto-resume from their .part, and a user-paused entry is
 * persisted with status 'paused' so it parks again instead of resuming.
 * Finished/cancelled/failed transfers deliberately drop out — they have no
 * automatic second life. QUEUED records are emitted in start order (the
 * waiting queue's current order), so a drag-reordered queue resumes in
 * the exact order the user left it.
 */
function resumableSnapshot() {
  const out = [];
  const qPos = new Map(waiting.map((id, i) => [id, i]));
  const queued = [];
  for (const t of transfers.values()) {
    if (!t.filePath) continue;
    if (t.status === 'queued' && qPos.has(t.id)) {
      queued.push(t);
    } else if (t.status === 'downloading' || t.status === 'paused') {
      out.push(resumeRecord(t));
    }
  }
  queued.sort((a, b) => qPos.get(a.id) - qPos.get(b.id));
  for (const t of queued) out.push(resumeRecord(t));
  return out;
}

/**
 * Re-enqueue persisted in-flight transfers (status 'queued', destination
 * already approved — no save dialog) and pump the queue so up to
 * MAX_ACTIVE resume right away; the rest wait their turn.
 */
function restorePending(list, onEvent) {
  const arr = Array.isArray(list) ? list : [];
  for (const rec of arr) {
    if (!rec || !rec.url || !rec.filePath) continue;
    // A record may reference a destination already covered by a live entry
    // (e.g. a retry queued before the persisted snapshot was dropped).
    let dup = false;
    for (const other of transfers.values()) {
      if ((other.status === 'queued' || other.status === 'downloading') && other.url === rec.url && other.filePath === rec.filePath) {
        dup = true;
        break;
      }
    }
    if (dup) continue;
    const t = makeEntry(rec.url, rec.filePath, { maxBytesPerSec: rec.maxBytesPerSec, folderRule: rec.folderRule, rateBps: rec.rateBps });
    transfers.set(t.id, t);
    if (rec.status === 'paused') {
      // A user pause survives a restart: park the transfer (its .part stays
      // on disk) instead of letting it auto-resume. Resume is manual.
      t.status = 'paused';
      t.finishedAt = Date.now();
      if (onEvent) onEvent(t, 'paused');
    } else {
      waiting.push(t.id);
      if (onEvent) onEvent(t, 'queued');
    }
  }
  sortQueue();
  pump(onEvent);
  return arr.length;
}

function cancelDownload(id) {
  const t = transfers.get(id);
  if (!t) return null;
  if (t.status === 'queued') {
    const i = waiting.indexOf(id);
    if (i >= 0) waiting.splice(i, 1);
    transfers.delete(id);
    return t;
  }
  if (t.status === 'paused') {
    // Removing a paused transfer also drops its .part (its only purpose
    // was resuming this transfer, which is now being discarded).
    transfers.delete(id);
    if (t.filePath) {
      try {
        if (fs.existsSync(t.filePath + '.part')) fs.unlinkSync(t.filePath + '.part');
      } catch {
        /* best-effort */
      }
    }
    return t;
  }
  if (t.status !== 'downloading') return null;
  t.status = 'cancelled'; // transitional — the abort keeps the .part
  const ac = controllers.get(id);
  if (ac) ac.abort();
  return t;
}

/**
 * Pause a running transfer: the stream aborts, its .part is kept, and its
 * queue slot frees up for the next queued transfer. The transfer parks in
 * status 'paused' — resume it with retryDownload (continues via Range).
 */
function pauseDownload(id, onEvent) {
  const t = transfers.get(Number(id));
  if (!t || t.status !== 'downloading') return null;
  t.status = 'paused'; // transitional — runTransfer's catch finalizes it
  const ac = controllers.get(id);
  if (ac) ac.abort();
  return t;
}

/** Resume every paused transfer (each continues its .part via Range). */
function resumeAllPaused(onEvent) {
  const list = [...transfers.values()].filter((t) => t.status === 'paused');
  for (const t of list) retryDownload(t.id, onEvent);
  return list.length;
}

/** Remove every paused transfer, dropping their partials too. */
function removeAllPaused() {
  const list = [...transfers.values()].filter((t) => t.status === 'paused');
  for (const t of list) cancelDownload(t.id);
  return list.length;
}

/** Drop finished transfers from the list. Partial files of interrupted
 *  transfers are removed too (they were only useful for a visible retry). */
function clearFinished() {
  for (const [id, t] of transfers) {
    if (t.status === 'downloading' || t.status === 'queued') continue;
    if (t.status !== 'done' && t.filePath && fs.existsSync(t.filePath + '.part')) {
      try {
        fs.unlinkSync(t.filePath + '.part');
      } catch {
        /* best-effort */
      }
    }
    transfers.delete(id);
  }
}

function getDownload(id) {
  return transfers.get(id) || null;
}

// ------------------------------------------------------------ demo files
//
// Fully offline direct downloads: picking a demo item's "file" writes a
// clearly-labeled sample payload to the chosen location, so the picker →
// save-dialog → progress → done flow is exercisable with zero network.

// demo-content is a few hundred KB so a speed limit is actually observable
// (a paced playtest runs ~7s at the 100 KB/s preset instead of finishing
// before the tray can be inspected); unlimited it still lands instantly.
const DEMO_FILES = [
  { name: 'demo-content.txt', size: 768 * 1024, format: 'Demo text' },
  { name: 'about-this-demo.txt', size: 1536, format: 'Demo text' },
];

function demoFiles() {
  return DEMO_FILES.map((f, i) => ({ ...f, url: `demo:${i === 0 ? 'content' : 'readme'}` }));
}

function demoLabel(url) {
  return /readme/i.test(String(url)) ? 'about-this-demo.txt' : 'demo-content.txt';
}

function demoPayload(url) {
  const readme = /readme/i.test(String(url));
  const head =
    'TORRENTOR DEMO FILE\n' +
    '===================\n' +
    'This file was generated locally by the app to demonstrate the direct-\n' +
    "download flow. It is NOT real content, has no infohash and isn't a\n" +
    'torrent — treat it as a UI fixture, exactly like the Demo result card\n' +
    'it came from. Delete it whenever you like.\n\n';
  if (readme) {
    return Buffer.from(head + 'What you just did: picked a file from a Demo card, chose where to save\nit, and watched it stream in with progress. The real Internet Archive and\nofficial-ISO sources do the same thing over HTTPS through your VPN/proxy\nroute — with a host allowlist checked on every redirect.\n');
  }
  // Sized so a speed limit is observable (see DEMO_FILES note): exactly
  // 768 KiB of repetitive filler after the explanatory header.
  const headBuf = Buffer.from(head + '\n');
  const lorem =
    'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ' +
    'incididunt ut labore et dolore magna aliqua. ';
  const body = Buffer.alloc(768 * 1024 - headBuf.length);
  let off = 0;
  while (off < body.length) {
    const chunk = Buffer.from(lorem + '\n');
    const n = Math.min(chunk.length, body.length - off);
    chunk.copy(body, off, 0, n);
    off += n;
  }
  return Buffer.concat([headBuf, body]);
}

async function writeDemoFile(t, signal) {
  const payload = demoPayload(t.url);
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(t.filePath);
    const onAbort = () => out.destroy(new Error('cancelled'));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    out.on('error', (err) => reject(err));
    out.on('finish', () => resolve());
    let sent = 0;
    const CHUNK = 64 * 1024;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const step = async () => {
      while (sent < payload.length) {
        if (signal && signal.aborted) return out.destroy(new Error('cancelled'));
        // Honor the LIVE effective limit (own speed limit + any applied
        // plan's active-window cap — same field the real streamer reads),
        // so the demo flow behaves like a real one.
        const rate = effectiveLimitBps(t);
        if (rate > 0) await sleep(Math.max(1, (CHUNK / rate) * 1000));
        if (signal && signal.aborted) return out.destroy(new Error('cancelled'));
        const end = Math.min(sent + CHUNK, payload.length);
        if (!out.write(payload.subarray(sent, end))) {
          await new Promise((r) => out.once('drain', r));
        }
        sent = end;
        t.received = sent;
        t.total = payload.length;
      }
      out.end();
    };
    step().catch((err) => {
      if (!out.destroyed) out.destroy(err);
    });
  });
}

// ------------------------------------------------ per-source folders
//
// Sources whose results expose direct HTTPS files get an optional default
// save folder in Settings (an alternative to the shared "last used"
// folder). The engine is inferred from the download URL so remembering
// happens at save time without the renderer passing engine ids around.
const DIRECT_FILE_ENGINE_HOSTS = [
  ['archive-org', ['archive.org']],
  ['distro-releases', ['releases.ubuntu.com', 'cdimage.debian.org']],
  ['arch-releases', ['archive.archlinux.org']],
];

/**
 * Which engine a direct-download URL belongs to (for per-source default
 * folders). Demo: URLs are local; host matches are suffix-scoped like the
 * allowlist. Returns null when the URL is not a direct-file source.
 */
function engineForUrl(url) {
  const u = String(url || '').trim();
  if (/^demo:/i.test(u)) return 'demo-curated';
  let host = '';
  try {
    host = new URL(u).hostname.toLowerCase().replace(/:\d+$/, '');
  } catch {
    return null;
  }
  for (const [engineId, hosts] of DIRECT_FILE_ENGINE_HOSTS) {
    if (hosts.some((h) => host === h || host.endsWith('.' + h))) return engineId;
  }
  return null;
}

// ------------------------------------------------------------ item files
//
// Internet Archive items bundle many files; search results are item-level
// so the app offers a picker backed by Archive's public metadata API.

const IA_METADATA = 'https://archive.org/metadata/';
const IA_DL = 'https://archive.org/download/';

// Archive metadata's file list is huge; the classic *_files.xml manifest
// (served from the download node) is the fallback when the JSON metadata
// API is unavailable/empty (it has had outages).
const FILES_XML_SELF = /<file\b([^>]*)\/>/g;
const FILES_XML_BLOCK = /<file\b([^>]*)>([\s\S]*?)<\/file>/g;
const ATTR = (k) => new RegExp(`(?:^|\\s)${k}=["']([^"']+)["']`);

/**
 * Parse an Archive *_files.xml manifest into [{ name, size, format }].
 * Sizes appear as an attribute on some manifests and as a child <size>
 * element on others — both are handled.
 */
function parseFilesXml(xml) {
  const body = String(xml || '');
  const out = [];
  const handle = (attrs, inner) => {
    const nameM = ATTR('name').exec(attrs);
    if (!nameM) return;
    const attrSize = ATTR('size').exec(attrs);
    const childSize = inner && /<size>\s*(\d+)\s*<\/size>/i.exec(inner);
    const sizeStr = (attrSize && attrSize[1]) || (childSize && childSize[1]) || '';
    const fmtM = ATTR('format').exec(attrs);
    out.push({
      name: nameM[1],
      size: /^\d+$/.test(sizeStr) ? Number(sizeStr) : null,
      format: fmtM ? fmtM[1] : '',
    });
  };
  let m;
  FILES_XML_BLOCK.lastIndex = 0;
  while ((m = FILES_XML_BLOCK.exec(body)) !== null) handle(m[1], m[2]);
  FILES_XML_SELF.lastIndex = 0;
  while ((m = FILES_XML_SELF.exec(body)) !== null) handle(m[1], '');
  return out;
}

// Archive bookkeeping files that are never worth offering for download.
const IA_JUNK_RE = /(_archive\.torrent|_meta\.xml|_files\.xml|_reviews\.xml|_djvu\.txt|ia_thumb|__ia_thumb|_thumbnails?|thumbs?)$/i;

/**
 * Turn Archive metadata `files` into pickable rows. Rows carry an
 * absolute download URL (host-allowlisted by construction). `itemId` is
 * used only to build the URL — no path traversal is possible because the
 * name is re-encoded here, never interpolated raw.
 */
function sanitizeItemFiles(files, itemId) {
  if (!Array.isArray(files)) return [];
  const id = String(itemId || '').trim();
  if (!id || /[\\/]/.test(id)) return [];
  const out = [];
  for (const f of files) {
    const name = String(f && f.name || '').trim();
    if (!name || name.startsWith('__') || IA_JUNK_RE.test(name)) continue;
    const size = Number.isFinite(Number(f.size)) ? Number(f.size) : null;
    // Only reasonably sized files; skip zero-byte stubs and directory-ish
    // entries (Archive exposes folder names in the same list).
    if (size == null || size <= 0 || size > 100 * 1024 ** 3) continue;
    if (f.format && /^Item Tile|Unknown/i.test(String(f.format))) continue;
    out.push({
      name,
      size,
      format: String(f.format || '').slice(0, 40) || null,
      url: `https://archive.org/download/${encodeURIComponent(id)}/${name.split('/').map(encodeURIComponent).join('/')}`,
    });
  }
  // Deterministic order: biggest first.
  return out.sort((a, b) => (b.size || 0) - (a.size || 0));
}

/** Fetch + sanitize the file list for an Archive item (proxy-aware). */
async function itemFiles(itemId) {
  const id = String(itemId || '').trim();
  if (!id || /[\\/]/.test(id)) throw new Error('Invalid item identifier.');
  const enc = encodeURIComponent(id);
  let files = [];
  try {
    const data = await network.getJson(`${IA_METADATA}${enc}.json`, { timeoutMs: 15000, maxBytes: 8 * 1024 * 1024 });
    files = (data && data.files) || [];
  } catch {
    /* fall through to the manifest */
  }
  if (!files || !files.length) {
    const xml = await network.getText(`${IA_DL}${enc}/${enc}_files.xml`, {
      timeoutMs: 20000,
      maxBytes: 8 * 1024 * 1024,
    });
    files = parseFilesXml(xml);
  }
  return sanitizeItemFiles(files, id);
}

module.exports = {
  MAX_ACTIVE,
  parseClock,
  scheduleWindowActive,
  setActivePlan,
  clearActivePlan,
  activePlanNameOf,
  appliedPlanInfo,
  setGlobalSchedule,
  globalScheduleInfo,
  scheduleBoundaryTick,
  resetScheduleTicks,
  effectiveLimitBps,
  setDefaultSpeedLimit,
  setDefaultAllowHosts,
  setSmartOrder,
  setStats,
  statsSnapshot,
  recordStats,
  statsForPeriod,
  etaDetail,
  previewQueueOrder,
  startDownload,
  retryDownload,
  pauseDownload,
  resumeAllPaused,
  removeAllPaused,
  cancelDownload,
  moveQueued,
  moveQueuedTo,
  setSpeedLimit,
  planEntries,
  applyPlanEntries,
  resumableSnapshot,
  restorePending,
  getDownload,
  snapshot,
  clearFinished,
  itemFiles,
  sanitizeItemFiles,
  suggestedName,
  parseFilesXml,
  demoFiles,
  demoPayload,
  demoLabel,
  IA_JUNK_RE,
  engineForUrl,
};