/**
 * Shouts panel (docs/designs/coach_shouts.md): the ten touchline shouts in a two-column grid, each with a
 * one-line hint and its cooldown; the shout in effect and its minutes left; and the side's receptiveness
 * (Quiet / Engaged / Overwhelmed). A tap sends ISSUE_SHOUT straight away (a shout is immediate, so there is no
 * confirm step). The grid is built from `config.shouts.shouts`. Disabled while playbackState === 'REPLAY'.
 */
import { View } from './View.js';
import { formatCommandError } from './ManagerView.js';
import { activeShout, shoutCooldownLeft, shoutReceptiveness } from '../../engine/tactics/Shouts.js';

const PARTIAL = `
<div class="shouts-panel">
  <div class="mgr-error is-hidden" id="sh-error" role="alert"></div>
  <div class="sh-status">
    <span class="sh-mood" id="sh-mood"></span>
    <span class="sh-active" id="sh-active"></span>
  </div>
  <div class="sh-grid" id="sh-grid"></div>
</div>
`;

/** Ticks per match minute. */
const TICKS_PER_MINUTE = 1200;

/** @param {string} s */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** @param {number} ticks */
const minutes = (ticks) => Math.max(1, Math.ceil(ticks / TICKS_PER_MINUTE));

export class ShoutsView extends View {
  /**
   * @param {{
   *   locale: import('../../i18n/Locale.js').LocaleManager,
   *   shouts: Record<string, any>,
   *   teamIndex?: number,
   *   onCommand: (cmd: {issuer: 'human', type: string, teamIndex: number, payload: Record<string, any>}) => {ok: boolean, code: string | null},
   * }} opts
   */
  constructor({ locale, shouts, teamIndex = 0, onCommand }) {
    super(PARTIAL);
    this.locale = locale;
    this.ids = Object.keys(shouts);
    this.teamIndex = teamIndex;
    this.onCommand = onCommand;
    this.errorMsg = '';
    /** @type {any} */
    this.lastState = null;
    this.lastPlaybackState = 'PAUSED';
    this._lastRenderKey = '';
  }

  /** Whether shouts can be given now (a match in progress, not a replay). */
  get usable() {
    const s = this.lastState;
    return s !== null && this.lastPlaybackState !== 'REPLAY' && this.lastPlaybackState !== 'FULL_TIME' && s.restart.state !== 'FULL_TIME';
  }

  /**
   * Sends shout `id`.
   * @param {string} id
   */
  shout(id) {
    if (!this.usable || !this.ids.includes(id)) return;
    const res = this.onCommand({ issuer: 'human', type: 'ISSUE_SHOUT', teamIndex: this.teamIndex, payload: { shout: id } });
    this.errorMsg = formatCommandError(res, this.locale) ?? '';
    this._lastRenderKey = '';
    this.#render();
  }

  /** Clears a shown error (closing the panel). */
  dismiss() {
    this.errorMsg = '';
    this._lastRenderKey = '';
    this.#render();
  }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    super.mount(rootEl);
    rootEl.addEventListener('click', (ev) => {
      const el = /** @type {HTMLElement | null} */ (ev.target);
      const btn = el?.closest?.('[data-shout]');
      if (btn) this.shout(btn.getAttribute('data-shout') ?? '');
    });
    this._unsub = this.locale.onChange(() => {
      this._lastRenderKey = '';
      this.#render();
    });
    this.#render();
  }

  /** @param {{state: any, playbackState: string}} frame */
  update(frame) {
    this.lastState = frame.state;
    this.lastPlaybackState = frame.playbackState;
    this.#render();
  }

  #render() {
    if (!this.root) return;
    /** @type {(k: string, vars?: Record<string, string | number>) => string} */
    const t = (k, vars) => this.locale.t(k, vars);
    const s = this.lastState;
    const usable = this.usable;
    const pending = s !== null && s.pendingCommands.some((/** @type {any} */ c) => c.type === 'ISSUE_SHOUT' && c.teamIndex === this.teamIndex);
    const cooldowns = this.ids.map((id) => (s === null ? 0 : minutesLeft(shoutCooldownLeft(s, this.teamIndex, id))));
    const active = s === null ? null : activeShout(s, this.teamIndex);
    const mood = s === null || s.config?.shouts === undefined ? 'engaged' : shoutReceptiveness(s, this.teamIndex);
    const activeKey = active === null ? '' : `${active.id}:${minutes(active.ticksLeft)}`;
    const key = [this.locale.getLocale(), usable ? 1 : 0, pending ? 1 : 0, cooldowns.join(','), activeKey, mood, this.errorMsg].join('|');
    if (key === this._lastRenderKey) return;
    this._lastRenderKey = key;
    this.root.classList.toggle('is-disabled', !usable);

    const errEl = this.root.querySelector('#sh-error');
    if (errEl) {
      errEl.textContent = this.errorMsg;
      errEl.classList.toggle('is-hidden', !this.errorMsg);
    }
    const moodEl = this.root.querySelector('#sh-mood');
    if (moodEl) {
      moodEl.textContent = `${t('shouts.receptiveness')}: ${t(`shouts.${mood}`)}`;
      moodEl.setAttribute('title', t(`shouts.${mood}Hint`));
      moodEl.className = `sh-mood is-${mood}`;
    }
    const activeEl = this.root.querySelector('#sh-active');
    if (activeEl) {
      activeEl.textContent = active === null ? t('shouts.none') : t('shouts.active', { shout: t(`shouts.${active.id}`), minutes: minutes(active.ticksLeft) });
    }
    const gridEl = this.root.querySelector('#sh-grid');
    if (gridEl) {
      gridEl.innerHTML = this.ids
        .map((id, k) => {
          const cd = cooldowns[k];
          const off = !usable || pending || cd > 0;
          const badge = cd > 0 ? `<span class="sh-cd">${esc(t('shouts.cooldown', { minutes: cd }))}</span>` : '';
          const on = active !== null && active.id === id ? ' is-active' : '';
          return (
            `<button type="button" class="sh-btn${on}" data-shout="${id}"${off ? ' disabled' : ''}>` +
            `<span class="sh-label">${esc(t(`shouts.${id}`))}${badge}</span>` +
            `<span class="sh-hint">${esc(t(`shouts.${id}Hint`))}</span></button>`
          );
        })
        .join('');
    }
  }

  destroy() {
    this._unsub?.();
    super.destroy();
  }
}

/** Whole match minutes left of a cooldown (0 when none). @param {number} ticks */
function minutesLeft(ticks) {
  return ticks > 0 ? minutes(ticks) : 0;
}
