/**
 * Single-line top broadcast commentary bar (design §15–16, item 66).
 * Displays only the latest match commentary line styled with the acting team's
 * kit colors and a blink pulse on `GOAL`, `RED_CARD`, or `PENALTY_AWARDED`.
 */
import { View } from './View.js';

const PARTIAL = `<div class="comm-broadcast" aria-live="polite"></div>`;

const DEFAULT_TEAM_COLORS = [
  { primary: '#2563eb', secondary: '#dbeafe' },
  { primary: '#dc2626', secondary: '#fee2e2' },
];

const FLASH_TYPES = new Set(['GOAL', 'RED_CARD', 'PENALTY_AWARDED']);

const IMPORTANT_TYPES = new Set([
  'GOAL',
  'ASSIST',
  'SHOT',
  'BIG_CHANCE',
  'SAVE',
  'PENALTY_AWARDED',
  'FOUL',
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
]);

/** @param {string} str */
function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    /** @type {[number, number]} */
    this.score = [0, 0];
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
    this.score = [0, 0];
    this.#renderAll();
  }

  /** @param {any[]} allEvents @param {[number, number]} [score] */
  setEvents(allEvents, score) {
    this.events = allEvents.filter((e) => IMPORTANT_TYPES.has(e.type));
    if (score) this.score = [score[0], score[1]];
    this.#renderAll();
  }

  /** @param {any} frame */
  update(frame) {
    if (Array.isArray(frame?.score)) {
      this.score = [frame.score[0], frame.score[1]];
    }
    if (!frame?.newEvents?.length) {
      if (Array.isArray(frame?.score)) this.#renderBroadcast();
      return;
    }
    let added = false;
    for (const ev of frame.newEvents) {
      if (IMPORTANT_TYPES.has(ev.type)) {
        this.events.push(ev);
        added = true;
      }
    }
    if (added) this.#renderAll();
  }

  #renderBroadcast() {
    const bar = /** @type {HTMLElement | null} */ (this.root?.querySelector('.comm-broadcast'));
    if (!bar || !this.ctx) return;
    const ev = this.events[this.events.length - 1];
    if (!ev) {
      bar.className = 'comm-broadcast is-idle';
      bar.style.removeProperty('--team-primary');
      bar.style.removeProperty('--team-secondary');
      bar.innerHTML = `<span class="comm-badge">--'</span><span class="comm-text">${esc(this.ctx.teams[0].name)} vs ${esc(this.ctx.teams[1].name)}</span><span class="comm-score">${this.score[0]} - ${this.score[1]}</span>`;
      return;
    }
    const loc = this.locale.getLocale();
    const text = this.commentator.lineFor(ev, loc, this.ctx);
    const colors = this.ctx.teamColors ?? DEFAULT_TEAM_COLORS;
    const teamIdx = ev.teamIndex === 0 || ev.teamIndex === 1 ? ev.teamIndex : -1;
    const pal = teamIdx >= 0 ? colors[teamIdx] : { primary: '#334155', secondary: '#e2e8f0' };
    const isFlash = FLASH_TYPES.has(ev.type);
    const alertCls =
      ev.type === 'GOAL'
        ? ' is-goal is-flash'
        : ev.type === 'YELLOW_CARD'
          ? ' is-yellow'
          : ev.type === 'RED_CARD'
            ? ' is-red is-flash'
            : ev.type === 'INJURY'
              ? ' is-injury'
              : isFlash
                ? ' is-flash'
                : '';
    const iconHtml = ev.type === 'INJURY' ? '<span class="comm-med-cross" aria-hidden="true">+</span>' : '';
    const actor = ev.actorIndex >= 0 ? this.ctx.players[ev.actorIndex] : null;
    const actorShort = actor?.shortName ?? '';
    const min = Math.max(1, Math.floor((ev.clockSeconds ?? 0) / 60) + 1);

    bar.style.setProperty('--team-primary', pal.primary);
    bar.style.setProperty('--team-secondary', pal.secondary);
    bar.className = `comm-broadcast${alertCls}${teamIdx >= 0 ? ' has-team' : ''}`;
    bar.innerHTML = `
      <span class="comm-badge">${min}'</span>
      ${iconHtml}
      ${actorShort ? `<span class="comm-actor">${esc(actorShort)}</span>` : ''}
      <span class="comm-text">${esc(text)}</span>
      <span class="comm-score">${this.score[0]} - ${this.score[1]}</span>
    `;
  }

  #renderAll() {
    this.#renderBroadcast();
  }

  destroy() {
    this._unsub?.();
    super.destroy();
  }
}
