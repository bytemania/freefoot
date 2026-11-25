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
/** @typedef {import('../runtime/animationCues.js').ShoutCue} ShoutCue */

/** Animation lengths in milliseconds. */
export const ANIM_MS = Object.freeze({ GOAL: 2200, RED_CARD: 1800, SUBSTITUTION: 2200, SHOUT: 2300 });

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
 * The yellow set-piece overlay for a frame's restart (the restart of the frame shown: a replay or pre-roll frame
 * carries its own): the penalty box and arc, or the 9.15 m ring round a free kick or corner, only while that
 * stoppage is on (a dead ball); null otherwise, so it clears the frame play resumes.
 * @param {{state: string, kind: string, x: number, y: number} | null | undefined} restart
 * @returns {null | {kind: 'PENALTY' | 'RING', x: number, y: number, top: boolean}}
 */
export function setPieceOverlay(restart) {
  if (!restart || restart.state !== 'DEAD_BALL') return null;
  if (restart.kind === 'PENALTY') return { kind: 'PENALTY', x: restart.x, y: restart.y, top: restart.x > PITCH_LENGTH / 2 };
  if (restart.kind === 'FREE_KICK' || restart.kind === 'CORNER') return { kind: 'RING', x: restart.x, y: restart.y, top: restart.x > PITCH_LENGTH / 2 };
  return null;
}

/**
 * The defensive wall of the frame shown, for the token layout to draw as a straight row (render/tokenLayout.js,
 * 4.): at a direct free kick being set (a dead ball), the defending outfield players standing on the wall line,
 * about 9.15-10 m from the ball toward the centre of the goal it attacks (the nearer goal: a wall is only set in the
 * attacking half) and within a few metres of the shot line. `ax`, `ay` run along the wall (across the shot line).
 * @param {{state: string, kind: string, direct?: boolean, teamIndex: number, x: number, y: number} | null | undefined} restart
 * @param {Float64Array} snap
 * @returns {null | {ids: number[], ax: number, ay: number}}
 */
export function wallLine(restart, snap) {
  if (!restart || restart.state !== 'DEAD_BALL' || restart.kind !== 'FREE_KICK' || restart.direct !== true) return null;
  const gx = restart.x > PITCH_LENGTH / 2 ? PITCH_LENGTH : 0;
  const dx = gx - restart.x;
  const dy = PITCH_WIDTH / 2 - restart.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const ux = dx / len;
  const uy = dy / len;
  /** @type {number[]} */
  const ids = [];
  for (let i = 0; i < PLAYERS_PER_TEAM * 2; i++) {
    const o = SNAP_PLAYERS + SNAP_PLAYER_STRIDE * i;
    if (snap[o + 4] !== 1 || snap[o + 5] === restart.teamIndex || snap[o + 8] === 1) continue;
    const rx = snap[o + 2] - restart.x;
    const ry = snap[o + 3] - restart.y;
    const along = rx * ux + ry * uy;
    const across = -rx * uy + ry * ux;
    if (along >= 8.6 && along <= 10.9 && Math.abs(across) <= 3.5) ids.push(i);
  }
  return ids.length >= 2 ? { ids, ax: -uy, ay: ux } : null;
}

/** How far behind the goal line (m) the ball comes to rest in the net (the net is drawn 2.4 m deep). */
export const NET_DEPTH = 1.7;
/** Half the goal mouth (m), less a ball's width: where the ball can rest in the net. */
const NET_HALF = 3.4;
/** The ball's flight to the line is drawn in this many ms at least and at most (whatever the shot speed). */
const FLIGHT_MS = Object.freeze({ min: 260, max: 650 });
/** Then it runs on into the net over this many ms, slowing, and rests there. */
const NET_MS = 420;

/**
 * The goal ball at `ms` into the celebration: it flies from where it was struck to the goal line (at the shot's speed,
 * drawn in 260-650 ms), runs on into the net, slowing and dropping, and rests at the back of it until the kick-off.
 * `speed` is the drawn speed (m/s of match time) for the motion trail.
 * @param {GoalCue} cue
 * @param {number} ms
 * @returns {{x: number, y: number, h: number, speed: number, phase: 'flight' | 'net' | 'rest'}}
 */
