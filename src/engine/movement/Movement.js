/**
 * Movement (design §7, §9b, item 40). No trigonometry: directions are unit
 * vectors from dx / dist. Fitness drain belongs to Fitness.js (tick step 7).
 */
import { getEffectiveAttribute } from '../state/PlayerMatchState.js';
import { normalize } from '../math/geom.js';
import { PITCH_LENGTH, PITCH_WIDTH } from '../state/MatchState.js';
import { ACTION } from '../decisions/Perception.js';

const dir = { x: 0, y: 0 };
/** Per-tick displacement accumulators for body separation, indexed by player index. */
let pushX = new Float64Array(0);
let pushY = new Float64Array(0);

/**
 * Whether two opponents are in a physical challenge (a tackle on the ball
 * carrier, or two chasers contesting a loose or aerial ball): such a pair is
 * allowed to make contact.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} a
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} b
 * @returns {boolean}
 */
function inDuel(state, a, b) {
  if (a.team === b.team) return false;
  const owner = state.ball.owner;
  if (owner === a.index) return b.pendingAction === ACTION.PRESS || b.pendingAction === ACTION.CHASE;
  if (owner === b.index) return a.pendingAction === ACTION.PRESS || a.pendingAction === ACTION.CHASE;
  const ca = a.pendingAction === ACTION.CHASE || a.pendingAction === ACTION.RECEIVE;
  const cb = b.pendingAction === ACTION.CHASE || b.pendingAction === ACTION.RECEIVE;
  return ca && cb;
}

/**
 * Keeps player bodies apart. Every pair closer than `minPlayerSeparation` gets
 * a push along the line between them, worked out from the positions as they
 * stand after movement and added up before anyone is moved, so the result does
 * not depend on the order the players are visited. Each player then moves by
 * the sum, at most `separationMaxStep` a tick, and stays on the pitch. Two
 * players on exactly the same spot are split along the pitch's long axis,
 * lower index towards the left. Pairs in a duel are left alone.
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function separatePlayers(state) {
  const m = state.k.weights.movement;
  const minSep = m.minPlayerSeparation ?? 1;
  if (!(minSep > 0)) return;
  const stiff = m.separationStiffness ?? 0.5;
  const maxStep = m.separationMaxStep ?? 0.2;
  const list = state.onPitchList;
  if (pushX.length < state.players.length) {
    pushX = new Float64Array(state.players.length);
    pushY = new Float64Array(state.players.length);
  }
  for (let n = 0; n < list.length; n++) {
    pushX[list[n]] = 0;
    pushY[list[n]] = 0;
  }
  let any = false;
  for (let n = 0; n < list.length; n++) {
    const a = state.players[list[n]];
    for (let o = n + 1; o < list.length; o++) {
      const b = state.players[list[o]];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minSep * minSep) continue;
      if (inDuel(state, a, b)) continue;
      let ux;
      let uy;
      let d = Math.sqrt(d2);
      if (d < 1e-9) {
        // Same spot: a fixed direction by index, so the split is repeatable.
        d = 0;
        ux = a.index < b.index ? 1 : -1;
        uy = 0;
      } else {
        ux = dx / d;
        uy = dy / d;
      }
      const half = ((minSep - d) * stiff) / 2;
      pushX[a.index] -= ux * half;
      pushY[a.index] -= uy * half;
      pushX[b.index] += ux * half;
      pushY[b.index] += uy * half;
      any = true;
    }
  }
  if (!any) return;
  for (let n = 0; n < list.length; n++) {
    const p = state.players[list[n]];
    let sx = pushX[p.index];
    let sy = pushY[p.index];
    if (sx === 0 && sy === 0) continue;
    const s = Math.sqrt(sx * sx + sy * sy);
    if (s > maxStep) {
      sx = (sx / s) * maxStep;
      sy = (sy / s) * maxStep;
    }
    const x = p.x + sx;
    const y = p.y + sy;
    p.x = x < 0 ? 0 : x > PITCH_LENGTH ? PITCH_LENGTH : x;
    p.y = y < 0 ? 0 : y > PITCH_WIDTH ? PITCH_WIDTH : y;
  }
}

/**
 * Top speed in m/s: v0 + v1 x pace / 20 (effective pace).
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {import('../TickConfig.js').TickConfig} k
 * @returns {number}
 */
