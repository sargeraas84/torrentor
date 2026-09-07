'use strict';

const { makeHtmlEngine } = require('./community-html-engine');

module.exports = makeHtmlEngine({
  id: 'fitgirl',
  name: 'FitGirl Repacks',
  homepage: 'https://fitgirl-repacks.site/',
  tagline: 'Official repack catalog for games — opt-in, off by default.',
  probe: 'game',
  baseUrl: 'https://fitgirl-repacks.site/',
  searchUrl: (q) => `https://fitgirl-repacks.site/?s=${encodeURIComponent(q)}`,
  category: 'games',
  // Search results are article links. They are page-only cards because the
  // official posts commonly put mirror links behind an interaction page.
  link: (url) => /fitgirl-repacks\.site\/(?!page\/|category\/|tag\/|\?)/i.test(url),
});
