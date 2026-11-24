/** Team state (design item 32). */

export class TeamState {
  /**
   * @param {number} index 0 home, 1 away
   * @param {'human' | 'ai'} controlledBy
   * @param {string} formationId
   */
  constructor(index, controlledBy, formationId) {
    this.index = index;
    this.controlledBy = controlledBy;
    this.score = 0;
    this.formationId = formationId;
    /** Whether the team plays a reduced shape (red card or injury with no substitutes). */
    this.reduced = false;
    this.subsUsed = 0;
    /** In-play stoppage windows in which the team has made substitutions (half-time does not count). */
    this.subWindows = 0;
    /** Whether the stoppage now under way already counts as one of the team's substitution windows. */
    this.inSubWindow = false;
    /** An unresolved forced decision (HIGH injury or goalkeeper sent off). */
    this.forcedDecision = false;
    /** What the forced decision is about: 0 none, 1 a HIGH injury, 2 a goalkeeper sent off. */
    this.forcedKind = 0;
    /** The injured or sent-off player of the forced decision, or -1. */
    this.forcedPlayer = -1;
    /** Ids of AI rules that have already fired, in firing order. */
    this.aiFired = /** @type {string[]} */ ([]);
    /** In-match momentum shift in morale points (goals, red cards), decaying toward 0. */
    this.moraleShift = 0;
  }
}
