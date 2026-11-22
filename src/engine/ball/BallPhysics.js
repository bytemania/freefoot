/**
 * Ball (design §8, item 41). Ground balls roll with a per-tick resistance
 * factor. Lofted balls store a flight descriptor: position is linear in
 * time, height is the closed-form parabola `4 x peak x s x (1 - s)` and is
 * evaluated only when a player is close enough to contest the ball.
 *
 * Until restarts exist (build step 4), a ball that leaves play is stopped at
 * the line; `state.ballStatus` records where and why.
 */
import { getEffectiveAttribute } from '../state/PlayerMatchState.js';
import { distSqPointSegment, closestPointOnSegment } from '../math/geom.js';
import { PITCH_LENGTH, PITCH_WIDTH } from '../state/MatchState.js';

export const BALL_IN_PLAY = 0;
export const BALL_TOUCHLINE = 1;
export const BALL_GOAL_LINE = 2;
export const BALL_GOAL = 3;

const GOAL_HALF_WIDTH = 3.66;
const GOAL_HEIGHT = 2.44;
const CENTRE_Y = PITCH_WIDTH / 2;

/**
 * Starts a ground pass or shot from (x0, y0) toward (x1, y1) at `speed` m/s.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number} speed
 * @param {number} [kicker] player index of the kicker, or -1
 */
export function launchGround(state, x0, y0, x1, y1, speed, kicker = -1) {
  const b = state.ball;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  b.x = b.prevX = x0;
  b.y = b.prevY = y0;
  b.vx = len > 0 ? (dx / len) * speed : 0;
  b.vy = len > 0 ? (dy / len) * speed : 0;
  b.height = 0;
  b.owner = -1;
  b.lastTouch = kicker;
  b.flight = null;
}

/**
 * Starts a lofted ball (long pass, cross, chip, clearance). Flight time is
 * distance / launch speed, rounded up to whole ticks.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number} speed horizontal launch speed in m/s
 * @param {number} peak peak height in metres
 * @param {number} [kicker] player index of the kicker, or -1
 */
export function launchLofted(state, x0, y0, x1, y1, speed, peak, kicker = -1) {
  const b = state.ball;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  let ticks = Math.ceil(dist / speed / state.k.dt);
  if (ticks < 1) ticks = 1;
  b.x = b.prevX = x0;
  b.y = b.prevY = y0;
  b.vx = dx / (ticks * state.k.dt);
  b.vy = dy / (ticks * state.k.dt);
  b.height = 0;
  b.owner = -1;
  b.lastTouch = kicker;
  b.flight = { launchTick: state.tick, x0, y0, x1, y1, flightTicks: ticks, peak };
}

/**
 * Moves the ball by one tick and detects the ball leaving play.
 * A carried ball sits on its owner.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} dt
 */
