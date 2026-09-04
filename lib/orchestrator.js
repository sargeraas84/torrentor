'use strict';
// ---------------------------------------------------------------------
// Torrentor — search orchestrator (main process).
//
// Runs the same query against every enabled engine concurrently, then
// merges the per-engine results into one list deduped by infohash
// (when known; otherwise by source+item). Every time an engine settles,
// the caller is handed a fresh snapshot so the UI can stream cards in
// as sources report, and the run's final payload resolves with the
// complete merged set. A watchdog guarantees no engine can hang a run.
// ---------------------------------------------------------------------

const { normalizeInfohash } = require('./magnet');

const PER_ENGINE_CAP = 60;
const TOTAL_CAP = 250;
const ENGINE_TIMEOUT_MS = 14000;

/** Stable identity of a result across engines. */
function keyOf(result) {
  const ih = normalizeInfohash(result && result.infohash);
  if (ih) return `btih:${ih}`;
  return `${result && result.sourceId ? result.sourceId : 'unknown'}:${result && result.itemId ? result.itemId : 'unknown'}`;
}

function mergeInto(map, result) {
  const key = keyOf(result);
  const existing = map.get(key);
  const src = {
    sourceId: result.sourceId,
    sourceLabel: result.sourceLabel,
    kind: result.kind,
    demo: !!result.demo,
    torrentUrl: result.torrentUrl || null,
    pageUrl: result.pageUrl || null,
    magnet: result.magnet || null,
    seeders: result.seeders ?? null,
    leechers: result.leechers ?? null,
  };
  if (!existing) {
    map.set(key, {
      key,
      title: result.title,
      // representative source identity — keeps keyOf() stable for
      // infohash-less sources (used by favorites round-trips)
      sourceId: result.sourceId,
      itemId: result.itemId,
      category: result.category || 'other',
      creator: result.creator || null,
      year: result.year || null,
      description: result.description || null,
      mediatype: result.mediatype || null,
      sizeBytes: result.sizeBytes ?? null,
      seeders: result.seeders ?? null,
      leechers: result.leechers ?? null,
      uploadedAt: result.uploadedAt ?? null,
      downloads: result.downloads ?? null,
      infohash: normalizeInfohash(result.infohash),
      magnet: result.magnet || null,
      torrentUrl: result.torrentUrl || null,
      pageUrl: result.pageUrl || null,
      thumbnail: result.thumbnail || null,
      demo: !!result.demo,
      relevance: result.relevance ?? 0,
      sources: [src],
    });
    return;
  }
  existing.sources.push(src);
  const maxOrNull = (cur, next) => Math.max(cur ?? 0, next ?? 0) || null;
  existing.seeders = maxOrNull(existing.seeders, result.seeders);
  existing.leechers = maxOrNull(existing.leechers, result.leechers);
  if (!existing.title && result.title) existing.title = result.title;
  // Rich catalog metadata carries first-seen-wins like title.
  if (!existing.creator && result.creator) existing.creator = result.creator;
  if (!existing.year && result.year) existing.year = result.year;
  if (!existing.description && result.description) existing.description = result.description;
  if (!existing.mediatype && result.mediatype) existing.mediatype = result.mediatype;
  if (result.category && result.category !== 'other') existing.category = result.category;
  if ((existing.sizeBytes ?? 0) < (result.sizeBytes ?? 0)) existing.sizeBytes = result.sizeBytes ?? null;
  if (!existing.uploadedAt && result.uploadedAt) existing.uploadedAt = result.uploadedAt;
  if (!existing.infohash) existing.infohash = normalizeInfohash(result.infohash);
  existing.magnet = existing.magnet || result.magnet || null;
  existing.torrentUrl = existing.torrentUrl || result.torrentUrl || null;
  existing.pageUrl = existing.pageUrl || result.pageUrl || null;
  existing.thumbnail = existing.thumbnail || result.thumbnail || null;
  existing.demo = existing.demo && !!result.demo;
  existing.relevance = Math.max(existing.relevance, result.relevance ?? 0);
}

