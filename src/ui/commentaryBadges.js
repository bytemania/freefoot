/**
 * Major-event categories of the commentary bar (CommentaryView): each gets its own accent, icon and a localized
 * badge (ui-strings `commentaryBadges.<key>`): a goal (emerald and gold), a yellow card (amber), a red card (red), a
 * VAR check or decision (indigo) and a substitution (green / red swap arrows). Pure: build-config checks every
 * badge has its string in every locale.
 */

/** Badge string keys (ui-strings `commentaryBadges`), by category. */
export const COMMENTARY_BADGE_KEYS = Object.freeze(['goal', 'yellowCard', 'redCard', 'var', 'substitution']);

/** @type {Readonly<Record<string, string>>} event type to badge key */
const CATEGORY = Object.freeze({
  GOAL: 'goal',
  YELLOW_CARD: 'yellowCard',
  RED_CARD: 'redCard',
  VAR_CHECK: 'var',
  VAR_DECISION: 'var',
  SUBSTITUTION: 'substitution',
});

/**
 * The major-event category of an event (its badge key), or null.
 * @param {{type: string}} ev
 * @returns {string | null}
 */
export function commentaryCategory(ev) {
  return CATEGORY[ev.type] ?? null;
}
