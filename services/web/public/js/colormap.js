// Colour maps as 256-entry RGB lookup tables.

function makeLut(stops) {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let k = 0; k < 256; k++) {
    const t = (k / 255) * (stops.length - 1);
    const i = Math.min(Math.floor(t), stops.length - 2);
    const f = t - i;
    for (let c = 0; c < 3; c++) lut[k * 3 + c] = stops[i][c] + (stops[i + 1][c] - stops[i][c]) * f;
  }
  return lut;
}

export const COLORMAPS = {
  // Perceptually uniform, good for magnitudes (speed).
  viridis: makeLut([[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]]),
  // Diverging around zero, good for signed values (pressure).
  coolwarm: makeLut([[59, 76, 192], [141, 176, 254], [221, 221, 221], [244, 154, 123], [180, 4, 38]]),
};

/** Index into a LUT for t in [0, 1]. */
export const lutIndex = (t) => 3 * Math.max(0, Math.min(255, Math.round(t * 255)));

export function gradientCss(lut) {
  const stops = [];
  for (let k = 0; k <= 8; k++) {
    const i = lutIndex(k / 8);
    stops.push(`rgb(${lut[i]}, ${lut[i + 1]}, ${lut[i + 2]})`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
