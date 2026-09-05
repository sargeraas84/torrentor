'use strict';
const React = require('react');
const { useState, useEffect } = require('react');
const { I } = require('./icons');
const fmt = require('../../lib/format');
const { nextPreset, limitLabel } = require('../../lib/download-presets');

const api = window.torrentor;

// ---------------------------------------------------------------- modal

/**
 * Archive item file picker: lists the item's downloadable files (loaded
 * from Archive's metadata API through main) and starts a direct download
 * per row.
 */
function FilesModal({ item, onClose, onToast }) {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // row name currently starting

  useEffect(() => {
    let alive = true;
    api
      .itemFiles(item.sourceId, item.itemId)
      .then((list) => {
        if (alive) setFiles(list);
      })
      .catch((err) => {
        if (alive) setError((err && err.message) || 'Could not load the file list.');
      });
    return () => {
      alive = false;
    };
  }, [item.sourceId, item.itemId]);

  const start = async (row) => {
    if (busy) return;
    setBusy(row.name);
    try {
      const res = await api.downloadFile(row.url);
      if (!res || !res.cancelled) onToast(`Downloading ${row.name}`);
    } catch (err) {
      onToast(`Download failed — ${(err && err.message) || 'unknown error'}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 120,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(4, 9, 18, 0.66)',
        backdropFilter: 'blur(2px)',
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="fade-in"
        data-testid="files-modal"
        style={{
          width: 'min(560px, 92vw)',
          maxHeight: '78vh',
          display: 'flex',
          flexDirection: 'column',
          background: '#0f1a2e',
          border: '1px solid #22314b',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,.6)',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '16px 18px 10px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14.5, color: '#e6edf7', wordBreak: 'break-word', lineHeight: 1.35 }}>{item.title}</div>
            <div style={{ color: '#8494ab', fontSize: 11.5, marginTop: 3 }}>
              {item.sourceId === 'demo-curated'
                ? 'Demo index · pick a sample file to try the download flow offline'
                : 'Internet Archive · choose a file to download directly'}
            </div>
          </div>
          <button type="button" aria-label="Close" style={closeBtn} onClick={onClose}>
            <I.close size={16} />
          </button>
        </div>

        <div style={{ overflowY: 'auto', padding: '2px 10px 14px', minHeight: 120 }}>
          {error && <div style={{ color: '#fecdd3', fontSize: 12.5, padding: '12px 8px' }}>{error}</div>}
          {!error && files === null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: '#8494ab', fontSize: 12.5, padding: '14px 8px' }}>
              <span className="spin-slow" style={{ width: 12, height: 12, borderRadius: 99, border: '2px solid rgba(34,211,238,0.25)', borderTopColor: '#22d3ee', display: 'inline-block' }} />
              Loading files…
            </div>
          )}
          {!error && files !== null && files.length === 0 && (
            <div style={{ color: '#8494ab', fontSize: 12.5, padding: '14px 8px' }}>No downloadable files found for this item.</div>
          )}
          {files &&
            files.map((row, i) => (
              <div
                key={`${row.name}-${i}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 8px',
                  borderBottom: '1px solid #16253d',
                }}
              >
                <I.file size={15} style={{ color: '#5b7a9a', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    title={row.name}
                    style={{ color: '#cfe3f7', fontSize: 12.5, wordBreak: 'break-all', lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                  >
                    {row.name}
                  </div>
                  <div style={{ color: '#5f7189', fontSize: 11, marginTop: 2 }}>
                    {row.format ? `${row.format} · ` : ''}
                    {fmt.formatBytes(row.size)}
                  </div>
                </div>
                <button
                  type="button"
                  data-testid="file-download"
                  className="app-nodrag"
                  style={fileBtn}
                  disabled={busy !== null}
                  onClick={() => start(row)}
                >
                  {busy === row.name ? <span className="spin-slow" style={spinnerMini} /> : <I.download size={13} />}
                  {busy === row.name ? 'Starting…' : 'Download'}
                </button>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tray

/** Bottom-right stack of transfers (running queue + recent session). */
function DownloadTray({ downloads, onCancel, onClear, onRetry, onReveal, onLimit, onMove }) {
  const running = downloads.filter((d) => d.status === 'downloading' || d.status === 'queued');
  const finished = downloads.filter((d) => d.status !== 'downloading' && d.status !== 'queued');
  const queuedCount = running.filter((d) => d.status === 'queued').length;
  if (!downloads.length) return null;

  return (
    <div
      className="fade-in"
      data-testid="download-tray"
      style={{
        position: 'absolute',
        right: 16,
        bottom: 16,
        width: 310,
        zIndex: 110,
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
        pointerEvents: 'none',
      }}
    >
      {running.map((d) => {
        const queued = d.status === 'queued';
        const pct = !queued && d.total ? Math.min(100, (d.received / d.total) * 100) : null;
        return (
          <div key={d.id} style={chip}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {queued ? (
                <I.clock size={13} style={{ color: '#8494ab', flexShrink: 0 }} />
              ) : (
                <I.download size={13} style={{ color: '#22d3ee', flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={chipTitle}>{d.name}</div>
                <div style={{ color: '#6f8199', fontSize: 10.5, marginTop: 1 }}>
                  {queued
                    ? 'Queued — waiting for a free slot'
                    : `${fmt.formatBytes(d.received)}${d.total ? ` / ${fmt.formatBytes(d.total)}` : ''}${pct != null ? ` (${Math.floor(pct)}%)` : ''}${d.speedBytesPerSec > 0 ? ` · ${fmt.formatBytes(d.speedBytesPerSec)}/s` : ''}${d.resumed ? ' · resumed from partial' : ''}`}
                </div>
              </div>
              {queued && (
                <>
                  <button
                    type="button"
                    data-testid="dl-move-up"
                    aria-label="Move up in queue (starts sooner)"
                    className="tooltip"
                    data-tip="Move up in the queue"
                    disabled={d.queuePos === 0}
                    style={{ ...moveBtn, ...(d.queuePos === 0 ? { color: '#2a3850', cursor: 'default' } : {}) }}
                    onClick={() => onMove && onMove(d.id, 'up')}
                  >
                    <I.arrowUp size={11} />
                  </button>
                  <button
                    type="button"
                    data-testid="dl-move-down"
                    aria-label="Move down in queue (starts later)"
                    className="tooltip"
                    data-tip="Move down in the queue"
                    disabled={d.queuePos === queuedCount - 1}
                    style={{ ...moveBtn, ...(d.queuePos === queuedCount - 1 ? { color: '#2a3850', cursor: 'default' } : {}) }}
                    onClick={() => onMove && onMove(d.id, 'down')}
                  >
                    <I.arrowDown size={11} />
                  </button>
                </>
              )}
              <button
                type="button"
                data-testid="dl-limit"
                className="tooltip"
                data-limit={d.maxBytesPerSec || 0}
                data-tip={d.maxBytesPerSec ? `Speed limit ${fmt.formatBytes(d.maxBytesPerSec)}/s — click to change` : 'Unlimited speed — click to set a limit'}
                style={limitBtn}
                onClick={() => onLimit && onLimit(d.id, nextPreset(d.maxBytesPerSec))}
              >
                {limitLabel(d.maxBytesPerSec)}
              </button>
              <button
                type="button"
                aria-label={queued ? 'Cancel queued download' : 'Cancel download'}
                className="tooltip"
                data-tip={queued ? 'Remove from queue' : 'Cancel — progress is kept, you can resume later'}
                style={miniBtn}
                onClick={() => onCancel(d.id)}
              >
                <I.close size={13} />
              </button>
            </div>
            {!queued && (
              <div style={{ height: 3, borderRadius: 99, background: '#16253d', marginTop: 7, overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: pct != null ? `${pct}%` : '45%',
                    background: pct != null ? '#22d3ee' : 'rgba(34,211,238,0.45)',
                    transition: 'width .3s',
                    ...(pct == null ? { animation: 'indeterminate 1.4s ease-in-out infinite' } : {}),
                  }}
                />
              </div>
            )}
          </div>
        );
      })}

      {finished.map((d) => {
        const done = d.status === 'done';
        const retryable = !done && (d.status === 'error' || d.status === 'cancelled');
        return (
          <div
            key={d.id}
            style={{ ...chip, opacity: 0.92 }}
            onContextMenu={(e) => {
              if (done && onReveal) {
                e.preventDefault();
                onReveal(d.id);
              }
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {done ? (
                <span
                  style={{ width: 14, height: 14, borderRadius: 99, background: '#34d39922', color: '#34d399', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round">
                    <path d="m4 12.5 5 5L20 6.5" />
                  </svg>
                </span>
              ) : (
                <I.info size={14} style={{ color: d.status === 'cancelled' ? '#8494ab' : '#fb7185', flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ ...chipTitle, color: done ? '#9fdcb9' : d.status === 'cancelled' ? '#8494ab' : '#f2b8bf' }}>{d.name}</div>
                <div style={{ color: '#6f8199', fontSize: 10.5, marginTop: 1 }}>
                  {done ? `Done · ${d.dir || 'saved'}` : d.status === 'cancelled' ? 'Cancelled — partial progress kept' : `Failed — ${d.error || 'unknown error'}`}
                </div>
              </div>
              {done ? (
                <button
                  type="button"
                  aria-label="Reveal in folder"
                  data-testid="dl-reveal"
                  className="tooltip"
                  data-tip="Reveal in folder (or right-click this entry)"
                  style={miniBtn}
                  onClick={() => onReveal && onReveal(d.id)}
                >
                  <I.folder size={14} />
                </button>
              ) : retryable ? (
                <button
                  type="button"
                  aria-label="Resume download"
                  data-testid="dl-retry"
                  className="tooltip"
                  data-tip="Resume — continues from the partial file"
                  style={miniBtn}
                  onClick={() => onRetry && onRetry(d.id)}
                >
                  <I.refresh size={14} />
                </button>
              ) : null}
            </div>
          </div>
        );
      })}

      {finished.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', pointerEvents: 'auto' }}>
          <button type="button" className="app-nodrag" style={clearBtn} onClick={onClear}>
            Clear finished
          </button>
        </div>
      )}
    </div>
  );
}

const closeBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  borderRadius: 8,
  background: 'transparent',
  border: 'none',
  color: '#8494ab',
  cursor: 'pointer',
  flexShrink: 0,
};
const fileBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 28,
  padding: '0 11px',
  borderRadius: 8,
  background: 'rgba(34,211,238,0.1)',
  border: '1px solid #22d3ee44',
  color: '#7ce7f7',
  fontWeight: 600,
  fontSize: 11.5,
  cursor: 'pointer',
  flexShrink: 0,
  whiteSpace: 'nowrap',
};
const chip = {
  pointerEvents: 'auto',
  background: '#0f1a2e',
  border: '1px solid #22314b',
  borderRadius: 10,
  boxShadow: '0 12px 34px rgba(0,0,0,.5)',
  padding: '9px 11px',
};
const chipTitle = {
  color: '#cfe3f7',
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const miniBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  borderRadius: 6,
  background: 'transparent',
  border: 'none',
  color: '#8494ab',
  cursor: 'pointer',
  flexShrink: 0,
};
const moveBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 18,
  height: 22,
  borderRadius: 6,
  background: 'transparent',
  border: 'none',
  color: '#5f7189',
  cursor: 'pointer',
  flexShrink: 0,
};
const limitBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 18,
  padding: '0 4px',
  borderRadius: 5,
  background: 'transparent',
  border: '1px solid #22314b',
  color: '#8494ab',
  fontSize: 9.5,
  fontWeight: 600,
  lineHeight: 1,
  cursor: 'pointer',
  flexShrink: 0,
};

const clearBtn = {
  background: 'transparent',
  border: '1px solid #22314b',
  color: '#8494ab',
  fontSize: 11,
  padding: '4px 10px',
  borderRadius: 7,
  cursor: 'pointer',
};
const spinnerMini = { width: 12, height: 12, borderRadius: 99, border: '2px solid rgba(34,211,238,0.25)', borderTopColor: '#22d3ee', display: 'inline-block' };

module.exports = { FilesModal, DownloadTray };