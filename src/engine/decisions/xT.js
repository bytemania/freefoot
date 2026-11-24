/**
 * Static expected-threat grid: the value of holding the ball in each of 12 x 8 zones (12 columns from the
 * team's own goal line to the opponent's, 8 rows across the width), the standard xT table of open football
 * data. Rows 0-3 are one half of the width; the other half mirrors them.
 */
const HALF = [
  [0.00638303, 0.00779616, 0.00844854, 0.00977659, 0.01126267, 0.01248344, 0.01473596, 0.0174506, 0.02122129, 0.02756312, 0.03485072, 0.0379259],
  [0.00750072, 0.00878589, 0.00942382, 0.0105949, 0.01214719, 0.0138454, 0.01611813, 0.01870347, 0.02401521, 0.02953272, 0.04066992, 0.04647721],
  [0.0088799, 0.00977745, 0.01001304, 0.01110462, 0.01269174, 0.01429128, 0.01685596, 0.01935132, 0.0241224, 0.02855202, 0.05491138, 0.06442595],
  [0.00941056, 0.01082722, 0.01016549, 0.01132376, 0.01262646, 0.01484598, 0.01689528, 0.0199707, 0.02385149, 0.03511326, 0.10805102, 0.25745362],
];

export const XT_COLUMNS = 12;
export const XT_ROWS = 8;

/** Row-major `XT_ROWS x XT_COLUMNS` table. */
export const XT_GRID = new Float64Array(XT_ROWS * XT_COLUMNS);
for (let r = 0; r < 4; r++) {
  for (let c = 0; c < XT_COLUMNS; c++) {
    XT_GRID[r * XT_COLUMNS + c] = HALF[r][c];
    XT_GRID[(XT_ROWS - 1 - r) * XT_COLUMNS + c] = HALF[r][c];
  }
}

/**
 * Expected threat of a point.
 * @param {number} along metres from the team's own goal line (0-105)
 * @param {number} y metres across the pitch (0-68)
 * @returns {number}
 */
export function xT(along, y) {
  let c = Math.floor((along / 105) * XT_COLUMNS);
  let r = Math.floor((y / 68) * XT_ROWS);
  c = c < 0 ? 0 : c >= XT_COLUMNS ? XT_COLUMNS - 1 : c;
  r = r < 0 ? 0 : r >= XT_ROWS ? XT_ROWS - 1 : r;
  return XT_GRID[r * XT_COLUMNS + c];
}
