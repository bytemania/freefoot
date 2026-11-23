/**
 * Per-player state (design §4, §6, item 31). One mutable object per player,
 * created once. Cold data (name, attributes, role) lives in `cold` and is
 * not part of the saved state.
 */
import { ATTRIBUTE_GROUPS } from '../contracts/MatchInput.js';

/** Injury level names by number (0 = none). */
export const INJURY_LEVELS = Object.freeze(['NONE', 'LIGHT', 'MEDIUM', 'HIGH']);

/** @type {Record<string, 'physical' | 'technical' | 'mental'>} */
const GROUP_OF = {};
for (const a of ATTRIBUTE_GROUPS.physical) GROUP_OF[a] = 'physical';
for (const a of ATTRIBUTE_GROUPS.goalkeeping) GROUP_OF[a] = 'physical';
for (const a of ATTRIBUTE_GROUPS.technical) GROUP_OF[a] = 'technical';
for (const a of ATTRIBUTE_GROUPS.mental) GROUP_OF[a] = 'mental';

/**
 * @typedef {import('../contracts/MatchInput.js').InputPlayer} ColdPlayer
 */

export class PlayerMatchState {
  /**
   * @param {number} index permanent index 0-35
   * @param {number} team 0 home, 1 away
   * @param {ColdPlayer} cold frozen input data
   */
  constructor(index, team, cold) {
    this.index = index;
    this.team = team;
    this.cold = cold;
    this.shortName = cold.shortName ?? cold.name;
    this.slot = -1;
    this.onPitch = 0;
    this.x = 0;
    this.y = 0;
    this.prevX = 0;
    this.prevY = 0;
    this.vx = 0;
    this.vy = 0;
    this.tx = 0;
    this.ty = 0;
    this.fitness = 1;
    this.distance = 0;
    this.sprints = 0;
    this.sprinting = 0;
    /** Seconds spent below the sprint threshold (starts at 1 so an opening sprint counts). */
    this.sprintCooldown = 1;
    /** 1 forces a decision on the next tick (a new owner, a changed pass target). */
    this.decisionTimer = 0;
    /** Current intent: see ACTION in decisions/Perception.js. */
    this.pendingAction = 0;
    /** Plan point for the current intent (a support run, a dribble target, a pass destination). */
    this.px = 0;
    this.py = 0;
    /** Index of the opponent this player marks, or -1. */
    this.markTarget = -1;
    /** 0 available; 1 substituted off or left injured (cannot return). */
    this.out = 0;
    /** 0 none, 1 LIGHT, 2 MEDIUM, 3 HIGH */
    this.injury = 0;
    /** 0 none, 1 yellow, 2 red */
    this.card = 0;
    this.isKeeper = 0;
    this.ticksOnPitch = 0;
    /** Starting morale 0-100 (player, else team, else neutral); set by MatchState. */
    this.baseMorale = 75;
    /** Current morale 0-100: baseMorale plus the team's momentum shift (morale/Morale.js). */
    this.morale = 75;
    /** Signed morale level derived from `morale` (0 neutral, +1 high, -1 low). Not saved. */
    this.moraleLevel = 0;
  }
}

/**
 * Effective attribute: contrast-scaled base x fitness factor x injury factor,
 * clamped to 1-20 (§6, §9a). The only way engine code reads an attribute.
 * The base is first pulled toward `attributes.pivot` by `attributes.contrast`
 * (1 = raw): the resolvers chain many duels, so raw 1-20 gaps compound into
 * one-sided matches; the contrast sets how strongly quality decides a match
 * and is calibrated against the closing-odds strength curves.
 * @param {PlayerMatchState} player
 * @param {string} attr
 * @param {import('../TickConfig.js').TickConfig} k
 * @returns {number}
 */
export function getEffectiveAttribute(player, attr, k) {
  const a = k.weights.attributes;
  const raw = /** @type {Record<string, number>} */ (player.cold.attributes)[attr];
  const base = a.pivot + a.contrast * (raw - a.pivot);
  const group = GROUP_OF[attr];
  const fit = k.weights.fitness;
  const lack = fit.threshold - player.fitness;
  const slope = group === 'physical' ? fit.s_phys : fit.s_ment;
  const fitnessFactor = lack > 0 ? 1 - slope * lack : 1;
  const injuryFactor = player.injury === 0 ? 1 : k.injuries.multipliers[INJURY_LEVELS[player.injury]][group];
  const v = base * fitnessFactor * injuryFactor;
  return v < 1 ? 1 : v > 20 ? 20 : v;
}

/**
 * Role rating: the weighted mean of a role's primary and secondary attributes
 * (0.7 and 0.3 by default). Uses base attributes.
 * @param {{role: string, attributes: Record<string, number>} | PlayerMatchState} player
 * @param {Record<string, any>} roles `config.roles`
 * @param {string} [roleId] defaults to the player's own role
 * @returns {number}
 */
export function roleRating(player, roles, roleId) {
  const cold = /** @type {any} */ (player).cold ?? player;
  const attrs = cold.attributes ?? cold;
  const role = roles[roleId ?? cold.role];
  let p = 0;
  for (const a of role.primary) p += attrs[a];
  let s = 0;
  for (const a of role.secondary) s += attrs[a];
  return role.rating.primary * (p / role.primary.length) + role.rating.secondary * (s / role.secondary.length);
}
