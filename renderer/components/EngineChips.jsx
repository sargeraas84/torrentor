'use strict';
const React = require('react');
const { I } = require('./icons');

const KIND_COLOR = {
  official: '#34d399',
  community: '#38bdf8',
  demo: '#fbbf24',
};

function StatusGlyph({ engine, perEngine }) {
  const st = perEngine && perEngine[engine.id];
  if (!st) {
    return engine.enabled ? (
      <I.clock size={11} style={{ color: '#8494ab' }} />
    ) : (
      <span style={{ color: '#5b6b84', fontSize: 10, letterSpacing: 0.6 }}>OFF</span>
    );
  }
  if (st.status === 'running') {
    return (
      <span
        className="spin-slow"
        style={{
          width: 11,
          height: 11,
          borderRadius: 99,
          border: '2px solid rgba(34,211,238,0.25)',
          borderTopColor: '#22d3ee',
          display: 'inline-block',
        }}
      />
    );
  }
  if (st.status === 'ok') {
    return (
      <span style={{ color: '#34d399', fontWeight: 700, fontSize: 10.5 }}>
        {st.count > 0 ? `${st.count}` : '✓'}
      </span>
    );
  }
  return <I.refresh size={12} style={{ color: '#fb7185' }} />;
}

module.exports = function EngineChips({ engines, perEngine, onToggle, onRetry }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      {engines.map((engine) => {
        const enabled = engine.enabled;
        const st = perEngine && perEngine[engine.id];
        const failed = enabled && st && st.status === 'error';
        const base = {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          padding: '5px 12px',
          borderRadius: 99,
          fontSize: 12.5,
          border: `1px solid ${enabled ? '#24405f' : '#1b2737'}`,
          background: enabled ? 'rgba(15, 26, 46, 0.9)' : 'rgba(13, 20, 33, 0.7)',
          color: enabled ? '#cfe3f7' : '#4d5d75',
          cursor: 'pointer',
          transition: 'border-color .15s, color .15s',
          userSelect: 'none',
        };
        const kindDot = KIND_COLOR[engine.kind] || '#8494ab';
        return (
          <button
            key={engine.id}
            type="button"
            data-testid={`engine-${engine.id}`}
            className="app-nodrag tooltip"
            data-tip={failed ? `${st.error} — click to retry` : enabled ? `${engine.tagline} — click to disable` : `${engine.name} is off — click to enable`}
            style={base}
            onClick={() => (failed ? onRetry(engine) : onToggle(engine))}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 99,
                background: enabled ? kindDot : '#3a4a63',
                boxShadow: enabled ? `0 0 6px ${kindDot}88` : 'none',
                flexShrink: 0,
              }}
            />
            <span style={{ fontWeight: 600 }}>{engine.name}</span>
            <StatusGlyph engine={engine} perEngine={perEngine} />
          </button>
        );
      })}
    </div>
  );
};
