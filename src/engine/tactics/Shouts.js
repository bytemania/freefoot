/**
 * Coach shouts (docs/designs/coach_shouts.md, config/shouts.yaml).
 *
 * `issueShout` carries out an ISSUE_SHOUT: every on-pitch player of the team whose slot role is in the shout's
 * `roles` and who stands in its `pitchZone` (own half / opponent's half / anywhere, in the team's own attacking
 * direction, so it holds for both teams and after the half-time switch) draws once from the match RNG and turns
 * 'positive' (morale and focus up, counts toward the tactical effect), 'negative' (morale and focus down) or
 * 'neutral' (nothing). Acceptance follows the player's morale level, the scoreline and the team's shout load.
 * One `SHOUT_REACTION` event lists the players who reacted: `secondaryIndices` holds the positive ones first
 * (`meta.positive` of them), then the negative ones.
 *
 * The tactical effect is the shout's knobs scaled by the accepted share, composed over the instruction knobs
 * (`team.knobs`) until `durationTicks` have passed; only a shout with knobs replaces the effect running.
 *
 * Zero regression: a team keeps `shout === null` (no state, nothing serialized, no RNG draws, no per-tick work)
 * until it shouts, unless its match input asks for the silence clock with `shouts: true`. Player `focus` stays 0,
 * and its read sites are skipped at 0.
 */
import { nextFloat } from '../rng/sfc32.js';
import { sigmoid } from '../math/detmath.js';
import { shiftPlayerMorale } from '../morale/Morale.js';
import { KNOBS, composeKnobs } from './Instructions.js';

const HALF_LENGTH = 52.5;

/**
 * @typedef {{id: string, untilTick: number, share: number}} ActiveShout
 * @typedef {{lastTick: number, count: number, load: number, active: ActiveShout | null, cooldowns: Record<string, number>}} ShoutState
 * @typedef {'positive' | 'negative'} ShoutOutcome
 */

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Panel strings every locale needs in its `shouts` group, besides `<id>` and `<id>Hint` per shout. */
export const SHOUT_PANEL_KEYS = Object.freeze([
  'title', 'receptiveness', 'quiet', 'engaged', 'overwhelmed', 'quietHint', 'engagedHint', 'overwhelmedHint', 'none', 'active', 'cooldown',
]);

/**
 * Every `shouts.*` UI string key the shouts in `shoutsCfg` need.
 * @param {any} shoutsCfg `config.shouts`
 * @returns {string[]}
 */
export function shoutStringKeys(shoutsCfg) {
  return [...SHOUT_PANEL_KEYS, ...Object.keys(shoutsCfg.shouts).flatMap((id) => [id, `${id}Hint`])];
}

/**
 * A fresh shout state (the silence clock starts at kick-off, tick 0).
 * @returns {ShoutState}
 */
export function newShoutState() {
  return { lastTick: 0, count: 0, load: 0, active: null, cooldowns: {} };
}

/**
 * Whether a player at `x` stands in `zone` for a team attacking in `dir`.
 * @param {'defensive' | 'offensive' | 'any'} zone
 * @param {number} x
 * @param {1 | -1} dir
 */
export function inPitchZone(zone, x, dir) {
  if (zone === 'any') return true;
  const along = dir > 0 ? x : 2 * HALF_LENGTH - x;
  return zone === 'defensive' ? along < HALF_LENGTH : along > HALF_LENGTH;
}

/**
 * The shout's knobs scaled by `share`: a multiplier m becomes 1 + (m - 1) share, an offset a becomes a share.
 * @param {Record<string, number>} knobs
 * @param {number} share
 * @returns {Record<string, number>}
 */
export function scaledShoutKnobs(knobs, share) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, v] of Object.entries(knobs)) {
    const def = /** @type {Record<string, {identity: number, compose: string}>} */ (KNOBS)[k];
    if (def === undefined) throw new Error(`shout knob "${k}" is not a knob`);
    if (def.compose === 'mul') out[k] = 1 + (v - 1) * share;
    else if (def.compose === 'add') out[k] = v * share;
    else throw new Error(`shout knob "${k}" must compose by mul or add`);
  }
  return out;
}

/**
 * Recomputes the team's knobs: its instruction knobs, with the running shout's scaled knobs on top.
 * @param {any} shoutsCfg `config.shouts`
 * @param {import('../state/TeamState.js').TeamState} team
 */