/** Deterministic sort. Modes: seeders (default) | size | newest | relevance. */
function sortResults(results, mode) {
  const list = [...results];
  const byTitle = (a, b) => String(a.title).localeCompare(String(b.title));
  const seedersOf = (r) => (r.seeders == null ? -1 : r.seeders);
  const sizeOf = (r) => (r.sizeBytes == null ? -1 : r.sizeBytes);
  const timeOf = (r) => (r.uploadedAt == null ? 0 : r.uploadedAt);
  switch (mode) {
    case 'size':
      return list.sort((a, b) => sizeOf(b) - sizeOf(a) || byTitle(a, b));
    case 'newest':
      return list.sort((a, b) => timeOf(b) - timeOf(a) || byTitle(a, b));
    case 'relevance':
      return list.sort((a, b) => b.relevance - a.relevance || seedersOf(b) - seedersOf(a) || byTitle(a, b));
    case 'seeders':
    default: {
      // Default view honesty rules:
      //  1. Real results always rank above synthetic demo fixtures — a
      //     demo's fabricated seeders must never outrank a genuine hit.
      //  2. Among real results, seeding wins; ties resolve by relevance
      //     BEFORE size so a small perfect match beats a big generic one.
      const demoFirst = (a, b) => Number(!!a.demo) - Number(!!b.demo);
      return list.sort((a, b) => demoFirst(a, b) || seedersOf(b) - seedersOf(a) || (b.relevance || 0) - (a.relevance || 0) || sizeOf(b) - sizeOf(a) || byTitle(a, b));
    }
  }
}

/**
 * @param {object} opts
 *   query, engineIds[], registry (indexers/registry), signal,
 *   network (lib/network bound to current proxy config),
 *   onProgress(snapshot) after each engine settles.
 * @returns merged payload (or null when aborted).
 */
async function runSearch(opts) {
  const { query, engineIds = [], registry, signal, network } = opts;
  const onProgress = opts.onProgress || (() => {});
  const q = String(query || '').trim();
  if (q.length < 2) throw new Error('Enter at least 2 characters to search.');

  const startedAt = Date.now();
  const map = new Map();
  const perEngine = {};

  const engines = engineIds
    .map((id) => registry.get(id))
    .filter((e) => e && typeof e.search === 'function');

  if (!engines.length) throw new Error('No search engines are enabled — enable at least one in Settings.');

  const settle = (id, status, extra) => {
    perEngine[id] = Object.assign({ status, count: 0 }, extra || {});
  };

  const snapshot = () => {
    const results = sortResults([...map.values()], 'seeders').slice(0, TOTAL_CAP);
    const runningIds = engines.filter((e) => perEngine[e.id] && perEngine[e.id].status === 'running').map((e) => e.id);
    return { results, perEngine: { ...perEngine }, runningIds };
  };

  const ctx = { query: q, signal, network, timeoutMs: ENGINE_TIMEOUT_MS };
  const tasks = engines.map((engine) => {
    perEngine[engine.id] = { status: 'running', count: 0 };
    const timeout = new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error('Engine timed out')), ENGINE_TIMEOUT_MS + 1500);
      if (t.unref) t.unref();
    });
    const work = Promise.resolve()
      .then(() => engine.search(q, ctx))
      .then((raw) => {
        if (signal && signal.aborted) return;
        const list = (Array.isArray(raw) ? raw : []).slice(0, PER_ENGINE_CAP);
        let merged = 0;
        for (const r of list) {
          if (!r || !r.title) continue;
          mergeInto(map, r);
          merged++;
        }
        settle(engine.id, 'ok', { count: merged, tookMs: Date.now() - startedAt });
        onProgress(snapshot());
      })
      .catch((err) => {
        if (signal && signal.aborted) return; // cancelled — stay silent
        settle(engine.id, 'error', { error: String((err && err.message) || err).slice(0, 160) });
        onProgress(snapshot());
      });
    return Promise.race([work, timeout]).catch(() => {
      if (!signal || !signal.aborted) {
        settle(engine.id, 'error', { error: 'Engine timed out' });
        onProgress(snapshot());
      }
    });
  });

  await Promise.allSettled(tasks);
  if (signal && signal.aborted) return null;

  const final = snapshot();
  return {
    query: q,
    results: final.results,
    perEngine: final.perEngine,
    stats: {
      unique: final.results.length,
      okEngines: engines.filter((e) => perEngine[e.id] && perEngine[e.id].status === 'ok').length,
      totalEngines: engines.length,
      tookMs: Date.now() - startedAt,
      engineIds: engines.map((e) => e.id),
    },
  };
}

/**
 * Merge a newly fetched page of results into results already shown,
 * deduped by key (infohash, or source+item). Returns the re-sorted
 * merged list (honesty rules intact) plus how many genuinely new cards
 * were added. Used by the Archive "load more" flow.
 */
function mergeIncremental(existing, incoming) {
  const map = new Map();
  for (const r of existing || []) {
    if (r && r.key) map.set(r.key, r);
  }
  let added = 0;
  for (const r of incoming || []) {
    if (!r || !r.title) continue;
    const before = map.size;
    mergeInto(map, r);
    if (map.size > before) added++;
  }
  return { results: sortResults([...map.values()], 'seeders').slice(0, TOTAL_CAP), added };
}

module.exports = { runSearch, keyOf, sortResults, mergeInto, mergeIncremental, PER_ENGINE_CAP, TOTAL_CAP, ENGINE_TIMEOUT_MS };
