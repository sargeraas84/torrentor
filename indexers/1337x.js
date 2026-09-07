'use strict';

const { makeHtmlEngine } = require('./community-html-engine');

module.exports = makeHtmlEngine({
  id: '1337x',
  name: '1337x',
  homepage: 'https://x1337x.eu/',
  tagline: 'Community movie and TV index — opt-in, off by default.',
  probe: 'ubuntu',
  baseUrl: 'https://x1337x.eu/',
  searchUrl: (q) => `https://x1337x.eu/search/${encodeURIComponent(q)}/1/`,
  category: 'other',
  link: (url) => /\/torrent\//i.test(url),
});
