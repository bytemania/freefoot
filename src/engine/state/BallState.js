/** Ball state (design §8, item 32). */

export class BallState {
  constructor() {
    this.x = 52.5;
    this.y = 34;
    this.prevX = 52.5;
    this.prevY = 34;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.az = 0;
    this.z = 0;
    /** Height at the start of the tick (set by updateBall; not part of the saved state). */
    this.prevZ = 0;
    this.maxZ = 0;
    this.height = 0;
    /** Player index of the owner, or -1. */
    this.owner = -1;
    /** Player index of the last player to kick or touch the ball, or -1. */
    this.lastTouch = -1;
    /** Tick of the last touch. */
    this.touchTick = 0;
    /**
     * A pass in flight, or null.
     * @type {null | {passer: number, receiver: number, kind: string, restart: boolean, accurate: boolean, px: number, py: number, tried: number[]}}
     */
    this.pass = null;
    /**
     * Flight descriptor of a lofted ball, or null for a ground ball.
     * @type {null | {launchTick: number, x0: number, y0: number, x1: number, y1: number, flightTicks: number, peak: number}}
     */
    this.flight = null;
  }

  /**
   * Height above the ground at `tick`: 4 * peak * s * (1 - s), s the fraction of flight completed.
   * @param {number} tick
   * @returns {number}
   */
  heightAt(tick) {
    const f = this.flight;
    if (f === null) return 0;
    let s = (tick - f.launchTick) / f.flightTicks;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    return 4 * f.peak * s * (1 - s);
  }
}
