'use strict';
// Small inline SVG icon set (no icon library — keeps the bundle tiny).

const React = require('react');

function Svg({ size = 16, children, ...rest }) {
  return React.createElement(
    'svg',
    Object.assign(
      {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      rest
    ),
    children
  );
}

const I = {
  search: (p) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></Svg>,
  magnet: (p) => <Svg {...p}><path d="M6 3v7a6 6 0 0 0 12 0V3" /><path d="M6 3h4v7H6z" /><path d="M14 3h4v7h-4z" /><path d="M6 15v3a3 3 0 0 0 6 0v-1" /><path d="M18 15v3a3 3 0 0 1-6 0v-1" /></Svg>,
  copy: (p) => <Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Svg>,
  external: (p) => <Svg {...p}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></Svg>,
  star: (p) => <Svg {...p} fill="currentColor" stroke="none"><path d="m12 2.6 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9L12 2.6z" /></Svg>,
  starOutline: (p) => <Svg {...p}><path d="m12 2.6 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9L12 2.6z" /></Svg>,
  clock: (p) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>,
  settings: (p) => <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" /></Svg>,
  shield: (p) => <Svg {...p}><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></Svg>,
  shieldOff: (p) => <Svg {...p}><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 1.1-.4 2.1-1 3-1.7" /><path d="M4 4l16 16" /><path d="M8.5 12l2.5 2.5 1-1.1" /></Svg>,
  trash: (p) => <Svg {...p}><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6M14 11v6" /></Svg>,
  close: (p) => <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>,
  minus: (p) => <Svg {...p}><path d="M5 12h14" /></Svg>,
  square: (p) => <Svg {...p}><rect x="6" y="6" width="12" height="12" rx="1.5" /></Svg>,
  arrowUp: (p) => <Svg {...p} fill="currentColor" stroke="none"><path d="M12 5 5 13h4v6h6v-6h4L12 5z" /></Svg>,
  arrowDown: (p) => <Svg {...p} fill="currentColor" stroke="none"><path d="M12 19l7-8h-4V5H9v6H5l7 8z" /></Svg>,
  download: (p) => <Svg {...p}><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></Svg>,
  refresh: (p) => <Svg {...p}><path d="M21 12a9 9 0 1 1-2.6-6.3" /><path d="M21 3v6h-6" /></Svg>,
  link: (p) => <Svg {...p}><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></Svg>,
  info: (p) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8h.01" /><path d="M11 12h1v4h1" /></Svg>,
  folder: (p) => <Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></Svg>,
  globe: (p) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" /></Svg>,
  gauge: (p) => <Svg {...p}><path d="M4.5 19a8.5 8.5 0 1 1 15 0" /><path d="M12 19 15 11.5" /><path d="M12 19h.01" /></Svg>,
};

/** The Torrentor mark: magnet U on a tile. */
function LogoMark({ size = 22, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="tor-mag" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#2dd4bf" />
        </linearGradient>
        <linearGradient id="tor-ring" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#34d399" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="10" fill="#0b1322" stroke="url(#tor-ring)" strokeWidth="2.4" />
      <path
        d="M14 12v10a10 10 0 0 0 20 0V12h-6v10a4 4 0 0 1-8 0V12h-6z"
        fill="url(#tor-mag)"
        opacity="0.95"
      />
      <path d="M14 32v2.5a6 6 0 0 0 12 0V32" stroke="#eaf6ff" strokeWidth="3.4" fill="none" strokeLinecap="round" opacity="0.95" />
      <path d="M34 32v2.5a6 6 0 0 1-12 0V32" stroke="#eaf6ff" strokeWidth="3.4" fill="none" strokeLinecap="round" opacity="0.95" />
    </svg>
  );
}

// ---- category meta (color + glyph) used across cards/filters --------
const CATEGORY_META = {
  video: { color: '#fb7185', label: 'Video' },
  audio: { color: '#38bdf8', label: 'Audio' },
  apps: { color: '#a78bfa', label: 'Apps' },
  games: { color: '#34d399', label: 'Games' },
  documents: { color: '#fbbf24', label: 'Docs' },
  other: { color: '#8494ab', label: 'Other' },
};

function CatGlyph({ category, size = 15, color }) {
  const c = color || (CATEGORY_META[category] || CATEGORY_META.other).color;
  const common = { size, style: { color: c } };
  switch (category) {
    case 'video':
      return <I.film {...common} />;
    case 'audio':
      return <I.music {...common} />;
    case 'apps':
      return <I.package {...common} />;
    case 'games':
      return <I.gamepad {...common} />;
    case 'documents':
      return <I.book {...common} />;
    default:
      return <I.file {...common} />;
  }
}

I.film = (p) => <Svg {...p}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M7 5v14M17 5v14M2 9h5M2 15h5M17 9h5M17 15h5" /></Svg>;
I.music = (p) => <Svg {...p}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></Svg>;
I.package = (p) => <Svg {...p}><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3z" /><path d="M4 7.5 12 12l8-4.5" /><path d="M12 12v9" /></Svg>;
I.gamepad = (p) => <Svg {...p}><path d="M6 8h12a4 4 0 0 1 4 4c0 2-1 3-2 3l-2.4 2.4a2 2 0 0 1-3-.6l-1-2a2 2 0 0 0-3.2 0l-1 2a2 2 0 0 1-3 .6L4 15c-1 0-2-1-2-3a4 4 0 0 1 4-4z" /><path d="M7 10v4M5 12h4" /><circle cx="16" cy="11" r="1" /><circle cx="19" cy="13" r="1" /></Svg>;
I.book = (p) => <Svg {...p}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></Svg>;
I.file = (p) => <Svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" /><path d="M14 2v6h6" /></Svg>;

module.exports = { I, LogoMark, CatGlyph, CATEGORY_META };
