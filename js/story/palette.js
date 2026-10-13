// Colors the 3D stage needs in JavaScript. The ramps mirror css/style.css
// (r0 quiet end, then Low → Severe); keep the two in sync.

export const RAMPS = {
  heat: { light: ['#e5dcd7', '#b6aaa2', '#cc7c37', '#b14420', '#721d17'], dark: ['#231e1b', '#4d443e', '#8d5321', '#d05933', '#fd7466'] },
  floods: { light: ['#d8dfe6', '#a3aeb7', '#4299dc', '#136dbf', '#0e3d7d'], dark: ['#1b2024', '#3f474f', '#296898', '#2985df', '#68a5ff'] },
  air: { light: ['#dfdce5', '#aeaab6', '#9f7ed6', '#7854b6', '#462e77'], dark: ['#201e23', '#47454e', '#6c5594', '#906ad5', '#ad8dfe'] },
  wind: { light: ['#d8e1db', '#a3b0a8', '#35aa76', '#028058', '#044c35'], dark: ['#1b211e', '#3f4943', '#1f744f', '#0a9b6c', '#0bc18d'] },
};

export const NEUTRAL = {
  light: { paper: '#f6f3ec', ink: '#141414', land: '#f1ece2', park: '#dcd8c8', water: '#d9d6cc', rule: '#d9d4c7' },
  dark: { paper: '#0f0f0e', ink: '#edeae2', land: '#24231f', park: '#1d211b', water: '#101418', rule: '#2b2a27' },
};

/** Sky by sun elevation (degrees): [elevation, top, horizon]. */
export const SKY = {
  light: [
    [-12, '#1d2433', '#262e3d'],
    [-6, '#2b3345', '#373d4b'],
    [-1, '#727480', '#c4997b'],
    [4, '#d8d1c3', '#e6c09a'],
    [14, '#e4e0d6', '#ece4d3'],
    [35, '#e8e5dc', '#f0ece2'],
  ],
  dark: [
    [-12, '#07090d', '#0c1016'],
    [-6, '#0a0d13', '#141922'],
    [-1, '#151924', '#3a2a24'],
    [4, '#1a1f2a', '#4a3529'],
    [14, '#1e2430', '#2c2f35'],
    [35, '#20262f', '#2f343b'],
  ],
};

export const SMOKE = { light: '#b8743a', dark: '#6a3a1a' };

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex([r, g, b]) {
  const c = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Color at t (0..1) along a ramp of hex stops, as [r, g, b] 0..1. */
export function rampAt(stops, t) {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mix(hexToRgb(stops[i]), hexToRgb(stops[i + 1]), x - i);
}

/** Sky colors for a sun elevation, optionally tinted by smoke (0..1). */
export function skyAt(theme, elevation, smoke = 0) {
  const keys = SKY[theme];
  let top = hexToRgb(keys[0][1]);
  let horizon = hexToRgb(keys[0][2]);
  for (let i = 1; i < keys.length; i++) {
    const [e1, t1, h1] = keys[i];
    const [e0, t0, h0] = keys[i - 1];
    if (elevation <= e1) {
      const t = Math.max(0, (elevation - e0) / (e1 - e0));
      top = mix(hexToRgb(t0), hexToRgb(t1), t);
      horizon = mix(hexToRgb(h0), hexToRgb(h1), t);
      break;
    }
    top = hexToRgb(t1);
    horizon = hexToRgb(h1);
  }
  if (smoke > 0) {
    const s = hexToRgb(SMOKE[theme]);
    top = mix(top, s, smoke * 0.55);
    horizon = mix(horizon, s, smoke * 0.85);
  }
  return { top, horizon };
}
