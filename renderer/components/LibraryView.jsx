'use strict';
const React = require('react');
const { I, CatGlyph, CATEGORY_META } = require('./icons');
const fmt = require('../../lib/format');

function FavoritesView({ favorites, onFavToggle }) {
  if (!favorites.length) {
    return (
      <Empty testid="favorites-empty" hint="Star any result to pin it here. Favorites are stored only on this machine." icon={<I.star size={34} style={{ color: '#3a4a63' }} />} />
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {favorites.map((f) => {
        const meta = CATEGORY_META[f.category] || CATEGORY_META.other;
        const title = (
          <span>
            {f.title}
            {f.demo && (
              <span
                className="tooltip"
                data-tip="Synthetic demo entry — not a real torrent"
                style={{
                  marginLeft: 8,
                  fontSize: 9.5,
                  fontWeight: 700,
                  color: '#7c4d05',
                  background: '#fbbf2433',
                  border: '1px solid #fbbf2455',
                  padding: '0 6px',
                  borderRadius: 99,
                  verticalAlign: 1,
                }}
              >
                DEMO
              </span>
            )}
          </span>
        );
        return (
          <div
            key={f.key}
            data-testid="favorite-row"
            style={{
              display: 'flex',
              gap: 11,
              alignItems: 'center',
              padding: '11px 13px',
              background: 'rgba(11,19,34,0.75)',
              border: '1px solid #16253d',
              borderRadius: 12,
            }}
          >
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 9,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: `${meta.color}14`,
              }}
            >
              <CatGlyph category={f.category} size={16} color={meta.color} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: '#e6edf7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.title}>
                {title}
              </div>
              <div style={{ display: 'flex', gap: 12, color: '#8494ab', fontSize: 11.5, marginTop: 2 }}>
                <span>{fmt.formatBytes(f.sizeBytes)}</span>
                {f.seeders != null && <span>⬆ {fmt.formatCompact(f.seeders)}</span>}
                <span>saved {fmt.relativeTime(f.addedAt)}</span>
              </div>
            </div>
            <button
              type="button"
              className="app-nodrag tooltip"
              data-tip={f.magnet ? 'Copy magnet' : 'No magnet available'}
              style={smallBtn}
              onClick={() => f.magnet && window.torrentor.copy(f.magnet)}
              disabled={!f.magnet}
            >
              <I.magnet size={15} />
            </button>
            <button type="button" className="app-nodrag tooltip" data-tip="Open in torrent client" style={smallBtn} disabled={!f.magnet} onClick={() => f.magnet && window.torrentor.openExternal(f.magnet)}>
              <I.external size={14} />
            </button>
            <button type="button" data-testid="remove-fav" className="app-nodrag tooltip" data-tip="Remove favorite" style={{ ...smallBtn, color: '#fb7185' }} onClick={() => onFavToggle(f)}>
              <I.trash size={15} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function HistoryView({ history, onRun, onClear }) {
  if (!history.length) {
    return <Empty testid="history-empty" hint="Completed searches appear here so you can re-run them in one click." icon={<I.clock size={34} style={{ color: '#3a4a63' }} />} />;
  }
  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {history.map((h) => (
          <button
            key={`${h.q}-${h.ts}`}
            type="button"
            data-testid="history-row"
            className="app-nodrag"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              textAlign: 'left',
              padding: '10px 13px',
              background: 'rgba(11,19,34,0.75)',
              border: '1px solid #16253d',
              borderRadius: 11,
              color: '#cfe3f7',
              cursor: 'pointer',
            }}
            onClick={() => onRun(h.q)}
          >
            <I.clock size={14} style={{ color: '#5b6b84' }} />
            <span style={{ fontWeight: 600, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.q}</span>
            <span style={{ color: '#8494ab', fontSize: 11.5 }}>{h.count} results</span>
            <span style={{ color: '#5b6b84', fontSize: 11 }}>{fmt.relativeTime(h.ts)}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="app-nodrag"
        style={{
          marginTop: 12,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          background: 'transparent',
          border: '1px solid #3a2a35',
          color: '#fb7185',
          borderRadius: 8,
          padding: '6px 12px',
          fontSize: 12,
          cursor: 'pointer',
        }}
        onClick={onClear}
      >
        <I.trash size={13} /> Clear history
      </button>
    </div>
  );
}

function Empty({ icon, hint, testid }) {
  return (
    <div data-testid={testid} style={{ textAlign: 'center', padding: '70px 20px', color: '#8494ab' }}>
      <div style={{ marginBottom: 14 }}>{icon}</div>
      <div style={{ fontSize: 13.5 }}>{hint}</div>
    </div>
  );
}

/**
 * Lifetime per-source download tallies (count + bytes) shown above the
 * Favorites and History views. Hidden until at least one download has
 * completed. Rows are sorted by bytes so the heaviest source leads.
 */
function DownloadStatsPanel({ stats, engines }) {
  const rows = stats && typeof stats === 'object' ? Object.entries(stats).filter(([, v]) => v && (v.count > 0 || v.bytes > 0)) : [];
  if (!rows.length) return null;
  const nameOf = (id) => {
    const e = (engines || []).find((x) => x.id === id);
    if (e && e.name) return e.name;
    return id === 'other' ? 'Other sources' : id;
  };
  const sorted = rows.slice().sort((a, b) => (b[1].bytes || 0) - (a[1].bytes || 0));
  const totalCount = sorted.reduce((s, [, v]) => s + (v.count || 0), 0);
  const totalBytes = sorted.reduce((s, [, v]) => s + (v.bytes || 0), 0);
  const maxBytes = Math.max(1, sorted[0][1].bytes || 0);
  return (
    <div data-testid="dl-stats" style={{ marginBottom: 12, padding: '12px 14px', background: 'rgba(11,19,34,0.75)', border: '1px solid #16253d', borderRadius: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#5b6b84', fontSize: 10.5, letterSpacing: 1.1, textTransform: 'uppercase', fontWeight: 700, marginBottom: 8 }}>
        <I.download size={12} /> Downloads by source
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sorted.map(([id, v]) => (
          <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
            <span style={{ width: 120, flexShrink: 0, color: '#cfe3f7', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={nameOf(id)}>
              {nameOf(id)}
            </span>
            <div style={{ flex: 1, height: 5, borderRadius: 99, background: '#16253d', overflow: 'hidden' }}>
              <div style={{ width: `${Math.max(2, ((v.bytes || 0) / maxBytes) * 100)}%`, height: '100%', borderRadius: 99, background: 'linear-gradient(90deg,#22d3ee,#2dd4bf)' }} />
            </div>
            <span style={{ width: 74, flexShrink: 0, textAlign: 'right', color: '#8494ab', fontSize: 11 }}>
              {v.count} file{v.count === 1 ? '' : 's'}
            </span>
            <span style={{ width: 70, flexShrink: 0, textAlign: 'right', color: '#b7c7dd', fontSize: 11.5, fontWeight: 600 }}>{fmt.formatBytes(v.bytes)}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 9, paddingTop: 8, borderTop: '1px solid #16253d', display: 'flex', justifyContent: 'space-between', color: '#8494ab', fontSize: 11.5 }}>
        <span>Total: {totalCount} file{totalCount === 1 ? '' : 's'} · {fmt.formatBytes(totalBytes)}</span>
        <span style={{ color: '#5b6b84' }}>lifetime</span>
      </div>
    </div>
  );
}

const smallBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  borderRadius: 8,
  background: 'transparent',
  border: '1px solid #22314b',
  color: '#9db3cf',
  cursor: 'pointer',
  flexShrink: 0,
};

module.exports = { FavoritesView, HistoryView, DownloadStatsPanel };
