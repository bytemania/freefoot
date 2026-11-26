/**
 * Match statistics comparison bars view (design §15, item 67).
 *
 * Live during the match: a header with the current match minute and half
 * (`34' · H1`, `45+2' · H1` in added time) above localized comparison bars.
 * It only touches the DOM while visible (the stats drawer is open) and when
 * the minute, the locale or a displayed value changed; becoming visible
 * renders the latest frame straight away.
 */
import { View } from './View.js';
import { matchMinuteLabel } from '../../shared/matchMinute.js';

export { matchMinuteLabel };

const PARTIAL = `<div class="stats-panel"><div class="stats-minute muted" aria-live="off"></div><div class="stats-rows"></div></div>`;

/** Displayed rows: the stats key, its `stats.*` ui-strings key and decimals. */
export const STATS_ROWS = [
  { key: 'goals', labelKey: 'stats.goals', dec: 0 },
  { key: 'possessionPct', labelKey: 'stats.possessionPct', dec: 0 },
  { key: 'shots', labelKey: 'stats.shots', dec: 0 },
  { key: 'shotsOnTarget', labelKey: 'stats.shotsOnTarget', dec: 0 },
  { key: 'passes', labelKey: 'stats.passes', dec: 0 },
  { key: 'passCompletionPct', labelKey: 'stats.passCompletionPct', dec: 0 },
  { key: 'foulsCommitted', labelKey: 'stats.fouls', dec: 0 },
  { key: 'yellowCards', labelKey: 'stats.yellowCards', dec: 0 },
  { key: 'redCards', labelKey: 'stats.redCards', dec: 0 },
  { key: 'distanceKm', labelKey: 'stats.distanceKm', dec: 1 },
];

export class StatsView extends View {
  /**
   * @param {{locale: import('../../i18n/Locale.js').LocaleManager}} opts
   */
  constructor({ locale }) {
    super(PARTIAL);
    this.locale = locale;
    this.visible = false;
    /** @type {any} */
    this.lastFrame = null;
    /** Signature of what is on screen; '' forces the next render. */
    this.renderedSig = '';
  }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    super.mount(rootEl);
    this._unsub = this.locale.onChange(() => this.#render(true));
  }

  /**
   * Shows or hides the live view (the stats drawer opening or closing).
   * Becoming visible renders the latest frame at once.
   * @param {boolean} visible
   */
  setVisible(visible) {
    this.visible = visible;
    if (visible) this.#render(true);
  }

  /**
   * @param {any} frame a playback frame with `stats`, plus the live
   *   `clockSeconds` and `half` of the match clock
   */
  update(frame) {
    this.lastFrame = frame;
    this.#render(false);
  }

  /** @param {boolean} force */
  #render(force) {
    const frame = this.lastFrame;
    if (!this.root || !this.visible || !frame?.stats) return;
    const h = frame.stats.home;
    const a = frame.stats.away;
    const minute = Number.isFinite(frame.clockSeconds) && frame.half ? matchMinuteLabel(frame.clockSeconds, frame.half) : '';
    const values = STATS_ROWS.map((r) => [Number(h[r.key] ?? 0), Number(a[r.key] ?? 0)]);
    const sig = `${this.locale.getLocale()}|${minute}|${frame.half}|${values.map(([hv, av], i) => `${hv.toFixed(STATS_ROWS[i].dec)}:${av.toFixed(STATS_ROWS[i].dec)}`).join(',')}`;
    if (!force && sig === this.renderedSig) return;
    this.renderedSig = sig;

    const t = (/** @type {string} */ k) => this.locale.t(k);
    const minuteEl = this.root.querySelector('.stats-minute');
    if (minuteEl) minuteEl.textContent = minute ? this.locale.t('stats.header', { minute, half: frame.half }) : '';
    const rowsEl = this.root.querySelector('.stats-rows');
    if (!rowsEl) return;
    rowsEl.innerHTML = STATS_ROWS.map((r, i) => {
      const [hv, av] = values[i];
      const tot = hv + av;
      const pct = tot > 0 ? (100 * hv) / tot : 50;
      return `<div class="stat-row">
        <div class="stat-nums"><span>${hv.toFixed(r.dec)}</span><span class="muted">${t(r.labelKey)}</span><span>${av.toFixed(r.dec)}</span></div>
        <div class="stat-bar"><div class="stat-fill-home" style="width:${pct.toFixed(1)}%"></div></div>
      </div>`;
    }).join('');
  }

  destroy() {
    this._unsub?.();
    super.destroy();
  }
}