export function refreshShoutKnobs(shoutsCfg, team) {
  const active = team.shout?.active ?? null;
  team.shoutKnobs = active === null ? null : scaledShoutKnobs(shoutsCfg.shouts[active.id].knobs, active.share);
  team.knobs = team.shoutKnobs === null ? team.instrKnobs : composeKnobs(team.instrKnobs, team.shoutKnobs);
}

/**
 * Why `id` cannot be shouted by the team now, or null.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} teamIndex
 * @param {unknown} id
 * @returns {null | 'UNKNOWN_SHOUT' | 'SHOUT_COOLDOWN' | 'SHOUT_PENDING'}
 */
export function shoutRefusal(state, teamIndex, id) {
  const cfg = state.config.shouts;
  if (typeof id !== 'string' || cfg === undefined || !Object.hasOwn(cfg.shouts, id)) return 'UNKNOWN_SHOUT';
  if (state.pendingCommands.some((c) => c.type === 'ISSUE_SHOUT' && c.teamIndex === teamIndex)) return 'SHOUT_PENDING';
  if (shoutCooldownLeft(state, teamIndex, id) > 0) return 'SHOUT_COOLDOWN';
  return null;
}

/**
 * Ticks until the team may give shout `id` again (0 = now).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} teamIndex
 * @param {string} id
 */
export function shoutCooldownLeft(state, teamIndex, id) {
  const until = state.teams[teamIndex].shout?.cooldowns[id] ?? 0;
  return until > state.tick ? until - state.tick : 0;
}

/**
 * The running tactical shout and its ticks left, or null.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} teamIndex
 * @returns {{id: string, ticksLeft: number, share: number} | null}
 */
export function activeShout(state, teamIndex) {
  const a = state.teams[teamIndex].shout?.active ?? null;
  return a === null ? null : { id: a.id, ticksLeft: Math.max(0, a.untilTick - state.tick), share: a.share };
}

/**
 * How the team takes shouts now: 'overwhelmed' over the spam threshold, 'quiet' after the silence threshold
 * without a shout, else 'engaged'.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} teamIndex
 * @returns {'quiet' | 'engaged' | 'overwhelmed'}
 */
export function shoutReceptiveness(state, teamIndex) {
  const cad = state.config.shouts.cadence;
  const sh = state.teams[teamIndex].shout;
  if (sh !== null && sh.load > cad.spamThreshold) return 'overwhelmed';
  return state.tick - (sh?.lastTick ?? 0) >= cad.silenceThresholdTicks ? 'quiet' : 'engaged';
}

/**
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} index
 * @param {{morale: number, focus: number}} effect
 * @param {number} scale
 */
function applyEffect(state, index, effect, scale) {
  shiftPlayerMorale(state, index, effect.morale * scale);
  if (effect.focus !== 0) {
    const p = state.players[index];
    p.focus = clamp(p.focus + effect.focus * scale, -1, 1);
  }
}

/**
 * Carries out shout `id` for the team (validated by `shoutRefusal` when it was issued).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} teamIndex
 * @param {string} id
 * @returns {{positive: number[], negative: number[], share: number, overload: number}}
 */
