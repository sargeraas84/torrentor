'use strict';
const React = require('react');
const { useState, useEffect, useRef } = require('react');
const { I, LogoMark } = require('./icons');
const fmt = require('../../lib/format');
const { LIMIT_PRESETS, limitOptionLabel } = require('../../lib/download-presets');

const KIND_LABEL = { official: 'Official', community: 'Community', demo: 'Demo' };

const dot = { width: 6, height: 6, borderRadius: 99, display: 'inline-block', flexShrink: 0 };

/** One engine's health status line (Settings → Search sources). */
function HealthLine({ record, running, demo }) {
  const base = { fontSize: 11.5, marginTop: 5, display: 'flex', alignItems: 'center', gap: 6, lineHeight: 1.4 };
  if (demo) {
    return (
      <div style={{ ...base, color: '#5b6b84' }}>
        <span style={{ ...dot, background: '#3a4a63' }} />
        offline · always available
      </div>
    );
  }
  if (running) {
    return (
      <div style={{ ...base, color: '#8494ab' }}>
        <span className="spin-slow" style={{ width: 10, height: 10, borderRadius: 99, border: '2px solid rgba(34,211,238,0.25)', borderTopColor: '#22d3ee', display: 'inline-block' }} />
        testing…
      </div>
    );
  }
  if (!record) {
    return (
      <div style={{ ...base, color: '#5b6b84' }}>
        <span style={{ ...dot, background: '#3a4a63' }} />
        not tested yet
      </div>
    );
  }
  const when = record.at ? ` · ${fmt.relativeTime(record.at)}` : '';
  if (record.ok) {
    return (
      <div style={{ ...base, color: '#34d399' }}>
        <span style={{ ...dot, background: '#34d399' }} />
        healthy · {record.count} result{record.count === 1 ? '' : 's'} · {(record.latencyMs / 1000).toFixed(1)}s{when}
      </div>
    );
  }
  return (
    <div style={{ ...base, color: '#fb7185' }}>
      <span style={{ ...dot, background: '#fb7185' }} />
      failing — {record.error || 'unknown error'}{when}
    </div>
  );
}

const labelStyle = { display: 'block', color: '#8494ab', fontSize: 11.5, marginBottom: 5, letterSpacing: 0.3 };
const inputStyle = {
  width: '100%',
  background: '#0b1322',
  border: '1px solid #22314b',
  color: '#e6edf7',
  borderRadius: 9,
  padding: '8px 11px',
  fontSize: 13,
  outline: 'none',
};
const primaryBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  background: 'rgba(34,211,238,0.14)',
  border: '1px solid #22d3ee66',
  color: '#7ce7f7',
  fontWeight: 600,
  fontSize: 12.5,
  padding: '8px 15px',
  borderRadius: 9,
  cursor: 'pointer',
};

