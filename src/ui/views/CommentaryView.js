/**
 * Scrolling commentary feed (design §15–16, item 66).
 * Renders newest-first using `Commentator`, re-renders the entire feed on
 * locale change, and caps the DOM at `commentaryDomCap` (200) lines.
 */
import { View } from './View.js';

const PARTIAL = `<div class="commentary-feed" aria-live="polite"></div>`;

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
    /** @type {{matchSeed: number, teams: [any, any], players: any[]} | null} */
    this.ctx = null;
  }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    super.mount(rootEl);
    this._unsub = this.locale.onChange(() => this.#renderAll());
  }

  /** @param {{matchSeed: number, teams: [any, any], players: any[]}} ctx */
  setContext(ctx) {
    this.ctx = ctx;
    this.events = [];
    this.#renderAll();
  }

  /** @param {any[]} allEvents */
  setEvents(allEvents) {
    this.events = allEvents.filter((e) => IMPORTANT_TYPES.has(e.type));
    this.#renderAll();
  }

  /** @param {any} frame */
  update(frame) {
    if (!frame?.newEvents?.length) return;
    let added = false;
    for (const ev of frame.newEvents) {
      if (IMPORTANT_TYPES.has(ev.type)) {
        this.events.push(ev);
        added = true;
      }
    }
    if (added) this.#renderAll();
  }

  #renderAll() {
    const feed = this.root?.querySelector('.commentary-feed');
    if (!feed || !this.ctx) return;
    const loc = this.locale.getLocale();
    const start = Math.max(0, this.events.length - this.domCap);
    const lines = [];
    for (let i = this.events.length - 1; i >= start; i--) {
      const ev = this.events[i];
      const text = this.commentator.lineFor(ev, loc, this.ctx);
      const hi = ev.type === 'GOAL' || ev.type === 'RED_CARD' || ev.type === 'PENALTY_AWARDED' ? ' is-key' : '';
      lines.push(`<div class="comm-line${hi}">${text}</div>`);
    }
    feed.innerHTML = lines.join('');
  }

  destroy() {
    this._unsub?.();
    super.destroy();
  }
}
