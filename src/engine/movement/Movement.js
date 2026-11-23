/**
 * Movement (design §7, §9b, item 40). No trigonometry: directions are unit
 * vectors from dx / dist. Fitness drain belongs to Fitness.js (tick step 7).
 */
import { getEffectiveAttribute } from '../state/PlayerMatchState.js';
import { normalize } from '../math/geom.js';
import { PITCH_LENGTH, PITCH_WIDTH } from '../state/MatchState.js';
import { ACTION } from '../decisions/Perception.js';

const dir = { x: 0, y: 0 };

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
