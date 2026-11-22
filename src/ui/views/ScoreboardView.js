/**
 * Scoreboard view (design §15, item 63): team names, score, clock, half,
 * added-time badge, and PT/EN language toggle.
 */
import { View } from './View.js';

const PARTIAL = `
<div class="sb-bar">
  <div class="sb-team sb-home"><span class="sb-name" id="sb-home-name">Home</span></div>
  <div class="sb-center">
    <div class="sb-score" id="sb-score">0 - 0</div>
    <div class="sb-clock" id="sb-clock">00:00 · H1</div>
  </div>
  <div class="sb-team sb-away"><span class="sb-name" id="sb-away-name">Away</span></div>
  <button type="button" class="btn btn-sm sb-lang" id="sb-lang-btn">PT / EN</button>
</div>
`;

export class ScoreboardView extends View {
  /**
   * @param {{locale: import('../../i18n/Locale.js').LocaleManager, homeName: string, awayName: string}} opts
   */
  constructor({ locale, homeName, awayName }) {
    super(PARTIAL);
    this.locale = locale;
    this.homeName = homeName;
    this.awayName = awayName;
  }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    super.mount(rootEl);
    this.setTeams(this.homeName, this.awayName);
    const btn = rootEl.querySelector('#sb-lang-btn');
    btn?.addEventListener('click', () => this.locale.toggle());
    this.#updateLangLabel();
    this._unsub = this.locale.onChange(() => this.#updateLangLabel());
  }

  /** @param {string} home @param {string} away */
  setTeams(home, away) {
    this.homeName = home;
    this.awayName = away;
    const h = this.root?.querySelector('#sb-home-name');
    const a = this.root?.querySelector('#sb-away-name');
    if (h) h.textContent = home;
    if (a) a.textContent = away;
  }

  #updateLangLabel() {
    const btn = this.root?.querySelector('#sb-lang-btn');
    if (btn) btn.textContent = this.locale.getLocale() === 'pt-PT' ? 'PT' : 'EN';
  }

  /** @param {any} frame */
  update(frame) {
    if (!this.root || !frame?.renderSnapshot) return;
    const snap = frame.renderSnapshot;
    const hScore = snap[1];
    const aScore = snap[2];
    const secs = Math.floor(snap[3]);
    const half = snap[4];
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    const added = frame.addedMinutes > 0 ? ` +${frame.addedMinutes}'` : '';
    const scoreEl = this.root.querySelector('#sb-score');
    const clockEl = this.root.querySelector('#sb-clock');
    if (scoreEl) scoreEl.textContent = `${hScore} - ${aScore}`;
    if (clockEl) clockEl.textContent = `${mm}:${ss}${added} · H${half}`;
  }

  destroy() {
    this._unsub?.();
    super.destroy();
  }
}
