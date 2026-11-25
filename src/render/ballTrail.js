/**
 * Render-only motion trail of the ball (the pitch canvas draws it behind the ball): the drawn ball positions over
 * the last `maxAge` seconds of match time, kept while the ball moves fast, so a hard pass or a shot can be followed
 * across the pitch. The engine resolves a shot at the strike (a saved shot is in the keeper's hands the next tick),
 * so the trail of that one jump is the streak of the shot.
 *
 * The trail is cleared on any time jump (a replay, a pre-roll, a seek, a reset: time goes back or leaps forward),
 * whenever play is not live (a dead ball: the ball is placed for the restart, not kicked there), and when the ball
 * jumps further than a shot could (`maxJump`).
 */

export const BALL_TRAIL_DEFAULTS = Object.freeze({
  /** Seconds of match time the trail reaches back. */
  maxAge: 0.22,
  /** Ball speed (m/s) under which no trail is drawn ... */
  minSpeed: 9,
  /** ... and from which it is drawn in full. */
  fullSpeed: 24,
  /** A jump (m) between two frames longer than this is a teleport, not a kick: the trail restarts there. */
  maxJump: 40,
  /** A forward step of more than this (s of match time) between two frames clears the trail. */
  maxStep: 0.5,
});

/** @typedef {{t: number, x: number, y: number, h: number}} TrailPoint */

export class BallTrail {
  /** @param {Partial<typeof BALL_TRAIL_DEFAULTS>} [opts] */
  constructor(opts = {}) {
    this.opts = { ...BALL_TRAIL_DEFAULTS, ...opts };
    /** @type {TrailPoint[]} oldest first */
    this.pts = [];
  }

  reset() {
    this.pts.length = 0;
  }

  /**
   * Records where the ball is drawn this frame.
   * @param {number} simTime match time (s) of the frame
   * @param {number} x
   * @param {number} y
   * @param {number} h height (m)
   * @param {boolean} [live] false while play is not live (a dead ball): clears the trail
   */
  push(simTime, x, y, h, live = true) {
    const o = this.opts;
    if (!live) {
      this.reset();
      return;
    }
    const last = this.pts[this.pts.length - 1];
    if (last !== undefined) {
      const dt = simTime - last.t;
      if (dt < 0 || dt > o.maxStep || Math.hypot(x - last.x, y - last.y) > o.maxJump) this.reset();
      else if (dt === 0) this.pts.pop(); // the same frame drawn again
    }
    this.pts.push({ t: simTime, x, y, h });
    while (this.pts.length > 1 && simTime - this.pts[0].t > o.maxAge) this.pts.shift();
  }

  /** Ball speed (m/s) over the trail, or 0. */
  get speed() {
    const n = this.pts.length;
    if (n < 2) return 0;
    const a = this.pts[0];
    const b = this.pts[n - 1];
    let d = 0;
    for (let i = 1; i < n; i++) d += Math.hypot(this.pts[i].x - this.pts[i - 1].x, this.pts[i].y - this.pts[i - 1].y);
    return b.t > a.t ? d / (b.t - a.t) : 0;
  }

  /**
   * The trail to draw, newest first (the ball's own position excluded), with `age` 0..1 along it and an overall
   * `strength` 0..1 from the ball speed; empty while the ball is slow.
   * @returns {{points: {x: number, y: number, h: number, age: number}[], strength: number}}
   */
  trail() {
    const o = this.opts;
    const v = this.speed;
    const strength = v <= o.minSpeed ? 0 : Math.min(1, (v - o.minSpeed) / (o.fullSpeed - o.minSpeed));
    const n = this.pts.length;
    if (strength === 0 || n < 2) return { points: [], strength: 0 };
    const now = this.pts[n - 1].t;
    const points = [];
    for (let i = n - 2; i >= 0; i--) {
      const p = this.pts[i];
      points.push({ x: p.x, y: p.y, h: p.h, age: Math.min(1, (now - p.t) / o.maxAge) });
    }
    return { points, strength };
  }
}
