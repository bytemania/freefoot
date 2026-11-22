/**
 * Formations (design §7, item 39): slot assignment by role fit, reduced
 * shapes, and the tactical anchors players hold.
 */
import { roleRating } from '../state/PlayerMatchState.js';
import { PITCH_LENGTH, PITCH_WIDTH, PLAYERS_PER_TEAM } from '../state/MatchState.js';

const CENTRE_X = PITCH_LENGTH / 2;
const CENTRE_Y = PITCH_WIDTH / 2;
/** Kick-off: players outside the centre circle stay in their own half. */
const KICK_OFF_LIMIT = CENTRE_X - 1;
/** A loose ball blends the shape from defending to attacking between these fractions of the pitch. */
const BLEND_FROM = 0.3;
const BLEND_TO = 0.7;

/**
 * Assigns each on-pitch player of `team` to a slot of formation `id` by role
 * fit (the role rating for the slot's role), slot by slot in slot order, with
 * ties going to the lower player index. The goalkeeper always takes the
 * goalkeeper slot. Players left over (when the formation has fewer slots than
 * players) get slot -1.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/TeamState.js').TeamState} team
 * @param {string} id
 */
export function setFormation(state, team, id) {
  const slots = state.config.tactics.formations[id].slots;
  team.formationId = id;
  const base = team.index * PLAYERS_PER_TEAM;
  /** @type {number[]} */
  const free = [];
  for (let i = base; i < base + PLAYERS_PER_TEAM; i++) {
    const p = state.players[i];
    p.slot = -1;
    if (p.onPitch === 1) free.push(i);
  }
  for (let s = 0; s < slots.length && free.length > 0; s++) {
    let best = -1;
    let bestRating = -1;
    for (let f = 0; f < free.length; f++) {
      const p = state.players[free[f]];
      let rating = roleRating(p, state.config.roles, slots[s].role);
      if (slots[s].role === 'GK' && p.isKeeper === 1) rating += 1000;
      if (slots[s].role !== 'GK' && p.isKeeper === 1) rating -= 1000;
      if (rating > bestRating) {
        bestRating = rating;
        best = f;
      }
    }
    state.players[free[best]].slot = s;
    free.splice(best, 1);
  }
}

/**
 * Switches a short-handed team to the reduced variant of its current
 * formation (ten men: `reducedTo.ten`; nine men: `reducedTo.nine`), or to the
 * emergency shape when the formation has no variant. Does nothing for a full
 * team or one with fewer than nine players.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/TeamState.js').TeamState} team
 */
export function reduce(state, team) {
  let n = 0;
  for (let i = team.index * PLAYERS_PER_TEAM; i < (team.index + 1) * PLAYERS_PER_TEAM; i++) {
    if (state.players[i].onPitch === 1) n++;
  }
  const key = n === 10 ? 'ten' : n === 9 ? 'nine' : null;
  if (key === null) return;
  const tactics = state.config.tactics;
  const id = tactics.formations[team.formationId].reducedTo[key] ?? tactics.emergencyShape[key];
  team.reduced = true;
  setFormation(state, team, id);
}

/**
 * Fills each on-pitch player's target (`tx`, `ty`) with their slot anchor:
 * `anchor = base + (ball - centre) x follow`. The base is the attacking anchor
 * when the team owns the ball and the defending anchor when the opponent
 * does. For a loose ball it blends from defending to attacking as the ball
 * moves from 30% to 70% of the pitch toward the opponent's goal, so the shape
 * slides instead of jumping when the ball crosses halfway.
 * Clamped to the pitch, so defenders never pass their own goal line.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/TeamState.js').TeamState} team
 */
export function computeAnchors(state, team) {
  const slots = state.config.tactics.formations[team.formationId].slots;
  const dir = state.attackDir(team.index);
  const ball = state.ball;
  // Ball in the team's own frame: x from its own goal line, y across.
  const bx = dir > 0 ? ball.x : PITCH_LENGTH - ball.x;
  const by = dir > 0 ? ball.y : PITCH_WIDTH - ball.y;
  const owner = ball.owner;
  let blend;
  if (owner >= 0) {
    blend = state.players[owner].team === team.index ? 1 : 0;
  } else {
    blend = (bx - BLEND_FROM * PITCH_LENGTH) / ((BLEND_TO - BLEND_FROM) * PITCH_LENGTH);
    blend = blend < 0 ? 0 : blend > 1 ? 1 : blend;
  }
  const kickOff = state.restart.state === 'DEAD_BALL' && state.restart.kind === 'KICK_OFF';
  const base = team.index * PLAYERS_PER_TEAM;
  for (let i = base; i < base + PLAYERS_PER_TEAM; i++) {
    const p = state.players[i];
    if (p.onPitch !== 1 || p.slot < 0) continue;
    const slot = slots[p.slot];
    const a = slot.attack;
    const d = slot.defend;
    const baseX = d[0] + blend * (a[0] - d[0]);
    const baseY = d[1] + blend * (a[1] - d[1]);
    let ax = baseX * PITCH_LENGTH + (bx - CENTRE_X) * slot.follow[0];
    let ay = baseY * PITCH_WIDTH + (by - CENTRE_Y) * slot.follow[1];
    if (kickOff) {
      ax = d[0] * PITCH_LENGTH;
      ay = d[1] * PITCH_WIDTH;
      if (ax > KICK_OFF_LIMIT) ax = KICK_OFF_LIMIT;
    }
    ax = ax < 0.5 ? 0.5 : ax > PITCH_LENGTH - 0.5 ? PITCH_LENGTH - 0.5 : ax;
    ay = ay < 0.5 ? 0.5 : ay > PITCH_WIDTH - 0.5 ? PITCH_WIDTH - 0.5 : ay;
    p.tx = dir > 0 ? ax : PITCH_LENGTH - ax;
    p.ty = dir > 0 ? ay : PITCH_WIDTH - ay;
  }
}
