/**
 * Single-line top broadcast commentary bar (design §15–16, item 66).
 * Displays one match commentary line as slots — `min` | `icon` | (`badge`) |
 * `comment` — styled with the acting team's kit colors, with a blink pulse on
 * `GOAL`, `RED_CARD`, `PENALTY_AWARDED` or `VAR_CHECK`. The score is not
 * repeated here: the scoreboard directly above already shows it.
 *
 * Major events (src/ui/commentaryBadges.js) get their own treatment: a goal an
 * emerald bar with a gold border, a gold minute, a GOAL badge, the scorer in
 * bold and a pulse; a yellow card an amber tint, a red card a red one, VAR an
 * indigo badge and border, a substitution green / red swap arrows; each with
 * its localized badge (`commentaryBadges.*`).
 *
 * The line shown is the latest one, except that a major line holds the bar for
 * a few seconds of match time against lesser ones (a goal's own ASSIST, the
 * KICK_OFF after it): see `PRIORITY` and `HOLD_TICKS`.
 */
import { View } from './View.js';
import { commentaryCategory } from '../commentaryBadges.js';

const PARTIAL = `<div class="comm-broadcast" aria-live="polite"></div>`;

const DEFAULT_TEAM_COLORS = [
  { primary: '#2563eb', secondary: '#dbeafe' },
  { primary: '#dc2626', secondary: '#fee2e2' },
];

const FLASH_TYPES = new Set(['GOAL', 'RED_CARD', 'PENALTY_AWARDED', 'VAR_CHECK']);

const IMPORTANT_TYPES = new Set([
  'GOAL',
  'ASSIST',
  'SHOT',
  'BIG_CHANCE',
  'SAVE',
  'PENALTY_AWARDED',
  'FOUL',
  'FREE_KICK',
  'YELLOW_CARD',
  'RED_CARD',
  'INJURY',
  'SUBSTITUTION',
  'FORMATION_CHANGE',
  'CORNER',
  'OFFSIDE',
  'KICK_OFF',
  'ADDED_TIME',
  'HALF_TIME',
  'FULL_TIME',
  'VAR_CHECK',
  'VAR_DECISION',
]);

/** How much a line holds the bar (3 highest): a newer line of lower priority replaces it only after `HOLD_TICKS`. */
const PRIORITY = Object.freeze(/** @type {Record<string, number>} */ ({
  GOAL: 3,
  RED_CARD: 3,
  VAR_CHECK: 3,
  VAR_DECISION: 3,
  HALF_TIME: 3,
  FULL_TIME: 3,
  PENALTY_AWARDED: 2,
  YELLOW_CARD: 2,
  SUBSTITUTION: 2,
  INJURY: 2,
}));

/** Ticks of match time a line of each priority holds the bar against lower ones (10 s, 5 s, none). */
const HOLD_TICKS = Object.freeze([0, 0, 100, 200]);

/** @param {any} ev */
const priorityOf = (ev) => PRIORITY[ev.type] ?? 1;

/** Ticks per match minute (20 ticks per second). */
const TICKS_PER_MINUTE = 1200;

/** @param {string} inner @param {string} [extra] */
const svg = (inner, extra = '') =>
  `<svg class="comm-svg" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"${extra}>${inner}</svg>`;

