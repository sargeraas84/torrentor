'use strict';
// ---------------------------------------------------------------------
// Torrentor smoke tests (npm test) — pure Node, no Electron, no network.
// Exercises: formatting, magnet URIs, category guessing, the engine
// registry, the offline demo engine, merge/dedupe + sorting, and JSON
// persistence. Live engines (archive-org / distro-releases / arch-releases)
// are exercised by the UI playtest and ad-hoc live runs; this suite tests
// only their pure helpers — never with outbound requests.
// ---------------------------------------------------------------------

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

let passed = 0;
let failures = 0;
// ok() accepts sync and async checks. Async ones are chained onto this
// promise so they run in call order and are drained before the summary
// (and before any shared-file cleanup) — never as racing background tasks.
let serial = Promise.resolve();
function ok(name, fn) {
  serial = serial.then(async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failures++;
      console.error(`  ✗ ${name} — ${err && err.message ? err.message : err}`);
    }
  });
}

async function main() {
  console.log('\nTorrentor smoke tests\n');

  // ------------------------------ format ------------------------------
  const fmt = require('../lib/format');
  ok('formatBytes', () => {
    assert.strictEqual(fmt.formatBytes(0), '0 B');
    assert.strictEqual(fmt.formatBytes(1536), '1.5 KB');
    assert.strictEqual(fmt.formatBytes(5.6 * 1024 ** 3), '5.6 GB');
    assert.strictEqual(fmt.formatBytes(null), '—');
    assert.strictEqual(fmt.formatBytes(-1), '—');
  });
  ok('formatCompact', () => {
    assert.strictEqual(fmt.formatCompact(12345), '12.3k');
    assert.strictEqual(fmt.formatCompact(999), '999');
    assert.strictEqual(fmt.formatCompact(2300000), '2.3M');
  });
  ok('relativeTime', () => {
    assert.strictEqual(fmt.relativeTime(Date.now() - 30000), 'just now');
    assert.ok(fmt.relativeTime(Date.now() - 2 * 3600e3).endsWith('h ago'));
    assert.ok(fmt.relativeTime(Date.now() - 40 * 86400e3).includes('20'));
  });
  ok('categorizeTitle by extension', () => {
    assert.strictEqual(fmt.categorizeTitle('movie.1080p.mkv'), 'video');
    assert.strictEqual(fmt.categorizeTitle('song.flac'), 'audio');
    assert.strictEqual(fmt.categorizeTitle('tool_amd64.deb'), 'apps');
    assert.strictEqual(fmt.categorizeTitle('book.epub'), 'documents');
  });
  ok('categorizeTitle by keywords + hints', () => {
    assert.strictEqual(fmt.categorizeTitle('The Show S01E01 1080p', []), 'video');
    assert.strictEqual(fmt.categorizeTitle('Album FLAC lossless', []), 'audio');
    assert.strictEqual(fmt.categorizeTitle('Something', ['texts']), 'documents');
    assert.strictEqual(fmt.categorizeTitle('Something', ['movies']), 'video');
  });
  // ------------------------------ magnet ------------------------------
  const magnet = require('../lib/magnet');
  ok('normalizeInfohash hex / btih / junk', () => {
    const hex = 'a1'.repeat(20);
    assert.strictEqual(magnet.normalizeInfohash(hex.toUpperCase()), hex);
    assert.strictEqual(magnet.normalizeInfohash(`btih:${hex}`), hex);
    assert.strictEqual(magnet.normalizeInfohash('not-a-hash'), null);
    assert.strictEqual(magnet.normalizeInfohash(null), null);
  });
  ok('base32 decode path (RFC4648)', () => {
    // encode the 20 bytes of hex "a1a2...be" as 32-char base32, then
    // verify normalizeInfohash maps it back to the original hex.
    const hex = 'a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf'.slice(0, 40);
    const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
    const bytes = Buffer.from(hex, 'hex');
    let bits = 0;
    let value = 0;
    let out = '';
    for (const b of bytes) {
      value = (value << 8) | b;
      bits += 8;
      while (bits >= 5) {
        out += ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    assert.strictEqual(out.length, 32);
    assert.strictEqual(magnet.normalizeInfohash(out), hex);
  });
  ok('buildMagnet + parseMagnet round-trip', () => {
    const hex = 'c0ffee'.padEnd(40, 'ab');
    const uri = magnet.buildMagnet({ infoHash: hex, name: 'Ubuntu ISO (test)' });
    assert.ok(uri.startsWith(`magnet:?xt=urn:btih:${hex}`));
    assert.ok(uri.includes('dn=Ubuntu%20ISO'));
    assert.ok(uri.includes('tr='));
    const parsed = magnet.parseMagnet(uri);
    assert.strictEqual(parsed.infoHash, hex);
    assert.strictEqual(parsed.name, 'Ubuntu ISO (test)');
    assert.ok(parsed.trackers.length >= 1);
  });
  ok('isSafeExternalUrl', () => {
    assert.ok(magnet.isSafeExternalUrl('https://archive.org/details/x'));
    assert.ok(magnet.isSafeExternalUrl('http://example.com/x.torrent'));
    assert.ok(magnet.isSafeExternalUrl('magnet:?xt=urn:btih:abc'));
    assert.ok(!magnet.isSafeExternalUrl('file:///etc/passwd'));
    assert.ok(!magnet.isSafeExternalUrl('javascript:alert(1)'));
    assert.ok(!magnet.isSafeExternalUrl('not a url'));
  });

  // ------------------------------ registry -----------------------------
  const registry = require('../indexers/registry');
  ok('registry allowlist integrity', () => {
    const ids = registry.list();
    assert.ok(ids.length >= 3, 'at least 3 engines');
    assert.strictEqual(new Set(ids).size, ids.length, 'ids are unique');
    for (const m of registry.meta()) {
      assert.ok(m.id && m.name && m.tagline && m.kind);
      assert.ok(typeof m.demo === 'boolean');
      assert.ok(registry.get(m.id), 'meta entry resolves');
    }
    // Every real (non-demo) engine must declare a health probe term so the
    // Settings self-test can exercise it; a future engine without one fails.
    for (const e of registry.ENGINES) {
      if (e.demo) continue;
      assert.ok(e.probe && typeof e.probe === 'string' && e.probe.trim().length > 0, `${e.id} declares a probe term`);
    }
    assert.strictEqual(registry.get('nope'), null);
  });

  // --------------------------- demo engine -----------------------------
  const demo = require('../indexers/demo-curated');
  ok('demo engine returns labeled synthetic results', async () => {
    const ctx = { query: 'ubuntu', network: null, signal: null, timeoutMs: 5000 };
    const results = await demo.search('ubuntu desktop', ctx);
    assert.ok(results.length >= 1, 'found something');
    for (const r of results.slice(0, 5)) {
      assert.ok(r.demo === true, 'demo flagged');
      assert.ok(r.infohash && /^[0-9a-f]{40}$/.test(r.infohash), '40-hex infohash');
      assert.ok(r.magnet && r.magnet.startsWith('magnet:?xt=urn:btih:'), 'magnet built');
      assert.strictEqual(r.sourceId, 'demo-curated');
      assert.ok(r.title);
      assert.ok(['video', 'audio', 'apps', 'games', 'documents', 'other'].includes(r.category));
    }
  });
  ok('demo engine respects query relevance', async () => {
    const ctx = { query: 'zzz-nonsense-qq', network: null, signal: null, timeoutMs: 5000 };
    const nothing = await demo.search('zzz-nonsense-qq', ctx);
    assert.ok(nothing.length === 0, 'garbage query returns nothing');
    const results = await demo.search('blender movie', ctx);
    assert.ok(results.some((r) => /blender/i.test(r.title)), 'keywords match');
  });
  ok('demo infohashes are stable (favorites-safe)', async () => {
    const a = await demo.search('ubuntu', {});
    const b = await demo.search('ubuntu', {});
    assert.deepStrictEqual(a.map((r) => r.infohash), b.map((r) => r.infohash));
  });

  // -------------------- archive.org pure helpers -----------------------
  const archive = require('../indexers/archive-org');
  ok('archive search URL builder + item normalization', () => {
    const url = archive.buildSearchUrl('ubuntu iso');
    assert.ok(url.startsWith('https://archive.org/advancedsearch.php?q=ubuntu%20iso'));
    assert.ok(url.includes('fl[]=identifier'));
    assert.ok(url.includes('rows=50'));
    assert.ok(!url.includes('sort[]'), 'no popularity sort — native relevance order');
    assert.ok(archive.buildSearchUrl('ubuntu', 2).includes('page=2'), 'paged URL');
    assert.ok(archive.buildSearchUrl('ubuntu', 0).includes('page=1'), 'page clamped to 1');
    assert.strictEqual(archive.ROWS, 50);
    const item = archive.normalizeItem(
      { identifier: 'foo_bar', title: 'Foo Bar Movie (1984)', mediatype: 'movies', item_size: '1234567890', downloads: '9876', publicdate: '2020-05-01T00:00:00Z' },
      'foo'
    );
    assert.strictEqual(item.torrentUrl, 'https://archive.org/download/foo_bar/foo_bar_archive.torrent');
    assert.strictEqual(item.pageUrl, 'https://archive.org/details/foo_bar');
    assert.strictEqual(item.downloads, 9876);
    assert.ok(item.thumbnail.includes('/services/img/foo_bar'));
  });
  ok('archive relevance gate: only genuine title/identifier matches pass', () => {
    assert.strictEqual(archive.matchesQuery({ title: 'Ubuntu Desktop ISO', identifier: 'x' }, 'ubuntu'), true);
    assert.strictEqual(archive.matchesQuery({ title: 'Collection of ISO images', identifier: 'ubuntu-24.04-live' }, 'ubuntu'), true, 'identifier slug matches');
    assert.strictEqual(archive.matchesQuery({ title: 'MAME 0.149 ROM Collection', identifier: 'mame-roms' }, 'ubuntu'), false, 'metadata-mention items are gated out');
    assert.strictEqual(archive.matchesQuery({ title: 'The Tiny 11 Build', identifier: 'tiny-11' }, 'ubuntu'), false);
    assert.strictEqual(archive.matchesQuery({ title: 'Ubuntu & Debian guides', identifier: 'x' }, 'debian'), true, 'multi-word query partial match');
    assert.strictEqual(archive.matchesQuery({ title: 'x', identifier: 'y' }, 'ubuntu'), false);
  });
  ok('archive normalization drops junk + non-matching rows', () => {
    assert.strictEqual(archive.normalizeItem({ identifier: '', title: 'x' }, 'q'), null);
    assert.strictEqual(archive.normalizeItem({ identifier: 'i', title: '  ' }, 'q'), null);
    assert.strictEqual(archive.normalizeItem({ identifier: 'mame-roms', title: 'MAME ROMs', downloads: 5, item_size: 100 }, 'ubuntu'), null);
  });
  ok('archive normalization captures creator/year/description/mediatype', () => {
    const item = archive.normalizeItem(
      {
        identifier: 'ubuntu-docs',
        title: 'Ubuntu Docs Collection',
        mediatype: 'texts',
        creator: 'Canonical',
        year: '2024',
        description: `  ${'Long sentence about the collection. '.repeat(40)}  `,
        downloads: 10,
        item_size: 100,
      },
      'ubuntu'
    );
    assert.strictEqual(item.creator, 'Canonical');
    assert.strictEqual(item.year, '2024');
    assert.ok(item.description.length <= 220 && !item.description.includes('  '), 'clipped + whitespace-collapsed');
    assert.strictEqual(item.mediatype, 'texts');
    // Full engine path: base normalizeResult whitelist keeps the fields.
    const base = require('../indexers/base');
    const out = base.normalizeResult(item, { id: 'archive-org', name: 'IA', kind: 'official' });
    assert.strictEqual(out.creator, 'Canonical');
    assert.strictEqual(out.mediatype, 'texts');
  });

  ok('archive sparse-page fallback: title-scoped query composes safely', () => {
    assert.strictEqual(archive.titleScopedQuery('public domain films'), '(public domain films) AND title:(public OR domain OR films)');
    assert.strictEqual(archive.titleScopedQuery('ubuntu'), '(ubuntu) AND title:(ubuntu)');
    assert.strictEqual(archive.titleScopedQuery('  !?  '), '!?', 'no significant tokens → trimmed raw query unchanged');
    assert.ok(!archive.titleScopedQuery('moby dick "quoted"').includes('"'), 'query rebuilt from safe tokens only');
  });
  const doc = (identifier, title) => ({
    identifier,
    title,
    mediatype: 'audio',
    item_size: '1000000',
    downloads: '100',
  });
  ok('archive sparse-page fallback fetches title-scoped page when honest page is thin', async () => {
    let calls = 0;
    const ctx = {
      signal: null,
      network: {
        getJson: async (url) => {
          calls++;
          const scoped = url.includes('AND%20title%3A');
          const docs = scoped
            ? Array.from({ length: 9 }, (_, i) => doc(`film-${i}`, `Public Domain Film ${i}`))
            : [doc('a1', 'Public Domain Archive Box 1'), doc('a2', 'Public Domain Archive Box 2')];
          return { response: { docs, numFound: 900 } };
        },
      },
    };
    const out = await archive.searchPage('public domain films', ctx);
    assert.strictEqual(calls, 2, 'natural page thin → one title-scoped refetch');
    assert.strictEqual(out.results.length, 9, 'richer scoped page wins');
    assert.ok(out.results.every((r) => r.title.includes('Film')), 'scoped results all honest title matches');
  });
  ok('archive does NOT refetch when the natural page already gates rich', async () => {
    let calls = 0;
    const ctx = {
      signal: null,
      network: {
        getJson: async () => {
          calls++;
          return {
            response: { docs: Array.from({ length: 12 }, (_, i) => doc(`u${i}`, `Ubuntu Docs ${i}`)), numFound: 400 },
          };
        },
      },
    };
    const out = await archive.searchPage('ubuntu docs', ctx);
    assert.strictEqual(calls, 1, 'no extra request when page 1 is honest-rich');
    assert.strictEqual(out.results.length, 12);
  });

  // -------------------- distro pure helpers ---------------------------
  const distro = require('../indexers/distro-releases');
  ok('distro size parsing', () => {
    assert.strictEqual(distro.parseSize('2.0G'), 2 * 1024 ** 3);
    assert.strictEqual(distro.parseSize('650M'), 650 * 1024 ** 2);
    assert.strictEqual(distro.parseSize('1.5GB'), 1.5 * 1024 ** 3);
    assert.strictEqual(distro.parseSize('512'), 512);
    assert.strictEqual(distro.parseSize('n/a'), null);
  });
  ok('distro listing parsing finds torrent rows', () => {
    const html =
      '<html><body><a href="../">Parent</a>' +
      '<a href="ubuntu-24.04-desktop-amd64.iso.torrent">ubuntu-24.04-desktop-amd64.iso.torrent</a> <td align="right">2.0G</td>' +
      '<a href="SHA256SUMS">SHA256SUMS</a></body></html>';
    const rows = distro.parseListing(html, 'https://releases.ubuntu.com/24.04/');
    assert.ok(rows.some((r) => r.label.includes('.iso.torrent')));
    const torrent = rows.find((r) => r.label.endsWith('.torrent'));
    assert.ok(torrent, 'torrent row present');
    assert.strictEqual(torrent.size, 2 * 1024 ** 3);
  });
  ok('distro listing keeps directory rows (redesigned releases.ubuntu.com)', () => {
    const html =
      '<a href="/">root</a>' +
      '<a href="../">Parent</a>' +
      '<a href="24.04.2/">24.04.2/</a>' +
      '<a href="noble/">noble/</a>' +
      '<a href="?C=N;O=D">Name</a>' +
      '<a href="ubuntu-24.04.2-desktop-amd64.iso.torrent">ubuntu-24.04.2-desktop-amd64.iso.torrent</a>';
    const rows = distro.parseListing(html, 'https://releases.ubuntu.com/');
    const hrefs = rows.map((r) => r.href);
    assert.ok(hrefs.some((h) => h.endsWith('24.04.2/')), 'dir rows kept');
    assert.ok(hrefs.some((h) => h.endsWith('noble/')), 'codename dir rows kept');
    assert.ok(hrefs.some((h) => h.endsWith('.torrent')), 'file rows kept');
    assert.ok(!hrefs.some((h) => h.endsWith('../') || h.endsWith('root')), 'parent/root links still skipped');
    assert.ok(!hrefs.some((h) => h.includes('?C=N')), 'sort links still skipped');
  });
  ok('distro picks the NEWEST numeric release dirs by version, not document order', () => {
    const dir = (v) => ({ href: `https://releases.ubuntu.com/${v}/` });
    // Scrambled document order incl. codename + junk rows, oldest first like
    // the redesigned page: the picker must choose newest series, one point
    // release each.
    const rows = [
      dir('14.04.6'), dir('noble'), dir('24.04.2'), dir('16.04.7'), dir('?C=N'),
      dir('22.04.5'), dir('24.04.3'), dir('18.04.6'), dir('20.04.6'), { href: 'https://releases.ubuntu.com/SHA256SUMS' },
    ];
    const chosen = distro.pickReleaseDirs(rows).map((h) => h.split('/').slice(-2)[0]);
    assert.deepStrictEqual(chosen, ['24.04.3', '22.04.5', '20.04.6', '18.04.6'], 'newest four series, newest point each');
    const flat = distro.pickReleaseDirs([dir('24.04.2'), dir('24.04.3')]);
    assert.strictEqual(flat.length, 1, 'one dir per series (newest point wins)');
    assert.ok(flat[0].endsWith('24.04.3/'), 'newest point of a series wins');
  });
  ok('distro torrent rows carry the payload (sibling ISO) size, not the .torrent size', () => {
    const rows = distro.torrentRowsWithSizes([
      { label: 'ubuntu-24.04.4-desktop-amd64.iso', size: 6 * 1024 ** 3 },
      { label: 'ubuntu-24.04.4-desktop-amd64.iso.torrent', size: 431104 },
      { label: 'SHA256SUMS', size: 7578 },
      { label: 'debian-13.6.0-amd64-netinst.iso.torrent', size: 55234 }, // Debian bt-cd: no sibling ISO row
    ]);
    assert.strictEqual(rows.length, 2);
    const ubuntu = rows.find((r) => r.label.includes('ubuntu-24.04.4'));
    assert.strictEqual(ubuntu.size, 6 * 1024 ** 3, 'ISO payload size wins when the sibling row exists');
    const debian = rows.find((r) => r.label.startsWith('debian-'));
    assert.strictEqual(debian.size, 55234, 'keeps .torrent size when no sibling row exists');
  });
  // Stub ctx.network so the engine's internal helpers run with zero network.
  const { collectTorrents } = distro;
  ok('distro crawl is LOUD when feeds parse to zero rows (site redesign)', async () => {
    const ctx = { signal: null, network: { getText: async () => '<html><a href="noble/">noble/</a></html>' } };
    await assert.rejects(() => collectTorrents(ctx), /no torrent entries/, 'empty catalog must error, not ok/0');
  });
  ok('distro crawl is LOUD when every feed is unreachable', async () => {
    const ctx = { signal: null, network: { getText: async () => { throw new Error('ECONNREFUSED'); } } };
    await assert.rejects(() => collectTorrents(ctx), /unreachable/);
  });

  // ---------------------------- arch helpers ---------------------------
  const arch = require('../indexers/arch-releases');
  ok('arch feed parsing keeps real ISO releases, drops junk', () => {
    const releases = arch.parseFeed({
      releases: [
        // non-date placeholder entry → dropped
        { version: '0.1', magnet_uri: 'magnet:?xt=urn:btih:x', torrent_url: '/releng/releases/0.1/torrent/', torrent: { file_name: 'arch-0.1.iso' } },
        // real monthly release → kept with absolute URLs + embedded torrent fields
        {
          version: '2026.09.01',
          created: '2026-09-01T17:00:00.000Z',
          magnet_uri: 'magnet:?xt=urn:btih:' + 'a1'.repeat(20),
          torrent_url: '/releng/releases/2026.09.01/torrent/',
          torrent: { file_name: 'archlinux-2026.09.01-x86_64.iso', file_length: 1234567890, info_hash: 'b2'.repeat(20) },
        },
        // missing torrent_url → dropped
        { version: '2026.08.01', magnet_uri: 'magnet:?xt=urn:btih:c3' },
      ],
    });
    assert.strictEqual(releases.length, 1, 'only the dated, torrent-complete release survives');
    assert.strictEqual(releases[0].version, '2026.09.01');
    assert.strictEqual(releases[0].fileName, 'archlinux-2026.09.01-x86_64.iso');
    assert.strictEqual(releases[0].fileLength, 1234567890);
    assert.strictEqual(releases[0].infoHash, 'b2'.repeat(20));
    assert.strictEqual(releases[0].torrentUrl, 'https://archlinux.org/releng/releases/2026.09.01/torrent/');
    assert.strictEqual(releases[0].created, Date.parse('2026-09-01T17:00:00.000Z'));
  });

  // -------------------------- pirate bay helpers -------------------------
  const pb = require('../indexers/piratebay');
  ok('piratebay category mapping (adult always dropped)', () => {
    assert.strictEqual(pb.mapCategory('201'), 'video');
    assert.strictEqual(pb.mapCategory('207'), 'video');
    assert.strictEqual(pb.mapCategory('104'), 'audio');
    assert.strictEqual(pb.mapCategory('301'), 'apps');
    assert.strictEqual(pb.mapCategory('401'), 'games');
    assert.strictEqual(pb.mapCategory('601'), 'documents');
    assert.strictEqual(pb.mapCategory('699'), 'other');
    assert.strictEqual(pb.mapCategory('505'), null, 'adult section dropped');
    assert.strictEqual(pb.mapCategory(''), 'other');
  });
  ok('piratebay row normalization + honesty gate', () => {
    const out = pb.normalizeRow(
      {
        id: '59191690',
        name: 'Ubuntu 22.04 LTS &amp; friends',
        info_hash: '2C6B6858D61DA9543D4231A71DB4B1C9264B0685',
        leechers: '4',
        seeders: '37',
        size: '3654957056',
        added: '1652877231',
        category: '303',
      },
      'ubuntu'
    );
    assert.ok(out, 'real row normalized');
    assert.strictEqual(out.infohash, '2c6b6858d61da9543d4231a71db4b1c9264b0685', 'hex lowercased');
    assert.strictEqual(out.seeders, 37);
    assert.strictEqual(out.leechers, 4);
    assert.strictEqual(out.sizeBytes, 3654957056);
    assert.strictEqual(out.uploadedAt, 1652877231000, 'unix seconds → ms');
    assert.strictEqual(out.title, 'Ubuntu 22.04 LTS & friends', 'entities decoded');
    assert.strictEqual(out.category, 'apps');
    assert.ok(out.torrentUrl.endsWith('/t.php?id=59191690'), 'torrent download URL');
    assert.strictEqual(
      pb.normalizeRow({ name: 'Unrelated movie', info_hash: 'ab'.repeat(20), category: '201' }, 'ubuntu'),
      null,
      'unrelated name gated out'
    );
    assert.strictEqual(pb.normalizeRow({ name: 'Ubuntu X', info_hash: '', category: '201' }, 'ubuntu'), null, 'missing hash dropped');
    assert.strictEqual(pb.normalizeRow({ name: 'Ubuntu XXX', info_hash: 'ab'.repeat(20), category: '505' }, 'ubuntu'), null, 'adult dropped');
    assert.strictEqual(pb.normalizeRow({ name: 'No results returned', info_hash: 'ab'.repeat(20), category: '0' }, 'ubuntu'), null, 'no-results sentinel dropped');
  });
  ok('piratebay cleanRows sorts by seeders, tolerates junk shapes', () => {
    const mk = (i, seeds) => ({
      id: String(i),
      name: `Ubuntu ${i}`,
      info_hash: 'f'.repeat(40),
      seeders: String(seeds),
      leechers: '0',
      size: '100',
      added: '1',
      category: '303',
    });
    const out = pb.cleanRows([mk(1, 5), mk(2, 50), mk(3, 1)], 'ubuntu');
    assert.deepStrictEqual(out.map((r) => r.seeders), [50, 5, 1], 'most-seeded first');
    assert.strictEqual(pb.cleanRows({ error: 'boom' }, 'ubuntu').length, 0, 'non-array response tolerated');
    assert.strictEqual(pb.cleanRows([], 'ubuntu').length, 0);
    assert.ok(pb.cleanRows(Array.from({ length: 80 }, (_, i) => mk(i, i)), 'ubuntu').length <= 50, 'capped at 50');
  });

  // ---------------------------- engine health ---------------------------
  const { runHealthChecks } = require('../lib/health');
  const fakeEngine = (id, impl) => ({
    id,
    name: id,
    tagline: '',
    kind: 'official',
    demo: false,
    probe: `probe-${id}`,
    search: async () => impl(),
  });
  ok('health: healthy engine reports ok with count + latency shape', async () => {
    const out = await runHealthChecks({
      registry: { ENGINES: [fakeEngine('a', () => [{ title: 'match', sourceId: 'a', itemId: 'x' }])] },
      network: null,
      signal: null,
    });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].engineId, 'a');
    assert.strictEqual(out[0].ok, true);
    assert.strictEqual(out[0].count, 1);
    assert.ok(out[0].latencyMs >= 0 && out[0].at > 0, 'latency + timestamp present');
  });
  ok('health: zero-result probe is a FAILURE (silent ok/0 tripwire)', async () => {
    const out = await runHealthChecks({
      registry: { ENGINES: [fakeEngine('a', () => [])] },
      network: null,
      signal: null,
    });
    assert.strictEqual(out[0].ok, false);
    assert.match(out[0].error, /returned 0 results/);
  });
  ok('health: throwing engine fails with message; demo (no probe) excluded; others still run', async () => {
    const out = await runHealthChecks({
      registry: {
        ENGINES: [
          fakeEngine('good', () => [{ title: 'm' }]),
          fakeEngine('bad', () => {
            throw new Error('boom');
          }),
          { id: 'demo', name: 'Demo', kind: 'demo', demo: true, search: async () => [] }, // no probe
        ],
      },
      network: null,
      signal: null,
    });
    assert.deepStrictEqual(
      out.map((r) => r.engineId),
      ['good', 'bad'],
      'order follows ENGINES, demo excluded'
    );
    assert.strictEqual(out[1].ok, false);
    assert.match(out[1].error, /boom/);
    assert.strictEqual(out[0].ok, true);
  });

  // ---------------------------- orchestrator ---------------------------
  const { Storage } = require('../lib/storage');
  const { runSearch, keyOf, sortResults, mergeInto, mergeIncremental } = require('../lib/orchestrator');

  ok('keyOf: infohash dedupes across sources, else source-scoped', () => {
    const ih = 'ab'.repeat(20);
    assert.strictEqual(keyOf({ sourceId: 'a', itemId: 'x', infohash: ih }), keyOf({ sourceId: 'b', itemId: 'y', infohash: ih }));
    assert.notStrictEqual(keyOf({ sourceId: 'a', itemId: 'x' }), keyOf({ sourceId: 'b', itemId: 'x' }));
    assert.strictEqual(keyOf({ sourceId: 'a', itemId: 'x' }), keyOf({ sourceId: 'a', itemId: 'x' }));
  });

  ok('mergeInto collapses duplicates and keeps best + sources', () => {
    const ih = 'cd'.repeat(20);
    const map = new Map();
    mergeInto(map, {
      title: 'Same torrent', sourceId: 'srcA', sourceLabel: 'A', infohash: ih, seeders: 10, sizeBytes: 100, magnet: 'm1', torrentUrl: 'u1', category: 'video',
    });
    mergeInto(map, {
      title: 'Same torrent', sourceId: 'srcB', sourceLabel: 'B', infohash: ih, seeders: 200, sizeBytes: 50, magnet: 'm2', torrentUrl: 'u2', category: 'other', demo: false,
    });
    const [merged] = [...map.values()];
    assert.strictEqual(merged.seeders, 200, 'max seeders win');
    assert.strictEqual(merged.sizeBytes, 100, 'max size wins');
    assert.strictEqual(merged.category, 'video', 'specific category wins');
    assert.strictEqual(merged.sources.length, 2, 'both sources remembered');
    assert.strictEqual(merged.demo, false);
    assert.strictEqual(merged.sourceId, 'srcA', 'representative source identity kept');
    assert.strictEqual(keyOf(merged), `btih:${ih}`, 'merged entry keyOf is stable');
  });
  ok('merge carries rich catalog metadata first-seen-wins', () => {
    const ih = 'ef'.repeat(20);
    const map = new Map();
    mergeInto(map, {
      title: 'Film', sourceId: 'archive-org', itemId: 'film-x', infohash: ih,
      creator: 'Orson Welles', year: '1941', mediatype: 'movies', description: 'first',
    });
    mergeInto(map, {
      title: 'Film', sourceId: 'other', itemId: 'y', infohash: ih,
      creator: 'Wrong Creator', mediatype: 'texts', description: 'dup',
    });
    const [merged] = [...map.values()];
    assert.strictEqual(merged.creator, 'Orson Welles', 'creator first-seen-wins');
    assert.strictEqual(merged.year, '1941');
    assert.strictEqual(merged.mediatype, 'movies', 'mediatype first-seen-wins');
    assert.strictEqual(merged.description, 'first');
  });

  ok('health storage round-trips', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-health-'));
    const s2 = new Storage(tmp);
    assert.deepStrictEqual(s2.getHealth(), []);
    const recs = [{ engineId: 'archive-org', ok: true, count: 4, latencyMs: 900, error: null, at: Date.now() }];
    s2.setHealth(recs);
    assert.deepStrictEqual(s2.getHealth(), recs);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  ok('favorites round-trip for infohash-less (source-scoped) results', () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-test2-'));
    const s2 = new Storage(tmp2);
    const archiveLike = {
      sourceId: 'archive-org', itemId: 'some_identifier', infohash: null, magnet: null,
      torrentUrl: 'https://archive.org/download/x/x_archive.torrent', title: 'An archive item', sizeBytes: 42,
    };
    const first = s2.toggleFavorite({ ...archiveLike, key: keyOf(archiveLike) });
    assert.strictEqual(first.added, true);
    const stored = s2.getFavorites()[0];
    assert.strictEqual(keyOf(stored), keyOf(archiveLike), 'recomputed key from stored favorite matches');
    const second = s2.toggleFavorite({ ...stored, key: keyOf(stored) });
    assert.strictEqual(second.added, false, 'removal by stored favorite works');
    assert.strictEqual(s2.getFavorites().length, 0);
    s2.flush();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350); // let debounced writes settle
    fs.rmSync(tmp2, { recursive: true, force: true });
  });

  // Fake registry exercising the fan-out path with one failing engine.
  const fakeRegistry = {
    get: (id) => ({
      id,
      search: async (query, ctx) => {
        if (id === 'failing') throw new Error('boom');
        return [
          { title: `${query} thing`, sourceId: id, sourceLabel: id, itemId: '1', sizeBytes: 1, seeders: 5 },
          { title: 'Duplicate across sources', sourceId: id, sourceLabel: id, itemId: 'dup', infohash: 'ef'.repeat(20), seeders: 7 },
        ];
      },
    }),
  };

  ok('runSearch: parallel merge, engine errors isolated, no hang', async () => {
    const progress = [];
    const payload = await runSearch({
      query: 'ubuntu',
      engineIds: ['good-a', 'good-b', 'failing'],
      registry: fakeRegistry,
      network: null,
      signal: null,
      onProgress: (snap) => progress.push(snap),
    });
    assert.ok(payload, 'not aborted');
    assert.strictEqual(payload.stats.okEngines, 2);
    assert.strictEqual(payload.stats.totalEngines, 3);
    assert.strictEqual(payload.perEngine.failing.status, 'error');
    assert.ok(payload.perEngine.failing.error.includes('boom'));
    // good-a + good-b each emitted "ubuntu thing" (source-scoped dup) AND a
    // shared infohash entry -> dedupe should collapse the shared one.
    const dup = payload.results.find((r) => r.infohash === 'ef'.repeat(20));
    assert.ok(dup, 'shared infohash present');
    assert.strictEqual(dup.sources.length, 2, 'collapsed from both engines');
    assert.ok(payload.results.length >= 3);
    assert.ok(progress.length >= 3, 'progress after each settle');
  });

  ok('runSearch: cancellation aborts silently', async () => {
    const ac = new AbortController();
    ac.abort();
    const payload = await runSearch({
      query: 'ubuntu', engineIds: ['good-a'], registry: fakeRegistry, network: null, signal: ac.signal, onProgress: () => {},
    });
    assert.strictEqual(payload, null);
  });

  ok('runSearch: short query rejected', async () => {
    await assert.rejects(
      runSearch({ query: 'x', engineIds: ['good-a'], registry: fakeRegistry, network: null, signal: null, onProgress: () => {} }),
      /at least 2 characters/
    );
  });

  ok('runSearch: no engines rejected', async () => {
    await assert.rejects(
      runSearch({ query: 'ubuntu', engineIds: [], registry: fakeRegistry, network: null, signal: null, onProgress: () => {} }),
      /No search engines/
    );
  });

  ok('sortResults modes', () => {
    const list = [
      { title: 'big', seeders: 1, sizeBytes: 300, uploadedAt: 1 },
      { title: 'popular', seeders: 900, sizeBytes: 10, uploadedAt: 3 },
      { title: 'nope', seeders: null, sizeBytes: 500, uploadedAt: 2 },
    ];
    const bySeeders = sortResults(list, 'seeders').map((r) => r.title);
    assert.deepStrictEqual(bySeeders, ['popular', 'big', 'nope']);
    assert.deepStrictEqual(sortResults(list, 'size').map((r) => r.title), ['nope', 'big', 'popular']);
    assert.deepStrictEqual(sortResults(list, 'newest').map((r) => r.title), ['popular', 'nope', 'big']);
  });

  ok('default sort: real results always rank above demo fixtures', () => {
    const list = [
      { title: 'demo shiny', demo: true, seeders: 999, relevance: 0.9, sizeBytes: 1 },
      { title: 'real match', demo: false, seeders: 2, relevance: 0.4, sizeBytes: 100 },
      { title: 'real big generic', demo: false, seeders: null, relevance: 0, sizeBytes: 10 ** 9 },
    ];
    const bySeeders = sortResults(list, 'seeders').map((r) => r.title);
    assert.deepStrictEqual(bySeeders, ['real match', 'real big generic', 'demo shiny'], 'demo cannot outrank real results');
  });

  ok('mergeIncremental: next page merges deduped into the shown list', () => {
    const ih = '12'.repeat(20);
    const src = (sid, item) => ({ sourceId: sid, itemId: item, demo: false });
    const shown = [
      { key: `btih:${ih}`, title: 'Duplicate across pages', sourceId: 'archive-org', itemId: 'a', infohash: ih, seeders: 5, sizeBytes: 10, relevance: 0.5, sources: [src('archive-org', 'a')] },
      { key: 'archive-org:b', title: 'Already shown item', sourceId: 'archive-org', itemId: 'b', infohash: null, seeders: null, sizeBytes: 30, relevance: 0.7, sources: [src('archive-org', 'b')] },
    ];
    const incoming = [
      { title: 'Duplicate across pages', sourceId: 'archive-org', itemId: 'a', infohash: ih, seeders: 5, sizeBytes: 10, relevance: 0.5 },
      { title: 'Fresh from page 2', sourceId: 'archive-org', itemId: 'c', infohash: null, sizeBytes: 20, relevance: 0.9 },
      { title: 'Another fresh card', sourceId: 'archive-org', itemId: 'd', infohash: null, sizeBytes: 5, relevance: 0.85 },
    ];
    const { results, added } = mergeIncremental(shown, incoming);
    assert.strictEqual(added, 2, 'only genuinely new cards counted');
    assert.strictEqual(results.length, 4, 'duplicates collapsed');
    const ids = results.map((r) => r.itemId);
    assert.ok(ids.includes('c') && ids.includes('d') && ids.includes('a'));
    assert.ok(results.every((r) => !r.demo), 'honesty ordering rules preserved');
  });

  ok('default sort: relevance beats size among seeder-less real results', () => {
    const list = [
      { title: 'big generic', demo: false, seeders: null, relevance: 0.1, sizeBytes: 10 ** 10 },
      { title: 'small perfect', demo: false, seeders: null, relevance: 0.9, sizeBytes: 10 },
    ];
    assert.deepStrictEqual(sortResults(list, 'seeders').map((r) => r.title), ['small perfect', 'big generic']);
  });

  // ------------------------------ storage ------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-test-'));
  const store = new Storage(tmp);
  ok('storage: prefs defaults + update merges proxy', () => {
    assert.strictEqual(store.getPrefs().proxy.enabled, false);
    store.updatePrefs({ proxy: { enabled: true, host: '127.0.0.1', port: 9050 } });
    assert.strictEqual(store.getPrefs().proxy.enabled, true);
    assert.strictEqual(store.getPrefs().proxy.port, 9050);
    assert.strictEqual(store.getPrefs().proxy.type, 'socks5', 'unset keys preserved');
    store.updatePrefs({ engines: { 'demo-curated': false } });
    assert.strictEqual(store.getPrefs().engines['demo-curated'], false);
  });
  ok('storage: history dedupes by query and caps', () => {
    store.pushHistory({ q: 'ubuntu', count: 4 });
    store.pushHistory({ q: 'blender', count: 7 });
    store.pushHistory({ q: 'ubuntu', count: 9 });
    const hist = store.getHistory();
    assert.strictEqual(hist.length, 2);
    assert.strictEqual(hist[0].q, 'ubuntu');
    assert.strictEqual(hist[0].count, 9);
  });
  ok('storage: favorites toggle + key round-trip', () => {
    const result = {
      key: keyOf({ sourceId: 'demo-curated', itemId: 'demo-1', infohash: 'ab'.repeat(20) }),
      title: 'Demo favorite',
      sourceId: 'demo-curated',
      infohash: 'ab'.repeat(20),
      magnet: 'magnet:?xt=urn:btih:' + 'ab'.repeat(20),
    };
    const first = store.toggleFavorite(result);
    assert.strictEqual(first.added, true);
    assert.strictEqual(store.getFavorites().length, 1);
    const second = store.toggleFavorite(result);
    assert.strictEqual(second.added, false, 'second toggle removes');
    assert.strictEqual(store.getFavorites().length, 0);
  });
  ok('storage: survives reload (file persistence)', () => {
    store.flush();
    const reloaded = new Storage(tmp);
    assert.strictEqual(reloaded.getPrefs().proxy.enabled, true);
    assert.strictEqual(reloaded.getHistory().length, 2);
  });
  store.flush();
  await new Promise((r) => setTimeout(r, 350)); // let debounced writes settle
  fs.rmSync(tmp, { recursive: true, force: true });

  // --------------------------- direct downloads -------------------------
  const { sanitizeItemFiles, suggestedName } = require('../lib/downloads');
  const dlNetwork = require('../lib/network');
  dlNetwork.setProxyConfig({ enabled: false }); // direct route for the server test

  ok('download host allowlist (exact + subdomain, never lookalikes)', () => {
    assert.strictEqual(dlNetwork.hostAllowed('archive.org'), true);
    assert.strictEqual(dlNetwork.hostAllowed('ia600000.us.archive.org'), true, 'archive.org subdomain allowed');
    assert.strictEqual(dlNetwork.hostAllowed('releases.ubuntu.com'), true);
    assert.strictEqual(dlNetwork.hostAllowed('archive.archlinux.org'), true);
    assert.strictEqual(dlNetwork.hostAllowed('example.com'), false);
    assert.strictEqual(dlNetwork.hostAllowed('archive.org.evil.com'), false, 'suffix-lookalike denied');
    assert.strictEqual(dlNetwork.hostAllowed('archive-org.com'), false);
    assert.strictEqual(dlNetwork.hostAllowed(''), false);
    assert.strictEqual(dlNetwork.hostAllowed(null), false);
    assert.strictEqual(dlNetwork.hostAllowed('127.0.0.1', ['127.0.0.1', 'example.com']), true, 'explicit override list works');
    assert.strictEqual(dlNetwork.hostAllowed('archive.org', ['127.0.0.1']), false);
  });

  ok('download suggestedName: last segment, decoded, sanitized', () => {
    assert.strictEqual(suggestedName('https://archive.org/download/foo_bar/My%20File%20(1).iso'), 'My File (1).iso');
    assert.strictEqual(suggestedName('https://x.example/dir/evil%3Fname%3A.bin'), 'evil_name_.bin');
    assert.strictEqual(suggestedName('https://x.example/'), 'download');
    assert.strictEqual(suggestedName('not a url'), 'download');
  });

  ok('item file sanitizer drops Archive bookkeeping junk + caps size', () => {
    const files = [
      { name: '__ia_thumb.jpg', size: 100 },
      { name: 'movie_archive.torrent', size: 500 },
      { name: 'movie_files.xml', size: 900 },
      { name: 'movie_meta.xml', size: 900 },
      { name: 'movie_reviews.xml', size: 900 },
      { name: 'big.mp4', size: 1000, format: 'MPEG4' },
      { name: 'cover.png', size: 50, format: 'PNG' },
      { name: 'empty.dat', size: 0 },
      { name: 'huge.iso', size: 101 * 1024 ** 3 },
    ];
    const out = sanitizeItemFiles(files, 'some_item');
    assert.deepStrictEqual(out.map((f) => f.name), ['big.mp4', 'cover.png'], 'junk + zero + >100GB dropped');
    assert.strictEqual(out[0].url, 'https://archive.org/download/some_item/big.mp4');
    assert.strictEqual(out[0].size, 1000);
    assert.strictEqual(sanitizeItemFiles(files, '../evil').length, 0, 'item id with slashes refused');
    assert.strictEqual(sanitizeItemFiles([{ name: 'a b+c.mp3', size: 9, format: 'MP3' }], 'x')[0].url, 'https://archive.org/download/x/a%20b%2Bc.mp3', 'name URL-encoded');
  });

  ok('files.xml manifest parser handles child/attr sizes + junk', () => {
    const { parseFilesXml } = require('../lib/downloads');
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<files>' +
      '<file name="01 - chapter.mp3" source="original">' +
      '<format>VBR MP3</format><size>1234567</size>' +
      '</file>' +
      '<file name="cover.jpg" size="4321" format="JPEG" />' +
      '<file name="no-size.txt" />' +
      '<file />' +
      '</files>';
    const out = parseFilesXml(xml);
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out[0].name, '01 - chapter.mp3');
    assert.strictEqual(out[0].size, 1234567, 'child <size> element read');
    assert.strictEqual(out[1].name, 'cover.jpg');
    assert.strictEqual(out[1].size, 4321, 'size attribute read');
    assert.strictEqual(out[2].name, 'no-size.txt');
    assert.strictEqual(out[2].size, null);
  });

  ok('streamToFile downloads through a real local server with byte progress', async () => {
    const http = require('http');
    const payload = Buffer.alloc(256 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const server = http.createServer((_req, res) => {
      res.setHeader('content-length', payload.length);
      res.end(payload);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const dest = path.join(os.tmpdir(), `torrentor-dl-test-${Date.now()}.bin`);
    const bytes = [];
    let total = null;
    try {
      const out = await dlNetwork.streamToFile({
        url: `http://127.0.0.1:${port}/payload.bin`,
        destPath: dest,
        allowHosts: ['127.0.0.1'],
        onBytes: (received, t) => {
          bytes.push(received);
          total = t;
        },
      });
      assert.strictEqual(out.status, 200);
      assert.strictEqual(out.bytes, payload.length);
      assert.strictEqual(total, payload.length, 'content-length surfaced');
      assert.strictEqual(fs.readFileSync(dest).equals(payload), true, 'file bytes match payload');
      assert.ok(bytes.length >= 1 && bytes[bytes.length - 1] === payload.length, 'progress reported');
    } finally {
      server.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    }
  });

  ok('streamToFile refuses non-allowlisted hosts and aborts cleanly', async () => {
    const http = require('http');
    let hit = 0;
    const server = http.createServer((_req, res) => res.end('x'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const dest = path.join(os.tmpdir(), `torrentor-dl-deny-${Date.now()}.bin`);
    try {
      await assert.rejects(
        dlNetwork.streamToFile({ url: `http://127.0.0.1:${port}/x.bin`, destPath: dest, allowHosts: ['example.com'] }),
        /not allowed/
      );
      assert.strictEqual(hit, 0);
      const ac = new AbortController();
      ac.abort();
      await assert.rejects(
        dlNetwork.streamToFile({ url: `http://127.0.0.1:${port}/y.bin`, destPath: dest, allowHosts: ['127.0.0.1'], signal: ac.signal }),
        /cancelled/
      );
      assert.strictEqual(fs.existsSync(dest), false, 'partial file removed on abort');
    } finally {
      server.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    }
  });

  // ------------------------- download manager -------------------------
  const dm = require('../lib/downloads');
  const dmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-dlmgr-'));

  ok('demo files: picker rows, labels, clearly-marked payload', () => {
    const files = dm.demoFiles();
    assert.strictEqual(files.length, 2);
    assert.deepStrictEqual(files.map((f) => f.name), ['demo-content.txt', 'about-this-demo.txt']);
    assert.ok(files.every((f) => /^demo:/.test(f.url)), 'demo: urls, never a network host');
    assert.strictEqual(files[0].format, 'Demo text');
    assert.strictEqual(dm.demoLabel('demo:readme'), 'about-this-demo.txt');
    const head = dm.demoPayload('demo:readme').toString('utf8').slice(0, 300);
    assert.ok(head.includes('TORRENTOR DEMO FILE') && head.includes('NOT real content'), 'payload is clearly labeled as synthetic');
  });

  const waitFor = async (cond, ms = 2500) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timed out waiting for download state');
  };

  ok('scheduler: MAX_ACTIVE cap queues the third, FIFO drains it', async () => {
    dm.clearFinished();
    const seen = [];
    const watch = (t, kind) => seen.push(`${t.id}:${kind}`);
    const mk = (n) => path.join(dmDir, `queue-${n}.txt`);
    const a = dm.startDownload('demo:content', mk('a'), watch);
    const b = dm.startDownload('demo:content', mk('b'), watch);
    const c = dm.startDownload('demo:readme', mk('c'), watch);
    assert.ok(dm.MAX_ACTIVE === 2, 'suite assumes a 2-slot queue');
    assert.strictEqual(a.status, 'downloading');
    assert.strictEqual(b.status, 'downloading');
    assert.strictEqual(c.status, 'queued', 'third transfer waits for a slot');
    assert.ok(seen.includes(`${c.id}:queued`), 'queued transition broadcast');
    await waitFor(() => dm.getDownload(c.id) && dm.getDownload(c.id).status === 'done');
    const snap = dm.snapshot();
    const my = snap.filter((t) => t.filePath.startsWith(dmDir));
    assert.strictEqual(my.filter((t) => t.status === 'done').length, 3, 'all three completed');
    assert.ok(seen.includes(`${c.id}:start`), 'queued transfer started once a slot freed');
    for (const n of ['a', 'b', 'c']) assert.ok(fs.readFileSync(mk(n)).length > 0, `file ${n} written`);
    dm.clearFinished();
  });

  ok('scheduler: cancelling a queued transfer removes it without side effects', async () => {
    dm.clearFinished();
    const a = dm.startDownload('demo:content', path.join(dmDir, 'cancel-a.txt'));
    const b = dm.startDownload('demo:content', path.join(dmDir, 'cancel-b.txt'));
    const c = dm.startDownload('demo:readme', path.join(dmDir, 'cancel-c.txt'));
    const before = dm.snapshot().filter((t) => t.filePath.startsWith(dmDir)).length;
    const gone = dm.cancelDownload(c.id);
    assert.ok(gone && gone.id === c.id, 'queued cancel returns the entry');
    assert.ok(!dm.snapshot().some((t) => t.id === c.id), 'queued entry removed from the list');
    await waitFor(() => dm.getDownload(b.id) && dm.getDownload(b.id).status === 'done');
    const after = dm.snapshot().filter((t) => t.filePath.startsWith(dmDir)).length;
    assert.strictEqual(after, before - 1, 'only the cancelled one is gone');
    assert.ok(!fs.existsSync(path.join(dmDir, 'cancel-c.txt')), 'cancelled-queued file never written');
    dm.clearFinished();
  });

  ok('scheduler: retry re-queues a failed transfer under its id (resume hook)', async () => {
    dm.clearFinished();
    const dest = path.join(dmDir, 'retry-fail.bin');
    const t0 = dm.startDownload('http://127.0.0.1:9/never.bin', dest); // host not allowlisted → immediate error
    await waitFor(() => dm.getDownload(t0.id) && dm.getDownload(t0.id).status === 'error');
    assert.ok(!fs.existsSync(dest), 'no final file on failure');
    const retried = dm.retryDownload(t0.id);
    assert.ok(retried && retried.id === t0.id, 'retry keeps the original id (and destination)');
    assert.ok(retried.status === 'downloading' || retried.status === 'queued', 'retry leaves the terminal state');
    assert.strictEqual(retried.error, null);
    // The failure is deterministic, so it errors again — that's fine; the
    // point is the scheduler accepted it back with its .part preserved.
    await waitFor(() => dm.getDownload(t0.id) && dm.getDownload(t0.id).status === 'error');
    dm.clearFinished();
  });

  // --------------------------- network helpers -------------------------
  const network = require('../lib/network');
  ok('validateProxyConfig', () => {
    assert.deepStrictEqual(network.validateProxyConfig({ enabled: false }), { ok: true });
    assert.strictEqual(network.validateProxyConfig({ enabled: true, host: '', port: 1080, type: 'socks5' }).ok, false);
    assert.strictEqual(network.validateProxyConfig({ enabled: true, host: 'x', port: 99999, type: 'socks5' }).ok, false);
    assert.strictEqual(network.validateProxyConfig({ enabled: true, host: 'x', port: 1080, type: 'weird' }).ok, false);
    assert.strictEqual(network.validateProxyConfig({ enabled: true, host: '127.0.0.1', port: 9050, type: 'socks5' }).ok, true);
  });
  network.setProxyConfig({ enabled: false });
  network.setProxyConfig({ enabled: false }); // idempotent no-op

  // Drain async checks (serialized, so call order is preserved), then clean
  // up the download-manager scratch dir now that its writes have finished.
  await serial;
  try {
    fs.rmSync(dmDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  console.log(`\n${passed} checks passed ✔\n`);
  if (failures) {
    console.error(`✗ ${failures} of ${passed + failures} checks FAILED`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\n✗ SMOKE TEST FAILED:', err);
  process.exit(1);
});
