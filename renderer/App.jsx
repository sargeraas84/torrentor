'use strict';
const React = require('react');
const { useEffect, useRef, useState, useCallback } = require('react');
const TitleBar = require('./components/TitleBar');
const EngineChips = require('./components/EngineChips');
const ResultCard = require('./components/ResultCard');
const { FavoritesView, HistoryView, DownloadStatsPanel } = require('./components/LibraryView');
const SettingsModal = require('./components/SettingsModal');
const { FilesModal, DownloadTray } = require('./components/Downloads');
const { I, CATEGORY_META } = require('./components/icons');
const { sortResults } = require('../lib/orchestrator');

const api = window.torrentor;
const SUGGESTIONS = ['ubuntu 24.04', 'blender open movie', 'moby dick audiobook', 'apollo 11 4k', 'libreoffice', 'supertuxkart'];
// Archive.org's own mediatype classification, used for the filter chips and
// authoritative category look on Archive-backed cards.
const ARCHIVE_MEDIATYPE_LABELS = { movies: 'Movies', audio: 'Audio', etree: 'Live music', texts: 'Texts', software: 'Software', image: 'Images', data: 'Data' };

function App() {
  const [version, setVersion] = useState('1.0.0');
  const [engines, setEngines] = useState([]);
  const [prefs, setPrefsState] = useState({ proxy: { enabled: false } });
  const [history, setHistory] = useState([]);
  const [favorites, setFavorites] = useState([]);

  const [query, setQuery] = useState('');
  const [lastQuery, setLastQuery] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | running | done
  const [runError, setRunError] = useState(null);
  const [results, setResults] = useState([]);
  const [perEngine, setPerEngine] = useState({});
  const [stats, setStats] = useState({ unique: 0, okEngines: 0, totalEngines: 0, tookMs: 0 });

  const [view, setView] = useState('search'); // search | favorites | history
  const [catFilter, setCatFilter] = useState('all');
  const [archiveFilter, setArchiveFilter] = useState('all'); // 'all' | archive mediatype
  const [sortMode, setSortMode] = useState('seeders');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [maxed, setMaxed] = useState(false);
  const [toast, setToast] = useState(null);
  // Source health (Settings → Search sources): last verdicts per engine + a
  // run-in-flight flag. App owns the state + subscription; SettingsModal is
  // a props consumer (same pattern as engines/favorites).
  const [health, setHealth] = useState([]);
  const [healthRunning, setHealthRunning] = useState(false);
  // Idle-screen "Explore open culture" tiles (label + Archive poster).
  const [exploreTiles, setExploreTiles] = useState([]);
  // Archive "load more" paging: page cursor + whether another page exists.
  const [archivePage, setArchivePage] = useState(1);
  const [archiveHasMore, setArchiveHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retryingId, setRetryingId] = useState(null);
  // Direct downloads: transfer tray list, the open Archive file picker,
  // and lifetime per-source tallies for the Library views.
  const [downloads, setDownloads] = useState([]);
  const [filesItem, setFilesItem] = useState(null);
  const [dlStats, setDlStats] = useState(null);

  const seqRef = useRef(0);
  const toastTimer = useRef(null);

  const showToast = useCallback((text) => {
    setToast({ id: Date.now(), text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  const enabledIds = () => engines.filter((e) => e.enabled).map((e) => e.id);

  // ----- direct downloads -------------------------------------------------
  const startDirectDownload = async (result) => {
    if (!result || !result.fileUrl) return;
    try {
      const res = await api.downloadFile(result.fileUrl);
      if (res && res.cancelled) return; // user dismissed the save dialog
      if (res && res.transfer) showToast('Download started');
    } catch (err) {
      showToast(`Download failed — ${(err && err.message) || 'unknown error'}`);
    }
  };
  const cancelDl = async (id) => {
    try {
      await api.cancelDownload(id);
    } catch {
      /* tray updates via the broadcast anyway */
    }
  };
  const pauseDl = async (id) => {
    try {
      const list = await api.pauseDownload(id);
      setDownloads(list || []);
    } catch {
      /* tray updates via the broadcast anyway */
    }
  };
  const clearDl = async () => {
    try {
      const list = await api.clearDownloads();
      setDownloads(list || []);
    } catch {
      /* non-fatal */
    }
  };
  const retryDl = async (id) => {
    try {
      const list = await api.retryDownload(id);
      setDownloads(list || []);
      showToast('Resuming download…');
    } catch (err) {
      showToast(`Resume failed — ${(err && err.message) || 'unknown error'}`);
    }
  };
  const revealDl = async (id) => {
    try {
      await api.revealDownload(id);
    } catch (err) {
      showToast(`Can't reveal — ${(err && err.message) || 'unknown error'}`);
    }
  };
  const setDlLimit = async (id, bytesPerSec) => {
    try {
      const list = await api.setDownloadLimit(id, bytesPerSec);
      setDownloads(list || []);
    } catch {
      /* tray updates via the broadcast anyway */
    }
  };
  const moveDl = async (id, dir) => {
    try {
      const list = await api.moveDownload(id, dir);
      setDownloads(list || []);
    } catch {
      /* non-fatal */
    }
  };
  const moveDlTo = async (id, toIndex) => {
    try {
      const list = await api.moveDownloadTo(id, toIndex);
      setDownloads(list || []);
    } catch {
      /* non-fatal */
    }
  };
  const refreshDlStats = useCallback(async () => {
    try {
      setDlStats((await api.getDownloadStats()) || null);
    } catch {
      /* non-fatal — panel stays hidden */
    }
  }, []);
  const resumeAllDl = async () => {
    try {
      const list = await api.resumePausedDownloads();
      setDownloads(list || []);
    } catch {
      /* tray updates via the broadcast anyway */
    }
  };
  const removeAllPausedDl = async () => {
    try {
      const list = await api.removePausedDownloads();
      setDownloads(list || []);
    } catch {
      /* tray updates via the broadcast anyway */
    }
  };

  const refreshLibrary = useCallback(async () => {
    try {
      const s = await api.getState();
      setHistory(s.history || []);
      setFavorites(s.favorites || []);
      setEngines(s.engines || []);
      setPrefsState(s.prefs || { proxy: { enabled: false } });
    } catch {
      /* non-fatal */
    }
  }, []);

  // ----- boot + subscriptions -----------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const s = await api.getState();
        setVersion(s.version);
        setEngines(s.engines || []);
        setPrefsState(s.prefs || { proxy: { enabled: false } });
        setHistory(s.history || []);
        setFavorites(s.favorites || []);
      } catch (err) {
        console.error('[torrentor] boot state failed', err);
      }
    })();

    const unsubProgress = api.onSearchProgress((snap) => {
      if (snap.runId !== seqRef.current) return; // stale run
      if (snap.results) setResults(snap.results);
      if (snap.perEngine) setPerEngine(snap.perEngine);
    });
    const unsubHealth = api.onHealthProgress((list) => setHealth(list || []));
    const unsubMax = api.onMaximized(setMaxed);
    const unsubDl = api.onDownloadsChanged(({ snapshot, kind }) => {
      setDownloads(snapshot || []);
      // A completed transfer moves bytes between sources' tallies — keep
      // the Library panel fresh without polling.
      if (kind === 'done') refreshDlStats();
    });
    api
      .getDownloads()
      .then((list) => setDownloads(list || []))
      .catch(() => {
        /* non-fatal */
      });
    refreshDlStats();
    api
      .exploreTiles()
      .then((tiles) => setExploreTiles(Array.isArray(tiles) ? tiles : []))
      .catch(() => {
        /* non-fatal — idle shows suggestions only */
      });
    return () => {
      unsubProgress();
      unsubHealth();
      unsubMax();
      unsubDl();
    };
  }, [refreshDlStats]);

  // ----- search ---------------------------------------------------------
  const runSearch = useCallback(
    async (q, opts) => {
      const text = String(q || '').trim();
      if (text.length < 2) {
        showToast('Type at least 2 characters');
        return;
      }
      const mySeq = ++seqRef.current;
      const ids = (opts && opts.ids) || enabledIds();
      setView('search');
      setLastQuery(text);
      setQuery(text);
      setRunError(null);
      setPhase('running');
      setResults([]);
      setArchiveFilter('all');
      setArchiveHasMore(false);
      setPerEngine(Object.fromEntries(engines.filter((e) => ids.includes(e.id)).map((e) => [e.id, { status: 'running', count: 0 }])));
      try {
        const payload = await api.search(text, ids);
        if (mySeq !== seqRef.current || payload == null) return; // superseded or cancelled
        setResults(payload.results || []);
        setPerEngine(payload.perEngine || {});
        setStats(payload.stats || { unique: 0, okEngines: 0, totalEngines: 0, tookMs: 0 });
        setPhase('done');
        const archiveOk = payload.perEngine && payload.perEngine['archive-org'] && payload.perEngine['archive-org'].status === 'ok';
        setArchivePage(1);
        setArchiveHasMore(!!archiveOk && (payload.perEngine['archive-org'].count || 0) > 0);
        refreshLibrary();
      } catch (err) {
        if (mySeq !== seqRef.current) return;
        const message = (err && err.error) || String(err && err.message ? err.message : err);
        setRunError(message);
        setPhase('done');
        setArchiveHasMore(false);
      }
    },
    [engines, showToast]
  );

  const scheduleRerun = useCallback(
    (q) => {
      if (!q) return;
      runSearch(q);
    },
    [runSearch]
  );

  const toggleEngine = async (engine) => {
    const next = { ...Object.fromEntries(engines.map((e) => [e.id, e.enabled])), [engine.id]: !engine.enabled };
    const ids = Object.keys(next).filter((id) => next[id]);
    try {
      await api.setEngines(ids);
      setEngines(engines.map((e) => ({ ...e, enabled: next[e.id] })));
    } catch {
      /* non-fatal */
    }
    if (lastQuery) scheduleRerun(lastQuery);
  };

  // True single-engine retry: re-run ONLY the failed engine and merge its
  // fresh results into the list already shown (deduped main-side).
  const retryEngine = useCallback(async (engine) => {
    if (!engine || !lastQuery || retryingId) return;
    const mySeq = seqRef.current;
    setRetryingId(engine.id);
    setPerEngine((pe) => ({ ...pe, [engine.id]: { status: 'running', count: 0 } }));
    try {
      const res = await api.retryEngine(engine.id, lastQuery, results);
      if (mySeq !== seqRef.current || !res) return; // superseded
      if (res.ok) {
        if (res.results) {
          setResults(res.results);
          setStats((s) => ({ ...s, unique: res.results.length }));
        }
        setPerEngine((pe) => ({ ...pe, [engine.id]: { status: 'ok', count: res.added || 0 } }));
      } else {
        setPerEngine((pe) => ({ ...pe, [engine.id]: { status: 'error', error: res.error || 'Retry failed' } }));
      }
    } catch (err) {
      if (mySeq === seqRef.current) {
        setPerEngine((pe) => ({ ...pe, [engine.id]: { status: 'error', error: (err && err.error) || 'Retry failed' } }));
      }
    } finally {
      if (mySeq === seqRef.current) setRetryingId(null);
    }
  }, [lastQuery, retryingId, results]);

  // Fetch the next Archive.org page and merge it into the shown list.
  const loadMoreArchive = useCallback(async () => {
    if (!lastQuery || loadingMore) return;
    const mySeq = seqRef.current;
    setLoadingMore(true);
    try {
      const res = await api.loadMore(lastQuery, archivePage + 1, results);
      if (mySeq !== seqRef.current || !res || !res.results) return; // superseded
      setResults(res.results);
      setStats((s) => ({ ...s, unique: res.results.length }));
      setArchivePage(res.page);
      setArchiveHasMore(!!res.hasMore && res.results.length < 250);
      if (!res.added) showToast('No new results on this page');
    } catch (err) {
      showToast((err && err.error) || 'Could not load more results');
    } finally {
      setLoadingMore(false);
    }
  }, [lastQuery, loadingMore, archivePage, results, showToast]);

  // ----- library ops ----------------------------------------------------
  const toggleFavorite = async (result) => {
    try {
      await api.toggleFavorite(result);
      const list = await api.getFavorites();
      setFavorites(list);
    } catch {
      showToast('Could not save favorite');
    }
  };

  const clearHistory = async () => {
    try {
      await api.clearHistory();
      setHistory([]);
      showToast('History cleared');
    } catch {
      /* ignore */
    }
  };

  // ----- source health (Settings → Search sources) ---------------------
  const loadHealth = useCallback(async () => {
    try {
      setHealth((await api.getHealth()) || []);
    } catch {
      /* non-fatal */
    }
  }, []);

  const runHealth = useCallback(async () => {
    if (healthRunning) return;
    setHealthRunning(true);
    try {
      setHealth((await api.runHealth()) || []);
    } catch (err) {
      showToast((err && err.error) || 'Health check failed');
    } finally {
      setHealthRunning(false);
    }
  }, [healthRunning, showToast]);

  const setProxyPrefs = async (partial) => {
    try {
      const out = await api.setPrefs(partial);
      setPrefsState(out);
      return out;
    } catch (err) {
      showToast((err && err.error) || 'Could not save settings');
      throw err;
    }
  };

  const favKeys = new Set(favorites.map((f) => f.key));
  const running = phase === 'running';

  // ----- derived display list --------------------------------------------
  // Results already arrive seeders-sorted from main; re-sort only for the
  // non-default sort modes the user can pick.
  let shown = [];
  if (view === 'search') {
    const byCat = catFilter === 'all' ? results : results.filter((r) => r.category === catFilter);
    // Archive mediatype filter: applies to Archive-backed cards only. While
    // active, cards from other engines are hidden (they have no authoritative
    // mediatype); 'All' restores everything.
    const filtered = archiveFilter === 'all' ? byCat : byCat.filter((r) => r.mediatype === archiveFilter);
    shown = sortMode === 'seeders' ? filtered : sortResults(filtered, sortMode);
  }

  const catCounts = {};
  for (const r of results) catCounts[r.category] = (catCounts[r.category] || 0) + 1;
  const archiveTypes = [...new Set(results.map((r) => r.mediatype).filter(Boolean))];
  const archiveCounts = {};
  for (const r of results) if (r.mediatype) archiveCounts[r.mediatype] = (archiveCounts[r.mediatype] || 0) + 1;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <TitleBar maximized={maxed} />

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* ============================ HEADER ============================ */}
        <div style={{ padding: '16px 22px 12px', flexShrink: 0 }}>
          {/* search row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                background: 'rgba(11,19,34,0.85)',
                border: running ? '1px solid #22d3ee88' : '1px solid #22314b',
                borderRadius: 14,
                padding: '0 14px',
                height: 50,
                boxShadow: running ? '0 0 0 3px rgba(34,211,238,0.08)' : 'none',
                transition: 'border-color .2s, box-shadow .2s',
              }}
            >
              <I.search size={18} style={{ color: running ? '#22d3ee' : '#5b6b84', flexShrink: 0 }} />
              <input
                data-testid="search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch(query)}
                placeholder="Search every enabled torrent source at once… e.g. ubuntu 24.04, big buck bunny"
                spellCheck={false}
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: '#e6edf7',
                  fontSize: 16.5,
                  fontFamily: 'inherit',
                }}
              />
              {running && (
                <span
                  className="spin-slow"
                  style={{ width: 15, height: 15, borderRadius: 99, border: '2px solid rgba(34,211,238,0.25)', borderTopColor: '#22d3ee', flexShrink: 0 }}
                />
              )}
              <button type="button" data-testid="search-go" className="app-nodrag" style={goBtn} onClick={() => runSearch(query)} disabled={running}>
                <I.search size={15} />
                Search
              </button>
            </div>

            <button
              type="button"
              data-testid="vpn-status"
              className="app-nodrag tooltip"
              data-tip={prefs.proxy && prefs.proxy.enabled ? 'VPN / proxy route active — click for privacy settings' : 'Direct route — click to configure a VPN / proxy'}
              style={{
                ...roundBtn,
                color: prefs.proxy && prefs.proxy.enabled ? '#34d399' : '#8494ab',
                border: `1px solid ${prefs.proxy && prefs.proxy.enabled ? '#34d39966' : '#22314b'}`,
                background: prefs.proxy && prefs.proxy.enabled ? 'rgba(52,211,153,0.08)' : 'transparent',
              }}
              onClick={() => {
                setSettingsOpen(true);
              }}
            >
              {prefs.proxy && prefs.proxy.enabled ? <I.shield size={17} /> : <I.shieldOff size={17} />}
            </button>
            <button type="button" data-testid="open-settings" className="app-nodrag tooltip" data-tip="Settings" style={roundBtn} onClick={() => setSettingsOpen(true)}>
              <I.settings size={17} />
            </button>
          </div>

          {/* engine chips */}
          <div style={{ marginTop: 11 }}>
            <EngineChips engines={engines} perEngine={perEngine} onToggle={toggleEngine} onRetry={retryEngine} />
          </div>

          {/* nav + toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 13, flexWrap: 'wrap' }}>
            {[
              ['search', `Results${results.length ? ` (${results.length})` : ''}`],
              ['favorites', `Favorites${favorites.length ? ` (${favorites.length})` : ''}`],
              ['history', `Recent${history.length ? ` (${history.length})` : ''}`],
            ].map(([id, label]) => (
              <button key={id} type="button" data-testid={`tab-${id}`} className="app-nodrag" style={tabBtn(view === id)} onClick={() => setView(id)}>
                {label}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            {view === 'search' && running && (
              <span data-testid="run-status" style={{ color: '#8494ab', fontSize: 12 }} className="fade-in">
                querying {Math.max(1, engines.filter((e) => e.enabled).length)} source{engines.filter((e) => e.enabled).length === 1 ? '' : 's'}…
              </span>
            )}
            {view === 'search' && !running && phase === 'done' && !runError && (
              <span data-testid="run-summary" style={{ color: '#8494ab', fontSize: 12 }} className="fade-in">
                {stats.unique} unique result{stats.unique === 1 ? '' : 's'} from {stats.okEngines}/{stats.totalEngines} sources in {(stats.tookMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>

          {/* category + sort strip (search view only) */}
          {view === 'search' && results.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, flexWrap: 'wrap' }} className="fade-in">
              <CatPill label="All" active={catFilter === 'all'} onClick={() => setCatFilter('all')} count={results.length} />
              {Object.keys(CATEGORY_META).map((c) => (
                <CatPill
                  key={c}
                  label={CATEGORY_META[c].label}
                  color={CATEGORY_META[c].color}
                  count={catCounts[c] || 0}
                  active={catFilter === c}
                  onClick={() => setCatFilter(catFilter === c ? 'all' : c)}
                />
              ))}
              <div style={{ flex: 1 }} />
              <select
                className="app-nodrag"
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value)}
                style={{
                  background: '#0b1322',
                  border: '1px solid #22314b',
                  color: '#b7c7dd',
                  borderRadius: 8,
                  padding: '5px 9px',
                  fontSize: 12,
                  outline: 'none',
                }}
              >
                <option value="seeders">Sort: seeders</option>
                <option value="size">Sort: size</option>
                <option value="newest">Sort: newest</option>
                <option value="relevance">Sort: relevance</option>
              </select>
            </div>
          )}

          {/* Archive mediatype filter row — only when Archive cards exist */}
          {view === 'search' && results.length > 0 && archiveTypes.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7, flexWrap: 'wrap' }} className="fade-in">
              <span style={{ color: '#5b6b84', fontSize: 11, letterSpacing: 0.4, textTransform: 'uppercase', fontWeight: 600 }}>Archive</span>
              <button
                type="button"
                data-testid="arch-filter-all"
                className="app-nodrag"
                style={{ ...filterChipStyle, fontWeight: archiveFilter === 'all' ? 650 : 500, color: archiveFilter === 'all' ? '#7ce7f7' : '#8494ab', borderColor: archiveFilter === 'all' ? '#22d3ee55' : '#22314b', background: archiveFilter === 'all' ? 'rgba(34,211,238,0.12)' : 'transparent' }}
                onClick={() => setArchiveFilter('all')}
              >
                All
              </button>
              {archiveTypes.map((mt) => (
                <button
                  key={mt}
                  type="button"
                  data-testid={`arch-filter-${mt}`}
                  className="app-nodrag"
                  style={{ ...filterChipStyle, fontWeight: archiveFilter === mt ? 650 : 500, color: archiveFilter === mt ? '#7ce7f7' : '#8494ab', borderColor: archiveFilter === mt ? '#22d3ee55' : '#22314b', background: archiveFilter === mt ? 'rgba(34,211,238,0.12)' : 'transparent' }}
                  onClick={() => setArchiveFilter(archiveFilter === mt ? 'all' : mt)}
                >
                  {ARCHIVE_MEDIATYPE_LABELS[mt] || mt}
                  <span style={{ color: archiveFilter === mt ? '#7ce7f7' : '#5b6b84', fontSize: 11 }}>{archiveCounts[mt] || 0}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ============================ BODY ============================ */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '2px 22px 28px' }}>
          {view === 'search' && phase === 'idle' && (
            <IdleState onSuggestion={(s) => runSearch(s)} engines={engines} tiles={exploreTiles} />
          )}

          {view === 'search' && runError && (
            <div
              style={{
                margin: '10px 0',
                padding: '11px 14px',
                borderRadius: 10,
                border: '1px solid #fb718544',
                background: 'rgba(251,113,133,0.07)',
                color: '#fecdd3',
                fontSize: 12.5,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <I.info size={15} style={{ color: '#fb7185', flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{runError}</span>
              <button type="button" data-testid="error-retry" style={{ ...ghostBtnSmall }} onClick={() => runSearch(lastQuery)}>
                Retry
              </button>
            </div>
          )}

          {view === 'search' && phase === 'done' && !runError && shown.length === 0 && (
            <EmptyState query={lastQuery} onRetry={() => runSearch(lastQuery)} onSuggestion={(s) => runSearch(s)} />
          )}

          {view === 'search' && shown.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {shown.map((r) => (
                <ResultCard
                  key={r.key}
                  result={r}
                  isFav={favKeys.has(r.key)}
                  onToast={showToast}
                  onFavToggle={toggleFavorite}
                  onDownload={startDirectDownload}
                  onFiles={(item) => setFilesItem(item)}
                />
              ))}
            </div>
          )}

          {view === 'search' && phase === 'done' && !running && shown.length > 0 && archiveHasMore && shown.length < 250 && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0 4px' }} className="fade-in">
              <button
                type="button"
                data-testid="load-more"
                className="app-nodrag"
                style={ghostBtnSmall}
                disabled={loadingMore}
                onClick={loadMoreArchive}
              >
                {loadingMore ? <span className="spin-slow" style={spinnerMini} /> : <I.download size={14} />}
                {loadingMore ? 'Loading next page…' : 'Load more results (Internet Archive)'}
              </button>
            </div>
          )}

          {(view === 'favorites' || view === 'history') && <DownloadStatsPanel stats={dlStats} engines={engines} />}
          {view === 'favorites' && <FavoritesView favorites={favorites} onFavToggle={toggleFavorite} />}
          {view === 'history' && <HistoryView history={history} onRun={(q) => runSearch(q)} onClear={clearHistory} />}
        </div>
      </div>

      {filesItem && <FilesModal item={filesItem} onClose={() => setFilesItem(null)} onToast={showToast} />}

      <DownloadTray downloads={downloads} onCancel={cancelDl} onClear={clearDl} onRetry={retryDl} onReveal={revealDl} onLimit={setDlLimit} onMove={moveDl} onMoveTo={moveDlTo} onPause={pauseDl} onResumeAll={resumeAllDl} onRemoveAll={removeAllPausedDl} />

      {settingsOpen && (
        <SettingsModal
          engines={engines}
          prefs={prefs}
          version={version}
          historyCount={history.length}
          health={health}
          healthRunning={healthRunning}
          onLoadHealth={loadHealth}
          onRunHealth={runHealth}
          onClose={() => setSettingsOpen(false)}
          onSetEngines={(id) => toggleEngine(engines.find((e) => e.id === id))}
          onSetPrefs={setProxyPrefs}
          onClearHistory={clearHistory}
        />
      )}

      {toast && (
        <div
          key={toast.id}
          data-testid="toast"
          className="fade-in"
          style={{
            position: 'absolute',
            bottom: 26,
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#0f1a2e',
            border: '1px solid #2b4d74',
            color: '#cfe3f7',
            borderRadius: 10,
            padding: '9px 16px',
            fontSize: 12.5,
            boxShadow: '0 12px 40px rgba(0,0,0,.5)',
            zIndex: 200,
          }}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

// ----------------------------- pieces ----------------------------------

const TILE_GRADIENTS = ['linear-gradient(135deg,#0e7490,#155e75)', 'linear-gradient(135deg,#7c3aed,#4c1d95)', 'linear-gradient(135deg,#b45309,#78350f)', 'linear-gradient(135deg,#0f766e,#134e4a)', 'linear-gradient(135deg,#be185d,#831843)', 'linear-gradient(135deg,#1d4ed8,#1e3a8a)'];

function IdleState({ onSuggestion, engines, tiles }) {
  const enabled = engines.filter((e) => e.enabled);
  return (
    <div data-testid="idle-state" style={{ textAlign: 'center', padding: '40px 10px 16px' }} className="fade-in">
      <div style={{ fontSize: 21, fontWeight: 700, color: '#e6edf7' }}>
        One query, every source, <span style={{ background: 'linear-gradient(90deg,#22d3ee,#2dd4bf)', WebkitBackgroundClip: 'text', color: 'transparent' }}>at once</span>
      </div>
      <div style={{ color: '#8494ab', fontSize: 13, marginTop: 8, lineHeight: 1.6, maxWidth: 600, margin: '8px auto 0' }}>
        Public-domain films, old radio, audiobooks, open software and more — Torrentor fans your query out to {enabled.length} legal source{enabled.length === 1 ? '' : 's'} in
        parallel, merges the results by infohash, and streams them in as each source answers.
      </div>
      <div style={{ marginTop: 22, display: 'flex', justifyContent: 'center' }}>
        <SuggestionChips suggestions={SUGGESTIONS} onPick={onSuggestion} />
      </div>
      {tiles && tiles.length > 0 && (
        <div style={{ marginTop: 30 }}>
          <div style={{ color: '#5b6b84', fontSize: 10.5, letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: 700, marginBottom: 10 }}>
            Explore open culture
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', maxWidth: 760, margin: '0 auto' }}>
            {tiles.map((t, i) => (
              <button
                key={t.q}
                type="button"
                data-testid="explore-tile"
                data-q={t.q}
                className="app-nodrag"
                onClick={() => onSuggestion(t.q)}
                style={{
                  position: 'relative',
                  width: 172,
                  height: 92,
                  borderRadius: 13,
                  border: '1px solid #22314b',
                  overflow: 'hidden',
                  cursor: 'pointer',
                  padding: 0,
                  textAlign: 'left',
                  flexShrink: 0,
                  background: TILE_GRADIENTS[i % TILE_GRADIENTS.length],
                }}
              >
                {t.thumb && (
                  <img
                    src={t.thumb}
                    alt=""
                    loading="lazy"
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.85 }}
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                )}
                <span
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    padding: '16px 10px 8px',
                    fontSize: 12,
                    fontWeight: 650,
                    color: '#f1f7ff',
                    textShadow: '0 1px 3px rgba(0,0,0,.8)',
                    background: 'linear-gradient(transparent, rgba(0,0,0,0.65))',
                    textAlign: 'left',
                  }}
                >
                  {t.label}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div style={{ color: '#4d5d75', fontSize: 11.5, marginTop: 26, maxWidth: 620, margin: '26px auto 0', lineHeight: 1.7 }}>
        Legal-first sources are on by default (Archive.org's public-domain & CC catalog, official Linux ISOs, and a clearly-labeled demo corpus).
        Torrentor is search software — it stores no files. Only download what you have the right to share.
      </div>
    </div>
  );
}

function EmptyState({ query, onRetry, onSuggestion }) {
  return (
    <div data-testid="empty-state" style={{ textAlign: 'center', padding: '60px 10px 20px' }} className="fade-in">
      <I.search size={40} style={{ color: '#3a4a63', marginBottom: 14 }} />
      <div style={{ color: '#b7c7dd', fontSize: 14.5, fontWeight: 600 }}>No results for “{query}”</div>
      <div style={{ color: '#8494ab', fontSize: 12.5, marginTop: 6 }}>
        Try broader terms, fewer words, or check that a source is reachable from your network.
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18 }}>
        <button type="button" data-testid="empty-retry" className="app-nodrag" style={ghostBtnSmall} onClick={onRetry}>
          <I.refresh size={13} /> Retry search
        </button>
        <SuggestionChips suggestions={SUGGESTIONS.slice(0, 3)} onPick={onSuggestion} />
      </div>
    </div>
  );
}

function SuggestionChips({ suggestions, onPick }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
      {suggestions.map((s) => (
        <button key={s} type="button" data-testid="suggestion" className="app-nodrag" style={suggestChip} onClick={() => onPick(s)}>
          {s}
        </button>
      ))}
    </div>
  );
}

function CatPill({ label, color, count, active, onClick }) {
  return (
    <button
      type="button"
      className="app-nodrag"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 11px',
        borderRadius: 99,
        fontSize: 12,
        fontWeight: active ? 650 : 500,
        background: active ? 'rgba(34,211,238,0.12)' : 'transparent',
        border: active ? '1px solid #22d3ee55' : '1px solid #22314b',
        color: active ? '#7ce7f7' : '#8494ab',
        cursor: 'pointer',
      }}
      onClick={onClick}
    >
      {color && <span style={{ width: 7, height: 7, borderRadius: 99, background: color, display: 'inline-block' }} />}
      {label}
      {count > 0 && <span style={{ color: active ? '#7ce7f7' : '#5b6b84', fontSize: 11 }}>{count}</span>}
    </button>
  );
}

function tabBtn(active) {
  return {
    padding: '5px 12px',
    borderRadius: 8,
    fontSize: 12.5,
    fontWeight: active ? 650 : 500,
    background: active ? 'rgba(15,26,46,1)' : 'transparent',
    border: active ? '1px solid #2b4d74' : '1px solid transparent',
    color: active ? '#cfe3f7' : '#8494ab',
    cursor: 'pointer',
  };
}

const spinnerMini = {
  width: 13,
  height: 13,
  borderRadius: 99,
  border: '2px solid rgba(34,211,238,0.25)',
  borderTopColor: '#22d3ee',
  display: 'inline-block',
};

const goBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  height: 34,
  padding: '0 16px',
  borderRadius: 10,
  background: 'linear-gradient(90deg, rgba(34,211,238,.9), rgba(45,212,191,.9))',
  border: 'none',
  color: '#04222b',
  fontWeight: 700,
  fontSize: 13,
  cursor: 'pointer',
  flexShrink: 0,
};
const roundBtn = {
  width: 44,
  height: 44,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(11,19,34,0.85)',
  border: '1px solid #22314b',
  color: '#b7c7dd',
  borderRadius: 12,
  cursor: 'pointer',
  flexShrink: 0,
};
const filterChipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 10px',
  borderRadius: 99,
  fontSize: 11.5,
  border: '1px solid #22314b',
  background: 'transparent',
  cursor: 'pointer',
};
const suggestChip = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  padding: '8px 15px',
  borderRadius: 99,
  background: 'rgba(15,26,46,0.85)',
  border: '1px solid #22314b',
  color: '#c6d7ec',
  fontSize: 12.5,
  cursor: 'pointer',
};
const ghostBtnSmall = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  padding: '7px 13px',
  borderRadius: 9,
  background: 'rgba(15,26,46,0.9)',
  border: '1px solid #22314b',
  color: '#c6d7ec',
  fontSize: 12.5,
  cursor: 'pointer',
};

module.exports = App;

// ----- entry point (this file is the esbuild bundle entry) --------
const { createRoot } = require('react-dom/client');
const root = createRoot(document.getElementById('root'));
root.render(React.createElement(App));