export function goalBallAt(cue, ms) {
  const b = cue.ball;
  const dist = Math.hypot(b.lineX - b.fromX, b.lineY - b.fromY);
  const flightMs = Math.min(FLIGHT_MS.max, Math.max(FLIGHT_MS.min, (dist / b.speed) * 1000));
  const inward = b.lineX >= PITCH_LENGTH / 2 ? 1 : -1;
  const restX = b.lineX + inward * NET_DEPTH;
  const restY = Math.max(PITCH_WIDTH / 2 - NET_HALF, Math.min(PITCH_WIDTH / 2 + NET_HALF, b.lineY + (b.lineY - b.fromY) * (NET_DEPTH / Math.max(1, Math.abs(b.lineX - b.fromX)))));
  const t = ms < 0 ? 0 : ms;
  if (t < flightMs) {
    const s = t / flightMs;
    // A straight strike, a touch of loft for a long one.
    const loft = Math.min(1.5, dist / 25) * 4 * s * (1 - s);
    return { x: b.fromX + (b.lineX - b.fromX) * s, y: b.fromY + (b.lineY - b.fromY) * s, h: b.fromZ + (b.lineZ - b.fromZ) * s + loft, speed: dist / (flightMs / 1000), phase: 'flight' };
  }
  const n = (t - flightMs) / NET_MS;
  if (n < 1) {
    const k = easeOut(n);
    const left = 1 - n;
    return { x: b.lineX + (restX - b.lineX) * k, y: b.lineY + (restY - b.lineY) * k, h: b.lineZ * left * left, speed: (Math.hypot(restX - b.lineX, restY - b.lineY) / (NET_MS / 1000)) * 3 * left * left, phase: 'net' };
  }
  return { x: restX, y: restY, h: 0, speed: 0, phase: 'rest' };
}

/**
 * Trail points behind the goal ball at `ms` (newest first): where it was over the last `spanMs`, while it moves fast.
 * @param {GoalCue} cue
 * @param {number} ms
 * @param {number} [spanMs]
 * @param {number} [count]
 * @returns {{x: number, y: number, h: number, age: number}[]} `age` 0..1 along the trail
 */
export function goalBallTrail(cue, ms, spanMs = 120, count = 8) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    const at = ms - (spanMs * i) / count;
    if (at < 0) break;
    const p = goalBallAt(cue, at);
    if (p.phase === 'rest') break;
    out.push({ x: p.x, y: p.y, h: p.h, age: i / count });
  }
  return out;
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
 * Whether a playback frame is fast-forwarding (shout reactions only play at 1x).
 * @param {{playbackState?: string, mode?: string, autoPacing?: string}} frame
 */
export function isFastFrame(frame) {
  return frame.playbackState === 'FAST_FORWARD' || (frame.mode === 'auto_highlights' && frame.autoPacing === 'FAST');
}

/**
 * One reacting player's mark at `progress` (0..1): an expanding, fading ring (`ring` px beyond the token) and an
 * arrow floating `lift` px above its resting spot (up for positive, down for negative).
 * @param {'positive' | 'negative'} outcome
 * @param {number} progress
 * @returns {{ring: number, alpha: number, lift: number, arrow: '▲' | '▼', color: string}}
 */
export function shoutMark(outcome, progress) {
  const t = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  const k = easeOut(t);
  const positive = outcome === 'positive';
  return {
    ring: 2 + k * 14,
    alpha: (1 - t) * 0.9,
    lift: positive ? k * 9 : -k * 6,
    arrow: positive ? '▲' : '▼',
    color: positive ? '#4ade80' : '#f59e0b',
  };
}

/**
 * The players the running SHOUT cues animate, by player index (a later shout wins), with their outcome and progress.
 * Players who did not react are absent.
 * @param {{cue: AnimationCue, progress: number}[]} active
 * @returns {Map<number, {outcome: 'positive' | 'negative', progress: number}>}
 */
export function shoutMarks(active) {
  /** @type {Map<number, {outcome: 'positive' | 'negative', progress: number}>} */
  const out = new Map();
  for (const a of active) {
    if (a.cue.kind !== 'SHOUT') continue;
    for (const r of a.cue.reactions) out.set(r.actor, { outcome: r.outcome, progress: a.progress });
  }
  return out;
}

/**
 * Plays cues against a wall clock: `ingest` starts them, `active` returns the
 * running ones with their progress (and drops the finished ones). Shout cues
 * are skipped while fast-forwarding, and a frame whose tick goes back (a reset
 * or a seek) clears everything running.
 */
export class PitchAnimations {
  /** @param {() => number} [now] milliseconds */
  constructor(now = () => performance.now()) {
    this.now = now;
    /** @type {{cue: AnimationCue, start: number, ms: number}[]} */
    this.running = [];
    /** The last frame tick seen, or -1. */
    this.lastTick = -1;
  }

  /**
   * @param {AnimationCue[] | undefined} cues
   * @param {{tick?: number, fast?: boolean}} [opts] the frame's tick and whether it is fast-forwarding
   */
  ingest(cues, opts = {}) {
    if (opts.tick !== undefined) {
      if (opts.tick < this.lastTick) this.clear();
      this.lastTick = opts.tick;
    }
    if (!cues || cues.length === 0) return;
    const t = this.now();
    for (const cue of cues) {
      if (cue.kind === 'SHOUT' && opts.fast) continue;
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
