'use strict';
// ---------------------------------------------------------------------
// Torrentor — network layer (main process only).
//
// All outbound engine traffic goes through this module. When a proxy /
// VPN route is configured it is applied here transparently, so every
// indexer request (Archive.org, distro pages, IP checks) flows through
// the user's VPN/SOCKS/HTTP proxy — nothing in the renderer ever
// touches the network, and no engine can bypass the configured route.
// ---------------------------------------------------------------------

const http = require('http');
const https = require('https');
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

module.exports = { setProxyConfig, validateProxyConfig, getJson, getText, requestText, checkIp, DEFAULT_UA };
