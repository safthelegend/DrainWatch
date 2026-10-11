// Colors the 3D stage needs in JavaScript. The ramps mirror css/style.css
// (r0 quiet end, then Low → Severe); keep the two in sync.

export const RAMPS = {
  heat: { light: ['#f3dfb3', '#d4842a', '#d2602a', '#bb3522', '#7f1712'], dark: ['#3a1d10', '#8a3d1d', '#c24a22', '#ec6a2c', '#ffb547'] },
  floods: { light: ['#cfe8f1', '#5fb3d6', '#2f86bf', '#195a97', '#0b2f5e'], dark: ['#10283c', '#1d5a85', '#2a83bd', '#52b4e0', '#b0ecf8'] },
  air: { light: ['#e4dcf2', '#a48fd6', '#7f5fc0', '#5c3593', '#3a1a60'], dark: ['#261a3f', '#5a3d8f', '#7d5cc0', '#a587e0', '#dccff7'] },
  wind: { light: ['#d5eee3', '#5fb895', '#2f8f6f', '#1a6650', '#0b4034'], dark: ['#0f2c24', '#1d6650', '#2a8d6d', '#4dbb92', '#b0ecd0'] },
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
