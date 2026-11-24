/**
 * On-pitch event animations (presentation only: the engine never sees them).
 *
 * The MatchController attaches animation cues (runtime/animationCues.js) to
 * the frame on which an event happens (`frame.animations`): a GOAL celebration (with the snapshot from
 * the tick before the goal, as the engine lines everyone up for the kick-off
 * on the goal tick itself), a RED_CARD exit and a SUBSTITUTION. The pitch
 * canvas plays each cue for a fixed wall-clock time and asks these pure
 * helpers where to draw the players involved, so the motion is testable
 * without a canvas.
 *
 * Coordinates are engine metres (x 0..105 along the pitch, y 0..68 across);
 * the tunnel and the technical areas are on the y = 0 touchline at halfway.
 */
import { SNAP_PLAYERS, SNAP_PLAYER_STRIDE } from '../engine/MatchEngine.js';
import { PITCH_LENGTH, PITCH_WIDTH, PLAYERS_PER_TEAM } from '../engine/state/MatchState.js';

export { cuesForEvents } from '../runtime/animationCues.js';
/** @typedef {import('../runtime/animationCues.js').AnimationCue} AnimationCue */
/** @typedef {import('../runtime/animationCues.js').GoalCue} GoalCue */

/** Animation lengths in milliseconds. */
export const ANIM_MS = Object.freeze({ GOAL: 2200, RED_CARD: 1800, SUBSTITUTION: 2200 });

/** Where players leave and join the pitch: the halfway line on the y = 0 touchline. */
export const TUNNEL = Object.freeze({ x: PITCH_LENGTH / 2, y: 0 });

/** Team-mates within this distance (m) of the scorer join the celebration. */
export const CELEBRATION_RADIUS = 28;

/** @param {number} t 0..1 */
export function easeOut(t) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - (1 - c) * (1 - c) * (1 - c);
}

/** @param {number} t 0..1 */
export function easeInOut(t) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c < 0.5 ? 4 * c * c * c : 1 - ((-2 * c + 2) ** 3) / 2;
}

/**
 * @param {Float64Array} snap
 * @param {number} i
 * @returns {{x: number, y: number, onPitch: number, team: number}}
 */
export function snapPlayer(snap, i) {
  const o = SNAP_PLAYERS + SNAP_PLAYER_STRIDE * i;
  return { x: snap[o + 2], y: snap[o + 3], onPitch: snap[o + 4], team: snap[o + 5] };
}

/**
 * The corner flag the scorer runs to: the corner of the end the goal went in,
 * on the scorer's side of the pitch.
 * @param {GoalCue} cue
 * @param {{x: number, y: number}} scorer
 * @returns {{x: number, y: number}}
 */
export function celebrationCorner(cue, scorer) {
  const endX = cue.x >= PITCH_LENGTH / 2 ? PITCH_LENGTH - 1.5 : 1.5;
  const sideY = scorer.y < PITCH_WIDTH / 2 ? 1.5 : PITCH_WIDTH - 1.5;
  return { x: endX, y: sideY };
}

/**
 * Celebration positions at `progress` (0..1): the scorer sprints toward the
 * corner flag and the team-mates within `CELEBRATION_RADIUS` converge on a
 * ring around them. Returns the overridden positions by player index (others
 * stay where the pre-goal snapshot has them).
 * @param {GoalCue} cue
 * @param {Float64Array} snap the pre-goal snapshot
 * @param {number} progress
 * @returns {Map<number, {x: number, y: number}>}
 */
