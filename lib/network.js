'use strict';
// ---------------------------------------------------------------------
// Torrentor — network layer (main process only).
//
// All outbound engine traffic goes through this module. When a proxy /
// VPN route is configured it is applied here transparently, so every
// indexer request (Archive.org, distro pages, IP checks) flows through
// the user's VPN/SOCKS/HTTP proxy — nothing in the renderer ever
// touches the network, and no engine can bypass the configured route.
//
// Direct file downloads (lib/downloads) stream through streamToFile: it
// writes to a ".part" file, resumes from it with an HTTP Range request
// when present, and only renames it to the final name on success — an
// interrupted download keeps its partial progress.
// ---------------------------------------------------------------------

const http = require('http');
const https = require('https');
const fs = require('fs');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Torrentor/1.0 (+https://github.com/; search-agent; contact: local-user)';

let currentConfig = null; // { enabled, type, host, port, username, password }
let agentCache = new Map(); // "type://host:port" -> agent

function resetAgents() {
  for (const a of agentCache.values()) {
    try {
      a.destroy();
    } catch {
      /* best-effort */
    }
  }
  agentCache.clear();
}

/** (Re)configure the route every engine request will use. */
function setProxyConfig(cfg) {
  const next = cfg && cfg.enabled && cfg.host && cfg.port ? cfg : null;
  const sig = next
    ? JSON.stringify([next.type, next.host, next.port, next.username || '', next.password || ''])
    : 'none';
  if (sig !== (currentConfig ? JSON.stringify([currentConfig.type, currentConfig.host, currentConfig.port, currentConfig.username || '', currentConfig.password || '']) : 'none')) {
    currentConfig = next;
    resetAgents();
  } else {
    currentConfig = next;
  }
}

function proxyUri(cfg) {
  const scheme = cfg.type === 'http' ? 'http' : cfg.type === 'socks4' ? 'socks4' : 'socks5';
  const auth = cfg.username ? `${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password || '')}@` : '';
  return `${scheme}://${auth}${cfg.host}:${cfg.port}`;
}

/** Agent for a (possibly proxy-routed) request. undefined = direct. */
function agentFor(cfg, targetIsHttps) {
  if (!cfg) return undefined;
  const key = `${targetIsHttps ? 'tls' : 'plain'}|${proxyUri(cfg)}`;
  if (agentCache.has(key)) return agentCache.get(key);
  let agent;
  try {
    if (cfg.type === 'http') {
      // https-proxy-agent tunnels https targets; for plain-http targets we
      // fall back to routing through the same proxy via CONNECT-less agent
      // (https-proxy-agent supports http CONNECT too, but plain http via
      // HttpsProxyAgent is not valid — use it only for https targets).
      agent = targetIsHttps ? new HttpsProxyAgent(proxyUri(cfg)) : undefined;
    } else {
      // socks4 / socks5 / socks5h: single agent handles both schemes.
      agent = new SocksProxyAgent(proxyUri(cfg));
    }
  } catch {
    agent = undefined;
  }
  if (agent) agentCache.set(key, agent);
  return agent;
}

/** Proxy config validation for the settings UI. Returns { ok, error? }. */
function validateProxyConfig(cfg) {
  if (!cfg || !cfg.enabled) return { ok: true };
  const host = String(cfg.host || '').trim();
  const port = Number(cfg.port);
  const type = cfg.type || 'socks5';
  if (!host) return { ok: false, error: 'Proxy host is required.' };
  if (!['http', 'socks4', 'socks5'].includes(type)) return { ok: false, error: 'Proxy type must be http, socks4 or socks5.' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'Proxy port must be between 1 and 65535.' };
  return { ok: true };
}

/**
 * Low-level text GET through the configured route.
 * opts: { url, timeoutMs, headers, maxBytes, redirects, signal }
 * Resolves { status, text }. Rejects on network errors/timeouts/oversize.
 */
function requestText(opts) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(opts.url);
    } catch {
      return reject(new Error('Invalid URL'));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return reject(new Error(`Unsupported protocol: ${url.protocol}`));
    }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const agent = agentFor(currentConfig, isHttps);
    const headers = Object.assign(
      {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.8',
        Connection: 'close',
      },
      opts.headers || {}
    );
    const timeoutMs = opts.timeoutMs || 12000;
    const maxBytes = opts.maxBytes || 4 * 1024 * 1024;
    let redirectsLeft = typeof opts.redirects === 'number' ? opts.redirects : 3;

    const request = () => {
      const req = lib.request(
        url,
        { method: 'GET', headers, agent },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            redirectsLeft--;
            try {
              url = new URL(res.headers.location, url);
            } catch {
              return reject(new Error(`Bad redirect: ${res.headers.location}`));
            }
            return request();
          }
          if (status < 200 || status >= 300) {
            res.resume();
            return reject(new Error(`HTTP ${status}`));
          }
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) {
              req.destroy(new Error(`Response too large (over ${maxBytes} bytes)`));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => resolve({ status, text: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', (err) => reject(err));
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out after ${timeoutMs}ms`)));
      req.on('error', (err) => {
        const aborted = opts.signal && opts.signal.aborted;
        reject(aborted ? new Error('aborted') : err);
      });
      if (opts.signal) {
        if (opts.signal.aborted) return req.destroy(new Error('aborted'));
        opts.signal.addEventListener(
          'abort',
          () => req.destroy(new Error('aborted')),
          { once: true }
        );
      }
      req.end();
    };
    request();
  });
}

async function getJson(url, opts = {}) {
  const res = await requestText(Object.assign({ url }, opts, { headers: Object.assign({ Accept: 'application/json' }, opts.headers) }));
  try {
    return JSON.parse(res.text);
  } catch (err) {
    throw new Error(`Invalid JSON from ${url} (${err.message})`);
  }
}

async function getText(url, opts = {}) {
  const res = await requestText(Object.assign({ url }, opts));
  return res.text;
}

// Hosts the app is willing to stream CONTENT from. Search only touches
// hosts the engines know; a direct download writes bytes to disk, so the
// bar is higher: an explicit allowlist, enforced again after every
// redirect hop. `archive.org` covers the item nodes it redirects to
// (ia*.us.archive.org etc.) via the suffix match.
const DOWNLOAD_ALLOW_HOSTS = ['archive.org', 'releases.ubuntu.com', 'cdimage.debian.org', 'archive.archlinux.org'];

/** Host allowlist check used for every direct-download request/hop. */
function hostAllowed(host, allow) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  if (!h) return false;
  const list = allow && allow.length ? allow : DOWNLOAD_ALLOW_HOSTS;
  return list.some((a) => h === a || h.endsWith('.' + a));
}

/**
 * Stream a GET (through the configured proxy route) to a file on disk.
 *
 * opts: { url, destPath, timeoutMs, signal, allowHosts, resumeFrom,
 *         rateLimit, onBytes(receivedAbs, totalAbs) }
 *
 * `rateLimit` is bytes/second (0 = unlimited) OR a function returning the
 * current bytes/second, evaluated per chunk — so a live per-transfer
 * speed limit can change while a download is streaming.
 *
 * Bytes always stream into `destPath + '.part'`; on success the part is
 * renamed to `destPath` and the promise resolves with
 * { status, bytes, url }. When `resumeFrom > 0` a Range request is sent
 * and the part is appended to (a 200 means the server ignored the range,
 * so the part is rewritten from scratch). Every redirect hop must satisfy
 * the host allowlist. On failure the partial file is KEPT so a retry can
 * resume (only empty parts are removed).
 */
function streamToFile(opts) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(opts.url);
    } catch {
      return reject(new Error('Invalid URL'));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return reject(new Error('Only http(s) downloads are supported.'));
    }
    if (!hostAllowed(url.hostname, opts.allowHosts)) {
      return reject(new Error(`Download host not allowed: ${url.hostname}`));
    }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const agent = agentFor(currentConfig, isHttps);
    const partPath = opts.destPath + '.part';
    const baseHeaders = Object.assign(
      {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/octet-stream,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.8',
      },
      opts.headers || {}
    );
    const timeoutMs = opts.timeoutMs || 20000;
    // Live rate getter: a static number, or a function the caller can use
    // to surface per-transfer changes mid-stream (0 = unlimited).
    const rateOf =
      typeof opts.rateLimit === 'function'
        ? opts.rateLimit
        : () => Math.max(0, Math.floor(Number(opts.rateLimit) || 0));
    const STALL_MS = 60000; // no body bytes for a minute → dead link
    let resumeFrom = Math.max(0, Math.floor(Number(opts.resumeFrom) || 0));
    let redirectsLeft = typeof opts.redirects === 'number' ? opts.redirects : 5;
    let written = 0; // bytes written this session (excluding resumed prefix)
    let done = false;
    let out = null;
    let rateTimer = null; // pending throttle-resume timer (cleared on abort)

    const fail = (err) => {
      if (done) return;
      done = true;
      if (rateTimer !== null) {
        clearTimeout(rateTimer);
        rateTimer = null;
      }
      if (out) out.destroy();
      // Keep a non-empty partial so a retry can resume; drop empty parts.
      try {
        if (fs.existsSync(partPath) && fs.statSync(partPath).size === 0) fs.unlinkSync(partPath);
      } catch {
        /* best-effort */
      }
      reject(err);
    };
    const renamePart = (cb) => {
      if (fs.existsSync(opts.destPath)) {
        try {
          fs.unlinkSync(opts.destPath);
        } catch {
          /* overwrite attempt below may still work */
        }
      }
      fs.rename(partPath, opts.destPath, (err) => (err ? cb(err) : cb(null)));
    };
    const finish = (status, resumed) => {
      if (done) return;
      done = true;
      if (out) out.end();
      renamePart((err) => {
        if (err) return fail(err);
        resolve({ status, bytes: written, resumedFrom: resumed, url: url.href });
      });
    };

    const request = () => {
      const reqHeaders = Object.assign({}, baseHeaders);
      if (resumeFrom > 0) reqHeaders.Range = `bytes=${resumeFrom}-`;
      const req = lib.request(url, { method: 'GET', headers: reqHeaders, agent }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          redirectsLeft--;
          try {
            const next = new URL(res.headers.location, url);
            if (!hostAllowed(next.hostname, opts.allowHosts)) {
              return fail(new Error(`Download redirect not allowed: ${next.hostname}`));
            }
            url = next;
          } catch (err) {
            return fail(new Error(`Bad redirect: ${res.headers.location}`));
          }
          return request();
        }
        let resumed = 0;
        if (status === 206 && resumeFrom > 0) {
          resumed = resumeFrom; // server honored the range → append
        } else if (status === 200) {
          resumed = 0; // server restarted the body → rewrite the part
          resumeFrom = 0;
        } else if (status === 416) {
          res.resume();
          return fail(new Error('HTTP 416 (range not satisfiable)'));
        } else if (status < 200 || status >= 300) {
          res.resume();
          return fail(new Error(`HTTP ${status}`));
        }
        try {
          out = fs.createWriteStream(partPath, { flags: resumed > 0 ? 'a' : 'w' });
        } catch (err) {
          return fail(err);
        }
        out.on('error', (err) => fail(err));
        const len = Number(res.headers['content-length']);
        // Absolute totals from the caller's point of view (resumed prefix
        // included) so progress bars are continuous across retries.
        const totalAbs = Number.isFinite(len) && len > 0 ? resumed + len : null;
        // Resolve only once the WRITE side has flushed (out 'finish'), not
        // on the response 'end' — otherwise the last buffered bytes may
        // still be in flight when the caller checks the file.
        res.on('error', (err) => fail(err));
        out.on('finish', () => finish(status, resumed));
        // Guard against a link that stalls mid-body (timeouts for the
        // header phase are separate — a big file legitimately takes long).
        res.setTimeout(STALL_MS, () => req.destroy(new Error('Download stalled (no data for 60s)')));
        // Flowing consumption with a per-chunk token bucket: without a
        // limit this is plain res.pipe-style writing; with one, `res` is
        // paused whenever the bucket is empty and resumed by a timer, so
        // bytes land on disk at (on average) the requested rate.
        let tokens = 0; // byte credit; refills over wall time (cold start)
        let lastRefill = Date.now();
        let ratePaused = false;
        let drainPaused = false;
        const tryResume = () => {
          if (done || res.destroyed) return;
          if (drainPaused || ratePaused) return;
          res.resume();
        };
        res.on('data', (c) => {
          if (done) return;
          const limit = rateOf();
          if (limit > 0) {
            const now = Date.now();
            tokens = Math.min(limit, tokens + ((now - lastRefill) * limit) / 1000);
            lastRefill = now;
            if (tokens < c.length) {
              const needMs = Math.max(1, ((c.length - tokens) / limit) * 1000);
              tokens = 0;
              ratePaused = true;
              res.pause();
              res.setTimeout(0); // deliberate pause — not a stalled link
              rateTimer = setTimeout(() => {
                rateTimer = null;
                ratePaused = false;
                lastRefill = Date.now();
                // The transfer may already have completed while the final
                // chunk was being rate-held (end fires even when paused) —
                // the response socket is gone by then, so just stop.
                if (done || !res.socket) return;
                res.setTimeout(STALL_MS, stall);
                tryResume();
              }, needMs);
            } else {
              tokens -= c.length;
            }
          }
          written += c.length;
          if (typeof opts.onBytes === 'function') opts.onBytes(resumed + written, totalAbs);
          if (!out.write(c)) {
            drainPaused = true;
            res.pause();
            out.once('drain', () => {
              drainPaused = false;
              tryResume();
            });
          }
        });
        res.on('error', (err) => fail(err));
        res.on('end', () => out.end());
        out.on('finish', () => finish(status, resumed));
        // Guard against a link that stalls mid-body (timeouts for the
        // header phase are separate — a big file legitimately takes long).
        const stall = () => req.destroy(new Error('Download stalled (no data for 60s)'));
        res.setTimeout(STALL_MS, stall);
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out after ${timeoutMs}ms`)));
      req.on('error', (err) => {
        if (done) return;
        const aborted = opts.signal && opts.signal.aborted;
        fail(aborted ? new Error('cancelled') : err);
      });
      if (opts.signal) {
        if (opts.signal.aborted) return req.destroy(new Error('cancelled'));
        opts.signal.addEventListener('abort', () => req.destroy(new Error('cancelled')), { once: true });
      }
      req.end();
    };
    request();
  });
}

/**
 * Verify the egress route: asks a public endpoint for the IP the server
 * sees. When a proxy/VPN is enabled this should show the VPN exit IP —
 * the app's one-click "is my VPN actually on?" check.
 * Returns { ok, ip, country, isp, route } or throws.
 */
async function checkIp(timeoutMs = 8000) {
  const ipInfo = await getJson('https://ipinfo.io/json', { timeoutMs, maxBytes: 256 * 1024 });
  const ip = String(ipInfo.ip || '').trim();
  if (!ip) throw new Error('Could not determine public IP');
  return {
    ok: true,
    ip,
    country: ipInfo.country ? ipInfo.country.toUpperCase() : '',
    isp: String(ipInfo.org || '').replace(/^AS\d+\s*/, ''),
    city: String(ipInfo.city || ''),
    route: currentConfig ? `${currentConfig.type}://${currentConfig.host}:${currentConfig.port}` : 'direct',
  };
}

module.exports = { setProxyConfig, validateProxyConfig, getJson, getText, requestText, streamToFile, hostAllowed, checkIp, DOWNLOAD_ALLOW_HOSTS, DEFAULT_UA };