export function updateBall(state, dt) {
  const b = state.ball;
  const status = state.ballStatus;
  status.code = BALL_IN_PLAY;
  status.landed = false;
  b.prevX = b.x;
  b.prevY = b.y;

  if (b.owner >= 0) {
    const p = state.players[b.owner];
    b.x = p.x;
    b.y = p.y;
    b.vx = 0;
    b.vy = 0;
    b.height = 0;
    b.flight = null;
    return;
  }

  const f = b.flight;
  if (f !== null) {
    const s = (state.tick - f.launchTick) / f.flightTicks;
    if (s >= 1) {
      b.x = f.x1;
      b.y = f.y1;
      b.vx *= state.k.weights.ball.landingKeep;
      b.vy *= state.k.weights.ball.landingKeep;
      b.flight = null;
      b.height = 0;
      status.landed = true;
    } else {
      b.x = f.x0 + s * (f.x1 - f.x0);
      b.y = f.y0 + s * (f.y1 - f.y0);
      b.height = b.heightAt(state.tick);
    }
  } else {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    const keep = 1 - state.k.weights.ball.rolling;
    b.vx *= keep;
    b.vy *= keep;
    const stop = state.k.weights.ball.stopSpeed;
    if (b.vx * b.vx + b.vy * b.vy < stop * stop) {
      b.vx = 0;
      b.vy = 0;
    }
  }

  // Out of play: crossing a goal line (a goal if between the posts and under the bar) or a touchline.
  if (b.x < 0 || b.x > PITCH_LENGTH) {
    const side = b.x < 0 ? 0 : 1;
    const goalX = side === 0 ? 0 : PITCH_LENGTH;
    const t = (goalX - b.prevX) / (b.x - b.prevX);
    const yAt = b.prevY + t * (b.y - b.prevY);
    const hAt = f !== null ? b.heightAt(state.tick - 1 + t) : 0;
    const inGoal = yAt >= CENTRE_Y - GOAL_HALF_WIDTH && yAt <= CENTRE_Y + GOAL_HALF_WIDTH && hAt <= GOAL_HEIGHT;
    status.code = inGoal ? BALL_GOAL : BALL_GOAL_LINE;
    status.side = side;
    status.x = goalX;
    status.y = yAt;
    stopAt(b, goalX, yAt < 0 ? 0 : yAt > PITCH_WIDTH ? PITCH_WIDTH : yAt);
  } else if (b.y < 0 || b.y > PITCH_WIDTH) {
    const lineY = b.y < 0 ? 0 : PITCH_WIDTH;
    const t = (lineY - b.prevY) / (b.y - b.prevY);
    status.code = BALL_TOUCHLINE;
    status.side = b.y < 0 ? 0 : 1;
    status.x = b.prevX + t * (b.x - b.prevX);
    status.y = lineY;
    stopAt(b, status.x, lineY);
  }
}

/**
 * @param {import('../state/BallState.js').BallState} b
 * @param {number} x
 * @param {number} y
 */
function stopAt(b, x, y) {
  b.x = x;
  b.y = y;
  b.vx = 0;
  b.vy = 0;
  b.height = 0;
  b.flight = null;
}

/**
 * @typedef {object} ContestList
 * @property {number} count
 * @property {Int32Array} player player index of each contender
 * @property {Float64Array} x contact point
 * @property {Float64Array} y
 * @property {Float64Array} height ball height at the contact point
 */

/** @returns {ContestList} a caller-owned output for `sweptContests` (22 on-pitch players at most) */
export function makeContestList() {
  return { count: 0, player: new Int32Array(22), x: new Float64Array(22), y: new Float64Array(22), height: new Float64Array(22) };
}

const scratch = { x: 0, y: 0, t: 0 };

/**
 * Lists the opponents of the last player to touch the ball who can contest it
 * on this tick's segment from `prevPos` to `currPos`. A ground ball can be
 * contested within `groundReach`; a lofted ball also needs its height at the
 * closest point to be under the player's reach (standing height plus jumping
 * reach; keepers add aerial reach).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {ContestList} out
 * @returns {ContestList} `out`
 */
export function sweptContests(state, out) {
  out.count = 0;
  const b = state.ball;
  if (b.lastTouch < 0) return out;
  const kickerTeam = state.players[b.lastTouch].team;
  const k = state.k;
  const c = k.weights.contest;
  const reachSq = c.groundReach * c.groundReach;
  const list = state.onPitchList;
  for (let n = 0; n < list.length; n++) {
    const p = state.players[list[n]];
    if (p.team === kickerTeam) continue;
    if (distSqPointSegment(b.prevX, b.prevY, b.x, b.y, p.x, p.y) > reachSq) continue;
    closestPointOnSegment(b.prevX, b.prevY, b.x, b.y, p.x, p.y, scratch);
    const h = b.flight !== null ? b.heightAt(state.tick - 1 + scratch.t) : 0;
    if (b.flight !== null) {
      let reach = c.standHeight + (c.jumpHeight * getEffectiveAttribute(p, 'jumpingReach', k)) / 20;
      if (p.isKeeper === 1) reach += (getEffectiveAttribute(p, 'aerialReach', k) / 20) * k.weights.keeper.reachFactor;
      if (h > reach) continue;
    }
    const i = out.count++;
    out.player[i] = p.index;
    out.x[i] = scratch.x;
    out.y[i] = scratch.y;
    out.height[i] = h;
  }
  return out;
}
