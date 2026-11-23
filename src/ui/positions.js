/**
 * Tactical position codes and their localized badges (ui-strings `positions`
 * for the abbreviation, `positionNames` for the full name).
 *
 * Codes are English (GK, CB, LB, RB, FB, LWB, RWB, DM, CM, LCM, RCM, AM, LM,
 * RM, LW, RW, W, ST, CF); the active locale turns them into its own badge,
 * e.g. pt-PT GR, DC, DE, DD, MC, EE, ED, PL.
 */

/**
 * Position code for a formation slot, from its generic role and its defending
 * anchor (x from own goal 0..1, y across the pitch 0..1, team perspective).
 * @param {{role: string, defend?: [number, number] | number[]} | null | undefined} slot
 * @returns {string} a position code, or 'SUB' without a slot
 */
export function positionCode(slot) {
  if (!slot) return 'SUB';
  const x = slot.defend?.[0] ?? 0.3;
  const y = slot.defend?.[1] ?? 0.5;
  switch (slot.role) {
    case 'GK':
      return 'GK';
    case 'CB':
      return 'CB';
    case 'FB':
      if (x >= 0.32) return y < 0.5 ? 'LWB' : 'RWB';
      return y < 0.4 ? 'LB' : y > 0.6 ? 'RB' : 'FB';
    case 'MF':
      if (x < 0.33 && y >= 0.36 && y <= 0.64) return 'DM';
      if (x >= 0.45) return 'AM';
      return y < 0.36 ? 'LCM' : y > 0.64 ? 'RCM' : 'CM';
    case 'W':
      return x >= 0.45 ? (y < 0.5 ? 'LW' : 'RW') : y < 0.5 ? 'LM' : 'RM';
    case 'ST':
      return 'ST';
    default:
      return slot.role;
  }
}

/** Generic squad role (config/roles.yaml) to a position code, for the bench. */
const ROLE_CODES = Object.freeze({ GK: 'GK', CB: 'CB', FB: 'FB', MF: 'CM', W: 'W', ST: 'ST' });

/**
 * @param {string} role a squad role id (GK, CB, FB, MF, W, ST)
 * @returns {string} its position code
 */
export function roleCode(role) {
  return /** @type {Record<string, string>} */ (ROLE_CODES)[role] ?? role;
}

/**
 * Localized badge for a position code. Unknown codes fall back to the code.
 * @param {string} code
 * @param {{t: (key: string) => string}} locale
 * @returns {{abbr: string, name: string}}
 */
export function positionLabel(code, locale) {
  const abbrKey = `positions.${code}`;
  const nameKey = `positionNames.${code}`;
  const abbr = locale.t(abbrKey);
  const name = locale.t(nameKey);
  return { abbr: abbr === abbrKey ? code : abbr, name: name === nameKey ? code : name };
}
