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

// Maximum simultaneous transfers streaming to disk.
const MAX_ACTIVE = 2;
// Maximum number of finished transfers kept for the UI.
const TRANSFER_LIMIT = 30;

const transfers = new Map(); // id -> transfer entry (incl. queued)
const controllers = new Map(); // id -> AbortController for the active stream
const waiting = []; // FIFO of ids whose status is 'queued'
let active = 0;
let idSeq = 1;

function snapshot() {
  // Display order: active downloads first, then queued transfers in queue
  // order (top of the queue starts next), then finished transfers newest
  // first. Shallow copies carry a queuePos (-1 when not queued) for the UI.
  const qPos = new Map();
  waiting.forEach((id, i) => qPos.set(id, i));
  const running = [];
  const queued = [];
  const rest = [];
  for (const t of transfers.values()) {
    if (t.status === 'downloading') running.push(t);
    else if (t.status === 'queued' && qPos.has(t.id)) queued.push(t);
    else rest.push(t);
  }
  running.sort((a, b) => b.startedAt - a.startedAt);
  queued.sort((a, b) => qPos.get(a.id) - qPos.get(b.id));
  rest.sort((a, b) => b.startedAt - a.startedAt);
  return [...running, ...queued, ...rest].slice(0, TRANSFER_LIMIT).map((t) => {
    const copy = Object.assign({}, t);
    copy.queuePos = qPos.has(t.id) ? qPos.get(t.id) : -1;
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
  if (onEvent) onEvent(t, 'limit');
  return t;
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
  return {
    id: idSeq++,
    url: String(url),
    name: isDemo ? demoLabel(url) : suggestedName(url),
    demo: isDemo,
    dir: destPath ? destPath.slice(0, Math.max(0, destPath.lastIndexOf('/'), destPath.lastIndexOf('\\'))) : '',
    filePath: destPath || '',
    status: 'queued',
    received: 0,
    total: null,
    speedBytesPerSec: 0,
    resumed: false,
    error: null,
    maxBytesPerSec: Math.max(0, Math.floor(Number(src.maxBytesPerSec) || 0)),
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
 */
function startDownload(url, destPath, onEvent) {
  const t = makeEntry(url, destPath);
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

/** Speed-throttled progress emitter (>=500ms between broadcasts). */
function throttled(onEvent, t) {
  let lastTick = Date.now();
  let lastBytes = 0;
  return (received, total) => {
    t.received = received;
    if (total != null) t.total = total;
    const now = Date.now();
    const dt = now - lastTick;
    if (dt >= 500) {
      t.speedBytesPerSec = ((received - lastBytes) * 1000) / dt;
      lastTick = now;
      lastBytes = received;
      emit(t, onEvent, 'progress');
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
      emit(t, onEvent, 'done');
      return;
    }
    // Live per-transfer speed limit (0 = unlimited) re-read each chunk.
    const limitBps = () => Math.max(0, Math.floor(Number(t.maxBytesPerSec) || 0));
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
    const out = await network.streamToFile({
      url: t.url,
      destPath: t.filePath,
      signal: ac.signal,
      resumeFrom,
      rateLimit: limitBps,
      onBytes: throttled(onEvent, t),
    });
    t.status = 'done';
    t.total = out.resumedFrom + out.bytes;
    t.received = t.total;
    t.speedBytesPerSec = 0;
    t.finishedAt = Date.now();
    emit(t, onEvent, 'done');
  } catch (err) {
    const cancelled = String((err && err.message) || err) === 'cancelled';
    t.status = cancelled ? 'cancelled' : 'error';
    t.error = cancelled ? null : String((err && err.message) || err).slice(0, 160);
    t.speedBytesPerSec = 0;
    t.finishedAt = Date.now();
    emit(t, onEvent, cancelled ? 'done' : 'error');
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

/** Minimal records for the transfers that should auto-resume next launch. */
function resumableSnapshot() {
  const out = [];
  for (const t of transfers.values()) {
    if ((t.status === 'downloading' || t.status === 'queued') && t.filePath) {
      out.push({
        url: t.url,
        filePath: t.filePath,
        demo: !!t.demo,
        maxBytesPerSec: t.maxBytesPerSec || 0,
      });
    }
  }
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
    const t = makeEntry(rec.url, rec.filePath, { maxBytesPerSec: rec.maxBytesPerSec });
    transfers.set(t.id, t);
    waiting.push(t.id);
    if (onEvent) onEvent(t, 'queued');
  }
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
  if (t.status !== 'downloading') return null;
  t.status = 'cancelled'; // transitional — the abort keeps the .part
  const ac = controllers.get(id);
  if (ac) ac.abort();
  return t;
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

const DEMO_FILES = [
  { name: 'demo-content.txt', size: 4608, format: 'Demo text' },
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
  const lorem =
    'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ' +
    'incididunt ut labore et dolore magna aliqua. ';
  const body = Buffer.alloc(4096);
  let off = 0;
  while (off < body.length) {
    const chunk = Buffer.from(lorem + '\n');
    const n = Math.min(chunk.length, body.length - off);
    chunk.copy(body, off, 0, n);
    off += n;
  }
  return Buffer.concat([Buffer.from(head + '\n'), body]);
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
        // Honor a live per-transfer speed limit (same field the real
        // streamer reads), so the demo flow behaves like a real one.
        const rate = Math.max(0, Math.floor(Number(t.maxBytesPerSec) || 0));
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
  startDownload,
  retryDownload,
  cancelDownload,
  moveQueued,
  setSpeedLimit,
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
};