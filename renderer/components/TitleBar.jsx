'use strict';
const React = require('react');
const { I, LogoMark } = require('./icons');

const btnBase = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 44,
  height: 40,
  color: '#8494ab',
  background: 'transparent',
  border: 'none',
  cursor: 'default',
  outline: 'none',
};

module.exports = function TitleBar({ maximized }) {
  return (
    <div
      className="app-drag"
      style={{
        height: 44,
        display: 'flex',
        alignItems: 'center',
        borderBottom: '1px solid #152238',
        background: 'rgba(8, 13, 24, 0.92)',
        flexShrink: 0,
        paddingLeft: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
        <LogoMark size={22} />
        <span style={{ fontWeight: 650, fontSize: 14, letterSpacing: 0.4, color: '#e6edf7' }}>Torrentor</span>
        <span style={{ color: '#8494ab', fontSize: 11.5, marginLeft: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          search every torrent source at once
        </span>
      </div>
      <div style={{ flex: 1 }} />
      <div className="app-nodrag" style={{ display: 'flex', marginLeft: 8 }}>
        <button
          type="button"
          style={btnBase}
          onClick={() => window.torrentor.minimize()}
          aria-label="Minimize"
        >
          <I.minus size={15} />
        </button>
        <button type="button" style={btnBase} onClick={() => window.torrentor.toggleMaximize()} aria-label="Maximize">
          {maximized ? <I.square size={12} style={{ transform: 'scale(0.9)' }} /> : <I.square size={13} />}
        </button>
        <button
          type="button"
          style={{ ...btnBase, color: '#8494ab', width: 46 }}
          onClick={() => window.torrentor.close()}
          aria-label="Close"
        >
          <I.close size={15} />
        </button>
      </div>
    </div>
  );
};
