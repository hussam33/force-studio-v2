// Builds the colour skins: each one is the cyberpunk stylesheet with every hue shifted, so the whole
// UI (accents, panels, glows) moves together instead of only a few variables.
//
//   node scripts/make-skins.mjs
//
// style.css stays the default "cyberpunk" skin; the files in public/skins/ are generated and committed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'public', 'style.css');
const OUT_DIR = path.join(ROOT, 'public', 'skins');

/** id, label, hue shift in degrees, saturation scale (null keeps the source exactly). */
export const SKINS = [
  // primary = where the magenta accent goes, secondary = where the cyan goes.
  { id: 'blade', label: 'Blade', primary: 214, secondary: 186, sat: 1.08 },
  { id: 'acid', label: 'Acid', primary: 92, secondary: 152, sat: 1.05 },
  { id: 'blood', label: 'Blood', primary: 356, secondary: 26, sat: 1.05 },
  { id: 'solar', label: 'Solar', primary: 38, secondary: 296, sat: 1.06 },
  { id: 'vapor', label: 'Vapor', primary: 316, secondary: 198, sat: 0.95 },
  { id: 'mono', label: 'Mono', primary: 320, secondary: 190, sat: 0.12 },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s, l];
}

function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = t => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(hue(h + 1 / 3) * 255), Math.round(hue(h) * 255), Math.round(hue(h - 1 / 3) * 255)];
}

/** Interpolate two hues the short way round the colour wheel. */
function mixHue(from, to, t) {
  let delta = ((to - from + 540) % 360) - 180;
  return (from + delta * t + 360) % 360;
}

/**
 * The source palette has two accents (magenta ~320°, cyan ~190°). Each skin says where those two go;
 * every other hue is interpolated between them along the same arc, so the whole sheet stays coherent.
 */
function shift(hex, skin) {
  const raw = hex.replace('#', '');
  const full = raw.length <= 4 ? raw.split('').map(c => c + c).join('') : raw;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
  const alpha = full.length >= 8 ? full.slice(6, 8) : '';
  let [h, s, l] = rgbToHsl(r, g, b);
  // Neutrals (text, greys) keep their hue so contrast and legibility do not change.
  if (s > 0.12) {
    const from = 190; // cyan anchor
    const to = 320; // magenta anchor
    const span = 130;
    const d = (h - from + 360) % 360;
    h =
      d <= span
        ? mixHue(skin.secondary, skin.primary, d / span)
        : mixHue(skin.primary, skin.secondary, (d - span) / (360 - span));
    s = clamp(s * skin.sat, 0, 1);
  } else if (l < 0.42) {
    // Dark neutrals pick up a hint of the skin instead of staying violet.
    h = skin.primary;
    s = 0.16;
  }
  const [nr, ng, nb] = hslToRgb(h, s, l);
  const to2 = v => v.toString(16).padStart(2, '0');
  return '#' + to2(nr) + to2(ng) + to2(nb) + alpha;
}

export function buildSkin(css, skin) {
  return css.replace(
    /#[0-9a-fA-F]{6}(?![0-9a-fA-F])|#[0-9a-fA-F]{8}|#[0-9a-fA-F]{3}(?![0-9a-fA-F])/g,
    match => {
      const upper = match === match.toUpperCase() && /[A-F]/.test(match);
      const out = shift(match, skin);
      return upper ? out.toUpperCase() : out;
    }
  );
}

function main() {
  const css = fs.readFileSync(SOURCE, 'utf8');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const skin of SKINS) {
    const target = path.join(OUT_DIR, `${skin.id}.css`);
    fs.writeFileSync(target, buildSkin(css, skin));
    console.log(`${skin.id}.css  (hue ${skin.hue}°, saturation ×${skin.sat})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
