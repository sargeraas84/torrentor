'use strict';
// ---------------------------------------------------------------------
// Torrentor — engine health self-test (main process only).
//
// Runs each probe-bearing engine's search() with its own known-good probe
// term through the SAME ctx the orchestrator uses (proxy-bound network),
// and marks an engine healthy ONLY when the probe returns >= 1 result.
// A reachable source whose parser silently yields nothing (site redesign,
// layout change) therefore reports FAILING here instead of a green chip.
// Engines without a probe (the offline demo index) are excluded.
// ---------------------------------------------------------------------

const HEALTH_TIMEOUT_MS = 10000;

/**
 * @param {object} opts
 *   registry  { ENGINES: [...] } — entries carry { id, demo, probe, search }
 *   network   lib/network (proxy-bound) — passed through to engine ctx
 *   signal    AbortSignal (optional)
 *   onProgress(partialResults) — called with accumulated results as each
 *             engine settles, so the UI can flip rows live.
 * @returns Promise<healthRecord[]> one record per probe-bearing engine, in
 *   ENGINES order. Record: { engineId, ok, count, latencyMs, error, at }.
 */
async function runHealthChecks(opts) {
  const { registry, network, signal } = opts;
  const onProgress = opts.onProgress || (() => {});
  const engines = (registry.ENGINES || []).filter(
    (e) => e && !e.demo && typeof e.probe === 'string' && e.probe.trim().length > 0
  );
  const results = [];
  await Promise.all(
    engines.map(async (engine) => {
      const startedAt = Date.now();
      const record = { engineId: engine.id, ok: false, count: 0, latencyMs: 0, error: null, at: startedAt };
      try {
        const ctx = { query: engine.probe, signal, network, timeoutMs: HEALTH_TIMEOUT_MS };
        const list = await engine.search(engine.probe, ctx);
        const count = Array.isArray(list) ? list.filter((r) => r && r.title).length : 0;
        record.latencyMs = Date.now() - startedAt;
        record.count = count;
        if (count > 0) {
          record.ok = true;
        } else {
          record.error = `returned 0 results for probe '${engine.probe}'`;
        }
      } catch (err) {
        record.latencyMs = Date.now() - startedAt;
        record.error = String((err && err.message) || err).slice(0, 160);
      }
      results.push(record);
      onProgress(results.slice());
    })
  );
  // Stable order: same as ENGINES (filtered), regardless of settle order.
  const order = new Map(engines.map((e, i) => [e.id, i]));
  return results.sort((a, b) => order.get(a.engineId) - order.get(b.engineId));
}

module.exports = { runHealthChecks, HEALTH_TIMEOUT_MS };
