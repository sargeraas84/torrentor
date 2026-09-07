'use strict';

const { makeHtmlEngine } = require('./community-html-engine');

module.exports = makeHtmlEngine({
  id: 'torrentdownloads',
  name: 'TorrentDownloads',
  homepage: 'https://www.torrentdownloads.pro/',
  tagline: 'Community index for hard-to-find content — opt-in, off by default.',
  probe: 'ubuntu',
  baseUrl: 'https://www.torrentdownloads.pro/',
  searchUrl: (q) => `https://www.torrentdownloads.pro/search/?new=1&s_cat=0&search=${encodeURIComponent(q)}`,
  link: (url) => /\/torrent\//i.test(url) || /torrentdownloads/i.test(url),
});