const ICON = {
  ball: svg('<circle cx="8" cy="8" r="6.5" fill="#fff" stroke="#0f172a" stroke-width="1"/><path d="M8 4.6l2.4 1.7-.9 2.8H6.5l-.9-2.8z" fill="#0f172a"/><path d="M8 1.5v3.1M10.4 6.3l3-1M9.5 9.1l1.9 2.6M6.5 9.1l-1.9 2.6M5.6 6.3l-3-1" stroke="#0f172a" stroke-width=".8"/>'),
  whistle: svg('<circle cx="6" cy="10" r="4" fill="currentColor"/><rect x="6" y="5.5" width="8.5" height="3.2" rx="1" fill="currentColor"/><circle cx="6" cy="10" r="1.4" fill="#0f172a"/>'),
  yellow: svg('<rect x="4" y="1.5" width="8" height="13" rx="1.2" fill="#facc15" stroke="#0f172a" stroke-width=".8"/>'),
  red: svg('<rect x="4" y="1.5" width="8" height="13" rx="1.2" fill="#dc2626" stroke="#fff" stroke-width=".8"/>'),
  swap: svg('<path d="M2 5h10M9 2l3 3-3 3M14 11H4M7 8l-3 3 3 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'),
  /** Substitution: a green arrow up (coming on), a red arrow down (going off). */
  subArrows: svg('<path d="M5 14V3M1.8 6.2L5 3l3.2 3.2" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 2v11M7.8 9.8L11 13l3.2-3.2" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
  glove: svg('<path d="M4 15V8L2.6 5.4a1 1 0 011.7-1L6 7V2.5a1 1 0 012 0V7V1.8a1 1 0 012 0V7V2.6a1 1 0 012 0V10a5 5 0 01-3 4.6V15z" fill="currentColor"/>'),
  post: svg('<path d="M2 15V2h12v13" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.2" fill="#fff" stroke="#0f172a" stroke-width=".7"/>'),
  flag: svg('<path d="M3 15V1.5" stroke="currentColor" stroke-width="1.6"/><path d="M3.8 2h9l-2.5 3 2.5 3h-9z" fill="#f97316"/>'),
  spot: svg('<path d="M1.5 4h13v10" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="10.5" r="2" fill="currentColor"/>'),
  target: svg('<circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="3.4" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/>'),
  boot: svg('<path d="M3 2h5v6l5.5 2.2a1.6 1.6 0 01-.6 3.1H3z" fill="currentColor"/><path d="M4 15h1.5M8 15h1.5M11.5 15H13" stroke="currentColor" stroke-width="1.3"/>'),
  board: svg('<rect x="2.5" y="2.5" width="11" height="12" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="6.5" r="1.1" fill="currentColor"/><circle cx="10" cy="6.5" r="1.1" fill="currentColor"/><circle cx="8" cy="11" r="1.1" fill="currentColor"/>'),
  clock: svg('<circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.3V8l2.6 1.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'),
  screen: svg('<rect x="1.5" y="2.5" width="13" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 14.5h5M8 11.5v3" stroke="currentColor" stroke-width="1.4"/><path d="M5 5.5l1.6 3.5L8.2 5.5M9.4 9l1.3-3.5L12 9M9.8 7.8h1.8" fill="none" stroke="currentColor" stroke-width="1"/>'),
  centre: svg('<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1v14" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/>'),
};

/**
 * Icon slot content for an event.
 * @param {any} ev
 * @returns {{kind: string, html: string}}
 */
export function commentaryIcon(ev) {
  switch (ev.type) {
    case 'GOAL':
      return { kind: 'goal', html: ICON.ball };
    case 'FOUL':
    case 'FREE_KICK':
      return { kind: 'whistle', html: ICON.whistle };
    case 'YELLOW_CARD':
      return { kind: 'yellow-card', html: ICON.yellow };
    case 'RED_CARD':
      return { kind: 'red-card', html: ICON.red };
    case 'INJURY':
      return { kind: 'injury', html: '<span class="comm-med-cross" aria-hidden="true">+</span>' };
    case 'SUBSTITUTION':
      return { kind: 'sub', html: `<span class="comm-swap" aria-hidden="true">${ICON.subArrows}</span>` };
    case 'SAVE':
      return { kind: 'save', html: ICON.glove };
    case 'SHOT':
      return ev.meta?.result === 'WOODWORK' ? { kind: 'woodwork', html: ICON.post } : { kind: 'shot', html: ICON.target };
    case 'BIG_CHANCE':
      return { kind: 'shot', html: ICON.target };
    case 'CORNER':
    case 'OFFSIDE':
      return { kind: 'flag', html: ICON.flag };
    case 'PENALTY_AWARDED':
      return { kind: 'penalty', html: ICON.spot };
    case 'ASSIST':
      return { kind: 'assist', html: ICON.boot };
    case 'FORMATION_CHANGE':
      return { kind: 'tactics', html: ICON.board };
    case 'KICK_OFF':
      return { kind: 'kick-off', html: ICON.centre };
    case 'VAR_CHECK':
    case 'VAR_DECISION':
      return { kind: 'var', html: ICON.screen };
    case 'ADDED_TIME':
    case 'HALF_TIME':
    case 'FULL_TIME':
      return { kind: 'clock', html: ICON.clock };
    default:
      return { kind: 'whistle', html: ICON.whistle };
  }
}

/**
 * Broadcast match minute for an event tick: `64'`, or `45+2'` / `90+3'` in
 * added time. `secondHalfTick` is the tick the second half began (the
 * `HALF_TIME` event), or -1 before it; without it the plain tick formula
 * `floor(tick / 1200) + 1` is used.
 * @param {number} tick
 * @param {number} [secondHalfTick]
 * @returns {string}
 */
export function matchMinuteLabel(tick, secondHalfTick = -1) {
  const t = tick > 0 ? tick : 0;
  if (secondHalfTick >= 0 && t >= secondHalfTick) {
    const m = 45 + Math.floor((t - secondHalfTick) / TICKS_PER_MINUTE) + 1;
    return m > 90 ? `90+${m - 90}'` : `${m}'`;
  }
  const m = Math.floor(t / TICKS_PER_MINUTE) + 1;
  if (secondHalfTick >= 0 && m > 45) return `45+${m - 45}'`;
  return `${m}'`;
}

/** @param {string} str */
function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class CommentaryView extends View {
  /**
   * @param {{commentator: import('../../i18n/Commentator.js').Commentator, locale: import('../../i18n/Locale.js').LocaleManager, domCap?: number}} opts
   */
  constructor({ commentator, locale, domCap = 200 }) {
    super(PARTIAL);
    this.commentator = commentator;
    this.locale = locale;
    this.domCap = domCap;
    /** @type {any[]} */
    this.events = [];
    /** @type {{matchSeed: number, teams: [any, any], players: any[], teamColors?: [{primary: string, secondary: string}, {primary: string, secondary: string}]} | null} */
    this.ctx = null;
    /** Tick the second half started (the HALF_TIME event), or -1. */
    this.secondHalfTick = -1;
    /** The line on the bar (the latest, unless a major one still holds it), or null. */
    this.shownEvent = /** @type {any} */ (null);
    /** What the bar shows now ('' for nothing yet). */
    this.renderedKey = '';
  }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    super.mount(rootEl);
    this._unsub = this.locale.onChange(() => this.#renderAll());
  }

  /** @param {{matchSeed: number, teams: [any, any], players: any[], teamColors?: [{primary: string, secondary: string}, {primary: string, secondary: string}]}} ctx */
  setContext(ctx) {
    this.ctx = ctx;
    this.events = [];
    this.secondHalfTick = -1;
    this.shownEvent = null;
    this.renderedKey = '';
    this.#renderAll();
  }

  /** @param {any[]} allEvents */
  setEvents(allEvents) {
    this.events = [];
    this.secondHalfTick = -1;
    this.shownEvent = null;
    this.renderedKey = '';
    for (const ev of allEvents) this.#add(ev);
    this.#renderAll();
  }

  /** @param {any} frame */
  update(frame) {
    if (!frame?.newEvents?.length) return;
    let added = false;
    for (const ev of frame.newEvents) added = this.#add(ev) || added;
    if (added) this.#renderAll();
  }

  /** @param {any} ev @returns {boolean} */
  #add(ev) {
    if (!IMPORTANT_TYPES.has(ev.type)) return false;
    if (ev.type === 'HALF_TIME' && this.secondHalfTick < 0 && typeof ev.tick === 'number') this.secondHalfTick = ev.tick;
    this.events.push(ev);
    if (this.events.length > this.domCap) this.events.splice(0, this.events.length - this.domCap);
    const cur = this.shownEvent;
    if (cur === null || priorityOf(ev) >= priorityOf(cur) || (ev.tick ?? 0) - (cur.tick ?? 0) >= HOLD_TICKS[priorityOf(cur)] || (ev.tick ?? 0) < (cur.tick ?? 0)) {
      this.shownEvent = ev;
    }
    return true;
  }

  /** The event on the bar (for tests), or null. */
  get shown() {
    return this.shownEvent;
  }

  /**
   * Single-line comment text for an event (without the minute prefix some
   * commentary templates carry, since the minute has its own slot).
   * @param {any} ev
   * @returns {string}
   */
  #commentFor(ev) {
    const ctx = /** @type {NonNullable<typeof this.ctx>} */ (this.ctx);
    if (ev.type === 'SUBSTITUTION') {
      const out = ev.actorIndex >= 0 ? ctx.players[ev.actorIndex] : null;
      const inIdx = ev.secondaryIndices?.[0] ?? -1;
      const incoming = inIdx >= 0 ? ctx.players[inIdx] : null;
      if (out && incoming) {
        return this.locale.t('prompts.substitutionLine', {
          in: incoming.shortName || incoming.name,
          out: out.shortName || out.name,
        });
      }
    }
    const text = this.commentator.lineFor(ev, this.locale.getLocale(), ctx);
    return text.replace(/^\s*\d+(\+\d+)?'\s*/, '').replace(/\s+/g, ' ').trim();
  }

  #renderBroadcast() {
    const bar = /** @type {HTMLElement | null} */ (this.root?.querySelector('.comm-broadcast'));
    if (!bar || !this.ctx) return;
    const ev = this.shownEvent;
    // The same line again (a lesser one was held back): nothing to redraw, and its pulse is not restarted.
    const key = ev ? `${ev.seq ?? ''}|${ev.tick}|${ev.type}|${this.locale.getLocale()}` : '';
    if (key !== '' && key === this.renderedKey) return;
    this.renderedKey = key;
    if (!ev) {
      bar.className = 'comm-broadcast is-idle';
      bar.style.removeProperty('--team-primary');
      bar.style.removeProperty('--team-secondary');
      bar.innerHTML = `<span class="comm-min">--'</span><span class="comm-icon" aria-hidden="true">${ICON.whistle}</span><span class="comm-text">${esc(this.ctx.teams[0].name)} vs ${esc(this.ctx.teams[1].name)}</span>`;
      return;
    }
    const colors = this.ctx.teamColors ?? DEFAULT_TEAM_COLORS;
    const teamIdx = ev.teamIndex === 0 || ev.teamIndex === 1 ? ev.teamIndex : -1;
    const pal = teamIdx >= 0 ? colors[teamIdx] : { primary: '#334155', secondary: '#e2e8f0' };
    const alertCls =
      ev.type === 'GOAL'
        ? ' is-goal is-flash'
        : ev.type === 'YELLOW_CARD'
          ? ' is-yellow'
          : ev.type === 'RED_CARD'
            ? ' is-red is-flash'
            : ev.type === 'INJURY'
              ? ' is-injury'
              : ev.type === 'SUBSTITUTION'
                ? ' is-sub'
                : FLASH_TYPES.has(ev.type)
                  ? ' is-flash'
                  : '';
    const icon = commentaryIcon(ev);
    const min = matchMinuteLabel(ev.tick ?? 0, this.secondHalfTick);
    const comment = this.#commentFor(ev);
    const category = commentaryCategory(ev);
    const catCls = category === 'var' ? ' is-var' : '';
    const badge = category !== null ? `<span class="comm-badge comm-badge--${category}">${esc(this.locale.t(`commentaryBadges.${category}`))}</span>` : '';

    bar.style.setProperty('--team-primary', pal.primary);
    bar.style.setProperty('--team-secondary', pal.secondary);
    bar.className = `comm-broadcast${alertCls}${catCls}${category !== null ? ' is-major' : ''}${teamIdx >= 0 ? ' has-team' : ''}`;
    if (bar.dataset) {
      bar.dataset.type = ev.type;
      bar.dataset.category = category ?? '';
    }
    bar.innerHTML =
      `<span class="comm-min">${min}</span>` +
      `<span class="comm-icon comm-icon--${icon.kind}" aria-hidden="true">${icon.html}</span>` +
      badge +
      `<span class="comm-text" title="${esc(comment)}">${ev.type === 'GOAL' ? this.#withScorer(ev, comment) : esc(comment)}</span>`;
  }

  /**
   * The goal line, escaped, with the scorer's name in bold.
   * @param {any} ev
   * @param {string} comment
   */
  #withScorer(ev, comment) {
    const text = esc(comment);
    const p = ev.actorIndex >= 0 ? this.ctx?.players?.[ev.actorIndex] : null;
    if (!p) return text;
    for (const n of [p.name, p.shortName]) {
      const e = n ? esc(n) : '';
      const at = e ? text.indexOf(e) : -1;
      if (at >= 0) return `${text.slice(0, at)}<strong class="comm-scorer">${e}</strong>${text.slice(at + e.length)}`;
    }
    return text;
  }

  #renderAll() {
    this.#renderBroadcast();
  }

  destroy() {
    this._unsub?.();
    super.destroy();
  }
}
