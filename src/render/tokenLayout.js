/**
 * Render-only layout of the player tokens on the pitch canvas: where each circle is drawn, in pitch
 * metres, given the interpolated engine positions. Two jobs, both stateful across frames:
 *
 * 1. Temporal smoothing. Each token follows its engine position through a critically damped spring
 *    with velocity feed-forward: a player running at constant speed is drawn exactly where the engine
 *    has him (no lag), but a sudden change of direction or a micro-correction of the off-ball target
 *    is eased over about a fifth of a second instead of drawn as a kink: the drawn velocity, and so
 *    the drawn acceleration, stay continuous. A jump of more than
 *    `snapDistance` metres (kick-off reset, substitution, replay seek) is drawn at once.
 *
 * 2. Rotation-free decluttering. A token radius is more than a metre of pitch, so tokens of players
 *    in a duel would stack. The Slice 18 push worked along the instantaneous line between the two
 *    centres: when two players ran past each other that line turned through 180 degrees in a few
 *    frames and the tokens visibly orbited one another (the standing one shoved back, then forward).
 *    Here a pair that comes into contact gets a push axis it keeps while the contact lasts (with
 *    hysteresis): across their relative motion when they are moving past each other (side chosen
 *    from which side they already are on, then the slot order when dead-on), along the line between
 *    them when they are standing. The axis can only turn smoothly toward the current across-motion
 *    direction, never flip, so the two slide past side by side. The push keeps the centres
 *    `minDist` apart (a bit under two radii, so they may brush). The resulting offsets go through a
 *    two-stage easing (continuous offset velocity, no kick when a contact starts or ends) behind a
 *    small soft deadband, so the tiny impulses of a pair hovering at the edge of a contact, or of
 *    targets updating tick by tick, do not make the tokens shimmer.
 *
 * 3. Stable engagements around the ball carrier. A defender pressing the carrier runs at the ball (the
 *    engine's press target, exempt from the engine's body separation), so it often hovers right on top
 *    of the carrier, where the line between the two centres swings round as they shuffle: the engine
 *    relative angle can sweep 100+ degrees a second with the two under a metre apart. The push axis
 *    used to turn with their relative motion, and projected out to the token spacing (the carrier is
 *    pinned, the defender takes the whole push) that drew the defender circling the carrier. So a
 *    contact with the pinned carrier holds the push axis it opened with (across the motion for a
 *    run-past, so the two still slide by side by side; the line between them otherwise) as a stance
 *    while the two overlap: no turn with the relative motion (no tangential impulse), a relative-angle
 *    change within `engageDeadzone` is ignored, and the excess is followed only through a damped
 *    (`engageTau`), rate-capped (`engageMaxTurn`) turn. Once they no longer overlap the axis follows
 *    the line between them.
 *
 * 4. A line of players standing shoulder to shoulder (a free-kick wall): the caller may name it, with its
 *    direction and a closer spacing. Two of its members push apart only along that line (their axis eases onto
 *    it, ordered by where they stand along it), so the wall is drawn as a straight row across the shot, never
 *    a zig-zag from the directions they walked in from; their tokens may overlap a little more than others.
 *
 * Nothing here touches the engine state: physics and determinism are unaffected. The layout resets
 * itself when the shown time goes backwards (replay, pre-roll, seek) or leaps forward, so a token
 * never trails across a time jump.
 */

