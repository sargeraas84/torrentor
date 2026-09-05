'use strict';
const React = require('react');
const { useState, useEffect } = require('react');
const { I } = require('./icons');
const fmt = require('../../lib/format');
const { nextPreset, limitLabel } = require('../../lib/download-presets');

const api = window.torrentor;

// Human words for the basis behind a smart-order ETA estimate (see
// lib/downloads.js etaDetail). Rendered small on queued chips so the
// scheduler's reasoning is visible instead of a magic number.
const ETA_BASIS_WORDS = {
  limit: 'limit',
  // The applied plan's schedule window is the binding cap (the file's own
  // limit is higher or unset) — say so instead of claiming the file chose
  // that speed.
  window: 'plan window',
  // The Settings 'night mode' global schedule is the binding cap.
  night: 'night mode',
  measured: 'measured',
  shared: 'live network',
  baseline: 'assumed',
};

// Weekday toggle buttons for schedule editors (JS Date.getDay() values, but
// laid out Monday-first for readability). An empty selection = every day.
const DAY_BUTTONS = [
  { v: 1, l: 'M' },
  { v: 2, l: 'T' },
  { v: 3, l: 'W' },
  { v: 4, l: 'T' },
  { v: 5, l: 'F' },
  { v: 6, l: 'S' },
  { v: 0, l: 'S' },
];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// One-click weekday presets for the schedule editors (null days = every
// day). Shown next to the manual toggles so common patterns need no tapping.
const DAY_PRESETS = [
  { id: 'weekdays', label: 'Weekdays', days: [1, 2, 3, 4, 5] },
  { id: 'weekends', label: 'Weekends', days: [0, 6] },
  { id: 'every', label: 'Every day', days: null },
];

/** 'Mon–Fri' style summary for a days array ('' when null/empty = every day). */
function daysText(days) {
  if (!Array.isArray(days) || !days.length) return '';
  const set = {};
  for (const d of days) set[Number(d)] = true;
  if (Object.keys(set).length >= 7) return ''; // every day → no suffix needed
  const names = Object.keys(set)
    .map(Number)
    .sort((a, b) => a - b)
    .map((d) => DAY_SHORT[d]);
  return ` · ${names.join(', ')}`;
}

/** Toggle one weekday in an editor's days array (empty result → undefined = every day). */
function toggleDays(cur, v) {
  const list = Array.isArray(cur) ? cur.slice() : [];
  const i = list.indexOf(Number(v));
  if (i >= 0) list.splice(i, 1);
  else list.push(Number(v));
  list.sort((a, b) => a - b);
  return list.length ? list : undefined;
}