export function topSpeed(p, k) {
  const m = k.weights.movement;
  return m.v0 + (m.v1 * getEffectiveAttribute(p, 'pace', k)) / 20;
}

/**
 * Acceleration in m/s^2: a0 + a1 x acceleration / 20 (effective acceleration).
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {import('../TickConfig.js').TickConfig} k
 * @returns {number}
 */
export function acceleration(p, k) {
  const m = k.weights.movement;
  return m.a0m + (m.a1m * getEffectiveAttribute(p, 'acceleration', k)) / 20;
}

/**
 * Steers every on-pitch player toward their target (`tx`, `ty`). The velocity
 * turns toward the target and changes by at most `accel x dt` per tick.
 * Speed scales down linearly inside `rArrive` of the target. A player
 * holding position closes the gap at `holdGain x distance`, capped at
 * `holdMaxSpeed` (below the sprint threshold; during a dead ball at least a brisk
 * walk, `deadBallGain x distance` up to `deadBallPace`), and sprints at top speed only
 * when the gap is at least `sprintDist`: jogs for corrections, sprints for
 * big recoveries. Pressing, chasing and receiving are at top speed, and a
 * carrier dribbles at `carryFraction` of it.
 * Updates previous and current position, velocity, distance and sprints.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} dt
 */
export function updateMovement(state, dt) {
  const k = state.k;
  const m = k.weights.movement;
  const list = state.onPitchList;
  const deadBall = state.restart.state === 'DEAD_BALL';
  const deadPace = m.deadBallPace ?? 2;
  const deadGain = m.deadBallGain ?? 4;
  for (let n = 0; n < list.length; n++) {
    const p = state.players[list[n]];
    p.prevX = p.x;
    p.prevY = p.y;
    const top = topSpeed(p, k);
    const accel = acceleration(p, k);
    const dist = normalize(p.tx - p.x, p.ty - p.y, dir);
    let want = m.holdGain * dist;
    if (want > m.holdMaxSpeed) want = m.holdMaxSpeed;
    if (dist >= m.sprintDist) want = top;
    if (deadBall) {
      // Walking back to restart positions: brisk, easing off as the spot is reached.
      const brisk = deadGain * dist < deadPace ? deadGain * dist : deadPace;
      if (want < brisk) want = brisk;
    }
    const a = p.pendingAction;
    if (a === ACTION.PRESS) want = top * m.chaseFraction * (1 + k.weights.morale.pressSpeed * p.moraleLevel); // pressing work-rate follows morale
    else if (a === ACTION.CHASE || a === ACTION.RECEIVE) want = top * m.chaseFraction; // going for the ball
    else if (a === ACTION.RUN) want = top * (k.weights.offBall?.runFraction ?? m.chaseFraction); // a run in behind or an overlap
    else if (a === ACTION.DRIBBLE) want = top * m.carryFraction;
    if (dist < m.rArrive) want = Math.min(want, top * (dist / m.rArrive));
    if (want > top) want = top;
    // Desired velocity, then a bounded change toward it.
    let dvx = dir.x * want - p.vx;
    let dvy = dir.y * want - p.vy;
    const dv = Math.sqrt(dvx * dvx + dvy * dvy);
    const maxDv = accel * dt;
    if (dv > maxDv) {
      dvx = (dvx / dv) * maxDv;
      dvy = (dvy / dv) * maxDv;
    }
    p.vx += dvx;
    p.vy += dvy;
    let x = p.x + p.vx * dt;
    let y = p.y + p.vy * dt;
    if (x < 0 || x > PITCH_LENGTH) {
      x = x < 0 ? 0 : PITCH_LENGTH;
      p.vx = 0;
    }
    if (y < 0 || y > PITCH_WIDTH) {
      y = y < 0 ? 0 : PITCH_WIDTH;
      p.vy = 0;
    }
    p.x = x;
    p.y = y;
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    p.distance += speed * dt;
    if (speed >= m.sprintThreshold) {
      if (p.sprinting === 0 && p.sprintCooldown >= 1) p.sprints++;
      p.sprinting = 1;
      p.sprintCooldown = 0;
    } else {
      p.sprinting = 0;
      p.sprintCooldown += dt;
    }
  }
}