module.exports = function SettingsModal({ engines, prefs, version, historyCount, health, healthRunning, onLoadHealth, onRunHealth, onClose, onSetEngines, onSetPrefs, onClearHistory }) {
  const [tab, setTab] = useState('engines');
  const [proxy, setProxy] = useState(null);
  const [ip, setIp] = useState(null);
  const [ipBusy, setIpBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const healthRequested = useRef(false);

  useEffect(() => {
    if (prefs && prefs.proxy) setProxy({ ...prefs.proxy });
  }, [prefs]);

  // When the sources tab first becomes active: paint cached verdicts, then
  // re-probe in the background (dots flip live via health:progress).
  useEffect(() => {
    if (tab === 'engines' && !healthRequested.current) {
      healthRequested.current = true;
      onLoadHealth();
      onRunHealth();
    }
  }, [tab, onLoadHealth, onRunHealth]);

  const applyProxy = async (thenTest) => {
    const cfg = { ...proxy };
    const valid = await window.torrentor.validateProxy(cfg);
    if (!valid.ok) {
      setMsg({ kind: 'err', text: valid.error || 'Invalid proxy configuration.' });
      return;
    }
    await window.torrentor.setPrefs({ proxy: cfg });
    setMsg({ kind: 'ok', text: thenTest ? 'Route saved — now checking your exit IP…' : 'Proxy route saved. All Torrentor search traffic will use it.' });
    if (thenTest) testIp();
  };

  const testIp = async () => {
    setIpBusy(true);
    setIp(null);
    try {
      const res = await window.torrentor.checkIp();
      setIp(res);
      setMsg({ kind: 'ok', text: 'Connection verified through the configured route.' });
    } catch (err) {
      const e = err && err.error ? err.error : String(err);
      setIp({ ok: false, error: e });
      setMsg({ kind: 'err', text: `Could not verify IP: ${e}` });
    } finally {
      setIpBusy(false);
    }
  };

  // Per-source default download folder (direct downloads). Choosing opens
  // the native folder dialog via main; the pref is saved through the same
  // onSetPrefs funnel as every other setting.
  const pickDir = async (engineId) => {
    try {
      const res = await window.torrentor.chooseDownloadDir(engineId);
      if (!res || res.cancelled || !res.path) return;
      await onSetPrefs({ downloadDirs: { [engineId]: res.path } });
    } catch {
      /* non-fatal: the user can retry */
    }
  };

  // Night mode: a GLOBAL clock-window speed cap applied to every download
  // regardless of queue plans (main enforces it live from prefs.nightMode).
  // Stored as null when off, { from, to, bytesPerSec } when on.
  const nm = prefs.nightMode || null;
  const setNm = (patch) => onSetPrefs({ nightMode: Object.assign({ from: '23:00', to: '07:00', bytesPerSec: 100 * 1024 }, nm || {}, patch) });
  // Toggle one weekday in the night window's days array (empty → undefined,
  // meaning every day of the week).
  const toggleNmDay = (v) => {
    const cur = Array.isArray(nm && nm.days) ? nm.days.slice() : [];
    const i = cur.indexOf(Number(v));
    if (i >= 0) cur.splice(i, 1);
    else cur.push(Number(v));
    cur.sort((a, b) => a - b);
    setNm({ days: cur.length ? cur : undefined });
  };
  // One-click weekday presets next to the manual toggles (null = every day).
  const NIGHT_DAY_PRESETS = [
    { id: 'weekdays', label: 'Weekdays', days: [1, 2, 3, 4, 5] },
    { id: 'weekends', label: 'Weekends', days: [0, 6] },
    { id: 'every', label: 'Every day', days: null },
  ];
  const setNmDayPreset = (id) => {
    const p = NIGHT_DAY_PRESETS.find((x) => x.id === id);
    if (p) setNm({ days: p.days ? p.days.slice() : undefined });
  };

  const enabledCount = engines.filter((e) => e.enabled).length;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 100,
        background: 'rgba(3, 6, 12, 0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="fade-in"
        style={{
          width: 660,
          maxWidth: '92vw',
          maxHeight: '86vh',
          display: 'flex',
          flexDirection: 'column',
          background: '#0a111e',
          border: '1px solid #22314b',
          borderRadius: 16,
          boxShadow: '0 30px 90px rgba(0,0,0,.6)',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '16px 20px 0' }}>
          <LogoMark size={24} />
          <span style={{ fontSize: 16, fontWeight: 700 }}>Settings</span>
          <span style={{ color: '#5b6b84', fontSize: 11.5 }}>v{version}</span>
          <div style={{ flex: 1 }} />
          <button type="button" data-testid="close-settings" aria-label="Close settings" style={xBtn} onClick={onClose}>
            <I.close size={15} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 4, padding: '8px 20px', borderBottom: '1px solid #152238' }}>
          {[
            ['engines', 'Search sources', <I.globe key="i" size={13} />],
            ['vpn', 'VPN & privacy', <I.shield key="i" size={13} />],
            ['library', 'Library', <I.clock key="i" size={13} />],
            ['about', 'About', <I.info key="i" size={13} />],
          ].map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              data-testid={`st-${id}`}
              className="app-nodrag"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                borderRadius: 8,
                fontSize: 12.5,
                background: tab === id ? 'rgba(34,211,238,0.12)' : 'transparent',
                color: tab === id ? '#7ce7f7' : '#8494ab',
                border: tab === id ? '1px solid #22d3ee44' : '1px solid transparent',
                fontWeight: tab === id ? 600 : 500,
                cursor: 'pointer',
              }}
              onClick={() => setTab(id)}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px 22px' }}>
          {/* ============================ ENGINES ============================ */}
          {tab === 'engines' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <p style={{ color: '#8494ab', fontSize: 12.5, margin: 0, lineHeight: 1.5, flex: 1 }}>
                  Every search fans out to the sources you enable, in parallel. Results are merged and duplicates collapsed by infohash.
                </p>
                <button
                  type="button"
                  data-testid="health-run-all"
                  className="app-nodrag"
                  style={{ ...primaryBtn, flexShrink: 0 }}
                  disabled={healthRunning}
                  onClick={onRunHealth}
                >
                  {healthRunning ? <span className="spin-slow" style={{ width: 11, height: 11, borderRadius: 99, border: '2px solid rgba(34,211,238,0.25)', borderTopColor: '#22d3ee', display: 'inline-block' }} /> : <I.refresh size={13} />}
                  {healthRunning ? 'Testing…' : 'Test all sources'}
                </button>
              </div>
              {engines.map((e) => {
                const on = e.enabled;
                return (
                  <div
                    key={e.id}
                    data-testid={`health-row-${e.id}`}
                    style={{
                      display: 'flex',
                      gap: 13,
                      alignItems: 'center',
                      padding: '12px 14px',
                      background: 'rgba(11,19,34,0.7)',
                      border: '1px solid #16253d',
                      borderRadius: 12,
                      opacity: on ? 1 : 0.62,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 650, fontSize: 13.5 }}>{e.name}</span>
                        <span
                          style={{
                            fontSize: 9.5,
                            fontWeight: 700,
                            letterSpacing: 0.6,
                            textTransform: 'uppercase',
                            color: KIND_LABEL[e.kind] === 'Demo' ? '#7c4d05' : '#0a5c4a',
                            background: KIND_LABEL[e.kind] === 'Demo' ? '#fbbf2433' : '#34d39922',
                            border: `1px solid ${KIND_LABEL[e.kind] === 'Demo' ? '#fbbf2455' : '#34d39944'}`,
                            padding: '1px 7px',
                            borderRadius: 99,
                          }}
                        >
                          {KIND_LABEL[e.kind] || e.kind}
                        </span>
                      </div>
                      <div style={{ color: '#8494ab', fontSize: 12, marginTop: 3, lineHeight: 1.45 }}>{e.tagline}</div>
                      <div data-testid={`health-status-${e.id}`}>
                        <HealthLine record={health.find((h) => h.engineId === e.id)} running={healthRunning} demo={e.demo} />
                      </div>
                    </div>
                    <Switch on={on} onChange={() => onSetEngines(e.id)} />
                  </div>
                );
              })}
              <p style={{ color: '#5b6b84', fontSize: 11.5, margin: '8px 0 0', lineHeight: 1.6 }}>
                The engine list is an allowlist — sources ship with the app only after their terms, rate limits and content policy are
                reviewed. Torrentor never loads search plugins from the network.
              </p>
            </div>
          )}

          {/* ========================== VPN / PRIVACY ========================= */}
          {tab === 'vpn' && proxy && (
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '11px 13px',
                  borderRadius: 11,
                  marginBottom: 16,
                  background: prefs.proxy && prefs.proxy.enabled ? 'rgba(52,211,153,0.09)' : 'rgba(132,148,171,0.08)',
                  border: `1px solid ${prefs.proxy && prefs.proxy.enabled ? '#34d39944' : '#44506666'}`,
                }}
              >
                {prefs.proxy && prefs.proxy.enabled ? <I.shield size={17} style={{ color: '#34d399' }} /> : <I.shieldOff size={17} style={{ color: '#8494ab' }} />}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 650, fontSize: 13, color: prefs.proxy && prefs.proxy.enabled ? '#a7f3d0' : '#b7c7dd' }}>
                    {prefs.proxy && prefs.proxy.enabled ? 'VPN / proxy route: ACTIVE' : 'Search route: DIRECT'}
                  </div>
                  <div style={{ color: '#8494ab', fontSize: 11.5, marginTop: 2 }}>
                    {prefs.proxy && prefs.proxy.enabled
                      ? `All search traffic exits through ${proxy.type}://${proxy.host}:${proxy.port}`
                      : 'No proxy configured — search requests go out from your normal connection.'}
                  </div>
                </div>
                <button type="button" data-testid="save-check-ip" style={primaryBtn} disabled={ipBusy} onClick={() => applyProxy(true)}>
                  {ipBusy ? '…' : <I.refresh size={13} />}
                  {ipBusy ? 'Checking' : 'Save & check IP'}
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Proxy type">
                  <select
                    data-testid="proxy-type"
                    style={inputStyle}
                    value={proxy.type}
                    onChange={(e) => setProxy({ ...proxy, type: e.target.value })}
                  >
                    <option value="socks5">SOCKS5 (recommended)</option>
                    <option value="socks4">SOCKS4</option>
                    <option value="http">HTTP proxy</option>
                  </select>
                </Field>
                <Field label="Port">
                  <input
                    data-testid="proxy-port"
                    type="number"
                    min={1}
                    max={65535}
                    style={inputStyle}
                    value={proxy.port}
                    onChange={(e) => setProxy({ ...proxy, port: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Host">
                  <input data-testid="proxy-host" style={inputStyle} value={proxy.host} placeholder="127.0.0.1" onChange={(e) => setProxy({ ...proxy, host: e.target.value })} spellCheck={false} />
                </Field>
                <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    data-testid="route-toggle"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      height: 36,
                      borderRadius: 9,
                      border: '1px solid #22314b',
                      background: proxy.enabled ? 'rgba(34,211,238,0.12)' : 'transparent',
                      color: proxy.enabled ? '#7ce7f7' : '#8494ab',
                      fontSize: 12.5,
                      cursor: 'pointer',
                      fontWeight: 600,
                    }}
                    onClick={() => setProxy({ ...proxy, enabled: !proxy.enabled })}
                  >
                    <I.shield size={13} />
                    {proxy.enabled ? 'Route enabled' : 'Route disabled'}
                  </button>
                </div>
                <Field label="Username (optional)">
                  <input style={inputStyle} value={proxy.username} onChange={(e) => setProxy({ ...proxy, username: e.target.value })} spellCheck={false} autoComplete="off" />
                </Field>
                <Field label="Password (optional)">
                  <input style={inputStyle} type="password" value={proxy.password} onChange={(e) => setProxy({ ...proxy, password: e.target.value })} autoComplete="new-password" />
                </Field>
              </div>

              <div style={{ display: 'flex', gap: 9, marginTop: 14, alignItems: 'center' }}>
                <button type="button" data-testid="save-proxy" style={ghostBtn} onClick={() => applyProxy(false)}>
                  Save proxy settings
                </button>
                <button type="button" data-testid="check-ip" style={ghostBtn} disabled={ipBusy} onClick={testIp}>
                  <I.globe size={13} /> Check my IP
                </button>
                {ipBusy && <span style={{ color: '#8494ab', fontSize: 12 }}>contacting ipinfo.io…</span>}
              </div>

              {ip && (
                <div
                  data-testid="ip-result"
                  style={{
                    marginTop: 12,
                    padding: '12px 14px',
                    borderRadius: 11,
                    fontFamily: 'Consolas, Menlo, monospace',
                    fontSize: 12.5,
                    border: `1px solid ${ip.ok ? '#34d39955' : '#fb718555'}`,
                    background: ip.ok ? 'rgba(52,211,153,0.07)' : 'rgba(251,113,133,0.08)',
                    color: ip.ok ? '#a7f3d0' : '#fecdd3',
                  }}
                >
                  {ip.ok ? (
                    <div>
                      <div>exit IP → {ip.ip}</div>
                      <div style={{ color: '#8494ab', marginTop: 4 }}>
                        {[ip.city, ip.country].filter(Boolean).join(', ')} · {ip.isp || 'unknown ISP'} · route: {ip.route}
                      </div>
                    </div>
                  ) : (
                    <div>IP check failed — {ip.error || 'unknown error'}. Is the proxy running and reachable?</div>
                  )}
                </div>
              )}

              <div style={{ marginTop: 16, color: '#5b6b84', fontSize: 11.5, lineHeight: 1.7, borderTop: '1px solid #152238', paddingTop: 14 }}>
                <strong style={{ color: '#8494ab' }}>How the VPN option works.</strong> Torrentor never bundles or sells a VPN — run any VPN app or local
                proxy (WireGuard client, OpenVPN, Tor, ssh -D…), then point this panel at it. Every outbound request — engine queries and the direct
                file downloads you start (Internet Archive files, official ISOs) — streams through your chosen HTTP/SOCKS route, and “Check my IP”
                confirms the exit address before you trust it. Torrent/magnet hand-offs download in your own torrent client, whose traffic is governed
                by that client's own network settings.
              </div>
              {msg && (
                <div
                  style={{
                    marginTop: 10,
                    fontSize: 12,
                    color: msg.kind === 'ok' ? '#a7f3d0' : '#fecdd3',
                    background: msg.kind === 'ok' ? 'rgba(52,211,153,0.07)' : 'rgba(251,113,133,0.08)',
                    border: `1px solid ${msg.kind === 'ok' ? '#34d39944' : '#fb718544'}`,
                    padding: '9px 12px',
                    borderRadius: 9,
                  }}
                >
                  {msg.text}
                </div>
              )}
            </div>
          )}

          {/* ======================== DOWNLOADS (in Library) ======================== */}
          {tab === 'library' && (
            <div>
              <Row label="Default download speed limit" desc="Applied to every new direct download. Each transfer in the tray still has its own control — change it there and only that file is affected.">
                <select
                  data-testid="dl-limit-default"
                  className="app-nodrag"
                  style={inputStyle}
                  value={String(prefs.downloadSpeedLimit || 0)}
                  onChange={(e) => onSetPrefs({ downloadSpeedLimit: Number(e.target.value) })}
                >
                  {LIMIT_PRESETS.map((v) => (
                    <option key={v} value={String(v)}>
                      {limitOptionLabel(v)}
                    </option>
                  ))}
                </select>
              </Row>
              <Row
                label="Night mode (global speed window)"
                desc={nm ? `${nm.from}–${nm.to} · caps every download to ${limitOptionLabel(nm.bytesPerSec)} while the clock is inside the window — independent of any queue plan.` : 'A clock-window speed cap that applies to every download, plan or no plan (like a quiet-hours throttle).'}
              >
                {nm ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      data-testid="night-mode-from"
                      type="time"
                      value={nm.from}
                      onChange={(e) => setNm({ from: e.target.value })}
                      style={{
                        height: 28,
                        padding: '0 6px',
                        borderRadius: 7,
                        background: '#0b1526',
                        border: '1px solid #22314b',
                        color: '#cfe3f7',
                        fontSize: 11.5,
                        outline: 'none',
                      }}
                    />
                    <span style={{ color: '#5b6b84', fontSize: 12 }}>–</span>
                    <input
                      data-testid="night-mode-to"
                      type="time"
                      value={nm.to}
                      onChange={(e) => setNm({ to: e.target.value })}
                      style={{
                        height: 28,
                        padding: '0 6px',
                        borderRadius: 7,
                        background: '#0b1526',
                        border: '1px solid #22314b',
                        color: '#cfe3f7',
                        fontSize: 11.5,
                        outline: 'none',
                      }}
                    />
                    <select
                      data-testid="night-mode-cap"
                      className="app-nodrag"
                      style={{ ...inputStyle, width: 'auto' }}
                      value={String(nm.bytesPerSec)}
                      onChange={(e) => setNm({ bytesPerSec: Number(e.target.value) })}
                    >
                      {LIMIT_PRESETS.filter((v) => v > 0).map((v) => (
                        <option key={v} value={String(v)}>
                          {limitOptionLabel(v)}
                        </option>
                      ))}
                    </select>
                    <button type="button" data-testid="night-mode-off" style={ghostBtn} onClick={() => onSetPrefs({ nightMode: null })}>
                      <I.close size={12} /> Turn off
                    </button>
                    <div data-testid="night-mode-days" style={{ display: 'flex', alignItems: 'center', gap: 3, width: '100%' }}>
                      <span style={{ color: '#5b6b84', fontSize: 10.5, flexShrink: 0 }}>Days:</span>
                      {[1, 2, 3, 4, 5, 6, 0].map((v, i) => {
                        const on = (nm.days || []).indexOf(v) >= 0;
                        return (
                          <button
                            key={v}
                            type="button"
                            data-testid="night-mode-day"
                            data-day={v}
                            data-on={on ? '1' : '0'}
                            className="tooltip app-nodrag"
                            data-tip="Restrict the night window to this weekday (none selected = every day)"
                            aria-pressed={on}
                            style={{
                              width: 22,
                              height: 22,
                              borderRadius: 6,
                              fontSize: 10,
                              fontWeight: 650,
                              cursor: 'pointer',
                              background: on ? 'rgba(245,215,142,0.16)' : 'transparent',
                              border: on ? '1px solid #f5d78e66' : '1px solid #22314b',
                              color: on ? '#f5d78e' : '#5b6b84',
                            }}
                            onClick={() => toggleNmDay(v)}
                          >
                            {['M', 'T', 'W', 'T', 'F', 'S', 'S'][i]}
                          </button>
                        );
                      })}
                      {!nm.days && <span style={{ color: '#5b6b84', fontSize: 10.5 }}>every day</span>}
                      <select
                        data-testid="night-mode-days-preset"
                        className="app-nodrag"
                        value=""
                        onChange={(e) => {
                          setNmDayPreset(e.target.value);
                          e.target.value = '';
                        }}
                        style={{
                          marginLeft: 4,
                          height: 22,
                          flexShrink: 0,
                          borderRadius: 6,
                          background: '#0b1526',
                          border: '1px solid #22314b',
                          color: '#8494ab',
                          fontSize: 10,
                          outline: 'none',
                        }}
                      >
                        <option value="">preset…</option>
                        {NIGHT_DAY_PRESETS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ) : (
                  <button type="button" data-testid="night-mode-on" style={ghostBtn} onClick={() => setNm({})}>
                    <I.moon size={13} /> Enable night mode
                  </button>
                )}
              </Row>
              <div style={{ fontWeight: 700, fontSize: 12.5, color: '#b7c7dd', marginTop: 4 }}>Per-source download folders</div>
              <div style={{ color: '#5b6b84', fontSize: 11.5, marginBottom: 2 }}>
                Optional default save folders for direct downloads. A source with no folder uses your last-used download folder.
              </div>
              {engines.filter((e) => e.directFiles).map((e) => {
                const dir = (prefs.downloadDirs && prefs.downloadDirs[e.id]) || '';
                return (
                  <Row
                    key={e.id}
                    label={e.name}
                    desc={dir ? dir : 'Default — follows the last-used download folder'}
                  >
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <button type="button" data-testid={`dl-folder-${e.id}`} style={ghostBtn} onClick={() => pickDir(e.id)}>
                        <I.folder size={13} />
                        {dir ? 'Change folder…' : 'Choose folder…'}
                      </button>
                      {dir && (
                        <button type="button" data-testid={`dl-folder-clear-${e.id}`} style={ghostBtn} onClick={() => onSetPrefs({ downloadDirs: { [e.id]: '' } })}>
                          <I.close size={13} /> Clear
                        </button>
                      )}
                    </div>
                  </Row>
                );
              })}
              <Row label="Search history" desc={`${historyCount} stored queries, kept only on this machine.`}>
                <button type="button" style={ghostBtn} onClick={onClearHistory}>
                  <I.trash size={13} /> Clear history
                </button>
              </Row>
              <Row label="Favorites" desc="Starred results are saved locally as JSON — no account, no sync.">
                <span style={{ color: '#8494ab', fontSize: 12.5 }}>Stored under your app data folder</span>
              </Row>
              <p style={{ color: '#5b6b84', fontSize: 11.5, marginTop: 16, lineHeight: 1.6 }}>
                Direct downloads stream to the folder you pick (per-source or last-used) and resume across restarts from their
                <code style={{ color: '#9db3cf' }}> .part</code> file. Torrentor keeps no telemetry and makes no outbound calls other than the
                searches you run (through your configured route), the optional IP check, and downloads you start. Query history lives in
                <code style={{ color: '#9db3cf' }}>prefs.json / history.json / favorites.json</code> next to the app's user-data folder — delete
                them any time.
              </p>
            </div>
          )}

          {/* ============================= ABOUT ============================= */}
          {tab === 'about' && (
            <div style={{ color: '#8494ab', fontSize: 12.5, lineHeight: 1.7 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <LogoMark size={44} />
                <div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: '#e6edf7' }}>Torrentor {version}</div>
                  <div style={{ fontSize: 12 }}>Meta-search for the torrent world — one query, many sources at once.</div>
                </div>
              </div>
              <p>
                Torrentor is an <strong style={{ color: '#b7c7dd' }}>indexer of indexes</strong>: it queries the sources you enable in parallel and
                merges the results in one list, collapsing duplicates by infohash. It hosts no content itself; the only files it writes are ones you
                explicitly download (to the folder you choose) plus your local prefs/history/favorites.
              </p>
              <ul style={{ paddingLeft: 18, margin: '8px 0' }}>
                <li>{enabledCount} of {engines.length} engines enabled · {engines.length} shipped in the allowlist</li>
                <li>All engine traffic runs in the main process and honors your VPN/proxy route</li>
                <li>Renderer is sandboxed; only whitelisted IPC calls reach the system</li>
              </ul>
              <p style={{ color: '#5b6b84', fontSize: 11.5 }}>
                Torrenting is a technology, not a crime — the same magnet links carry Linux ISOs, open movies and public-domain books. Please only
                download or share content you are legally entitled to. License: MIT.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

function Field({ label, children }) {
  return (
    <label>
      <span style={labelStyle}>{label}</span>
      {children}
    </label>
  );
}

function Row({ label, desc, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '13px 2px', borderBottom: '1px solid #152238' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 650, color: '#e6edf7', fontSize: 13.5 }}>{label}</div>
        <div style={{ color: '#8494ab', fontSize: 12, marginTop: 2 }}>{desc}</div>
      </div>
      {children}
    </div>
  );
}

function Switch({ on, onChange }) {
  return (
    <button
      type="button"
      className="app-nodrag"
      role="switch"
      aria-checked={on}
      style={{
        width: 40,
        height: 22,
        borderRadius: 99,
        border: 'none',
        cursor: 'pointer',
        position: 'relative',
        background: on ? 'rgba(34,211,238,0.85)' : '#24314a',
        transition: 'background .15s',
        flexShrink: 0,
      }}
      onClick={onChange}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 20 : 2,
          width: 18,
          height: 18,
          borderRadius: 99,
          background: '#fff',
          transition: 'left .15s',
          boxShadow: '0 1px 3px rgba(0,0,0,.4)',
        }}
      />
    </button>
  );
}

const ghostBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  background: 'rgba(15,26,46,0.9)',
  border: '1px solid #22314b',
  color: '#c6d7ec',
  borderRadius: 9,
  padding: '8px 13px',
  fontSize: 12.5,
  cursor: 'pointer',
};
const xBtn = {
  width: 30,
  height: 30,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  color: '#8494ab',
  borderRadius: 8,
  cursor: 'pointer',
};
