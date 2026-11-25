/**
 * Duel resolution (design §9, §9a, §9b, item 43). Pure functions, see passing.js.
 */
import { sigmoid } from '../math/detmath.js';
import { n } from './passing.js';

/**
 * pBeat = sigmoid(d0 + d1 n(dribbling) + d2 n(agility) + d3 n(flair) - d4 n(def.tackling) - d5 n(def.positioning)).
 * @param {number} dribbling
 * @param {number} agility
 * @param {number} flair
 * @param {number} defTackling
 * @param {number} defPositioning
 * @param {any} k
 * @param {number} u
 * @param {{pBeat: number, beat: boolean}} out
 * @param {number} [edge] logit offset on pBeat (the defending team's marking instruction)
 */
export function dribbleOutcome(dribbling, agility, flair, defTackling, defPositioning, k, u, out, edge = 0) {
  const d = k.dribble;
  out.pBeat = sigmoid(edge + d.d0 + d.d1 * n(dribbling) + d.d2 * n(agility) + d.d3 * n(flair) - d.d4 * n(defTackling) - d.d5 * n(defPositioning));
  out.beat = u < out.pBeat;
}

/**
 * pWin = sigmoid(k0 + k1 n(tackling) + k2 n(strength) - k3 n(carrier.dribbling) - k4 n(carrier.balance));
 * pFoul = sigmoid(f0 + f1 n(aggression) - f2 n(tackling) + f3 (1 - fitness) + f4 fromBehind + f5 injuryLevel).
 * The foul is decided first (`uFoul`); otherwise the tackle is won when `uWin < pWin`.
 * @param {number} tackling
 * @param {number} strength
 * @param {number} carrierDribbling
 * @param {number} carrierBalance
 * @param {number} aggression
 * @param {number} fitness 0-1
 * @param {number} fromBehind 0 or 1
 * @param {number} injuryLevel 0-3
 * @param {any} k
 * @param {number} uFoul
 * @param {number} uWin
 * @param {{pWin: number, pFoul: number, won: boolean, foul: boolean}} out
 * @param {number} [edge] logit offset on pWin (morale: tackler minus carrier)
 * @param {number} [foulEdge] logit offset on pFoul (a defender in their own box is more careful)
 */
export function tackleOutcome(tackling, strength, carrierDribbling, carrierBalance, aggression, fitness, fromBehind, injuryLevel, k, uFoul, uWin, out, edge = 0, foulEdge = 0) {
  const t = k.tackle;
  out.pWin = sigmoid(edge + t.k0 + t.k1 * n(tackling) + t.k2 * n(strength) - t.k3 * n(carrierDribbling) - t.k4 * n(carrierBalance));
  out.pFoul = sigmoid(foulEdge + t.f0 + t.f1 * n(aggression) - t.f2 * n(tackling) + t.f3 * (1 - fitness) + t.f4 * fromBehind + t.f5 * injuryLevel);
  out.foul = uFoul < out.pFoul;
  out.won = !out.foul && uWin < out.pWin;
}

/**
 * Aerial duel: pWinA = sigmoid(a0 + a1 (aerialA - aerialB) / 10). Each player's
 * aerial score is (jumpingReach + strength + bravery) / 3.
 * @param {number} aerialA
 * @param {number} aerialB
 * @param {any} k
 * @param {number} u
 * @param {{pWinA: number, aWins: boolean}} out
 */
export function aerialDuel(aerialA, aerialB, k, u, out) {
  out.pWinA = sigmoid(k.aerial.a0 + (k.aerial.a1 * (aerialA - aerialB)) / 10);
  out.aWins = u < out.pWinA;
}

/**
 * Ball contest (interception or block): pWin = sigmoid(c0 + c1 n(anticipation) - c2 ballSpeed/20 - c3 distToPath/reach).
 * @param {number} anticipation positioning (keepers use reflexes)
 * @param {number} ballSpeed
 * @param {number} distToPath
 * @param {number} reach
 * @param {any} k
 * @param {number} u
 * @param {{pWin: number, won: boolean}} out
 * @param {number} [edge] logit offset (the defender's morale)
 */
export function contestOutcome(anticipation, ballSpeed, distToPath, reach, k, u, out, edge = 0) {
  const c = k.contest;
  out.pWin = sigmoid(edge + c.c0 + c.c1 * n(anticipation) - (c.c2 * ballSpeed) / 20 - (c.c3 * distToPath) / reach);
  out.won = u < out.pWin;
}
