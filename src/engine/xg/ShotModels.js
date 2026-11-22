/**
 * Shot quality models (design §13, item 50). Never used to decide whether a
 * shot scores: shots are decided by `shotPlacement` and `saveOutcome`.
 */
import { sigmoid } from '../math/detmath.js';

/**
 * Logistic xG: sigmoid(intercept + distance d + angle a + isHeader h + defendersInCone c + assistType[type]).
 * Features are defined in item 26b.
 * @param {{distance: number, angle: number, isHeader: boolean | number, defendersInCone: number, assistType: string}} features
 * @param {any} coeffs `config.xg.logistic`
 * @returns {number}
 */
export function xg(features, coeffs) {
  return sigmoid(
    coeffs.intercept +
      coeffs.distance * features.distance +
      coeffs.angle * features.angle +
      coeffs.header * (features.isHeader ? 1 : 0) +
      coeffs.defendersInCone * features.defendersInCone +
      coeffs.assistType[features.assistType],
  );
}

/**
 * Post-shot xG: xG x clamp(base + placementWeight x placement + speedWeight x min(1, vShot / speedRef), 0, max).
 * Placement runs from 0 (central) to 1 (corner).
 * @param {number} xgValue
 * @param {number} goalY metres from the goal centre
 * @param {number} goalZ metres above the ground
 * @param {number} vShot
 * @param {any} coeffs `config.xg.psxg`
 * @returns {number}
 */
export function psxg(xgValue, goalY, goalZ, vShot, coeffs) {
  const ay = goalY < 0 ? -goalY : goalY;
  const py = ay / 3.66;
  const pz = goalZ / 2.44;
  const placement = py > pz ? py : pz;
  const speed = vShot / coeffs.speedRef;
  const f = coeffs.base + coeffs.placementWeight * (placement > 1 ? 1 : placement) + coeffs.speedWeight * (speed > 1 ? 1 : speed);
  return xgValue * (f > coeffs.max ? coeffs.max : f < 0 ? 0 : f);
}
