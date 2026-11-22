/**
 * Repro bundle export (design §14, §20, item 56, CUJ 3).
 * The repro record is identical to the save record.
 */
import { buildSaveRecord } from './Persistence.js';

/**
 * Serialises the current match state as a repro JSON string.
 * @param {any} controller
 * @returns {string}
 */
export function buildReproJson(controller) {
  return JSON.stringify(buildSaveRecord(controller), null, 2);
}
