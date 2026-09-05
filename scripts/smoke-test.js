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
  ok('storage: per-source download folders merge and clear independently', async () => {
    const stDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-ddirs-'));
    const dirA = path.join(os.tmpdir(), 'torrentor-folders-a');
    const dirB = path.join(os.tmpdir(), 'torrentor-folders-b');
    const s = new Storage(stDir);
    s.updatePrefs({ downloadDirs: { 'archive-org': dirA } });
    s.updatePrefs({ downloadDirs: { 'distro-releases': dirB } });
    assert.strictEqual(s.getPrefs().downloadDirs['archive-org'], dirA, 'first source kept');
    assert.strictEqual(s.getPrefs().downloadDirs['distro-releases'], dirB, 'second source added without clobbering');
    s.updatePrefs({ downloadDirs: { 'archive-org': '' } }); // clear one source
    assert.strictEqual(s.getPrefs().downloadDirs['archive-org'], '', 'cleared source falls back to last-used');
    assert.strictEqual(s.getPrefs().downloadDirs['distro-releases'], dirB, 'other source untouched');
    await new Promise((r) => setTimeout(r, 320)); // let debounced writes settle
    fs.rmSync(stDir, { recursive: true, force: true });
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

  ok('streamToFile honors a live per-chunk rate limit (token bucket)', async () => {
    const http = require('http');
    const payload = Buffer.alloc(384 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) % 251;
    const server = http.createServer((_req, res) => {
      res.setHeader('content-length', payload.length);
      res.end(payload);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const dest = path.join(os.tmpdir(), `torrentor-dl-rate-${Date.now()}.bin`);
    const seen = [];
    try {
      const t0 = Date.now();
      const out = await dlNetwork.streamToFile({
        url: `http://127.0.0.1:${port}/rate.bin`,
        destPath: dest,
        allowHosts: ['127.0.0.1'],
        rateLimit: () => 256 * 1024, // live getter form (per-transfer limit)
        onBytes: (received) => seen.push(received),
      });
      const elapsedMs = Date.now() - t0;
      assert.strictEqual(out.bytes, payload.length);
      assert.ok(elapsedMs >= 1200, `rate-limited to ~256KB/s but finished in ${elapsedMs}ms`);
      assert.ok(elapsedMs < 12000, `rate-limited download too slow (${elapsedMs}ms)`);
      assert.strictEqual(seen[seen.length - 1], payload.length, 'final progress byte count exact');
      for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], 'progress monotonic');
      assert.strictEqual(fs.readFileSync(dest).length, payload.length, 'file bytes match');
    } finally {
      server.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    }
  });

  ok('streamToFile resumes a partial via HTTP Range when the server supports it', async () => {
    const http = require('http');
    const payload = Buffer.alloc(200 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const ranged = [];
    const server = http.createServer((req, res) => {
      const m = /^bytes=(\d+)-/.exec(req.headers.range || '');
      if (!m) {
        res.setHeader('content-length', payload.length);
        return res.end(payload);
      }
      ranged.push(Number(m[1]));
      const from = Number(m[1]);
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${from}-${payload.length - 1}/${payload.length}`);
      res.setHeader('content-length', payload.length - from);
      res.end(payload.subarray(from));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const dest = path.join(os.tmpdir(), `torrentor-dl-resume-${Date.now()}.bin`);
    try {
      // Simulate an interrupted download: a partial file already on disk.
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest + '.part', payload.subarray(0, 60 * 1024));
      const out = await dlNetwork.streamToFile({
        url: `http://127.0.0.1:${port}/resume.bin`,
        destPath: dest,
        allowHosts: ['127.0.0.1'],
        resumeFrom: 60 * 1024,
      });
      assert.strictEqual(out.status, 206, 'server honored the Range request');
      assert.strictEqual(out.resumedFrom, 60 * 1024);
      assert.strictEqual(out.bytes, 140 * 1024, 'only the missing tail streamed');
      assert.strictEqual(fs.readFileSync(dest).equals(payload), true, 'resumed file byte-identical');
      assert.ok(ranged.includes(60 * 1024), 'Range header actually sent');
    } finally {
      server.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      if (fs.existsSync(dest + '.part')) fs.unlinkSync(dest + '.part');
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

  ok('scheduler: manual queue reorder changes start order (moveQueued)', async () => {
    dm.clearFinished();
    const mk = (n) => path.join(dmDir, `move-${n}.txt`);
    const a = dm.startDownload('demo:content', mk('a'));
    const b = dm.startDownload('demo:content', mk('b'));
    const c = dm.startDownload('demo:readme', mk('c'));
    const d = dm.startDownload('demo:content', mk('d'));
    assert.strictEqual(a.status, 'downloading');
    assert.strictEqual(b.status, 'downloading');
    assert.strictEqual(c.status, 'queued');
    assert.strictEqual(d.status, 'queued');
    // Snapshot reports queued transfers in queue order with queuePos set.
    let snap = dm.snapshot().filter((t) => t.filePath.startsWith(dmDir));
    assert.strictEqual(snap.find((t) => t.id === c.id).queuePos, 0);
    assert.strictEqual(snap.find((t) => t.id === d.id).queuePos, 1);
    assert.strictEqual(snap.find((t) => t.id === a.id).queuePos, -1, 'active transfer not queued');
    // Promote d above c.
    assert.strictEqual(dm.moveQueued(d.id, 'up').id, d.id);
    snap = dm.snapshot().filter((t) => t.filePath.startsWith(dmDir));
    assert.deepStrictEqual(snap.filter((t) => t.status === 'queued').map((t) => t.id), [d.id, c.id], 'd moved ahead of c');
    // Edge no-ops: d already at the head, c at the tail, active a not queued.
    assert.strictEqual(dm.moveQueued(d.id, 'up'), null, 'cannot move above the queue head');
    assert.strictEqual(dm.moveQueued(c.id, 'down'), null, 'cannot move below the queue tail');
    assert.strictEqual(dm.moveQueued(a.id, 'up'), null, 'active download not reorderable');
    // Cancel c (second in line): d must be next to start once a slot frees.
    dm.cancelDownload(c.id);
    await waitFor(() => dm.getDownload(d.id) && dm.getDownload(d.id).status === 'done', 5000);
    assert.ok(!fs.existsSync(mk('c')), 'cancelled queued file never written');
    assert.ok(fs.existsSync(mk('d')), 'promoted transfer completed');
    dm.clearFinished();
  });

  ok('scheduler: moveQueuedTo reorders to an absolute position (drag-and-drop)', async () => {
    dm.clearFinished();
    const mk = (n) => path.join(dmDir, `dnd-${n}.txt`);
    const a = dm.startDownload('demo:content', mk('a'));
    const b = dm.startDownload('demo:content', mk('b'));
    const c = dm.startDownload('demo:readme', mk('c'));
    const d = dm.startDownload('demo:content', mk('d'));
    const e = dm.startDownload('demo:readme', mk('e'));
    assert.strictEqual(a.status, 'downloading');
    assert.strictEqual(b.status, 'downloading');
    assert.strictEqual(c.status, 'queued');
    assert.strictEqual(d.status, 'queued');
    assert.strictEqual(e.status, 'queued');
    const q = () =>
      dm
        .snapshot()
        .filter((t) => t.status === 'queued' && t.filePath.startsWith(dmDir))
        .map((t) => t.id);
    assert.deepStrictEqual(q(), [c.id, d.id, e.id], 'initial queue order');
    // Drag e onto d's slot: e splices into position 1.
    assert.strictEqual(dm.moveQueuedTo(e.id, 1).id, e.id);
    assert.deepStrictEqual(q(), [c.id, e.id, d.id], 'dragged e into d\'s position');
    // Drag c to the tail.
    dm.moveQueuedTo(c.id, 2);
    assert.deepStrictEqual(q(), [e.id, d.id, c.id], 'c dragged to the tail');
    // Same-position no-op + unknown + active rejections.
    assert.strictEqual(dm.moveQueuedTo(e.id, 0), null, 'same position is a no-op');
    assert.strictEqual(dm.moveQueuedTo(999999, 0), null, 'unknown id rejected');
    assert.strictEqual(dm.moveQueuedTo(a.id, 0), null, 'active transfer not draggable');
    await waitFor(() => dm.snapshot().every((t) => t.status === 'done' || t.status === 'error'), 8000);
    dm.clearFinished();
  });

  ok('scheduler: smart order starts the fastest-finishing file first', async () => {
    dm.clearFinished();
    dm.setSmartOrder(true);
    const mk = (n) => path.join(dmDir, `smart-${n}.txt`);
    // Both demo payloads expose their exact size up front: the 1.5 KB
    // readme queues ahead of the 768 KB content file under smart order.
    const a = dm.startDownload('demo:content', mk('a'));
    const b = dm.startDownload('demo:content', mk('b'));
    const c = dm.startDownload('demo:content', mk('c'));
    const d = dm.startDownload('demo:readme', mk('d'));
    assert.strictEqual(a.status, 'downloading');
    assert.strictEqual(b.status, 'downloading');
    const q = () => dm.snapshot().filter((t) => t.status === 'queued' && t.filePath.startsWith(dmDir)).map((t) => t.id);
    assert.deepStrictEqual(q(), [d.id, c.id], 'smallest remaining (readme) queues first');
    // Unknown-size HTTP transfers sort AFTER known sizes, arrival order kept.
    const e = dm.startDownload('http://127.0.0.1:9/never.bin', mk('e'));
    const f = dm.startDownload('http://127.0.0.1:9/never2.bin', mk('f'));
    assert.deepStrictEqual(q(), [d.id, c.id, e.id, f.id], 'unknown sizes stay behind known, FIFO among themselves');
    // A queued transfer's limit re-sorts: a 570 B readme at 1 B/s (~570 s)
    // drops behind a 768 KB content file at 2 KB/s (~384 s).
    const g = dm.startDownload('demo:readme', mk('g'));
    assert.deepStrictEqual(q(), [d.id, g.id, c.id, e.id, f.id], 'tiny files rank by size, unknowns last');
    dm.setSpeedLimit(c.id, 2048);
    dm.setSpeedLimit(g.id, 1);
    assert.deepStrictEqual(q(), [d.id, c.id, g.id, e.id, f.id], 'limit change re-sorts the queue');
    // Manual moves are overridden while smart order is on.
    dm.moveQueuedTo(c.id, 0);
    assert.deepStrictEqual(q(), [d.id, c.id, g.id, e.id, f.id], 'smart order re-applies after a manual move');
    dm.setSmartOrder(false);
    dm.moveQueuedTo(c.id, 0);
    assert.deepStrictEqual(q(), [c.id, d.id, g.id, e.id, f.id], 'with smart order off, manual order sticks');
    // Lift every limit so the queue drains fast (never strand a paced file).
    for (const t of dm.snapshot().filter((x) => x.filePath.startsWith(dmDir))) dm.setSpeedLimit(t.id, 0);
    await waitFor(() => dm.snapshot().every((t) => t.status === 'done' || t.status === 'error'), 8000);
    dm.clearFinished();
  });

  ok('scheduler: smart order batches equal-ETA files by destination folder', async () => {
    dm.clearFinished();
    dm.setSmartOrder(true);
    const fa = path.join(dmDir, 'tie-a');
    const fb = path.join(dmDir, 'tie-b');
    fs.mkdirSync(fa, { recursive: true });
    fs.mkdirSync(fb, { recursive: true });
    // Two paced actives hold the slots; four identical 1.5 KB readme files
    // queue with interleaved destinations. Identical size + identical rate
    // means every ETA is exactly equal, so the folder-aware tie-break must
    // cluster folder-a together then folder-b, not keep arrival order.
    const a = dm.startDownload('demo:content', path.join(fa, 'a.txt'), null, { maxBytesPerSec: 51200 });
    const b = dm.startDownload('demo:content', path.join(fb, 'b.txt'), null, { maxBytesPerSec: 51200 });
    const x1 = dm.startDownload('demo:readme', path.join(fa, 'x1.txt'));
    const x2 = dm.startDownload('demo:readme', path.join(fb, 'x2.txt'));
    const x3 = dm.startDownload('demo:readme', path.join(fa, 'x3.txt'));
    const x4 = dm.startDownload('demo:readme', path.join(fb, 'x4.txt'));
    assert.strictEqual(a.status, 'downloading');
    assert.strictEqual(b.status, 'downloading');
    const q = () =>
      dm
        .snapshot()
        .filter((t) => t.status === 'queued' && t.filePath.startsWith(dmDir))
        .map((t) => t.filePath);
    assert.deepStrictEqual(
      q(),
      [path.join(fa, 'x1.txt'), path.join(fa, 'x3.txt'), path.join(fb, 'x2.txt'), path.join(fb, 'x4.txt')],
      'equal-ETA files cluster by destination folder, arrival within folder'
    );
    for (const t of dm.snapshot().filter((x) => x.filePath.startsWith(dmDir))) dm.setSpeedLimit(t.id, 0);
    await waitFor(() => dm.snapshot().every((t) => t.status === 'done' || t.status === 'error'), 10000);
    dm.clearFinished();
    dm.setSmartOrder(false);
    fs.rmSync(fa, { recursive: true, force: true });
    fs.rmSync(fb, { recursive: true, force: true });
  });

  ok('scheduler: restored queue ranks by learned per-file speed (rateBps)', async () => {
    dm.clearFinished();
    dm.setSmartOrder(true);
    const mk = (n) => path.join(dmDir, `learn-${n}.txt`);
    // Occupy both slots with paced actives so restored records queue.
    const a = dm.startDownload('demo:content', mk('a'), null, { maxBytesPerSec: 51200 });
    const b = dm.startDownload('demo:content', mk('b'), null, { maxBytesPerSec: 51200 });
    // The same 1.5 KB file restored twice: identical size, so its rank is
    // decided purely by the per-file speed each transfer measured before
    // quitting (rateBps, persisted with the resume record).
    dm.restorePending(
      [
        { url: 'demo:readme', filePath: mk('slow'), maxBytesPerSec: 0, rateBps: 60, folderRule: '' },
        { url: 'demo:readme', filePath: mk('fast'), maxBytesPerSec: 0, rateBps: 120000, folderRule: '' },
      ],
      () => {}
    );
    // Two more paced actives + two equal-speed restores (the control: ties
    // among equal learned speeds keep arrival order).
    const c = dm.startDownload('demo:content', mk('c'), null, { maxBytesPerSec: 51200 });
    const d = dm.startDownload('demo:content', mk('d'), null, { maxBytesPerSec: 51200 });
    dm.restorePending(
      [
        { url: 'demo:readme', filePath: mk('f1'), maxBytesPerSec: 0, rateBps: 60000, folderRule: '' },
        { url: 'demo:readme', filePath: mk('f2'), maxBytesPerSec: 0, rateBps: 60000, folderRule: '' },
      ],
      () => {}
    );
    const q = () =>
      dm
        .snapshot()
        .filter((t) => t.status === 'queued' && t.filePath.startsWith(dmDir))
        .map((t) => t.filePath);
    // fast ≈ 0.005 s, f1/f2 ≈ 0.009 s, slow ≈ 9.5 s, paced c/d ≈ 15 s.
    assert.deepStrictEqual(
      q(),
      [mk('fast'), mk('f1'), mk('f2'), mk('slow'), mk('c'), mk('d')],
      'learned per-file speed outranks arrival; equal speeds stay stable'
    );
    for (const t of dm.snapshot().filter((x) => x.filePath.startsWith(dmDir))) dm.setSpeedLimit(t.id, 0);
    await waitFor(() => dm.snapshot().every((t) => t.status === 'done' || t.status === 'error'), 10000);
    dm.clearFinished();
    dm.setSmartOrder(false);
  });

  ok('scheduler: snapshot exposes the smart-order reasoning on queued chips', async () => {
    dm.clearFinished();
    dm.setSmartOrder(true);
    const mk = (n) => path.join(dmDir, `eta-${n}.txt`);
    const a = dm.startDownload('demo:content', mk('a'), null, { maxBytesPerSec: 51200 });
    const b = dm.startDownload('demo:content', mk('b'), null, { maxBytesPerSec: 51200 });
    // A limited readme: ETA = remaining bytes ÷ its exact enforced limit.
    const c = dm.startDownload('demo:readme', mk('c'), null, { maxBytesPerSec: 1024 });
    // An HTTP transfer whose size arrives only once it streams.
    const d = dm.startDownload('http://127.0.0.1:9/eta-unknown.bin', mk('d'));
    assert.strictEqual(a.status, 'downloading');
    assert.strictEqual(b.status, 'downloading');
    assert.strictEqual(c.status, 'queued');
    assert.strictEqual(d.status, 'queued');
    const chipOf = (id) => dm.snapshot().find((t) => t.id === id);
    const cChip = chipOf(c.id);
    assert.strictEqual(cChip.etaBasis, 'limit', 'an enforced limit is the rate basis');
    assert.strictEqual(cChip.etaRateBps, 1024, 'rate = the limit');
    const readmeBytes = dm.demoPayload('demo:readme').length;
    assert.ok(Math.abs(cChip.etaSeconds - readmeBytes / 1024) < 1e-9, `ETA = remaining ÷ limit (${cChip.etaSeconds}s for ${readmeBytes} B)`);
    assert.strictEqual(cChip.etaRemaining, readmeBytes, 'remaining = total − received (0 for a fresh queue entry)');
    assert.strictEqual(cChip.etaTotal, readmeBytes, 'total bytes exposed alongside the ETA');
    const dChip = chipOf(d.id);
    assert.strictEqual(dChip.etaBasis, 'size-unknown', 'unknown size → no estimate, honest basis');
    assert.strictEqual(dChip.etaSeconds, null, 'no ETA while the size is unknown');
    assert.strictEqual(dChip.etaRemaining, null, 'unknown-size files expose no byte math');
    assert.strictEqual(dChip.etaTotal, null, 'unknown-size files expose no byte math');
    // Active chips carry the SAME live reasoning under smart order: the
    // paced 50 KB/s transfer shows its limit basis and a shrinking ETA.
    const aChip = chipOf(a.id);
    assert.strictEqual(aChip.etaBasis, 'limit', 'a paced active chip shows its limit basis');
    assert.ok(aChip.etaSeconds > 0 && aChip.etaSeconds <= 16, `active ETA is live and bounded (${aChip.etaSeconds}s for 768 KB @ 50 KB/s)`);
    assert.strictEqual(aChip.etaRateBps, 51200, 'active rate = its enforced limit');
    dm.setSmartOrder(false);
    assert.ok(!('etaBasis' in chipOf(c.id)), 'eta fields disappear when smart order is off');
    assert.ok(!('etaBasis' in chipOf(a.id)), 'active eta fields disappear when smart order is off');
    for (const t of dm.snapshot().filter((x) => x.filePath.startsWith(dmDir))) dm.setSpeedLimit(t.id, 0);
    await waitFor(() => dm.snapshot().every((t) => t.status === 'done' || t.status === 'error'), 10000);
    dm.clearFinished();
  });

  ok('scheduler: what-if preview re-ranks without mutating the queue', async () => {
    dm.clearFinished();
    dm.setSmartOrder(true);
    const mk = (n) => path.join(dmDir, `wf-${n}.txt`);
    // Both active slots paced, two queued 768 KB demo files at the same
    // 100 KB/s limit → equal ETAs → arrival order (distinct smoke dirs).
    dm.startDownload('demo:content', mk('a'), null, { maxBytesPerSec: 51200 });
    dm.startDownload('demo:content', mk('b'), null, { maxBytesPerSec: 51200 });
    const p1 = dm.startDownload('demo:content', mk('p1'), null, { maxBytesPerSec: 102400 });
    const p2 = dm.startDownload('demo:content', mk('p2'), null, { maxBytesPerSec: 102400 });
    assert.strictEqual(p1.status, 'queued');
    assert.strictEqual(p2.status, 'queued');
    const q = () => dm.snapshot().filter((t) => t.status === 'queued').map((t) => t.id);
    const payload = dm.demoPayload('demo:content').length;
    // Baseline preview mirrors the live queue, with full chip-level detail.
    const base = dm.previewQueueOrder({});
    assert.deepStrictEqual(base.map((r) => r.id), [p1.id, p2.id], 'baseline preview = live queue order (equal ETAs, arrival order)');
    assert.strictEqual(base[0].etaBasis, 'limit', 'preview rows carry the same basis words as chips');
    assert.strictEqual(base[0].etaRateBps, 102400, 'preview rate = current limit');
    assert.ok(Math.abs(base[0].etaSeconds - payload / 102400) < 1e-9, 'preview ETA = remaining ÷ limit');
    assert.strictEqual(base[0].limit, 102400, 'the real limit is reported alongside the preview');
    // Patch p2's limit to 1 MB/s → its ETA drops to ~0.75 s → jumps first.
    const preview = dm.previewQueueOrder({ [p2.id]: 1024 * 1024 });
    assert.deepStrictEqual(preview.map((r) => r.id), [p2.id, p1.id], 'patched file re-ranks first');
    assert.ok(Math.abs(preview[0].etaSeconds - payload / (1024 * 1024)) < 1e-9, 'preview ETA uses the hypothetical limit');
    assert.strictEqual(preview[0].limit, 102400, 'the reported limit stays the CURRENT real one');
    // Patching to unlimited falls back to the nominal baseline (nothing has
    // measured a shared rate yet — every stream here is app-limited).
    const unlimited = dm.previewQueueOrder({ [p1.id]: 0 });
    assert.strictEqual(unlimited[0].etaBasis, 'baseline', 'unlimited patch → baseline rate until a real speed is measured');
    assert.strictEqual(unlimited[0].etaRateBps, 102400, 'baseline rate is the nominal 100 KB/s');
    // The preview mutates NOTHING — live order and limits are untouched.
    assert.deepStrictEqual(q(), [p1.id, p2.id], 'real queue order untouched by previews');
    assert.strictEqual(dm.getDownload(p2.id).maxBytesPerSec, 102400, 'real limit untouched by preview');
    assert.strictEqual(dm.getDownload(p1.id).maxBytesPerSec, 102400, 'real limit untouched by preview (patched id too)');
    // With smart order off the order is plain FIFO — no preview.
    dm.setSmartOrder(false);
    assert.strictEqual(dm.previewQueueOrder({}), null, 'preview unavailable when smart order is off');
    dm.setSmartOrder(true);
    for (const t of dm.snapshot().filter((x) => x.filePath.startsWith(dmDir))) dm.setSpeedLimit(t.id, 0);
    await waitFor(() => dm.snapshot().every((t) => t.status === 'done' || t.status === 'error'), 10000);
    dm.clearFinished();
    dm.setSmartOrder(false);
  });

  ok('queue plans: saved patches key by path and re-apply by re-matching it', async () => {
    dm.clearFinished();
    dm.setSmartOrder(true);
    const mk = (n) => path.join(dmDir, `plan-${n}.txt`);
    dm.startDownload('demo:content', mk('a'), null, { maxBytesPerSec: 51200 });
    dm.startDownload('demo:content', mk('b'), null, { maxBytesPerSec: 51200 });
    const p1 = dm.startDownload('demo:content', mk('p1'), null, { maxBytesPerSec: 102400 });
    const p2 = dm.startDownload('demo:content', mk('p2'), null, { maxBytesPerSec: 102400 });
    // planEntries turns a transient id-keyed patch into stable path keys,
    // dropping ids that no longer resolve.
    const entries = dm.planEntries({ [p2.id]: 1024 * 1024, [p1.id]: 0, 999999: 12345 });
    assert.strictEqual(entries.length, 2, 'unknown transfer ids are dropped');
    assert.deepStrictEqual(entries.find((e) => e.filePath === p2.filePath), { filePath: p2.filePath, bytesPerSec: 1024 * 1024 }, 'plan stores path + limit');
    assert.deepStrictEqual(entries.find((e) => e.filePath === p1.filePath), { filePath: p1.filePath, bytesPerSec: 0 }, 'unlimited (0) survives normalization');
    // applyPlanEntries re-matches by path and re-ranks like a live change.
    const applied = dm.applyPlanEntries(entries);
    assert.strictEqual(applied, 2, 'both listed files got limits');
    assert.strictEqual(dm.getDownload(p2.id).maxBytesPerSec, 1024 * 1024, 'limit applied for real');
    assert.strictEqual(dm.getDownload(p1.id).maxBytesPerSec, 0, 'unlimited applied for real');
    const q = () => dm.snapshot().filter((t) => t.status === 'queued').map((t) => t.id);
    assert.deepStrictEqual(q(), [p2.id, p1.id], 'applying the plan re-ranks the smart-ordered queue exactly like the preview');
    // Re-matching a plan against a FRESH transfer to the same path (as a
    // relaunch recreates transfers with new ids) still applies.
    const fresh = dm.startDownload('demo:content', mk('p3'), null, { maxBytesPerSec: 51200 });
    assert.strictEqual(fresh.status, 'queued', 'the fresh file queues behind the re-ranked pair');
    const applied2 = dm.applyPlanEntries([{ filePath: fresh.filePath, bytesPerSec: 262144 }]);
    assert.strictEqual(applied2, 1);
    assert.strictEqual(dm.getDownload(fresh.id).maxBytesPerSec, 262144, 'path-keyed plan applies to the recreated transfer');
    for (const t of dm.snapshot().filter((x) => x.filePath.startsWith(dmDir))) dm.setSpeedLimit(t.id, 0);
    await waitFor(() => dm.snapshot().every((t) => t.status === 'done' || t.status === 'error'), 10000);
    dm.clearFinished();
    dm.setSmartOrder(false);
  });

  ok('queue plans: folder rules cover later-queued files, per-file overrides win', async () => {
    dm.clearFinished();
    dm.setSmartOrder(true);
    const dirX = path.join(dmDir, 'shared');
    fs.mkdirSync(dirX, { recursive: true });
    const a = dm.startDownload('demo:content', path.join(dirX, 'a.txt'), null, { maxBytesPerSec: 51200 });
    const b = dm.startDownload('demo:content', path.join(dirX, 'b.txt'), null, { maxBytesPerSec: 51200 });
    // Folder rule pins dirX at 100 KB/s; b gets a per-file override at 1 MB/s.
    const entries = dm.planEntries({ [b.id]: 1024 * 1024 }, { [dirX]: 102400 });
    assert.strictEqual(entries.length, 2, 'folder rule + one override = 2 entries');
    assert.deepStrictEqual(entries.find((e) => e.dir === dirX), { dir: dirX, bytesPerSec: 102400 }, 'folder rule stored as { dir, bytesPerSec }');
    assert.deepStrictEqual(entries.find((e) => e.filePath === b.filePath), { filePath: b.filePath, bytesPerSec: 1024 * 1024 }, 'deviation stored as a per-file override');
    assert.ok(!entries.some((e) => e.filePath === a.filePath), 'a is covered by the folder rule — no redundant filePath entry');
    const applied = dm.applyPlanEntries(entries);
    assert.ok(applied >= 2, `both files touched (applied ${applied})`);
    assert.strictEqual(dm.getDownload(a.id).maxBytesPerSec, 102400, 'folder rule pins a');
    assert.strictEqual(dm.getDownload(b.id).maxBytesPerSec, 1024 * 1024, 'override wins for b (applied after the folder rule)');
    // A file queued into the folder LATER is covered by the same rule.
    const c = dm.startDownload('demo:content', path.join(dirX, 'c.txt'), null, { maxBytesPerSec: 51200 });
    assert.strictEqual(c.status, 'queued', 'c queues behind the two active slots');
    const applied2 = dm.applyPlanEntries(entries);
    assert.ok(applied2 >= 3, `later-queued file also matched (applied ${applied2})`);
    assert.strictEqual(dm.getDownload(c.id).maxBytesPerSec, 102400, 'folder rule pins the later-queued file');
    for (const t of dm.snapshot().filter((x) => x.filePath.startsWith(dmDir))) dm.setSpeedLimit(t.id, 0);
    await waitFor(() => dm.snapshot().every((t) => t.status === 'done' || t.status === 'error'), 10000);
    dm.clearFinished();
    dm.setSmartOrder(false);
  });

  ok('plan schedules: window math, armed whole-queue cap, ETA basis flips to window', async () => {
    // Pure clock/window math: parseClock normalizes HH:MM to minutes; the
    // window is end-exclusive at `to` and overnight windows wrap midnight.
    assert.strictEqual(dm.parseClock('23:00'), 23 * 60);
    assert.strictEqual(dm.parseClock('7:30'), 7 * 60 + 30);
    assert.strictEqual(dm.parseClock('99:99'), null, 'malformed clocks rejected');
    const night = { from: '23:00', to: '07:00', bytesPerSec: 102400 };
    assert.strictEqual(dm.scheduleWindowActive(night, 23 * 60 + 30), true, 'active inside the night window');
    assert.strictEqual(dm.scheduleWindowActive(night, 2 * 60), true, 'overnight window stays active past midnight');
    assert.strictEqual(dm.scheduleWindowActive(night, 7 * 60), false, 'end-exclusive at `to`');
    assert.strictEqual(dm.scheduleWindowActive(night, 6 * 60 + 59), true, 'active one minute before `to`');
    assert.strictEqual(dm.scheduleWindowActive(night, 12 * 60), false, 'inactive at noon');
    assert.strictEqual(dm.scheduleWindowActive({ from: '00:00', to: '00:00', bytesPerSec: 102400 }, 5 * 60), true, 'from === to is a whole-day window');
    assert.strictEqual(dm.scheduleWindowActive(null, 12 * 60), false, 'no schedule → never active');

    // Arming a plan with a whole-day window caps EVERY transfer at the
    // schedule's rate (its own lower limit still wins).
    dm.clearActivePlan();
    const day = { from: '00:00', to: '00:00', bytesPerSec: 102400 };
    const armed = dm.setActivePlan('night', day);
    assert.strictEqual(armed.name, 'night');
    assert.deepStrictEqual(armed.schedule, { from: '00:00', to: '00:00', bytesPerSec: 102400 });
    const info = dm.appliedPlanInfo();
    assert.strictEqual(info.name, 'night');
    assert.strictEqual(info.windowActive, true, 'whole-day window is active now');
    assert.strictEqual(dm.effectiveLimitBps({ maxBytesPerSec: 0 }), 102400, 'no own limit → window cap applies');
    assert.strictEqual(dm.effectiveLimitBps({ maxBytesPerSec: 51200 }), 51200, 'own lower limit still wins');
    assert.strictEqual(dm.effectiveLimitBps({ maxBytesPerSec: 262144 }), 102400, 'own higher limit is capped by the window');

    // A queued transfer under the armed window reports the window as the
    // basis (rate = cap, not the file's own limit); disarming restores it.
    dm.clearFinished();
    dm.setSmartOrder(true);
    const mk = (n) => path.join(dmDir, `sched-${n}.txt`);
    dm.startDownload('demo:content', mk('a'), null, { maxBytesPerSec: 51200 });
    dm.startDownload('demo:content', mk('b'), null, { maxBytesPerSec: 51200 });
    const c = dm.startDownload('demo:content', mk('c'), null, { maxBytesPerSec: 262144 });
    assert.strictEqual(c.status, 'queued', 'c queues behind the active pair');
    const dUnder = dm.etaDetail(c);
    assert.strictEqual(dUnder.rateBps, 102400, 'queued ETA rate = the window cap, not the file limit');
    assert.strictEqual(dUnder.basis, 'window', 'chip says the plan window binds');
    dm.clearActivePlan();
    assert.strictEqual(dm.appliedPlanInfo().name, '', 'clearActivePlan drops the badge');
    assert.strictEqual(dm.appliedPlanInfo().windowActive, false, '…and disarms the cap');
    const dFree = dm.etaDetail(c);
    assert.strictEqual(dFree.rateBps, 262144, 'ETA rate back to the file limit once the plan clears');
    assert.strictEqual(dFree.basis, 'limit');
    for (const t of dm.snapshot().filter((x) => x.filePath.startsWith(dmDir))) dm.setSpeedLimit(t.id, 0);
    await waitFor(() => dm.snapshot().every((t) => t.status === 'done' || t.status === 'error'), 10000);
    dm.clearFinished();
    dm.setSmartOrder(false);
  });

  ok('night mode: global schedule merges with plan windows; boundary ticks detect flips', async () => {
    // Night mode is a Settings-level whole-queue cap independent of plans.
    dm.setGlobalSchedule(null);
    dm.clearActivePlan();
    const info0 = dm.globalScheduleInfo();
    assert.strictEqual(info0.schedule, null);
    assert.strictEqual(info0.windowActive, false);
    assert.strictEqual(dm.effectiveLimitBps({ maxBytesPerSec: 262144 }), 262144, 'no night mode → own limit unchanged');

    // Whole-day night window: caps unlimited + high-own transfers; own lower
    // limits still win.
    dm.setGlobalSchedule({ from: '00:00', to: '00:00', bytesPerSec: 51200 });
    const info = dm.globalScheduleInfo();
    assert.strictEqual(info.schedule && info.schedule.bytesPerSec, 51200);
    assert.strictEqual(info.windowActive, true);
    assert.strictEqual(info.capNow, 51200);
    assert.strictEqual(dm.effectiveLimitBps({ maxBytesPerSec: 0 }), 51200, 'night mode caps an unlimited file');
    assert.strictEqual(dm.effectiveLimitBps({ maxBytesPerSec: 262144 }), 51200, 'night mode caps a faster file');
    assert.strictEqual(dm.effectiveLimitBps({ maxBytesPerSec: 25600 }), 25600, 'own lower limit still wins');
    // A queued demo chip reports the binding source on its ETA line.
    dm.clearFinished();
    dm.setSmartOrder(true);
    const mk = (n) => path.join(dmDir, `night-${n}.txt`);
    dm.startDownload('demo:content', mk('a'), null, { maxBytesPerSec: 51200 });
    dm.startDownload('demo:content', mk('b'), null, { maxBytesPerSec: 51200 });
    const c = dm.startDownload('demo:content', mk('c'), null, { maxBytesPerSec: 262144 });
    const dNight = dm.etaDetail(c);
    assert.strictEqual(dNight.rateBps, 51200, 'queued ETA rate = the night cap');
    assert.strictEqual(dNight.basis, 'night', 'chip says night mode binds');
    // The tighter of plan window vs night mode wins; ties go to the plan.
    dm.setActivePlan('nightcap', { from: '00:00', to: '00:00', bytesPerSec: 102400 });
    const dBoth = dm.etaDetail(c);
    assert.strictEqual(dBoth.rateBps, 51200, 'night cap (50 KB/s) tighter than the plan window (100 KB/s)');
    assert.strictEqual(dBoth.basis, 'night');
    dm.setGlobalSchedule({ from: '00:00', to: '00:00', bytesPerSec: 204800 });
    const dPlan = dm.etaDetail(c);
    assert.strictEqual(dPlan.rateBps, 102400, 'plan window now tighter than night mode');
    assert.strictEqual(dPlan.basis, 'window');
    dm.clearActivePlan();
    dm.setGlobalSchedule({ from: '00:00', to: '00:00', bytesPerSec: 204800 });
    const dOwn = dm.etaDetail(c);
    assert.strictEqual(dOwn.rateBps, 204800, 'cleared plan → night cap binds again');
    assert.strictEqual(dOwn.basis, 'night');
    dm.setGlobalSchedule(null);
    dm.clearActivePlan();
    const dFree = dm.etaDetail(c);
    assert.strictEqual(dFree.rateBps, 262144, 'night off + no plan → own limit');
    assert.strictEqual(dFree.basis, 'limit');

    // Boundary tick: reports when the active state of either window flips
    // (the signal main uses to broadcast clock-boundary changes).
    dm.resetScheduleTicks();
    const t0 = dm.scheduleBoundaryTick();
    assert.strictEqual(t0.changed, false, 'first tick seeds the baseline');
    dm.setGlobalSchedule({ from: '00:00', to: '00:00', bytesPerSec: 51200 });
    const t1 = dm.scheduleBoundaryTick();
    assert.strictEqual(t1.changed, true, 'night window entering is a boundary flip');
    assert.strictEqual(t1.night, true);
    dm.setGlobalSchedule(null);
    const t2 = dm.scheduleBoundaryTick();
    assert.strictEqual(t2.changed, true, 'night window leaving is a boundary flip');
    assert.strictEqual(t2.night, false);
    dm.setActivePlan('p', { from: '00:00', to: '00:00', bytesPerSec: 51200 });
    const t3 = dm.scheduleBoundaryTick();
    assert.strictEqual(t3.changed, true, 'plan window entering is a boundary flip');
    assert.strictEqual(t3.plan, true);
    const t4 = dm.scheduleBoundaryTick();
    assert.strictEqual(t4.changed, false, 'no flip → no broadcast');
    dm.clearActivePlan();
    dm.resetScheduleTicks();

    // Weekday selectors: a schedule with a non-empty `days` array is active
    // only on those weekdays (JS Date.getDay(): 0 = Sunday … 6 = Saturday).
    assert.deepStrictEqual(dm.normalizeDays([2, 2, 1, '3']), [1, 2, 3], 'normalizeDays dedupes + sorts + coerces');
    assert.strictEqual(dm.normalizeDays([]), null, 'empty days = every day');
    assert.strictEqual(dm.normalizeDays('nope'), null, 'non-array days ignored');
    assert.strictEqual(dm.normalizeDays([8]), null, 'invalid weekday numbers dropped');
    const week = { from: '23:00', to: '07:00', bytesPerSec: 51200, days: [1, 2, 3, 4, 5] };
    assert.strictEqual(dm.scheduleWindowActive(week, 0 * 60, 2), true, 'weekday inside window + selected day → active');
    assert.strictEqual(dm.scheduleWindowActive(week, 0 * 60, 6), false, 'selected times but wrong weekday → inactive');
    assert.strictEqual(dm.scheduleWindowActive(week, 12 * 60, 2), false, 'right weekday but outside window → inactive');
    assert.strictEqual(dm.scheduleWindowActive({ ...week, days: null }, 0 * 60, 6), true, 'null days = every day');
    assert.strictEqual(dm.scheduleWindowActive({ ...week, days: [] }, 0 * 60, 6), true, 'empty days = every day');
    const weekPlan = dm.setActivePlan('wk', week);
    assert.deepStrictEqual(weekPlan.schedule.days, [1, 2, 3, 4, 5], 'setActivePlan preserves the weekday selector');
    dm.clearActivePlan();

    // Session override (the tray pill): force night mode on/off regardless
    // of the clock window; null returns to following the window. The test
    // window is guaranteed to be in the past (now−3h → now−2h), so the
    // clock can never make it active by accident.
    const pad = (n) => String(n).padStart(2, '0');
    const hmOf = (ms) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
    dm.setGlobalSchedule({ from: hmOf(Date.now() - 3 * 3600e3), to: hmOf(Date.now() - 2 * 3600e3), bytesPerSec: 51200 });
    const override0 = dm.globalScheduleInfo();
    assert.strictEqual(override0.override, null, 'override starts null (follow the window)');
    assert.strictEqual(override0.windowActive, false, 'past window is inactive');
    assert.strictEqual(dm.effectiveLimitBps({ maxBytesPerSec: 262144 }), 262144, 'no override, outside window → no cap');
    const on = dm.setNightOverride(true);
    assert.strictEqual(on.override, true);
    assert.strictEqual(on.windowActive, true, 'override forces the night cap on outside the window');
    assert.strictEqual(on.capNow, 51200);
    assert.strictEqual(dm.effectiveLimitBps({ maxBytesPerSec: 262144 }), 51200, 'forced-on night cap binds');
    assert.strictEqual(dm.effectiveLimitBps({ maxBytesPerSec: 25600 }), 25600, 'own lower limit still wins under override');
    const off = dm.setNightOverride(false);
    assert.strictEqual(off.override, false);
    assert.strictEqual(off.windowActive, false, 'override forces night mode off');
    assert.strictEqual(dm.effectiveLimitBps({ maxBytesPerSec: 262144 }), 262144, 'forced-off → no night cap even inside the window');
    dm.setNightOverride(null);
    assert.strictEqual(dm.globalScheduleInfo().windowActive, false, 'null override follows the window again');
    dm.setGlobalSchedule(null);

    // capBreakdown: exposes own vs plan window vs night for the chip
    // tooltip when a shared cap binds; null when no shared cap applies.
    assert.strictEqual(dm.capBreakdown({ maxBytesPerSec: 262144 }), null, 'no shared cap → nothing to explain');
    dm.setActivePlan('nightcap', { from: '00:00', to: '00:00', bytesPerSec: 102400 });
    dm.setGlobalSchedule({ from: '00:00', to: '00:00', bytesPerSec: 51200 });
    const bd = dm.capBreakdown({ maxBytesPerSec: 262144 });
    assert.deepStrictEqual(bd.planWindow, { cap: 102400, name: 'nightcap' }, 'plan window listed with its name');
    assert.deepStrictEqual(bd.night, { cap: 51200 }, 'night cap listed');
    assert.strictEqual(bd.effective, 51200, 'tighter of the two shared caps is effective');
    assert.strictEqual(bd.binding, 'night', 'binding source reported');
    assert.strictEqual(dm.capBreakdown({ maxBytesPerSec: 25600 }).effective, 25600, 'own lower limit is the effective speed');
    assert.strictEqual(dm.capBreakdown({ maxBytesPerSec: 25600 }).binding, 'limit', '…and its own limit binds');
    dm.clearActivePlan();
    dm.setGlobalSchedule(null);
    for (const t of dm.snapshot().filter((x) => x.filePath.startsWith(dmDir))) dm.setSpeedLimit(t.id, 0);
    await waitFor(() => dm.snapshot().every((t) => t.status === 'done' || t.status === 'error'), 10000);
    dm.clearFinished();
    dm.setSmartOrder(false);
  });

  ok('scheduler: resumableSnapshot preserves queue order across a restart', async () => {
    dm.clearFinished();
    const mk = (n) => path.join(dmDir, `order-${n}.txt`);
    const a = dm.startDownload('demo:content', mk('a'));
    const b = dm.startDownload('demo:content', mk('b'));
    const c = dm.startDownload('demo:readme', mk('c'));
    const d = dm.startDownload('demo:readme', mk('d'));
    assert.strictEqual(a.status, 'downloading');
    assert.strictEqual(b.status, 'downloading');
    assert.deepStrictEqual(dm.snapshot().filter((t) => t.status === 'queued' && t.filePath.startsWith(dmDir)).map((t) => t.id), [c.id, d.id]);
    dm.moveQueuedTo(d.id, 0); // drag d above c
    const recs = dm.resumableSnapshot().filter((r) => r.filePath.startsWith(dmDir));
    assert.deepStrictEqual(recs.map((r) => r.filePath), [mk('a'), mk('b'), mk('d'), mk('c')], 'queued records emitted in start order (actives first)');
    // Drain, then restore into a fresh queue: the reordered position holds.
    await waitFor(() => dm.snapshot().every((t) => t.status === 'done' || t.status === 'error'), 8000);
    dm.clearFinished();
    const n = dm.restorePending(recs.map((r) => ({ ...r, maxBytesPerSec: 102400 })), () => {});
    assert.strictEqual(n, 4);
    const restoredQueued = dm.snapshot().filter((t) => t.status === 'queued' && t.filePath.startsWith(dmDir)).map((t) => t.filePath);
    assert.deepStrictEqual(restoredQueued, [mk('d'), mk('c')], 'restored queue keeps the drag-reordered position');
    // Cleanup: lift the pacing limits and drain.
    for (const t of dm.snapshot().filter((x) => x.filePath.startsWith(dmDir))) dm.setSpeedLimit(t.id, 0);
    await waitFor(() => dm.snapshot().every((t) => t.status === 'done' || t.status === 'error'), 8000);
    dm.clearFinished();
  });

  ok('scheduler: per-download speed limit applies live and survives retry', async () => {
    dm.clearFinished();
    const t = dm.startDownload('demo:content', path.join(dmDir, 'limit-demo.txt'));
    dm.setSpeedLimit(t.id, 256 * 1024);
    assert.strictEqual(dm.getDownload(t.id).maxBytesPerSec, 256 * 1024, 'limit stored on the entry');
    await waitFor(() => dm.getDownload(t.id) && dm.getDownload(t.id).status === 'done', 5000);
    assert.strictEqual(dm.snapshot().find((x) => x.id === t.id).maxBytesPerSec, 256 * 1024, 'limit exposed in the snapshot');
    dm.clearFinished();
    // Retry carries the chosen limit into the resumed attempt.
    const bad = dm.startDownload('http://127.0.0.1:9/never.bin', path.join(dmDir, 'limit-bad.bin'));
    await waitFor(() => dm.getDownload(bad.id) && dm.getDownload(bad.id).status === 'error');
    dm.setSpeedLimit(bad.id, 100 * 1024);
    const retried = dm.retryDownload(bad.id);
    assert.strictEqual(retried.maxBytesPerSec, 100 * 1024, 'limit carried into the retry');
    await waitFor(() => dm.getDownload(bad.id) && dm.getDownload(bad.id).status === 'error', 5000);
    dm.clearFinished();
  });

  ok('scheduler: resumableSnapshot persists only in-flight; restorePending resumes them', async () => {
    dm.clearFinished();
    const destA = path.join(dmDir, 'resume-a.txt');
    const destB = path.join(dmDir, 'resume-b.txt');
    dm.startDownload('demo:content', destA);
    dm.startDownload('demo:content', destB);
    // Both fill the two active slots synchronously — capture them mid-flight.
    const recs = dm.resumableSnapshot().filter((r) => r.filePath === destA || r.filePath === destB);
    assert.strictEqual(recs.length, 2, 'active transfers are persisted');
    assert.ok(recs.every((r) => r.demo && r.url.startsWith('demo:') && r.filePath), 'records carry url + approved destination');
    const findById = (needle) => [...dm.snapshot()].find((x) => x.filePath === needle);
    await waitFor(() => {
      const xa = findById(destA);
      const xb = findById(destB);
      return xa && xb && xa.status === 'done' && xb.status === 'done';
    });
    assert.strictEqual(dm.resumableSnapshot().length, 0, 'finished transfers drop out of the resumable set');
    // Simulate an interrupted session: re-enqueue the saved records — they
    // restart under fresh ids, no dialog, and re-write their destinations.
    dm.clearFinished();
    const events = [];
    const n = dm.restorePending(recs, (entry, kind) => events.push(`${entry.id}:${kind}`));
    assert.strictEqual(n, 2, 'restore accepted both records');
    await waitFor(() => {
      const xa = findById(destA);
      const xb = findById(destB);
      return xa && xb && xa.status === 'done' && xb.status === 'done';
    }, 5000);
    assert.ok(fs.existsSync(destA) && fs.existsSync(destB), 'restored transfers wrote their files');
    assert.ok(events.some((e) => e.endsWith(':queued')), 'restore reported queued transitions');
    dm.clearFinished();
  });

  ok('scheduler: pause parks a running transfer; manual resume continues it', async () => {
    dm.clearFinished();
    const dest = path.join(dmDir, 'pause-demo.txt');
    // A 100 KB/s demo takes ~7s, so there is plenty of window to pause.
    const t = dm.startDownload('demo:content', dest, () => {}, { maxBytesPerSec: 102400 });
    assert.strictEqual(t.status, 'downloading');
    const parked = dm.pauseDownload(t.id);
    assert.ok(parked && parked.id === t.id, 'pause accepted on a running transfer');
    return (async () => {
      await waitFor(() => dm.getDownload(t.id) && dm.getDownload(t.id).status === 'paused', 4000);
      const snap = dm.snapshot().find((x) => x.id === t.id);
      assert.strictEqual(snap.status, 'paused', 'transfer parked as paused');
      assert.strictEqual(snap.queuePos, -1, 'paused transfer is not in the start queue');
      const pausedRec = dm.resumableSnapshot().find((r) => r.filePath === dest);
      assert.ok(pausedRec && pausedRec.status === 'paused', 'paused transfer persisted as paused (parks, never auto-resumes)');
      // Manual resume: lift the limit (the pause kept it at 100 KB/s) and
      // restart — a real URL would continue its .part via HTTP Range.
      dm.setSpeedLimit(t.id, 0);
      const resumed = dm.retryDownload(t.id);
      assert.ok(resumed && resumed.status === 'downloading', 'resume starts the parked transfer');
      await waitFor(() => dm.getDownload(t.id) && dm.getDownload(t.id).status === 'done', 8000);
      assert.ok(fs.existsSync(dest) && fs.statSync(dest).size > 0, 'resumed file written');
      dm.clearFinished();
    })();
  });

  ok('scheduler: removing a paused transfer deletes it (partial dropped too)', async () => {
    dm.clearFinished();
    const dest = path.join(dmDir, 'pause-remove.txt');
    const t = dm.startDownload('demo:content', dest, () => {}, { maxBytesPerSec: 102400 });
    dm.pauseDownload(t.id);
    await waitFor(() => dm.getDownload(t.id) && dm.getDownload(t.id).status === 'paused', 4000);
    const removed = dm.cancelDownload(t.id); // remove semantics for paused
    assert.ok(removed && removed.id === t.id, 'paused transfer removable');
    assert.ok(!dm.snapshot().some((x) => x.id === t.id), 'removed from the list');
    dm.clearFinished();
  });

  ok('scheduler: folderRule recorded, bulk resume/remove all paused', async () => {
    dm.clearFinished();
    const destA = path.join(dmDir, 'bulk-a.txt');
    const destB = path.join(dmDir, 'bulk-b.txt');
    const mk = (dest, label) => dm.startDownload('demo:content', dest, () => {}, { folderRule: label, maxBytesPerSec: 102400 });
    const a = mk(destA, 'Demo index default folder');
    const b = mk(destB, 'Demo index default folder');
    const snapA = dm.snapshot().find((x) => x.id === a.id);
    assert.strictEqual(snapA.folderRule, 'Demo index default folder', 'folder rule recorded on the entry');
    assert.ok(snapA.dir && snapA.dir.length > 0, 'save folder derived from destination');
    // A transfer only becomes pausable once it is actually streaming — if a
    // slot was transiently busy it waits queued first. Park each one as it
    // starts (pausing frees the slot for the next, like the real tray).
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const ids = [a.id, b.id].filter((id) => {
        const x = dm.getDownload(id);
        return x && x.status !== 'paused';
      });
      if (!ids.length) break;
      for (const id of ids) {
        const x = dm.getDownload(id);
        if (x && x.status === 'downloading') dm.pauseDownload(id);
      }
      await sleep(30);
    }
    assert.strictEqual(dm.getDownload(a.id).status, 'paused');
    assert.strictEqual(dm.getDownload(b.id).status, 'paused');
    assert.strictEqual(dm.resumeAllPaused(), 2, 'bulk resume returns both');
    assert.ok(dm.snapshot().find((x) => x.id === a.id).status === 'downloading', 'both resumed');
    dm.setSpeedLimit(a.id, 0);
    dm.setSpeedLimit(b.id, 0);
    await waitFor(() => dm.getDownload(a.id).status === 'done' && dm.getDownload(b.id).status === 'done', 8000);
    dm.clearFinished();
    const c = mk(path.join(dmDir, 'bulk-c.txt'), 'Last-used folder');
    const d = mk(path.join(dmDir, 'bulk-d.txt'), 'Last-used folder');
    dm.pauseDownload(c.id);
    dm.pauseDownload(d.id);
    await waitFor(() => dm.getDownload(c.id).status === 'paused' && dm.getDownload(d.id).status === 'paused', 4000);
    assert.strictEqual(dm.removeAllPaused(), 2, 'bulk remove returns both');
    assert.ok(!dm.snapshot().some((x) => x.id === c.id || x.id === d.id), 'all paused gone (partials dropped)');
    dm.clearFinished();
  });

  ok('scheduler: folderRule survives a persisted restore', async () => {
    dm.clearFinished();
    const dest = path.join(dmDir, 'rule-restore.txt');
    const n = dm.restorePending(
      [{ url: 'demo:readme', filePath: dest, demo: true, maxBytesPerSec: 0, folderRule: 'Internet Archive default folder' }],
      () => {}
    );
    assert.strictEqual(n, 1);
    const t = dm.snapshot().find((x) => x.filePath === dest);
    assert.ok(t, 'restored transfer present');
    assert.strictEqual(t.folderRule, 'Internet Archive default folder', 'rule carried across restart');
    await waitFor(() => dm.getDownload(t.id) && dm.getDownload(t.id).status === 'done', 5000);
    dm.clearFinished();
  });

  ok('scheduler: paused records restore parked across a restart', async () => {
    dm.clearFinished();
    const dest = path.join(dmDir, 'paused-restore.txt');
    const busyDest = path.join(dmDir, 'paused-busy.txt');
    // Restore a paused record AND a queued record together: only the queued
    // one may stream; the paused one must park (a user pause is respected).
    const n = dm.restorePending(
      [
        { url: 'demo:content', filePath: dest, demo: true, maxBytesPerSec: 102400, status: 'paused' },
        { url: 'demo:readme', filePath: busyDest, demo: true, maxBytesPerSec: 0 },
      ],
      () => {}
    );
    assert.strictEqual(n, 2, 'both records accepted');
    const parked = dm.snapshot().find((x) => x.filePath === dest);
    assert.ok(parked, 'paused record restored');
    assert.strictEqual(parked.status, 'paused', 'parked, not started');
    assert.strictEqual(parked.queuePos, -1, 'not in the start queue');
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(dm.getDownload(parked.id).status, 'paused', 'still parked after the queue ran');
    const rec = dm.resumableSnapshot().find((r) => r.filePath === dest);
    assert.ok(rec && rec.status === 'paused', 'paused record persists as paused');
    // Manual resume continues it.
    const resumed = dm.retryDownload(parked.id);
    assert.ok(resumed && resumed.status === 'downloading', 'manual resume starts the parked transfer');
    dm.setSpeedLimit(parked.id, 0);
    await waitFor(() => dm.getDownload(parked.id).status === 'done', 8000);
    assert.ok(fs.existsSync(dest) && fs.statSync(dest).size > 0, 'resumed file written');
    dm.clearFinished();
  });

  ok('download stats: period aggregation (week/month) from timestamped events', () => {
    const tally = {
      'archive-org': {
        count: 3,
        bytes: 3000,
        events: [
          { ts: Date.now() - 2 * 24 * 3600 * 1000, bytes: 1000 },
          { ts: Date.now() - 10 * 24 * 3600 * 1000, bytes: 1000 },
          { ts: Date.now() - 60 * 24 * 3600 * 1000, bytes: 1000 },
        ],
      },
      'demo-curated': { count: 1, bytes: 500, events: [{ ts: Date.now() - 200 * 24 * 3600 * 1000, bytes: 500 }] },
    };
    assert.deepStrictEqual(dm.statsForPeriod(tally, 'all')['archive-org'], { count: 3, bytes: 3000 }, 'all = lifetime counters');
    assert.deepStrictEqual(dm.statsForPeriod(tally, 'week')['archive-org'], { count: 1, bytes: 1000 }, 'week = last 7 days only');
    assert.strictEqual(dm.statsForPeriod(tally, 'week')['demo-curated'].count, 0, '200-day-old event not in the week window');
    assert.deepStrictEqual(dm.statsForPeriod(tally, 'month')['archive-org'], { count: 2, bytes: 2000 }, 'month = last 30 days only');
    // Retention: seeding prunes out-of-window events but keeps the lifetime counters.
    const seeded = dm.setStats(tally);
    assert.strictEqual(seeded['demo-curated'].events.length, 0, 'out-of-retention events pruned on seed');
    assert.strictEqual(seeded['demo-curated'].count, 1, 'lifetime counters survive pruning');
    dm.setStats({});
  });

  ok('dl-stats: statsCsv renders the panel table as copyable text', () => {
    const { statsCsv } = require('../lib/dl-stats');
    const csv = statsCsv([
      { source: 'Internet Archive', count: 3, bytes: 3000 },
      { source: 'Odd, "source"', count: 1, bytes: 7 },
    ]);
    assert.strictEqual(csv.split('\n')[0], 'Source,Files,Bytes', 'header row');
    assert.ok(csv.includes('Internet Archive,3,3000'), 'plain name unquoted');
    assert.ok(csv.includes('"Odd, ""source""",1,7'), 'commas/quotes escaped');
    assert.ok(csv.endsWith('Total,4,3007\n'), 'total row appended');
    assert.strictEqual(statsCsv([]), 'Source,Files,Bytes\n', 'empty rows → header only');
    assert.strictEqual(statsCsv(null), 'Source,Files,Bytes\n', 'null safe');
  });

  ok('download stats: recordStats tallies per source and round-trips', async () => {
    dm.setStats({});
    dm.recordStats('https://archive.org/download/foo/bar.mp4', 1500);
    dm.recordStats('demo:content', 768 * 1024);
    dm.recordStats('https://unknown.example/x.bin', 42);
    const snap = dm.statsSnapshot();
    assert.strictEqual(snap['archive-org'].count, 1, 'archive tallied');
    assert.strictEqual(snap['archive-org'].bytes, 1500, 'archive bytes exact');
    assert.strictEqual(snap['demo-curated'].count, 1, 'demo tallied');
    assert.strictEqual(snap['demo-curated'].bytes, 768 * 1024, 'demo bytes exact');
    assert.strictEqual(snap['other'].count, 1, 'unmapped host buckets under other');
    // Persistence round-trip: seed a fresh tally with the snapshot.
    dm.setStats({});
    dm.setStats(snap);
    assert.deepStrictEqual(dm.statsSnapshot(), snap, 'seed → snapshot round-trip');
    dm.setStats({});
    // A completed transfer credits its source automatically.
    const t = dm.startDownload('demo:readme', path.join(dmDir, 'stats-demo.txt'));
    await waitFor(() => dm.getDownload(t.id) && dm.getDownload(t.id).status === 'done', 5000);
    assert.strictEqual(dm.statsSnapshot()['demo-curated'].count, 1, 'done transfer recorded');
    assert.ok(dm.statsSnapshot()['demo-curated'].bytes > 0, 'done transfer bytes recorded');
    dm.setStats({});
    dm.clearFinished();
  });

  ok('engineForUrl maps direct-file URLs to their engine (per-source folders)', () => {
    assert.strictEqual(dm.engineForUrl('https://archive.org/download/x/y.mp4'), 'archive-org');
    assert.strictEqual(dm.engineForUrl('https://releases.ubuntu.com/24.04/x.iso'), 'distro-releases');
    assert.strictEqual(dm.engineForUrl('https://cdimage.debian.org/x/y.iso'), 'distro-releases');
    assert.strictEqual(dm.engineForUrl('https://archive.archlinux.org/iso/x.iso'), 'arch-releases');
    assert.strictEqual(dm.engineForUrl('demo:readme'), 'demo-curated');
    assert.strictEqual(dm.engineForUrl('https://evil-example.org/x.iso'), null, 'unknown host → no engine');
    assert.strictEqual(dm.engineForUrl('not a url'), null);
  });

  ok('storage: persisted transfers round-trip (auto-resume records)', async () => {
    const stDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-transfers-'));
    const s1 = new Storage(stDir);
    assert.deepStrictEqual(s1.getTransfers(), []);
    const recs = [{ url: 'demo:content', filePath: '/tmp/x.bin', demo: true, maxBytesPerSec: 512 * 1024 }];
    s1.setTransfers(recs);
    s1.setStats({ 'archive-org': { count: 3, bytes: 4096, events: [{ ts: 123, bytes: 4096 }] }, other: { count: 1, bytes: 7, events: [] } });
    s1.flush();
    const s2 = new Storage(stDir);
    assert.deepStrictEqual(s2.getTransfers(), recs, 'records survive a storage reload');
    assert.deepStrictEqual(s2.getStats(), { 'archive-org': { count: 3, bytes: 4096, events: [{ ts: 123, bytes: 4096 }] }, other: { count: 1, bytes: 7, events: [] } }, 'stats (count/bytes/events) survive a storage reload');
    assert.deepStrictEqual(s2.getStats().demo, undefined, 'no phantom engine buckets');
    await new Promise((r) => setTimeout(r, 320)); // let debounced writes settle
    fs.rmSync(stDir, { recursive: true, force: true });
  });

  ok('storage: replacePrefs persists deletions the merge would resurrect', () => {
    const stDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrentor-plans-'));
    const s = new Storage(stDir);
    s.updatePrefs({ queuePlans: { a: [{ filePath: '/a', bytesPerSec: 1024 }], b: [{ filePath: '/b', bytesPerSec: 2048 }] } });
    // The nested merge keeps stored keys, so a deletion via updatePrefs is
    // silently resurrected — the exact bug replacePrefs exists for.
    s.updatePrefs({ queuePlans: { a: [{ filePath: '/a', bytesPerSec: 1024 }] } });
    assert.ok(s.getPrefs().queuePlans.b, 'merge retains keys absent from the partial (documented behavior)');
    s.replacePrefs('queuePlans', { a: [{ filePath: '/a', bytesPerSec: 1024 }] });
    assert.ok(!s.getPrefs().queuePlans.b, 'replacePrefs drops the deleted plan in memory');
    s.flush();
    const s2 = new Storage(stDir);
    assert.deepStrictEqual(s2.getPrefs().queuePlans, { a: [{ filePath: '/a', bytesPerSec: 1024 }] }, 'the deletion survives a storage reload');
    fs.rmSync(stDir, { recursive: true, force: true });
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
