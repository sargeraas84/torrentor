'use strict';

const { normalizeResult } = require('./base');
const { parseSearchPage } = require('./community-html');

function makeHtmlEngine(config) {
  const engine = {
    id: config.id,
    name: config.name,
    tagline: config.tagline,
    homepage: config.homepage || config.baseUrl || null,
    kind: 'community',
    demo: false,
    probe: config.probe,
    defaultEnabled: false,
  };

  async function search(query, ctx) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    const url = config.searchUrl(q);
    let html;
    try {
      html = await ctx.network.getText(url, {
        timeoutMs: ctx.timeoutMs,
        maxBytes: config.maxBytes || 3 * 1024 * 1024,
        signal: ctx.signal,
      });
    } catch (err) {
      if (ctx.signal && ctx.signal.aborted) throw err;
      throw new Error(`${config.name} unreachable (${String((err && err.message) || err).slice(0, 80)})`);
    }
    return parseSearchPage(html, q, {
      baseUrl: config.baseUrl,
      maxResults: config.maxResults || 50,
      category: config.category,
      link: config.link,
    }).map((item) => normalizeResult(item, engine));
  }

  return { engine, search };
}

module.exports = { makeHtmlEngine };
