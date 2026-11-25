/**
 * Render-only separation of player tokens on the pitch canvas. In a close duel two players can stand
 * almost on the same spot in pitch metres, and at canvas scale their circles would stack, hiding one
 * of them. Before the tokens are drawn, a few relaxation passes push any two screen-space centres
 * closer than `minDist` apart, symmetrically along the line between them (along x, lower index to
 * the left, when they coincide exactly). It works on the screen coordinates only: the engine state
 * is never touched, so physics and determinism are unaffected.
 */

/**
 * Separates token centres in place.
 * @param {Float64Array | number[]} xs screen x of each token
 * @param {Float64Array | number[]} ys screen y of each token
 * @param {ArrayLike<number>} active indices of the tokens to separate (the on-pitch players)
 * @param {number} minDist minimum distance between two centres (2 x radius plus padding)
 * @param {{passes?: number, pinned?: number}} [opts] relaxation passes (default 3); a `pinned` token (the
 *   ball carrier, so the ball stays at its feet) does not move and the other token takes the whole push
 */
export function separateTokens(xs, ys, active, minDist, { passes = 3, pinned = -1 } = {}) {
  const n = active.length;
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (let a = 0; a < n; a++) {
      const i = active[a];
      for (let b = a + 1; b < n; b++) {
        const j = active[b];
        let dx = xs[j] - xs[i];
        let dy = ys[j] - ys[i];
        let d = Math.sqrt(dx * dx + dy * dy);
        if (d >= minDist) continue;
        if (d < 1e-9) {
          // Exactly on top of each other: a deterministic axis (the higher index to the right).
          dx = 1;
          dy = 0;
          d = 0;
        } else {
          dx /= d;
          dy /= d;
        }
        const push = minDist - d;
        const shareI = i === pinned ? 0 : j === pinned ? 1 : 0.5;
        const shareJ = 1 - shareI;
        xs[i] -= dx * push * shareI;
        ys[i] -= dy * push * shareI;
        xs[j] += dx * push * shareJ;
        ys[j] += dy * push * shareJ;
        moved = true;
      }
    }
    if (!moved) return;
  }
}