export function issueShout(state, teamIndex, id) {
  const cfg = state.config.shouts;
  const def = cfg.shouts[id];
  const cad = cfg.cadence;
  const team = state.teams[teamIndex];
  const opp = state.teams[1 - teamIndex];
  if (team.shout === null) team.shout = newShoutState();
  const sh = team.shout;
  const tick = state.tick;

  const rapid = sh.count > 0 && tick - sh.lastTick < cad.rapidTicks;
  sh.load += cad.loadPerShout + (rapid ? cad.rapidLoad : 0);
  const overload = sh.load > cad.spamThreshold ? sh.load - cad.spamThreshold : 0;
  const effectiveness = 1 / (1 + overload);
  const context = team.score > opp.score ? def.accept.leading : team.score < opp.score ? def.accept.trailing : def.accept.level;
  const backfire = Math.min(1, def.backfire + cad.spamBackfire * overload);
  const dir = state.attackDir(teamIndex);
  const slots = state.config.tactics.formations[team.formationId].slots;

  /** @type {number[]} */
  const positive = [];
  /** @type {number[]} */
  const negative = [];
  let scope = 0;
  let accepted = 0;
  for (let j = 0; j < state.onPitchList.length; j++) {
    const i = state.onPitchList[j];
    const p = state.players[i];
    if (p.team !== teamIndex) continue;
    const role = p.slot >= 0 && slots[p.slot] !== undefined ? slots[p.slot].role : p.cold.role;
    if (!def.roles.includes(role)) continue;
    const disciplined = p.card > 0 || p.fouls >= (def.preferFouls ?? 2);
    const weight = def.prefer === 'discipline' && !disciplined ? def.otherWeight : 1;
    scope += weight;
    if (!inPitchZone(def.pitchZone, p.x, dir)) continue;
    const logit = def.accept.base + def.accept.morale * p.moraleLevel + context + (p.card > 0 ? (def.accept.booked ?? 0) : 0) + cad.spamAcceptLogit * overload;
    const pAccept = sigmoid(logit);
    const u = nextFloat(state.rng);
    if (u < pAccept) {
      accepted += weight;
      applyEffect(state, i, def.positive, weight * effectiveness);
      positive.push(i);
    } else if (u < pAccept + (1 - pAccept) * backfire) {
      applyEffect(state, i, def.negative, weight);
      negative.push(i);
    }
  }
  // Overwhelmed: the whole side feels the stress.
  if (overload > 0) {
    for (let j = 0; j < state.onPitchList.length; j++) {
      const i = state.onPitchList[j];
      if (state.players[i].team !== teamIndex) continue;
      shiftPlayerMorale(state, i, cad.spamStressMorale * overload);
      if (!positive.includes(i) && !negative.includes(i)) negative.push(i);
    }
  }

  const share = scope > 0 ? (accepted / scope) * effectiveness : 0;
  if (Object.keys(def.knobs).length > 0) {
    sh.active = share > 0 ? { id, untilTick: tick + def.durationTicks, share } : null;
    refreshShoutKnobs(cfg, team);
  }
  sh.cooldowns[id] = tick + def.cooldownTicks;
  sh.lastTick = tick;
  sh.count++;
  state.emit('SHOUT_REACTION', {
    teamIndex,
    secondaryIndices: [...positive, ...negative],
    meta: { shout: id, positive: positive.length, negative: negative.length, overloaded: overload > 0 },
  });
  return { positive, negative, share, overload };
}

/**
 * The reactions of a SHOUT_REACTION event, by player index.
 * @param {{secondaryIndices: number[], meta: Record<string, any>}} event
 * @returns {{actor: number, outcome: ShoutOutcome}[]}
 */
export function shoutReactions(event) {
  const n = Number(event.meta.positive) || 0;
  return event.secondaryIndices.map((actor, k) => ({ actor, outcome: k < n ? 'positive' : 'negative' }));
}

/**
 * Tick step 7 (after morale): the running shout ends after its duration; each match second the shout load and
 * the players' focus decay; with `shouts: true`, silence past the threshold slowly drains morale and focus.
 * Does nothing for a team without shout state and without the silence clock.
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function updateShouts(state) {
  for (let t = 0; t < 2; t++) {
    const team = state.teams[t];
    const sh = team.shout;
    if (sh === null && !team.shoutsEnabled) continue;
    const cfg = state.config.shouts;
    const cad = cfg.cadence;
    const tick = state.tick;
    if (sh !== null && sh.active !== null && tick >= sh.active.untilTick) {
      sh.active = null;
      refreshShoutKnobs(cfg, team);
    }
    if (team.shoutsEnabled) {
      const past = tick - (sh?.lastTick ?? 0) - cad.silenceThresholdTicks;
      if (past >= 0 && past % cad.silenceIntervalTicks === 0) silenceDrift(state, t);
    }
    if (tick % 20 !== 0) continue;
    if (sh !== null && sh.load > 0) {
      const next = sh.load * cad.loadDecayPerSecond;
      sh.load = next < 0.01 ? 0 : next;
    }
    const decay = cfg.focus.decayPerSecond;
    const base = t * 18;
    for (let i = base; i < base + 18; i++) {
      const p = state.players[i];
      if (p.focus === 0) continue;
      const next = p.focus * decay;
      p.focus = next > -0.005 && next < 0.005 ? 0 : next;
    }
  }
}

/**
 * One silence step: every on-pitch player loses a little morale and focus.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} teamIndex
 */
function silenceDrift(state, teamIndex) {
  const cad = state.config.shouts.cadence;
  for (let j = 0; j < state.onPitchList.length; j++) {
    const i = state.onPitchList[j];
    const p = state.players[i];
    if (p.team !== teamIndex) continue;
    shiftPlayerMorale(state, i, cad.silenceMorale);
    if (p.focus > cad.silenceFocusFloor) p.focus = Math.max(cad.silenceFocusFloor, p.focus + cad.silenceFocus);
  }
}