export function celebrationPositions(cue, snap, progress) {
  /** @type {Map<number, {x: number, y: number}>} */
  const out = new Map();
  const scorerIdx = cue.actor >= 0 ? cue.actor : nearestOfTeam(snap, cue.team, cue.x, cue.y);
  if (scorerIdx < 0) return out;
  const scorer = snapPlayer(snap, scorerIdx);
  const corner = celebrationCorner(cue, scorer);
  // The scorer stops 4 m short of the flag, inside the pitch.
  const ex = corner.x + (scorer.x - corner.x > 0 ? 4 : -4) * 0.6;
  const ey = corner.y + (scorer.y - corner.y > 0 ? 4 : -4) * 0.6;
  const k = easeOut(progress);
  const sx = scorer.x + (ex - scorer.x) * k;
  const sy = scorer.y + (ey - scorer.y) * k;
  out.set(scorerIdx, { x: sx, y: sy });
  const mates = [];
  for (let i = cue.team * PLAYERS_PER_TEAM; i < (cue.team + 1) * PLAYERS_PER_TEAM; i++) {
    if (i === scorerIdx) continue;
    const q = snapPlayer(snap, i);
    if (q.onPitch !== 1) continue;
    const d = Math.hypot(q.x - scorer.x, q.y - scorer.y);
    if (d <= CELEBRATION_RADIUS) mates.push({ i, q, d });
  }
  mates.sort((a, b) => a.d - b.d || a.i - b.i);
  const n = mates.length;
  mates.forEach((m, j) => {
    // Team-mates set off a little later the farther they are, and end on a 2.2 m ring.
    const delay = Math.min(0.35, m.d / CELEBRATION_RADIUS / 3);
    const local = easeInOut((progress - delay) / (1 - delay));
    const ang = (2 * Math.PI * j) / Math.max(1, n) + 0.6;
    const tx = ex + Math.cos(ang) * 2.2;
    const ty = ey + Math.sin(ang) * 2.2;
    out.set(m.i, { x: m.q.x + (tx - m.q.x) * local, y: m.q.y + (ty - m.q.y) * local });
  });
  return out;
}

/**
 * @param {Float64Array} snap
 * @param {number} team
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
function nearestOfTeam(snap, team, x, y) {
  let best = -1;
  let bestD = Infinity;
  for (let i = team * PLAYERS_PER_TEAM; i < (team + 1) * PLAYERS_PER_TEAM; i++) {
    const q = snapPlayer(snap, i);
    if (q.onPitch !== 1) continue;
    const d = (q.x - x) * (q.x - x) + (q.y - y) * (q.y - y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * A player leaving the pitch: from `from` toward the tunnel, walking (eased).
 * @param {{x: number, y: number}} from
 * @param {number} progress
 * @returns {{x: number, y: number}}
 */
export function exitPosition(from, progress) {
  const k = easeInOut(progress);
  return { x: from.x + (TUNNEL.x - from.x) * k, y: from.y + (TUNNEL.y - 1 - from.y) * k };
}

/**
 * A substitute coming on: from the tunnel touchline to their place.
 * @param {{x: number, y: number}} to
 * @param {number} progress
 * @returns {{x: number, y: number}}
 */
export function entryPosition(to, progress) {
  const k = easeOut(progress);
  return { x: TUNNEL.x + (to.x - TUNNEL.x) * k, y: TUNNEL.y - 1 + (to.y - (TUNNEL.y - 1)) * k };
}

/**
 * Plays cues against a wall clock: `ingest` starts them, `active` returns the
 * running ones with their progress (and drops the finished ones).
 */
export class PitchAnimations {
  /** @param {() => number} [now] milliseconds */
  constructor(now = () => performance.now()) {
    this.now = now;
    /** @type {{cue: AnimationCue, start: number, ms: number}[]} */
    this.running = [];
  }

  /** @param {AnimationCue[] | undefined} cues */
  ingest(cues) {
    if (!cues || cues.length === 0) return;
    const t = this.now();
    for (const cue of cues) {
      // A new goal replaces a running celebration; everything else stacks.
      if (cue.kind === 'GOAL') this.running = this.running.filter((r) => r.cue.kind !== 'GOAL');
      this.running.push({ cue, start: t, ms: ANIM_MS[cue.kind] });
    }
  }

  /** @returns {{cue: AnimationCue, progress: number}[]} */
  active() {
    const t = this.now();
    this.running = this.running.filter((r) => t - r.start < r.ms);
    return this.running.map((r) => ({ cue: r.cue, progress: (t - r.start) / r.ms }));
  }

  get busy() {
    return this.running.length > 0;
  }

  clear() {
    this.running = [];
  }
}