/** Compact clock text from fractional seconds: 0.56 → '1s', 95 → '1m 35s'. */
function fmtEta(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

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
function DownloadTray({ downloads, onCancel, onClear, onRetry, onReveal, onLimit, onMove, onMoveTo, onPause, onResumeAll, onRemoveAll, smartOrder, onSmartOrder, onPreviewQueue, onApplyLimits, queuePlans, onSavePlan, onReapplyPlan, onDeletePlan, appliedPlan, onClearAppliedPlan, nightMode, onNightToggle }) {
  const actives = downloads.filter((d) => d.status === 'downloading');
  const queuedItems = downloads.filter((d) => d.status === 'queued');
  const pausedItems = downloads.filter((d) => d.status === 'paused');
  const running = [...actives, ...queuedItems, ...pausedItems];
  const finished = downloads.filter((d) => d.status !== 'downloading' && d.status !== 'queued' && d.status !== 'paused');
  const queuedCount = queuedItems.length;
  const [dragId, setDragId] = useState(null); // queued id being dragged
  const [dropId, setDropId] = useState(null); // queued id currently hovered as drop target
  const [showQueueInfo, setShowQueueInfo] = useState(false); // smart-order popover
  const [whatIf, setWhatIf] = useState(false); // popover what-if mode
  const [previewPatch, setPreviewPatch] = useState({}); // hypothetical limits {id: bps}
  const [folderPatch, setFolderPatch] = useState({}); // hypothetical folder rules {dir: bps}
  const [previewOrder, setPreviewOrder] = useState(null); // previewQueueOrder result
  const [planName, setPlanName] = useState(''); // save-as-plan input
  // Optional ACTIVE-WINDOW rule on the plan being saved (e.g. a 'night'
  // plan throttling the whole queue to 100 KB/s between 23:00 and 07:00).
  const [planSchedule, setPlanSchedule] = useState(null); // { from, to, bytesPerSec, days? } | null
  // Chip tooltip explaining the EFFECTIVE speed when a shared cap (plan
  // window or night mode) binds a transfer: own limit vs plan window vs
  // night cap. Returns null when no shared cap is binding — then the chip
  // needs no explanation.
  const capTip = (d) => {
    const own = Number(d && d.maxBytesPerSec) > 0 ? Number(d.maxBytesPerSec) : null;
    const pc = appliedPlan && appliedPlan.windowActive && appliedPlan.capNow > 0 ? appliedPlan.capNow : null;
    const nc = nightMode && nightMode.windowActive && nightMode.capNow > 0 ? nightMode.capNow : null;
    if (!pc && !nc) return null;
    const sources = [];
    if (own) sources.push(own);
    if (pc) sources.push(pc);
    if (nc) sources.push(nc);
    const eff = Math.min.apply(null, sources);
    const bind = eff === own ? 'own limit' : eff === pc ? 'plan window' : 'night mode';
    const lines = [
      'Effective speed breakdown:',
      `· own limit: ${own ? fmt.formatBytes(own) + '/s' : 'unlimited'}`,
      `· plan window${appliedPlan.name ? ` (${appliedPlan.name})` : ''}: ${pc ? fmt.formatBytes(pc) + '/s' : 'inactive'}`,
      `· night mode: ${nc ? fmt.formatBytes(nc) + '/s' : 'inactive'}`,
      `→ effective: ${fmt.formatBytes(eff)}/s (${bind})`,
    ];
    return lines.join('\n');
  };
  // Tolerant access to a saved plan: records are { entries, schedule }
  // now; plans saved before schedules existed are plain entry arrays.
  const planRec = (name) => {
    const rec = (queuePlans || {})[name];
    if (!rec) return { entries: [], schedule: null };
    if (Array.isArray(rec)) return { entries: rec, schedule: null };
    return { entries: rec.entries || [], schedule: rec.schedule || null };
  };
  const planFileCount = (name) => (planRec(name).entries || []).length;
  const planScheduleText = (s) =>
    s && s.from && s.to ? `${s.from}–${s.to} · ${fmt.formatBytes(s.bytesPerSec)}/s whole-queue cap${daysText(s.days)}` : '';
  // Rows shown in the popover: the live queue, or (in what-if mode) the
  // hypothetical re-rank. Bars scale to the longest estimated wait.
  const displayRows = whatIf ? previewOrder || queuedItems : queuedItems;
  const popMaxEta = displayRows.reduce((m, d) => (d.etaSeconds != null && d.etaSeconds > m ? d.etaSeconds : m), 0);
  // What-if rows grouped by destination folder, so one stepper can re-rank
  // an entire same-folder batch at once (the manager's folder tie-break
  // then batches them together when ETAs tie).
  const folderGroups = whatIf
    ? (() => {
        const groups = [];
        const byDir = new Map();
        for (const d of displayRows) {
          const key = d.dir || '(no folder)';
          if (!byDir.has(key)) {
            byDir.set(key, []);
            groups.push({ dir: key, rows: byDir.get(key) });
          }
          byDir.get(key).push(d);
        }
        return groups;
      })()
    : null;
  const planNames = Object.keys(queuePlans || {});
  // Which plan is applied right now ('' when none) + whether its schedule
  // window is currently capping the whole queue.
  const appliedName = (appliedPlan && appliedPlan.name) || '';
  const appliedSchedule = (appliedPlan && appliedPlan.schedule) || null;
  // Settings night mode (global clock-window cap) — dimmed pill when set but
  // outside the window, bright 'throttling now' while inside.
  const nightSched = (nightMode && nightMode.schedule) || null;
  // Cap-overlap warning: when the applied plan's window AND night mode are
  // both active right now with DIFFERENT caps, the tray names the conflict
  // and which tighter cap actually wins. Equal caps (or one window off) is
  // not a conflict worth a row.
  const overlapPlanCap = appliedPlan && appliedPlan.windowActive && appliedPlan.capNow > 0 ? appliedPlan.capNow : null;
  const overlapNightCap = nightMode && nightMode.windowActive && nightMode.capNow > 0 ? nightMode.capNow : null;
  const capOverlap = overlapPlanCap != null && overlapNightCap != null && overlapPlanCap !== overlapNightCap;
  const overlapWinner = capOverlap ? (overlapPlanCap < overlapNightCap ? 'plan' : 'night') : null;
  // What-if preview plumbing: hypothetical limits go to the manager (which
  // ranks exactly as Apply would) and come back as an ordered row list.
  const fetchPreview = async (patch) => {
    if (!onPreviewQueue) return null;
    try {
      return (await onPreviewQueue(patch)) || null;
    } catch {
      return null;
    }
  };
  const toggleWhatIf = async () => {
    if (whatIf) {
      setWhatIf(false);
      setPreviewPatch({});
      setFolderPatch({});
      setPreviewOrder(null);
    } else {
      setWhatIf(true);
      setPreviewOrder(await fetchPreview({}));
    }
  };
  const stepLimit = async (id, current) => {
    const next = nextPreset(current);
    const patch = { ...previewPatch, [id]: next };
    setPreviewPatch(patch);
    setPreviewOrder(await fetchPreview(patch));
  };
  const applyPreview = async () => {
    if (onApplyLimits) await onApplyLimits(previewPatch);
    // Stay in preview mode so the applied patch can be saved as a plan.
  };
  const resetPreview = async () => {
    setPreviewPatch({});
    setFolderPatch({});
    setPreviewOrder(await fetchPreview({}));
  };
  // Folder stepper: cycle one hypothetical limit and apply it to every
  // queued file headed to the same folder. The folder-level value is also
  // remembered (folderPatch) so saving a plan stores a FOLDER rule — one
  // that keeps covering files queued into that folder later — with only
  // genuine per-file deviations stored as overrides.
  const stepFolderLimit = async (dir, current) => {
    const group = (folderGroups || []).find((g) => g.dir === dir);
    if (!group) return;
    const next = nextPreset(current);
    const patch = { ...previewPatch };
    for (const d of group.rows) patch[d.id] = next;
    setPreviewPatch(patch);
    setFolderPatch((f) => ({ ...f, [dir]: next }));
    setPreviewOrder(await fetchPreview(patch));
  };
  // Queue plans: save the current patch (+ optional active-window rule)
  // under a name, re-apply a saved plan, or delete one.
  const savePlan = async () => {
    const name = planName.trim();
    if (!name || !onSavePlan) return;
    await onSavePlan(name, previewPatch, folderPatch, planSchedule);
    setPlanName('');
    setPlanSchedule(null);
  };
  // Schedule editor: cycle the whole-queue cap while editing a window, or
  // toggle the editor open/closed (defaults to a 23:00–07:00 'night' cap).
  const stepPlanScheduleBps = () => {
    if (!planSchedule) return;
    setPlanSchedule({ ...planSchedule, bytesPerSec: nextPreset(planSchedule.bytesPerSec) });
  };
  const togglePlanSchedule = () => {
    if (planSchedule) {
      setPlanSchedule(null);
    } else {
      setPlanSchedule({ from: '23:00', to: '07:00', bytesPerSec: 102400 });
    }
  };
  const togglePlanDay = (v) => setPlanSchedule((s) => (s ? { ...s, days: toggleDays(s.days, v) } : s));
  const applyPlanDayPreset = (days) => setPlanSchedule((s) => (s ? { ...s, days: days ? days.slice() : undefined } : s));
  const reapplyPlan = async (name) => {
    if (onReapplyPlan) await onReapplyPlan(name);
  };
  const deletePlan = async (name) => {
    if (onDeletePlan) await onDeletePlan(name);
  };
  // Hypothetical limit shown on a what-if row/folder stepper: the preview
  // patch wins, else the row's own (preview rows carry `limit`; live rows
  // carry maxBytesPerSec).
  const popHypLimit = (d) => (previewPatch[d.id] !== undefined ? previewPatch[d.id] : d.limit !== undefined ? d.limit : d.maxBytesPerSec);
  const popRow = (d) => {
    const eta = d.etaSeconds;
    const known = eta != null && d.etaTotal != null;
    return (
      <div key={d.id} data-testid="dl-smart-row" data-id={d.id} style={{ padding: '6px 0', borderBottom: '1px solid #16253d' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span title={d.name} style={{ flex: 1, minWidth: 0, color: '#cfe3f7', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {d.name}
          </span>
          <span data-testid="dl-smart-row-eta" style={{ color: '#7ce7f7', fontSize: 10.5, fontWeight: 650, whiteSpace: 'nowrap' }}>
            {known ? `~${fmtEta(eta)}` : 'size unknown'}
          </span>
          {whatIf && (
            <button
              type="button"
              data-testid="dl-whatif-step"
              data-id={d.id}
              data-limit={popHypLimit(d)}
              className="tooltip"
              data-tip="Cycle this file's hypothetical speed limit"
              style={limitBtn}
              onClick={() => stepLimit(d.id, popHypLimit(d))}
            >
              {limitLabel(popHypLimit(d))}
            </button>
          )}
        </div>
        <div style={{ color: '#5b6b84', fontSize: 10, marginTop: 2 }}>
          {known
            ? `${fmt.formatBytes(d.etaRemaining)} of ${fmt.formatBytes(d.etaTotal)} left · ${fmt.formatBytes(d.etaRateBps)}/s ${ETA_BASIS_WORDS[d.etaBasis] || d.etaBasis}`
            : 'starts after known-size files'}
        </div>
        <div style={{ height: 4, borderRadius: 99, background: '#16253d', marginTop: 5, overflow: 'hidden' }}>
          <div
            data-testid="dl-smart-bar"
            style={{
              height: '100%',
              width: known && popMaxEta > 0 ? `${Math.max(4, Math.round((eta / popMaxEta) * 100))}%` : '100%',
              background: known ? '#22d3ee' : 'rgba(34,211,238,0.25)',
              ...(known ? {} : { animation: 'indeterminate 1.4s ease-in-out infinite' }),
            }}
          />
        </div>
      </div>
    );
  };
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
      <div style={{ display: 'flex', justifyContent: 'flex-end', pointerEvents: 'auto' }}>
        <button
          type="button"
          data-testid="dl-smart-order"
          data-on={smartOrder ? '1' : '0'}
          className="tooltip"
          data-tip={smartOrder ? 'Smart order on — queue starts the fastest-finishing file first (drag/arrows disabled while on)' : 'Smart order off — files start in queue order (drag to reorder)'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 20,
            padding: '0 8px',
            borderRadius: 99,
            fontSize: 10,
            fontWeight: 650,
            cursor: 'pointer',
            background: smartOrder ? 'rgba(34,211,238,0.12)' : 'transparent',
            border: smartOrder ? '1px solid #22d3ee55' : '1px solid #22314b',
            color: smartOrder ? '#7ce7f7' : '#8494ab',
            whiteSpace: 'nowrap',
          }}
          onClick={() => onSmartOrder && onSmartOrder(!smartOrder)}
        >
          <I.gauge size={11} />
          {smartOrder ? 'Smart order on' : 'Smart order off'}
        </button>
        {smartOrder && queuedItems.length > 0 && (
          <button
            type="button"
            data-testid="dl-smart-info"
            aria-label="Explain queue order"
            className="tooltip"
            data-tip="Why this order — per-file ETA breakdown"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 20,
              height: 20,
              marginLeft: 6,
              borderRadius: 99,
              background: showQueueInfo ? 'rgba(34,211,238,0.15)' : 'rgba(34,211,238,0.08)',
              border: showQueueInfo ? '1px solid #22d3ee77' : '1px solid #22d3ee44',
              color: '#7ce7f7',
              cursor: 'pointer',
              flexShrink: 0,
            }}
            onClick={() => setShowQueueInfo((v) => !v)}
          >
            <I.info size={11} />
          </button>
        )}
      </div>
      {(planNames.length > 0 || appliedName) && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', pointerEvents: 'auto' }}>
          <div
            data-testid="dl-plan-switch-box"
            data-active={appliedName || ''}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              height: 20,
              padding: '0 4px 0 8px',
              borderRadius: 99,
              fontSize: 10,
              background: appliedName ? 'rgba(245,215,142,0.10)' : 'rgba(15,26,46,0.9)',
              border: appliedName ? (appliedPlan && appliedPlan.windowActive ? '1px solid #f5d78e88' : '1px solid #f5d78e44') : '1px solid #22314b',
              color: appliedName ? '#f5d78e' : '#8494ab',
              whiteSpace: 'nowrap',
            }}
          >
            <I.gauge size={10} style={{ flexShrink: 0 }} />
            <select
              data-testid="dl-plan-switch"
              value={appliedName}
              title={appliedName ? `Plan “${appliedName}” applied${appliedPlan && appliedPlan.windowActive ? ' — window cap active now' : ''}` : 'Apply a saved queue plan'}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '__clear') {
                  if (onClearAppliedPlan) onClearAppliedPlan();
                } else if (v) {
                  reapplyPlan(v);
                }
              }}
              style={{
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: appliedName ? '#f5d78e' : '#8494ab',
                fontSize: 10,
                fontWeight: 650,
                cursor: 'pointer',
                padding: '0 2px',
                maxWidth: 150,
              }}
            >
              <option value="">{appliedName ? 'Applied' : 'Apply plan…'}</option>
              {planNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              {appliedName && planNames.indexOf(appliedName) < 0 && <option value={appliedName}>{appliedName}</option>}
              {appliedName && <option value="__clear">Clear applied plan</option>}
            </select>
          </div>
        </div>
      )}
      {nightSched && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', pointerEvents: 'auto' }}>
          <button
            type="button"
            data-testid="dl-night"
            data-from={nightSched.from}
            data-to={nightSched.to}
            data-cap={nightSched.bytesPerSec}
            data-active={nightMode && nightMode.windowActive ? '1' : '0'}
            data-override={nightMode && nightMode.override === true ? 'on' : nightMode && nightMode.override === false ? 'off' : 'auto'}
            className="tooltip app-nodrag"
            data-tip={
              nightMode && nightMode.override !== null
                ? `Night mode ${nightMode.override ? 'forced ON' : 'forced OFF'} for this session (click to ${nightMode.override ? 'disable' : 'enable'}) — the ${nightSched.from}–${nightSched.to} window applies again on next launch`
                : `Night mode caps every download${nightMode && nightMode.windowActive ? ' RIGHT NOW' : ''} between ${nightSched.from} and ${nightSched.to} — click to override for this session`
            }
            onClick={() => onNightToggle && onNightToggle()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              height: 20,
              padding: '0 8px',
              borderRadius: 99,
              fontSize: 10,
              fontWeight: 650,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              background: nightMode && nightMode.windowActive ? 'rgba(245,215,142,0.14)' : 'rgba(15,26,46,0.9)',
              border: nightMode && nightMode.windowActive ? '1px solid #f5d78e88' : '1px solid #22314b',
              color: nightMode && nightMode.windowActive ? '#f5d78e' : '#8494ab',
            }}
          >
            <I.moon size={10} style={{ flexShrink: 0 }} />
            {nightMode && nightMode.windowActive
              ? `night mode ON · ${fmt.formatBytes(nightSched.bytesPerSec)}/s now${nightMode.override === true ? ' (override)' : ''}`
              : nightMode && nightMode.override === false
                ? `night mode off (session) · ${fmt.formatBytes(nightSched.bytesPerSec)}/s`
                : `night mode ${nightSched.from}–${nightSched.to} · ${fmt.formatBytes(nightSched.bytesPerSec)}/s`}
          </button>
        </div>
      )}
      {capOverlap && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', pointerEvents: 'auto' }}>
          <div
            data-testid="dl-cap-overlap"
            data-plan-cap={overlapPlanCap}
            data-night-cap={overlapNightCap}
            data-wins={overlapWinner}
            title={
              overlapWinner === 'plan'
                ? `The applied plan “${appliedName}” caps the queue at ${fmt.formatBytes(overlapPlanCap)}/s — tighter than night mode's ${fmt.formatBytes(overlapNightCap)}/s, so it wins while both windows are active`
                : `Night mode caps the queue at ${fmt.formatBytes(overlapNightCap)}/s — tighter than the applied plan's ${fmt.formatBytes(overlapPlanCap)}/s, so it wins while both windows are active`
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              height: 20,
              padding: '0 8px',
              borderRadius: 99,
              fontSize: 10,
              fontWeight: 650,
              whiteSpace: 'nowrap',
              background: 'rgba(251,113,133,0.10)',
              border: '1px solid #fb718555',
              color: '#fda4af',
            }}
          >
            <I.info size={10} style={{ flexShrink: 0 }} />
            {overlapWinner === 'plan'
              ? `plan “${appliedName}” ${fmt.formatBytes(overlapPlanCap)}/s wins over night ${fmt.formatBytes(overlapNightCap)}/s`
              : `night mode ${fmt.formatBytes(overlapNightCap)}/s wins over plan's ${fmt.formatBytes(overlapPlanCap)}/s`}
          </div>
        </div>
      )}
      {showQueueInfo && smartOrder && queuedItems.length > 0 && (
        <div
          data-testid="dl-smart-pop"
          style={{
            position: 'absolute',
            right: 0,
            top: 26,
            width: 300,
            maxHeight: '58vh',
            overflowY: 'auto',
            background: '#0f1a2e',
            border: '1px solid #22314b',
            borderRadius: 12,
            boxShadow: '0 18px 50px rgba(0,0,0,.55)',
            padding: '10px 12px',
            pointerEvents: 'auto',
            zIndex: 115,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <I.gauge size={12} style={{ color: '#7ce7f7', flexShrink: 0 }} />
            <span style={{ color: '#cfe3f7', fontSize: 11.5, fontWeight: 650, flex: 1 }}>Start order — fastest-finishing first</span>
            <button
              type="button"
              data-testid="dl-whatif-toggle"
              className="tooltip"
              data-tip={whatIf ? 'Back to the live queue order' : 'What if… — preview speed limits before applying them'}
              style={{ ...whatIfBtn, background: whatIf ? 'rgba(34,211,238,0.15)' : 'rgba(34,211,238,0.08)' }}
              onClick={toggleWhatIf}
            >
              {whatIf ? 'Live order' : 'What if…'}
            </button>
            <button type="button" aria-label="Close" data-testid="dl-smart-pop-close" style={closeBtn} onClick={() => setShowQueueInfo(false)}>
              <I.close size={13} />
            </button>
          </div>
          {whatIf
            ? folderGroups.map((g) => (
                <div key={`g-${g.dir}`}>
                  {g.rows.length > 1 && (
                    <div data-testid="dl-whatif-folder" data-dir={g.dir} style={folderHeader}>
                      <I.folder size={10} style={{ color: '#5b7a9a', flexShrink: 0 }} />
                      <span title={g.dir} style={{ flex: 1, minWidth: 0, color: '#8494ab', fontSize: 9.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {g.dir}
                      </span>
                      <span style={{ color: '#5b6b84', fontSize: 9.5, flexShrink: 0 }}>{g.rows.length} files</span>
                      <button
                        type="button"
                        data-testid="dl-whatif-folder-step"
                        data-dir={g.dir}
                        data-limit={popHypLimit(g.rows[0])}
                        className="tooltip"
                        data-tip="Set every file in this folder to one speed limit"
                        style={limitBtn}
                        onClick={() => stepFolderLimit(g.dir, popHypLimit(g.rows[0]))}
                      >
                        {limitLabel(popHypLimit(g.rows[0]))}
                      </button>
                    </div>
                  )}
                  {g.rows.map((d) => popRow(d))}
                </div>
              ))
            : displayRows.map((d) => popRow(d))}
          {whatIf ? (
            <div style={{ marginTop: 6 }}>
              <div style={{ color: '#f5d78e', fontSize: 9.5, lineHeight: 1.45 }}>
                Preview only — nothing applied yet. Steppers re-rank the start order live.
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
                <button type="button" data-testid="dl-whatif-apply" style={applyBtn} onClick={applyPreview}>
                  Apply limits
                </button>
                <button type="button" data-testid="dl-whatif-reset" style={resetBtn} onClick={resetPreview}>
                  Reset
                </button>
              </div>
              <div style={{ marginTop: 9, borderTop: '1px solid #16253d', paddingTop: 8 }}>
                <div style={{ color: '#cfe3f7', fontSize: 10.5, fontWeight: 650, marginBottom: 6 }}>Queue plans</div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <input
                    data-testid="dl-plan-name"
                    value={planName}
                    onChange={(e) => setPlanName(e.target.value)}
                    placeholder="Plan name…"
                    style={planInput}
                  />
                  <button type="button" data-testid="dl-plan-save" style={applyBtn} onClick={savePlan}>
                    Save patch
                  </button>
                </div>
                {planSchedule ? (
                  <div
                    data-testid="dl-plan-schedule"
                    data-from={planSchedule.from}
                    data-to={planSchedule.to}
                    data-bps={planSchedule.bytesPerSec}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 7 }}
                  >
                    <I.clock size={10} style={{ color: '#f5d78e', flexShrink: 0 }} />
                    <span style={{ color: '#8494ab', fontSize: 9, flexShrink: 0 }}>window</span>
                    <input
                      data-testid="dl-plan-sched-from"
                      type="time"
                      value={planSchedule.from}
                      onChange={(e) => setPlanSchedule((s) => (s ? { ...s, from: e.target.value } : s))}
                      style={timeInput}
                    />
                    <span style={{ color: '#5b6b84', fontSize: 9, flexShrink: 0 }}>–</span>
                    <input
                      data-testid="dl-plan-sched-to"
                      type="time"
                      value={planSchedule.to}
                      onChange={(e) => setPlanSchedule((s) => (s ? { ...s, to: e.target.value } : s))}
                      style={timeInput}
                    />
                    <button
                      type="button"
                      data-testid="dl-plan-sched-bps"
                      data-bps={planSchedule.bytesPerSec}
                      className="tooltip"
                      data-tip="Whole-queue cap while the window is active (a transfer's own lower limit still wins)"
                      style={{ ...limitBtn, height: 18, padding: '0 6px', fontSize: 9 }}
                      onClick={stepPlanScheduleBps}
                    >
                      {limitLabel(planSchedule.bytesPerSec)}
                    </button>
                    <button type="button" data-testid="dl-plan-sched-off" aria-label="Remove the schedule window" style={miniBtn} onClick={togglePlanSchedule}>
                      <I.close size={10} />
                    </button>
                    <div
                      data-testid="dl-plan-days"
                      style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 7 }}
                    >
                      <I.clock size={9} style={{ color: '#5b7a9a', flexShrink: 0 }} />
                      {DAY_BUTTONS.map((b) => {
                        const on = (planSchedule.days || []).indexOf(b.v) >= 0;
                        return (
                          <button
                            key={b.v}
                            type="button"
                            data-testid="dl-plan-day"
                            data-day={b.v}
                            data-on={on ? '1' : '0'}
                            className="tooltip app-nodrag"
                            data-tip="Restrict the window to this weekday (none selected = every day)"
                            aria-pressed={on}
                            style={{
                              width: 18,
                              height: 18,
                              borderRadius: 5,
                              fontSize: 9,
                              fontWeight: 650,
                              cursor: 'pointer',
                              background: on ? 'rgba(245,215,142,0.16)' : 'transparent',
                              border: on ? '1px solid #f5d78e66' : '1px solid #22314b',
                              color: on ? '#f5d78e' : '#5b6b84',
                            }}
                            onClick={() => togglePlanDay(b.v)}
                          >
                            {b.l}
                          </button>
                        );
                      })}
                      {!planSchedule.days && (
                        <span style={{ color: '#5b6b84', fontSize: 8.5, marginLeft: 2 }}>every day</span>
                      )}
                      <select
                        data-testid="dl-plan-days-preset"
                        className="app-nodrag"
                        value=""
                        onChange={(e) => {
                          const p = DAY_PRESETS.find((x) => x.id === e.target.value);
                          if (p) applyPlanDayPreset(p.days);
                          e.target.value = '';
                        }}
                        style={{
                          marginLeft: 4,
                          flexShrink: 0,
                          height: 16,
                          borderRadius: 4,
                          background: '#0b1526',
                          border: '1px solid #22314b',
                          color: '#8494ab',
                          fontSize: 8,
                          outline: 'none',
                        }}
                      >
                        <option value="">preset…</option>
                        {DAY_PRESETS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ) : (
                  <button type="button" data-testid="dl-plan-sched-on" style={addWinBtn} onClick={togglePlanSchedule}>
                    + Window — cap the whole queue at set hours
                  </button>
                )}
                {planNames.length === 0 ? (
                  <div style={{ color: '#5b6b84', fontSize: 9.5 }}>
                    No saved plans yet — apply a patch, then save it to reuse the limits later.
                  </div>
                ) : (
                  planNames.map((name) => {
                    const rec = planRec(name);
                    const schedText = planScheduleText(rec.schedule);
                    return (
                      <div key={name} data-testid="dl-plan-row" data-name={name} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span
                          title={name}
                          style={{ flex: 1, minWidth: 0, color: '#cfe3f7', fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}
                        >
                          {name}
                          {schedText && (
                            <span data-testid="dl-plan-row-sched" style={{ display: 'block', color: '#f5d78e', fontSize: 8.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {schedText}
                            </span>
                          )}
                        </span>
                        <span style={{ color: '#5b6b84', fontSize: 9.5, flexShrink: 0 }}>{planFileCount(name)} files</span>
                        <button
                          type="button"
                          data-testid="dl-plan-reapply"
                          data-name={name}
                          className="tooltip"
                          data-tip="Apply this plan now — its window rule throttles the whole queue while active"
                          style={{ ...applyBtn, height: 20, padding: '0 8px', fontSize: 9.5 }}
                          onClick={() => reapplyPlan(name)}
                        >
                          <I.refresh size={10} /> Apply
                        </button>
                        <button type="button" data-testid="dl-plan-delete" data-name={name} aria-label="Delete plan" style={miniBtn} onClick={() => deletePlan(name)}>
                          <I.close size={12} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ) : (
            <div style={{ color: '#5b6b84', fontSize: 9.5, marginTop: 6, lineHeight: 1.45 }}>
              Bars scale to the longest estimated wait. Equal-ETA files batch by destination folder.
            </div>
          )}
        </div>
      )}
      {running.map((d) => {
        const queued = d.status === 'queued';
        const paused = d.status === 'paused';
        const pct = !queued && !paused && d.total ? Math.min(100, (d.received / d.total) * 100) : null;
        const folderNote = d.dir && !queued ? d.dir + (d.folderRule ? ` — ${d.folderRule}` : '') : '';
        // Drag-and-drop reorder only applies to queued chips (and only when
        // smart order is off — it would instantly re-sort any manual move):
        // the dragged chip dims, the hovered sibling highlights, and a drop
        // splices the dragged transfer into that sibling's queue position.
        const dndProps = queued && !smartOrder
          ? {
              draggable: true,
              onDragStart: (e) => {
                e.dataTransfer.setData('text/plain', String(d.id));
                e.dataTransfer.effectAllowed = 'move';
                setDragId(d.id);
              },
              onDragOver: (e) => {
                if (dragId == null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDropId(d.id);
              },
              onDrop: (e) => {
                e.preventDefault();
                const id = Number(e.dataTransfer.getData('text/plain'));
                if (id && id !== d.id && onMoveTo) onMoveTo(id, d.queuePos);
                setDragId(null);
                setDropId(null);
              },
              onDragEnd: () => {
                setDragId(null);
                setDropId(null);
              },
            }
          : {};
        const capTipText = capTip(d);
        return (
          <div
            key={d.id}
            data-testid="dl-chip"
            data-id={d.id}
            data-status={d.status}
            title={capTipText || undefined}
            {...dndProps}
            style={{
              ...chip,
              ...(dragId === d.id ? { opacity: 0.45 } : {}),
              ...(queued && dropId === d.id ? { borderColor: '#22d3ee88' } : {}),
              ...(queued && !smartOrder && queuedItems.length > 1 ? { cursor: 'grab' } : {}),
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {queued ? (
                <I.clock size={13} style={{ color: '#8494ab', flexShrink: 0 }} />
              ) : paused ? (
                <I.pause size={13} style={{ color: '#fbbf24', flexShrink: 0 }} />
              ) : (
                <I.download size={13} style={{ color: '#22d3ee', flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={chipTitle}>{d.name}</div>
                <div style={{ color: '#6f8199', fontSize: 10.5, marginTop: 1 }}>
                  {queued
                    ? smartOrder && d.etaBasis
                      ? d.etaSeconds != null ? (
                          <span data-testid="dl-eta" data-eta-sec={Math.round(d.etaSeconds)} data-basis={d.etaBasis}>
                            Queued · ETA ~{fmtEta(d.etaSeconds)}{' '}
                            <span style={{ color: '#5b6b84' }}>· {fmt.formatBytes(d.etaRateBps)}/s {ETA_BASIS_WORDS[d.etaBasis] || d.etaBasis}</span>
                            {d.etaTotal != null && (
                              <span data-testid="dl-eta-bytes" style={{ color: '#5b6b84' }}>
                                {' '}· {fmt.formatBytes(d.etaRemaining)} / {fmt.formatBytes(d.etaTotal)} left
                              </span>
                            )}
                          </span>
                        ) : (
                          <span data-testid="dl-eta" data-basis="size-unknown">Queued · size unknown — starts after known-size files</span>
                        )
                      : 'Queued — waiting for a free slot'
                    : paused
                      ? 'Paused — partial kept · resume anytime'
                      : smartOrder && d.etaBasis && d.etaSeconds != null
                        ? (
                            <span data-testid="dl-eta-active" data-eta-sec={Math.round(d.etaSeconds)} data-basis={d.etaBasis}>
                              {fmt.formatBytes(d.received)}
                              {d.total ? ` / ${fmt.formatBytes(d.total)}` : ''}
                              {pct != null ? ` (${Math.floor(pct)}%)` : ''} · ~{fmtEta(d.etaSeconds)} left ·{' '}
                              <span style={{ color: '#5b6b84' }}>{fmt.formatBytes(d.etaRateBps)}/s {ETA_BASIS_WORDS[d.etaBasis] || d.etaBasis}</span>
                              {d.resumed ? ' · resumed from partial' : ''}
                            </span>
                          )
                        : `${fmt.formatBytes(d.received)}${d.total ? ` / ${fmt.formatBytes(d.total)}` : ''}${pct != null ? ` (${Math.floor(pct)}%)` : ''}${d.speedBytesPerSec > 0 ? ` · ${fmt.formatBytes(d.speedBytesPerSec)}/s` : ''}${d.resumed ? ' · resumed from partial' : ''}`}
                </div>
                {appliedName && (
                  <div
                    data-testid="dl-chip-plan"
                    data-name={appliedName}
                    data-window={appliedPlan && appliedPlan.windowActive ? '1' : '0'}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3, color: '#f5d78e', fontSize: 9.5, minWidth: 0 }}
                  >
                    <I.gauge size={9} style={{ flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      plan “{appliedName}”
                      {appliedPlan && appliedPlan.windowActive && appliedSchedule
                        ? ` · window cap ${fmt.formatBytes(appliedSchedule.bytesPerSec)}/s now`
                        : ''}
                    </span>
                  </div>
                )}
              </div>
              {queued && !smartOrder && (
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
              {!paused && (
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
              )}
              {queued ? (
                <button
                  type="button"
                  aria-label="Remove from queue"
                  data-testid="dl-remove"
                  className="tooltip"
                  data-tip="Remove from queue"
                  style={miniBtn}
                  onClick={() => onCancel(d.id)}
                >
                  <I.close size={13} />
                </button>
              ) : paused ? (
                <>
                  <button
                    type="button"
                    aria-label="Resume paused download"
                    data-testid="dl-resume"
                    className="tooltip"
                    data-tip="Resume — continues from the partial file"
                    style={miniBtn}
                    onClick={() => onRetry && onRetry(d.id)}
                  >
                    <I.play size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label="Remove paused download"
                    data-testid="dl-remove"
                    className="tooltip"
                    data-tip="Remove — deletes the partial too"
                    style={miniBtn}
                    onClick={() => onCancel(d.id)}
                  >
                    <I.close size={13} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  aria-label="Pause download"
                  data-testid="dl-pause"
                  className="tooltip"
                  data-tip="Pause — keep partial progress and free the slot"
                  style={miniBtn}
                  onClick={() => onPause && onPause(d.id)}
                >
                  <I.pause size={13} />
                </button>
              )}
            </div>
            {!queued && !paused && (
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
            {folderNote && (
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 5, color: '#5b6b84', fontSize: 9.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}
                title={folderNote}
              >
                <I.folder size={9} style={{ flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{folderNote}</span>
              </div>
            )}
          </div>
        );
      })}

      {pausedItems.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            pointerEvents: 'auto',
            background: 'rgba(251,191,36,0.07)',
            border: '1px solid #fbbf2433',
            borderRadius: 9,
            padding: '5px 8px',
          }}
        >
          <I.pause size={12} style={{ color: '#fbbf24', flexShrink: 0 }} />
          <span style={{ color: '#f5d78e', fontSize: 11, fontWeight: 600, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {pausedItems.length} paused
          </span>
          <button type="button" data-testid="dl-resume-all" style={miniTxt} onClick={() => onResumeAll && onResumeAll()}>
            <I.play size={10} /> Resume all
          </button>
          <button type="button" data-testid="dl-remove-all" style={miniTxt} onClick={() => onRemoveAll && onRemoveAll()}>
            <I.close size={10} /> Remove all
          </button>
        </div>
      )}

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
                  {done ? `Done · ${d.dir || 'saved'}${d.folderRule ? ` — via ${d.folderRule}` : ''}` : d.status === 'cancelled' ? 'Cancelled — partial progress kept' : `Failed — ${d.error || 'unknown error'}`}
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
const miniTxt = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  height: 20,
  padding: '0 6px',
  borderRadius: 6,
  background: 'rgba(251,191,36,0.1)',
  border: '1px solid #fbbf2440',
  color: '#f5d78e',
  fontSize: 10,
  fontWeight: 600,
  cursor: 'pointer',
  flexShrink: 0,
  whiteSpace: 'nowrap',
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
const whatIfBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 20,
  padding: '0 8px',
  borderRadius: 99,
  border: '1px solid #22d3ee55',
  color: '#7ce7f7',
  fontSize: 9.5,
  fontWeight: 650,
  lineHeight: 1,
  cursor: 'pointer',
  flexShrink: 0,
  whiteSpace: 'nowrap',
};
const applyBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 22,
  padding: '0 10px',
  borderRadius: 7,
  background: 'rgba(34,211,238,0.12)',
  border: '1px solid #22d3ee55',
  color: '#7ce7f7',
  fontSize: 10,
  fontWeight: 650,
  cursor: 'pointer',
};
const folderHeader = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 2px 3px',
  borderTop: '1px solid #16253d',
};
const planInput = {
  flex: 1,
  minWidth: 0,
  height: 22,
  padding: '0 8px',
  borderRadius: 7,
  background: '#0b1526',
  border: '1px solid #22314b',
  color: '#cfe3f7',
  fontSize: 10.5,
  outline: 'none',
};
const timeInput = {
  width: 62,
  height: 20,
  padding: '0 3px',
  borderRadius: 6,
  background: '#0b1526',
  border: '1px solid #22314b',
  color: '#cfe3f7',
  fontSize: 10,
  outline: 'none',
  flexShrink: 0,
};
const addWinBtn = {
  display: 'block',
  width: '100%',
  height: 20,
  marginBottom: 7,
  borderRadius: 6,
  background: 'rgba(245,215,142,0.07)',
  border: '1px dashed #f5d78e55',
  color: '#f5d78e',
  fontSize: 9.5,
  fontWeight: 600,
  cursor: 'pointer',
  textAlign: 'center',
};
const resetBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 22,
  padding: '0 10px',
  borderRadius: 7,
  background: 'transparent',
  border: '1px solid #22314b',
  color: '#8494ab',
  fontSize: 10,
  fontWeight: 600,
  cursor: 'pointer',
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