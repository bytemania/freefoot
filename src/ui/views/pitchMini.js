/**
 * Shared vertical tactical mini-pitch helper (used by `ManagerView` and `PreMatchView`).
 */

export const MINI_PITCH_LINES_HTML = `
  <div class="mgr-pitch-half"></div>
  <div class="mgr-pitch-box-top"></div>
  <div class="mgr-pitch-box-bot"></div>
  <div class="mgr-pitch-circle"></div>
`;

/**
 * Converts a formation slot's `[xFrac, yFrac]` defending anchor into percentage CSS
 * coordinates on the vertical tactical minimap.
 * @param {[number, number] | number[] | undefined} defendAnchor
 * @returns {{leftPct: number, topPct: number}}
 */
export function miniPitchCoords(defendAnchor) {
  const xFrac = defendAnchor?.[0] ?? 0.3;
  const yFrac = defendAnchor?.[1] ?? 0.5;
  // Spread across the width a little more than the pitch fraction so central midfield cards do not overlap.
  const leftPct = Math.max(14, Math.min(86, 50 + (yFrac - 0.5) * 125));
  const topPct = Math.max(11, Math.min(89, 92 - xFrac * 135));
  return { leftPct, topPct };
}
