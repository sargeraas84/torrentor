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

module.exports = { FavoritesView, HistoryView };
