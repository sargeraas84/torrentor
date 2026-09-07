'use strict';

const { makeHtmlEngine } = require('./community-html-engine');

module.exports = makeHtmlEngine({
  id: 'limetorrents',
  name: 'LimeTorrents',
  homepage: 'https://limetorrents.info/',
  tagline: 'Community index for new releases — opt-in, off by default.',
  probe: 'ubuntu',
  baseUrl: 'https://limetorrents.info/',
  searchUrl: (q) => `https://limetorrents.info/search/all/${encodeURIComponent(q)}/`,
  link: (url) => /\/torrent\//i.test(url) || /limetorrents/i.test(url),
});