export const TOKEN_LAYOUT_DEFAULTS = Object.freeze({
  /** Smoothing time constant (s of match time): the spring's 1/e response time. */
  smoothTau: 0.18,
  /** A target further than this (m) from the drawn token is drawn at once. */
  snapDistance: 4,
  /** Total easing time constant (s) of the separation offsets (two stages of half each). */
  offsetTau: 0.18,
  /**
   * Soft deadband (m) on the separation offsets while a contact lasts: an offset change smaller than
   * this is not followed, a larger one only by the excess. Released at once when the contact ends.
   */
  offsetDeadband: 0.04,
  /** Time constant (s) of the push axis turning toward the across-motion direction. */
  axisTau: 0.2,
  /** Relative speed (m/s) above which a pair counts as moving past each other. */
  passingSpeed: 0.5,
  /**
   * Time constant (s) of each pair's smoothed relative velocity, which decides whether the pair is
   * moving past each other: sustained motion counts, the to-and-fro of two players shuffling does not.
   */
  relVelTau: 0.25,
  /**
   * Reach of the push, in `minDist`: two centres `t` apart across the push axis are kept
   * `minDist * (1 - (t / reach / minDist)^2)^2` apart along it. That smooth bump starts with zero slope
   * (a passing token eases aside instead of being kicked) and, with a reach of 2, never dips under
   * the circle of radius `minDist`, so the centres never come closer than `minDist`.
   */
  reach: 2,
  /** A pair's contact (and its push axis) ends when the centres are this many reaches apart. */
  release: 1.1,
  /** Relative-angle change (rad) an engagement's stance ignores (about 35 degrees). */
  engageDeadzone: 0.6,
  /** Time constant (s) of an engagement's stance turning toward the relative angle, past the deadzone. */
  engageTau: 0.45,
  /** Fastest turn (rad/s) of an engagement's stance (about 1.5 m/s round the carrier at token spacing). */
  engageMaxTurn: 0.6,
  /** Relaxation passes per frame. */
  passes: 3,
  /** A forward step of more than this (s of match time) between two frames resets the layout. */
  maxStep: 1,
  /** Wall-clock step cap (s) for easing the separation while match time stands still. */
  maxWallStep: 0.25,
});

/**
 * @typedef {object} TokenLayoutFrame
 * @property {number} simTime shown match time (s); drives the smoothing
 * @property {number} [wallTime] wall clock (s); eases the separation while match time stands still
 * @property {number} minDist minimum distance (m) between two token centres
 * @property {number} [pinned] a token that does not move for the separation (the ball carrier)
 * @property {ArrayLike<number>} [snap] per slot: non-zero to draw that token at its target this frame
 *   (an on-pitch animation is driving it)
 * @property {{ids: ArrayLike<number>, ax: number, ay: number, minDist: number}} [line] players standing in a line
 *   (a free-kick wall): unit direction along it and the minimum distance between two of its members
 */

export class TokenLayout {
  /**
   * @param {number} n number of player slots
   * @param {Partial<typeof TOKEN_LAYOUT_DEFAULTS>} [opts]
   */
  constructor(n, opts = {}) {
    this.n = n;
    this.opts = { ...TOKEN_LAYOUT_DEFAULTS, ...opts };
    /** Drawn position (m) of each slot, after smoothing and separation. */
    this.outX = new Float64Array(n);
    this.outY = new Float64Array(n);
    // Smoothed (pre-separation) position and velocity, last target, eased separation offset.
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.tx = new Float64Array(n);
    this.ty = new Float64Array(n);
    this.offX = new Float64Array(n);
    this.offY = new Float64Array(n);
    // First easing stage of the separation offsets.
    this.midX = new Float64Array(n);
    this.midY = new Float64Array(n);
    this.rawX = new Float64Array(n);
    this.rawY = new Float64Array(n);
    /** Frame number at which each slot was last laid out (0 = never since the last reset). */
    this.seen = new Uint32Array(n);
    this.frame = 0;
    // Per pair (lo * n + hi): contact flag and the unit push axis, pointing from lo to hi.
    this.live = new Uint8Array(n * n);
    this.axX = new Float64Array(n * n);
    // Per pair: smoothed relative velocity (hi minus lo).
    this.pvX = new Float64Array(n * n);
    this.pvY = new Float64Array(n * n);
    this.axY = new Float64Array(n * n);
    /** Per slot: whether it is in this frame's line (4. in the header). */
    this.inLine = new Uint8Array(n);
    /** @type {number[]} pair keys in contact this frame */
    this.pairs = [];
    this.simTime = NaN;
    this.wallTime = NaN;
  }

  /** Forgets all history: the next frame draws every token at its target. */
  reset() {
    this.seen.fill(0);
    this.frame = 0;
    this.live.fill(0);
    this.offX.fill(0);
    this.offY.fill(0);
    this.midX.fill(0);
    this.midY.fill(0);
    this.vx.fill(0);
    this.vy.fill(0);
    this.simTime = NaN;
    this.wallTime = NaN;
  }

