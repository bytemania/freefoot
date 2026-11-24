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
 * Exact Hungarian (Kuhn-Munkres) max-weight bipartite matching for an `R x C`
 * fit matrix (`R <= C` or `R > C`). Returns `assignRow[r] = c` (or `-1` for
 * unmatched overflow rows when `R > C`).
 * @param {number[][]} weights
 * @param {number} R
 * @param {number} C
 * @returns {Int32Array}
 */
function solveMaxWeightAssignment(weights, R, C) {
  const N = R > C ? R : C;
  let maxW = -Infinity;
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (weights[r][c] > maxW) maxW = weights[r][c];
    }
  }
  const INF = 1e12;
  const u = new Float64Array(N + 1);
  const v = new Float64Array(N + 1);
  const p = new Int32Array(N + 1);
  const way = new Int32Array(N + 1);
  const minv = new Float64Array(N + 1);
  const used = new Uint8Array(N + 1);

  for (let i = 1; i <= N; i++) {
    p[0] = i;
    let j0 = 0;
    minv.fill(INF);
    used.fill(0);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= N; j++) {
        if (used[j]) continue;
        const w = i0 - 1 < R && j - 1 < C ? weights[i0 - 1][j - 1] : 0;
        const cost = maxW - w;
        const cur = cost - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= N; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const out = new Int32Array(R).fill(-1);
  for (let j = 1; j <= N; j++) {
    if (p[j] > 0 && p[j] <= R && j <= C) {
      out[p[j] - 1] = j - 1;
    }
  }
  return out;
}

/**
 * Computes optimal `(playerIndex -> slotIndex)` assignments for a list of
 * on-pitch `players` against `slots` using `roleRating` + natural role fit,
 * keeping keepers in slot `0`. Shared by `setFormation` and `ManagerView` draft
 * preview.
 * @param {any[]} players
 * @param {any[]} slots
 * @param {Record<string, any>} roles
 * @returns {Map<number, number>}
 */
export function computeOptimalSlotAssignments(players, slots, roles) {
  const result = new Map();
  if (players.length === 0 || slots.length === 0) return result;
  /** @type {number[][]} */
  const weights = [];
  for (let r = 0; r < players.length; r++) {
    const p = players[r];
    const row = [];
    for (let s = 0; s < slots.length; s++) {
      const slotRole = slots[s].role;
      let w = roleRating(p, roles, slotRole);
      if (p.cold.role === slotRole) w += 3;
      if (slotRole === 'GK' && p.isKeeper === 1) w += 10000;
      else if (slotRole !== 'GK' && p.isKeeper === 1) w -= 10000;
      else if (slotRole === 'GK' && p.isKeeper === 0) w -= 10000;
      w += (12 - Math.abs(r - s)) * 1e-6;
      row.push(w);
    }
    weights.push(row);
  }
  const assigned = solveMaxWeightAssignment(weights, players.length, slots.length);
  for (let r = 0; r < players.length; r++) {
    result.set(players[r].index, assigned[r]);
  }
  return result;
}

/**
 * Assigns each on-pitch player of `team` to a slot of formation `id` using an
 * optimal bipartite assignment solver maximizing `roleRating` + natural role
 * fit while keeping the goalkeeper in the GK slot. Deterministic ties go to
 * lower player/slot indices.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/TeamState.js').TeamState} team
 * @param {string} id
 */
export function setFormation(state, team, id) {
  const slots = state.config.tactics.formations[id].slots;
  team.formationId = id;
  const base = team.index * PLAYERS_PER_TEAM;
  /** @type {any[]} */
  const free = [];
  for (let i = base; i < base + PLAYERS_PER_TEAM; i++) {
    const p = state.players[i];
    p.slot = -1;
    if (p.onPitch === 1) free.push(p);
  }
  const assigned = computeOptimalSlotAssignments(free, slots, state.config.roles);
  for (const p of free) {
    p.slot = assigned.get(p.index) ?? -1;
  }
}

/**
 * Immediately swaps the tactical formation slots of two on-pitch teammates.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} playerA
 * @param {number} playerB
 */
