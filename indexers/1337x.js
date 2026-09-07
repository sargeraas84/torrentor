'use strict';

const { makeHtmlEngine } = require('./community-html-engine');

module.exports = makeHtmlEngine({
  id: '1337x',
  name: '1337x',
  homepage: 'https://1337x.to/',
  tagline: 'Community movie and TV index — opt-in, off by default.',
  probe: 'ubuntu',
  baseUrl: 'https://1337x.to/',
  searchUrl: (q) => `https://1337x.to/search/${encodeURIComponent(q)}/1/`,
  blockedMessage: '1337x is blocking automated requests (HTTP 403); open the source page in a browser or retry later.',
  category: 'other',
  link: (url) => /\/torrent\//i.test(url),
});
