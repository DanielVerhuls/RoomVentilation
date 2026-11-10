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
  // Dark to bright, good for concentrations (CO2).
  inferno: makeLut([[0, 0, 4], [87, 16, 110], [188, 55, 84], [249, 142, 9], [252, 255, 164]]),
  // Dry (sand) to wet (deep blue), for relative humidity.
  humidity: makeLut([[222, 196, 140], [230, 232, 215], [150, 200, 230], [55, 130, 200], [10, 50, 130]]),
  // Clean (light) to smoky (dark brown), for cooking fumes.
  smoke: makeLut([[245, 245, 240], [214, 200, 170], [160, 125, 90], [95, 65, 45], [40, 25, 20]]),
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