export function swapPlayerPositions(state, playerA, playerB) {
  const pA = state.players[playerA];
  const pB = state.players[playerB];
  const tmpSlot = pA.slot;
  pA.slot = pB.slot;
  pB.slot = tmpSlot;
  pA.isKeeper = pA.slot === 0 ? 1 : 0;
  pB.isKeeper = pB.slot === 0 ? 1 : 0;
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
 * slides instead of jumping when the ball crosses halfway. Out of possession
 * in open play the anchor also slides `offBall.compactShift` of the way toward
 * the ball's width (compact ball-side defending).
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
  // Out of possession the shape slides toward the ball side (compact
  // defending; `weights.offBall.compactShift`).
  const ob = state.k.weights.offBall;
  const compact = ob !== undefined && owner >= 0 && blend === 0 && state.restart.state === 'IN_PLAY';
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
    if (compact && slot.role !== 'GK') {
      if (ob.lineShift !== undefined && (slot.role === 'CB' || slot.role === 'FB' || slot.role === 'MF')) {
        const t = (bx - ob.lineDeepX) / (ob.lineFullX - ob.lineDeepX);
        const depth = ob.lineDeepScale + (1 - ob.lineDeepScale) * (t < 0 ? 0 : t > 1 ? 1 : t);
        ay += (by - ay) * ob.lineShift * depth;
      } else {
        ay += (by - ay) * ob.compactShift;
      }
    }
    if (kickOff) {
      ax = d[0] * PITCH_LENGTH;
      ay = d[1] * PITCH_WIDTH;
      if (ax > KICK_OFF_LIMIT) ax = KICK_OFF_LIMIT;
    }
    ax = ax < 0.5 ? 0.5 : ax > PITCH_LENGTH - 0.5 ? PITCH_LENGTH - 0.5 : ax;
    ay = ay < 0.5 ? 0.5 : ay > PITCH_WIDTH - 0.5 ? PITCH_WIDTH - 0.5 : ay;
    p.tx = dir > 0 ? ax : PITCH_LENGTH - ax;
    p.ty = dir > 0 ? ay : PITCH_WIDTH - ay;
    p.linePos = ay; // own-frame y, for the line spacing pass below
  }
  if (compact && ob.lineMinGap !== undefined) {
    spaceLine(state, team, slots, dir, ob.lineMinGap, (r) => r === 'CB' || r === 'FB');
    spaceLine(state, team, slots, dir, ob.lineMinGap, (r) => r === 'MF');
  }
}

/** Scratch list for `spaceLine` (player indices of one line). */
const lineScratch = /** @type {number[]} */ ([]);

/**
 * Keeps the players of one line at least `gap` metres apart across the pitch after the ball-side
 * shift: sorted by y, each is pushed away from its neighbour, the line staying centred on where it was.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/TeamState.js').TeamState} team
 * @param {any[]} slots
 * @param {number} dir
 * @param {number} gap
 * @param {(role: string) => boolean} inLine
 */
function spaceLine(state, team, slots, dir, gap, inLine) {
  lineScratch.length = 0;
  const base = team.index * PLAYERS_PER_TEAM;
  for (let i = base; i < base + PLAYERS_PER_TEAM; i++) {
    const p = state.players[i];
    if (p.onPitch === 1 && p.slot >= 0 && inLine(slots[p.slot].role)) lineScratch.push(i);
  }
  const n = lineScratch.length;
  if (n < 2) return;
  // Insertion sort by own-frame y (ties by index).
  for (let a = 1; a < n; a++) {
    const v = lineScratch[a];
    let b = a - 1;
    while (b >= 0 && (state.players[lineScratch[b]].linePos > state.players[v].linePos || (state.players[lineScratch[b]].linePos === state.players[v].linePos && lineScratch[b] > v))) {
      lineScratch[b + 1] = lineScratch[b];
      b--;
    }
    lineScratch[b + 1] = v;
  }
  let before = 0;
  for (let a = 0; a < n; a++) before += state.players[lineScratch[a]].linePos;
  for (let a = 1; a < n; a++) {
    const prev = state.players[lineScratch[a - 1]];
    const cur = state.players[lineScratch[a]];
    if (cur.linePos < prev.linePos + gap) cur.linePos = prev.linePos + gap;
  }
  let after = 0;
  for (let a = 0; a < n; a++) after += state.players[lineScratch[a]].linePos;
  const back = (after - before) / n; // re-centre where the line was
  for (let a = 0; a < n; a++) {
    const p = state.players[lineScratch[a]];
    let y = p.linePos - back;
    y = y < 0.5 ? 0.5 : y > PITCH_WIDTH - 0.5 ? PITCH_WIDTH - 0.5 : y;
    p.ty = dir > 0 ? y : PITCH_WIDTH - y;
  }
}
