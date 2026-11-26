/**
 * Broadcast match minute formatting (pure, DOM-free).
 * Shared by `src/runtime/matchday/MatchReport.js` and `src/ui/views/StatsView.js`.
 */

/**
 * The broadcast match minute: the minute being played, so 00:00 is `1'`,
 * and added time past 45 / 90 reads `45+2'` / `90+3'`.
 * @param {number} clockSeconds match clock (the second half starts at 2700)
 * @param {number} half 1 or 2
 * @returns {string}
 */
export function matchMinuteLabel(clockSeconds, half) {
  const regulationEnd = half === 1 ? 45 : 90;
  const minute = Math.floor((clockSeconds > 0 ? clockSeconds : 0) / 60) + 1;
  return minute > regulationEnd ? `${regulationEnd}+${minute - regulationEnd}'` : `${minute}'`;
}