  /**
   * Lays out the tokens of `ids` for one rendered frame; read the result from `outX` / `outY`.
   * @param {ArrayLike<number>} ids slots on the pitch
   * @param {ArrayLike<number>} targetX interpolated engine x (m) per slot
   * @param {ArrayLike<number>} targetY interpolated engine y (m) per slot
   * @param {TokenLayoutFrame} frame
   */
  update(ids, targetX, targetY, { simTime, wallTime = simTime, minDist, pinned = -1, snap, line }) {
    const o = this.opts;
    let dtSim = simTime - this.simTime;
    if (Number.isFinite(this.simTime) && !(dtSim >= 0 && dtSim <= o.maxStep)) this.reset();
    const fresh = !Number.isFinite(this.simTime);
    if (fresh) dtSim = 0;
    const dtWall = fresh ? 0 : Math.min(o.maxWallStep, Math.max(0, wallTime - this.wallTime));
    // The tokens move on match time only (a repeated render of the same frame changes nothing); the
    // separation offsets also ease on wall time while it stands still (an animation over a paused match).
    const dt = dtSim;
    const dtEase = dtSim > 0 ? dtSim : dtWall;
    this.simTime = simTime;
    this.wallTime = wallTime;
    const prevFrame = this.frame;
    const frameNo = ++this.frame;

    // 1. Smoothing: a critically damped spring on the error to a constant-velocity target.
    const w = 2 / o.smoothTau;
    const decay = Math.exp(-w * dt);
    const snapSq = o.snapDistance * o.snapDistance;
    /** @type {number[]} */
    const snapped = [];
    for (let a = 0; a < ids.length; a++) {
      const i = ids[a];
      const tx = targetX[i];
      const ty = targetY[i];
      const ex0 = this.x[i] - tx;
      const ey0 = this.y[i] - ty;
      const continuing = prevFrame > 0 && this.seen[i] === prevFrame;
      if (!continuing || (snap && snap[i]) || ex0 * ex0 + ey0 * ey0 > snapSq) {
        this.x[i] = tx;
        this.y[i] = ty;
        // A token appearing mid-play takes up the target's motion (if this is not the first frame).
        const keepV = continuing && dtSim > 0 && !(snap && snap[i]);
        this.vx[i] = keepV ? (tx - this.tx[i]) / dtSim : 0;
        this.vy[i] = keepV ? (ty - this.ty[i]) / dtSim : 0;
        snapped.push(i);
      } else if (dt > 0) {
        // Target velocity over this frame.
        const Vx = (tx - this.tx[i]) / dt;
        const Vy = (ty - this.ty[i]) / dt;
        // Error against where the target was a frame ago, carried along the target's motion.
        const ex = this.x[i] - (tx - Vx * dt);
        const ey = this.y[i] - (ty - Vy * dt);
        const evx = this.vx[i] - Vx;
        const evy = this.vy[i] - Vy;
        const cx = evx + w * ex;
        const cy = evy + w * ey;
        this.x[i] = tx + (ex + cx * dt) * decay;
        this.y[i] = ty + (ey + cy * dt) * decay;
        this.vx[i] = Vx + (evx - w * cx * dt) * decay;
        this.vy[i] = Vy + (evy - w * cy * dt) * decay;
      }
      this.tx[i] = tx;
      this.ty[i] = ty;
      this.seen[i] = frameNo;
      this.rawX[i] = 0;
      this.rawY[i] = 0;
    }

    // 2. Contacts and their persistent push axes.
    const n = this.n;
    const reach = minDist * o.reach;
    const reachSq = reach * reach;
    const releaseSq = (reach * o.release) ** 2;
    const kAxis = dt > 0 ? 1 - Math.exp(-dt / o.axisTau) : 0;
    const kRel = dt > 0 ? 1 - Math.exp(-dt / o.relVelTau) : 0;
    const vMinSq = o.passingSpeed * o.passingSpeed;
    const pairs = this.pairs;
    pairs.length = 0;
    const inLine = this.inLine;
    inLine.fill(0);
    if (line) for (let a = 0; a < line.ids.length; a++) inLine[line.ids[a]] = 1;
    const kLine = dt > 0 ? 1 - Math.exp(-dt / 0.1) : fresh ? 1 : 0;
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const lo = Math.min(ids[a], ids[b]);
        const hi = Math.max(ids[a], ids[b]);
        const key = lo * n + hi;
        const dx = this.x[hi] - this.x[lo];
        const dy = this.y[hi] - this.y[lo];
        const dSq = dx * dx + dy * dy;
        if (this.live[key] && dSq <= releaseSq) {
          // Still in contact: turn the axis (smoothly, never through more than 90 degrees) across the motion.
          this.pvX[key] += (this.vx[hi] - this.vx[lo] - this.pvX[key]) * kRel;
          this.pvY[key] += (this.vy[hi] - this.vy[lo] - this.pvY[key]) * kRel;
          const rvx = this.pvX[key];
          const rvy = this.pvY[key];
          const rvSq = rvx * rvx + rvy * rvy;
          if (line && inLine[lo] && inLine[hi]) {
            this.#alignToLine(key, dx, dy, line.ax, line.ay, kLine);
          } else if (lo === pinned || hi === pinned) {
            // A contact with the ball carrier: hold the stance (see 3. in the header).
            if (dt > 0) this.#holdStance(key, dx, dy, dSq, minDist, dt, kAxis);
          } else if (rvSq > vMinSq && kAxis > 0) {
            const rv = Math.sqrt(rvSq);
            let px = -rvy / rv;
            let py = rvx / rv;
            if (px * this.axX[key] + py * this.axY[key] < 0) {
              px = -px;
              py = -py;
            }
            const nx = this.axX[key] + (px - this.axX[key]) * kAxis;
            const ny = this.axY[key] + (py - this.axY[key]) * kAxis;
            const len = Math.hypot(nx, ny);
            if (len > 1e-9) {
              this.axX[key] = nx / len;
              this.axY[key] = ny / len;
            }
          }
          pairs.push(key);
        } else if (dSq < reachSq) {
          this.#openContact(key, lo, hi, dx, dy, dSq, vMinSq);
          if (line && inLine[lo] && inLine[hi]) this.#alignToLine(key, dx, dy, line.ax, line.ay, 1);
          pairs.push(key);
        } else {
          this.live[key] = 0;
        }
      }
    }

    // 3. Relax the contacts along their axes; the ball carrier stays at the ball.
    const lead = o.offsetTau;
    // A wall is a chain of contacts: give it a pass per member to spread out evenly.
    const passes = line ? Math.max(o.passes, line.ids.length + 2) : o.passes;
    for (let pass = 0; pass < passes; pass++) {
      let moved = false;
      for (const key of pairs) {
        const lo = Math.floor(key / n);
        const hi = key - lo * n;
        const nx = this.axX[key];
        const ny = this.axY[key];
        // For a pair moving past each other, the geometry a little ahead in time (by the easing lag) so
        // the eased offset arrives on time; ramped in with the relative speed, so a standing pair's
        // shuffling is not amplified.
        const rvx = this.pvX[key];
        const rvy = this.pvY[key];
        const ramp = Math.min(1, Math.max(0, Math.hypot(rvx, rvy) / o.passingSpeed - 1));
        const ahead = lead * ramp * ramp;
        const dx = this.x[hi] + this.rawX[hi] - this.x[lo] - this.rawX[lo] + rvx * ahead;
        const dy = this.y[hi] + this.rawY[hi] - this.y[lo] - this.rawY[lo] + rvy * ahead;
        const along = dx * nx + dy * ny;
        const across = -dx * ny + dy * nx;
        const pairMin = line && inLine[lo] && inLine[hi] ? line.minDist : minDist;
        const u = 1 - (across * across) / reachSq;
        const need = u > 0 ? pairMin * u * u : 0;
        if (along >= need - 1e-9) continue;
        const push = Math.min(need - along, pairMin);
        const shareLo = lo === pinned ? 0 : hi === pinned ? 1 : 0.5;
        const shareHi = 1 - shareLo;
        this.rawX[lo] -= nx * push * shareLo;
        this.rawY[lo] -= ny * push * shareLo;
        this.rawX[hi] += nx * push * shareHi;
        this.rawY[hi] += ny * push * shareHi;
        moved = true;
      }
      if (!moved) break;
    }

    // 4. Ease the offsets (a snapped token takes its offset at once) and write the drawn positions.
    const kOff = fresh ? 1 : dtEase > 0 ? 1 - Math.exp(-(2 * dtEase) / o.offsetTau) : 0;
    const db = o.offsetDeadband;
    for (let a = 0; a < ids.length; a++) {
      const i = ids[a];
      let dx = this.rawX[i] - this.midX[i];
      let dy = this.rawY[i] - this.midY[i];
      if (this.rawX[i] !== 0 || this.rawY[i] !== 0) {
        // In contact: follow only the part of the change beyond the deadband.
        const d = Math.hypot(dx, dy);
        const keep = d > db ? 1 - db / d : 0;
        dx *= keep;
        dy *= keep;
      }
      this.midX[i] += dx * kOff;
      this.midY[i] += dy * kOff;
      this.offX[i] += (this.midX[i] - this.offX[i]) * kOff;
      this.offY[i] += (this.midY[i] - this.offY[i]) * kOff;
    }
    for (const i of snapped) {
      this.offX[i] = this.midX[i] = this.rawX[i];
      this.offY[i] = this.midY[i] = this.rawY[i];
    }
    for (let a = 0; a < ids.length; a++) {
      const i = ids[a];
      this.outX[i] = this.x[i] + this.offX[i];
      this.outY[i] = this.y[i] + this.offY[i];
    }
  }

  /**
   * Eases a pair's push axis (lo to hi) onto a line's direction (`ax`, `ay`), pointing the way hi stands from lo
   * along it (dead level: the slot order).
   * @param {number} key
   * @param {number} dx
   * @param {number} dy
   * @param {number} ax
   * @param {number} ay
   * @param {number} k easing share this frame (1: at once)
   */
  #alignToLine(key, dx, dy, ax, ay, k) {
    const side = dx * ax + dy * ay;
    const sgn = Math.abs(side) > 1e-3 ? Math.sign(side) : 1;
    const tx = ax * sgn;
    const ty = ay * sgn;
    // Never through more than 90 degrees at once (from the far side: straight onto it).
    const from = this.axX[key] * tx + this.axY[key] * ty < 0 ? 1 : k;
    const nx = this.axX[key] + (tx - this.axX[key]) * from;
    const ny = this.axY[key] + (ty - this.axY[key]) * from;
    const len = Math.hypot(nx, ny);
    if (len > 1e-9) {
      this.axX[key] = nx / len;
      this.axY[key] = ny / len;
    }
  }

  /**
   * Turns an engagement's push axis (lo to hi) toward the line between the two centres (`dx`, `dy`, lo to hi):
   * freely once they no longer overlap, else only past the deadzone, damped and rate-capped.
   * @param {number} key
   * @param {number} dx
   * @param {number} dy
   * @param {number} dSq
   * @param {number} minDist
   * @param {number} dt
   * @param {number} kAxis
   */
  #holdStance(key, dx, dy, dSq, minDist, dt, kAxis) {
    if (dSq < 1e-12) return;
    const o = this.opts;
    const ax = this.axX[key];
    const ay = this.axY[key];
    const err = Math.atan2(ax * dy - ay * dx, ax * dx + ay * dy);
    let turn;
    if (dSq >= minDist * minDist) {
      // Apart: the axis follows the line between them (as the push will not need it soon).
      turn = err * kAxis;
    } else {
      const mag = Math.abs(err) - o.engageDeadzone;
      if (mag <= 0) return;
      turn = Math.sign(err) * Math.min(mag * (1 - Math.exp(-dt / o.engageTau)), o.engageMaxTurn * dt);
    }
    const c = Math.cos(turn);
    const sn = Math.sin(turn);
    this.axX[key] = ax * c - ay * sn;
    this.axY[key] = ax * sn + ay * c;
  }

  /**
   * Starts a contact between `lo` and `hi` (lo < hi) and picks its push axis, pointing from lo to hi.
   * @param {number} key
   * @param {number} lo
   * @param {number} hi
   * @param {number} dx
   * @param {number} dy
   * @param {number} dSq
   * @param {number} vMinSq
   */
  #openContact(key, lo, hi, dx, dy, dSq, vMinSq) {
    this.live[key] = 1;
    const rvx = this.vx[hi] - this.vx[lo];
    const rvy = this.vy[hi] - this.vy[lo];
    this.pvX[key] = rvx;
    this.pvY[key] = rvy;
    const rvSq = rvx * rvx + rvy * rvy;
    let nx;
    let ny;
    if (rvSq > vMinSq) {
      // Moving past each other: push across the relative motion, on the side they already are on.
      const rv = Math.sqrt(rvSq);
      nx = -rvy / rv;
      ny = rvx / rv;
      const side = dx * nx + dy * ny;
      // Dead-on (within a millimetre): the slot order decides, the higher slot to the +y side.
      const flip = Math.abs(side) > 1e-3 ? side < 0 : ny < 0 || (ny === 0 && nx < 0);
      if (flip) {
        nx = -nx;
        ny = -ny;
      }
    } else if (dSq > 1e-12) {
      const d = Math.sqrt(dSq);
      nx = dx / d;
      ny = dy / d;
    } else {
      // Standing on the same spot: split across the pitch, the higher slot to the +y side
      // (drawn to the right on the portrait canvas).
      nx = 0;
      ny = 1;
    }
    this.axX[key] = nx;
    this.axY[key] = ny;
  }
}
