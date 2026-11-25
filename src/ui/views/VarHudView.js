/**
 * VAR HUD banner over the pitch (docs/designs/var.md). A VAR_CHECK shows `VAR CHECK` and what is being checked
 * (goal, penalty, possible penalty, possible red card); the VAR_DECISION replaces it with the call: an overturn's
 * own headline (`GOAL DISALLOWED`, `PENALTY`, `NO PENALTY`, `RED CARD`) or `CHECK COMPLETE` over the decision that
 * stands. The decision clears once play resumes (after at least `minDecisionMs`, at most `maxDecisionMs`).
 *
 * Driven only by the frame's released events, so the banner follows what is on screen: an Auto Highlights
 * pre-roll releases VAR_CHECK as it reaches it, and the decision is never shown before its own tick. A frame
 * going back in time (reset, seek) clears it; replays (Best Moments, tap-to-replay) show no banner.
 */
import { View } from './View.js';
import { varBanner } from '../../engine/officiating/VarSystem.js';

/** @param {string} s */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class VarHudView extends View {
  /**
   * @param {{
   *   locale: import('../../i18n/Locale.js').LocaleManager,
   *   now?: () => number,
   *   minDecisionMs?: number,
   *   maxDecisionMs?: number,
   * }} opts
   */
  constructor({ locale, now = () => performance.now(), minDecisionMs = 1800, maxDecisionMs = 6000 }) {
    super('<div class="var-hud is-hidden" role="status" aria-live="assertive"></div>');
    this.locale = locale;
    this.now = now;
    this.minDecisionMs = minDecisionMs;
    this.maxDecisionMs = maxDecisionMs;
    /** @type {null | {headline: string, detail: string, tone: string, phase: 'check' | 'decision', shownAt: number}} */
    this.banner = null;
    this.lastTick = -1;
    /** @type {string | null} what is rendered (null: nothing yet) */
    this.renderedKey = null;
    /** @type {null | (() => void)} */
    this.offLocale = null;
  }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    super.mount(rootEl);
    this.offLocale = this.locale.onChange(() => {
      this.renderedKey = null;
      this.#render();
    });
    this.#render();
  }

  /** What the banner shows now, or null (for tests). */
  get shown() {
    return this.banner === null ? null : { phase: this.banner.phase, headline: this.banner.headline, detail: this.banner.detail, tone: this.banner.tone };
  }

  /** Hides the banner. */
  clear() {
    this.banner = null;
    this.#render();
  }

  /**
   * @param {{tick?: number, playbackState?: string, newEvents?: any[], restart?: {state: string}}} frame
   */
  update(frame) {
    if (typeof frame.tick === 'number') {
      if (frame.tick < this.lastTick) this.banner = null;
      this.lastTick = frame.tick;
    }
    if (frame.playbackState === 'REPLAY') {
      this.banner = null;
      this.#render();
      return;
    }
    for (const ev of frame.newEvents ?? []) {
      const b = varBanner(ev);
      if (b !== null) this.banner = { ...b, phase: ev.type === 'VAR_CHECK' ? 'check' : 'decision', shownAt: this.now() };
    }
    if (this.banner !== null && this.banner.phase === 'decision') {
      const shownFor = this.now() - this.banner.shownAt;
      if (shownFor >= this.maxDecisionMs || (shownFor >= this.minDecisionMs && frame.restart?.state === 'IN_PLAY')) this.banner = null;
    }
    this.#render();
  }

  #render() {
    const el = /** @type {HTMLElement | null} */ (this.root?.querySelector('.var-hud') ?? null);
    if (!el) return;
    const b = this.banner;
    const key = b === null ? '' : `${b.phase}|${b.headline}|${b.detail}|${this.locale.getLocale()}`;
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    if (b === null) {
      el.className = 'var-hud is-hidden';
      el.innerHTML = '';
      return;
    }
    el.className = `var-hud is-${b.tone}`;
    if (el.dataset) el.dataset.phase = b.phase;
    el.innerHTML =
      `<span class="var-hud-badge">VAR</span>` +
      `<span class="var-hud-text"><strong class="var-hud-headline">${esc(this.locale.t(`var.${b.headline}`))}</strong>` +
      `<span class="var-hud-detail">${esc(this.locale.t(`var.${b.detail}`))}</span></span>`;
  }

  destroy() {
    this.offLocale?.();
    this.offLocale = null;
    super.destroy();
  }
}
