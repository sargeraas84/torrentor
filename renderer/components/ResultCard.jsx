'use strict';
const React = require('react');
const { useState, useRef, useEffect } = require('react');
const { I, CatGlyph, CATEGORY_META } = require('./icons');
const fmt = require('../../lib/format');

function SourceBadges({ result }) {
  const list = result.sources || [];
  if (!list.length) return null;
  const dup = list.length > 1;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
      {dup && <span style={{ color: '#5b6b84', fontSize: 11 }}>also on</span>}
      {list.map((s, i) => (
        <span
          key={`${s.sourceId}-${i}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            background: 'rgba(28, 42, 66, 0.7)',
            border: '1px solid #22314b',
            color: '#9db3cf',
            padding: '1px 8px',
            borderRadius: 99,
            fontSize: 11,
            lineHeight: '17px',
          }}
        >
          <span style={{ width: 5, height: 5, borderRadius: 99, background: s.demo ? '#fbbf24' : '#38bdf8', flexShrink: 0 }} />
          {s.sourceLabel || s.sourceId}
        </span>
      ))}
    </div>
  );
}

function Menu({ result, isFav, onAction }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const items = [];
  if (result.magnet) items.push({ key: 'copy-magnet', label: 'Copy magnet link', icon: <I.copy size={14} />, fn: () => onAction('copy', result.magnet) });
  if (result.torrentUrl) items.push({ key: 'copy-torrent', label: 'Copy .torrent URL', icon: <I.link size={14} />, fn: () => onAction('copy', result.torrentUrl) });
  if (result.infohash) items.push({ key: 'copy-ih', label: `Copy infohash (${result.infohash.slice(0, 12)}…)`, icon: <I.hash size={14} />, fn: () => onAction('copy', result.infohash) });
  if (result.pageUrl) items.push({ key: 'page', label: 'Open source page', icon: <I.external size={14} />, fn: () => onAction('open', result.pageUrl) });
  if (result.torrentUrl) items.push({ key: 'torrent-ext', label: 'Download .torrent file', icon: <I.download size={14} />, fn: () => onAction('open', result.torrentUrl) });
  items.push({ key: 'fav', label: isFav ? 'Remove favorite' : 'Save favorite', icon: <I.starOutline size={14} />, fn: () => onAction('fav', result) });

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="app-nodrag"
        aria-label="More actions"
        style={iconBtn}
        onClick={() => setOpen((v) => !v)}
      >
        <I.more size={16} />
      </button>
      {open && (
        <div
          className="fade-in"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            zIndex: 40,
            minWidth: 205,
            background: '#0f1a2e',
            border: '1px solid #22314b',
            borderRadius: 10,
            boxShadow: '0 16px 40px rgba(0,0,0,.55)',
            padding: 5,
          }}
        >
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              className="app-nodrag"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                width: '100%',
                textAlign: 'left',
                background: 'transparent',
                border: 'none',
                color: '#c6d7ec',
                padding: '7px 10px',
                borderRadius: 7,
                fontSize: 12.5,
                cursor: 'pointer',
              }}
              onClick={() => {
                setOpen(false);
                it.fn();
              }}
            >
              <span style={{ color: '#8494ab', display: 'inline-flex' }}>{it.icon}</span>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const iconBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  borderRadius: 8,
  background: 'transparent',
  border: '1px solid transparent',
  color: '#8494ab',
  cursor: 'pointer',
};

module.exports = function ResultCard({ result, isFav, onToast, onFavToggle }) {
  const meta = CATEGORY_META[result.category] || CATEGORY_META.other;
  const hasMagnet = !!result.magnet;
  const primary = hasMagnet ? 'magnet' : result.torrentUrl ? 'torrent' : null;
  // Archive.org cards carry a poster thumbnail; render it (falling back
  // to the category tile when the image can't load).
  const [thumbFailed, setThumbFailed] = useState(false);
  const showThumb = !!result.thumbnail && !result.demo && !thumbFailed;

  const doAction = (kind, payload) => {
    if (kind === 'copy') {
      window.torrentor.copy(payload);
      onToast('Copied to clipboard');
    } else if (kind === 'open') {
      window.torrentor.openExternal(payload);
    } else if (kind === 'fav') {
      onFavToggle(payload);
    }
  };

  return (
    <div
      className="fade-in"
      data-testid="result-card"
      style={{
        display: 'flex',
        gap: 13,
        padding: '13px 14px',
        background: 'rgba(11, 19, 34, 0.75)',
        border: '1px solid #16253d',
        borderRadius: 13,
        alignItems: 'flex-start',
        transition: 'border-color .15s, background .15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = '#25405f';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = '#16253d';
      }}
    >
      {/* poster / category tile */}
      {showThumb ? (
        <img
          data-testid="result-thumb"
          src={result.thumbnail}
          alt=""
          loading="lazy"
          onError={() => setThumbFailed(true)}
          style={{
            width: 96,
            height: 64,
            objectFit: 'cover',
            borderRadius: 10,
            border: '1px solid #22314b',
            flexShrink: 0,
            background: '#0b1322',
            display: 'block',
          }}
        />
      ) : (
        <div
          style={{
            width: 40,
          height: 40,
          borderRadius: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          background: `${meta.color}14`,
          border: `1px solid ${meta.color}33`,
        }}
      >
        <CatGlyph category={result.category} size={19} color={meta.color} />
      </div>
      )}

      {/* main */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          title={result.title}
          style={{
            fontWeight: 600,
            fontSize: 13.8,
            lineHeight: 1.35,
            color: '#e6edf7',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            wordBreak: 'break-word',
          }}
        >
          {result.title}
          {result.demo && (
            <span
              className="tooltip"
              data-tip="Synthetic demo entry — the infohash is not a real torrent"
              style={{
                marginLeft: 8,
                verticalAlign: 2,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.6,
                color: '#7c4d05',
                background: '#fbbf2433',
                border: '1px solid #fbbf2455',
                padding: '1px 7px',
                borderRadius: 99,
                textTransform: 'uppercase',
              }}
            >
              Demo
            </span>
          )}
        </div>

        {/* meta row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 5, color: '#8494ab', fontSize: 12 }}>
          <span style={{ color: '#b7c7dd' }}>{fmt.formatBytes(result.sizeBytes)}</span>
          {result.seeders != null && (
            <span className="tooltip" data-tip="Seeders">
              <I.arrowUp size={11} style={{ color: '#34d399', verticalAlign: -1, marginRight: 3 }} />
              <span style={{ color: '#34d399', fontWeight: 600 }}>{fmt.formatCompact(result.seeders)}</span>
            </span>
          )}
          {result.leechers != null && (
            <span className="tooltip" data-tip="Leechers">
              <I.arrowDown size={11} style={{ color: '#fb7185', verticalAlign: -1, marginRight: 3 }} />
              <span style={{ color: '#fb7185', fontWeight: 600 }}>{fmt.formatCompact(result.leechers)}</span>
            </span>
          )}
          {result.downloads != null && (
            <span className="tooltip" data-tip="Downloads">
              <I.download size={12} style={{ verticalAlign: -1, marginRight: 3 }} />
              <span>{fmt.formatCompact(result.downloads)}</span>
            </span>
          )}
          {result.uploadedAt && (
            <span className="tooltip" data-tip={new Date(result.uploadedAt).toLocaleDateString()}>
              <I.clock size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
              {fmt.relativeTime(result.uploadedAt)}
            </span>
          )}
          <span
            style={{
              fontFamily: 'Consolas, Menlo, monospace',
              fontSize: 11,
              color: '#5b7a9a',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: 150,
            }}
            className="tooltip"
            data-tip={result.infohash ? `Infohash: ${result.infohash}` : 'No infohash exposed by this source'}
          >
            {result.infohash ? `${result.infohash.slice(0, 12)}…` : 'no infohash'}
          </span>
        </div>

        <div style={{ marginTop: 7 }}>
          <SourceBadges result={result} />
        </div>
      </div>

      {/* actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, marginTop: 2 }}>
        <button
          type="button"
          className="app-nodrag tooltip"
          data-testid="fav-toggle"
          data-tip={isFav ? 'Remove favorite' : 'Save favorite'}
          style={{ ...iconBtn, color: isFav ? '#fbbf24' : '#8494ab' }}
          onClick={() => onFavToggle(result)}
        >
          <I.star size={17} style={isFav ? { fill: '#fbbf24', color: '#fbbf24' } : {}} />
        </button>
        {primary === 'magnet' && (
          <button
            type="button"
            className="app-nodrag tooltip"
            data-tip={result.demo ? 'Copy this demo magnet (synthetic)' : 'Copy magnet link'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 30,
              padding: '0 12px',
              borderRadius: 8,
              background: result.demo ? 'transparent' : 'rgba(34,211,238,0.12)',
              border: `1px solid ${result.demo ? '#3a3f4e' : '#22d3ee55'}`,
              color: result.demo ? '#8494ab' : '#7ce7f7',
              fontWeight: 600,
              fontSize: 12,
              cursor: 'pointer',
            }}
            onClick={() => doAction('copy', result.magnet)}
          >
            <I.magnet size={14} />
            {result.demo ? 'Demo magnet' : 'Magnet'}
          </button>
        )}
        {primary === 'torrent' && (
          <button
            type="button"
            className="app-nodrag tooltip"
            data-tip="Open the official .torrent file"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 30,
              padding: '0 12px',
              borderRadius: 8,
              background: 'rgba(45,212,191,0.12)',
              border: '1px solid #2dd4bf55',
              color: '#8ff0e0',
              fontWeight: 600,
              fontSize: 12,
              cursor: 'pointer',
            }}
            onClick={() => doAction('open', result.torrentUrl)}
          >
            <I.download size={14} />
            .torrent
          </button>
        )}
        <Menu result={result} isFav={isFav} onAction={doAction} />
      </div>
    </div>
  );
};

I.more = (p) => (
  <svg width={(p && p.size) || 16} height={(p && p.size) || 16} viewBox="0 0 24 24" fill="currentColor">
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </svg>
);
I.hash = (p) => (
  <svg
    width={(p && p.size) || 16}
    height={(p && p.size) || 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
  >
    <path d="M10 3 8 21M16 3l-2 18M4 8h16M3 16h16" />
  </svg>
);
