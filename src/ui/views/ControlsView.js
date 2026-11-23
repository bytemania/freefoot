/**
 * Match playback controls view (design §14–15, item 65):
 * Play / Pause + a compact FM-style `Auto Highlights` speed icon pinned to the
 * bar's edge (`>>` fast-forwarding calm play at 60x, `>` live at 1x, `||`
 * paused; the full wording lives in the tooltip / accessible label only),
 * Stats, Manager, and Continue controls (no manual speed slider or
 * continuous full-match mode toggle).
 */
import { View } from './View.js';

/**
 * The speed icon for a playback frame (pure; used by ControlsView and tests).
 * @param {{playbackState?: string, mode?: string, autoPacing?: string}} frame
 * @returns {{icon: '>>' | '>' | '||', kind: 'fast' | 'live' | 'paused', labelKey: string}}
 */
export function pacingIndicator(frame) {
  const moving = frame.playbackState === 'FULL_MATCH' || frame.playbackState === 'FAST_FORWARD' || frame.playbackState === 'REPLAY';
  if (!moving) return { icon: '||', kind: 'paused', labelKey: 'buttons.pacingPaused' };
  const fast = frame.playbackState === 'FAST_FORWARD' || (frame.mode === 'auto_highlights' && frame.autoPacing === 'FAST');
  return fast ? { icon: '>>', kind: 'fast', labelKey: 'buttons.pacingFast' } : { icon: '>', kind: 'live', labelKey: 'buttons.pacingLive' };
}

const PARTIAL = `
<div class="ctrl-bar">
  <div class="ctrl-row">
    <button type="button" class="btn btn-primary" id="ctrl-play">Play</button>
    <button type="button" class="btn" id="ctrl-stats">Stats</button>
    <button type="button" class="btn" id="ctrl-manager">Manager</button>
    <button type="button" class="btn btn-primary is-hidden" id="ctrl-continue">Continue</button>
    <span class="pacing-badge is-paused" id="ctrl-pacing" role="status" aria-live="polite">||</span>
  </div>
</div>
`;

export class ControlsView extends View {
  /**
   * @param {{
   *   locale: import('../../i18n/Locale.js').LocaleManager,
   *   onTogglePlay: () => void,
   *   onContinue: () => void,
   *   onOpenStats: () => void,
   *   onOpenManager: () => void,
   * }} opts
   */
  constructor(opts) {
    super(PARTIAL);
    this.opts = opts;
    this.locale = opts.locale;
    this.lastFrame = null;
  }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    super.mount(rootEl);
    rootEl.querySelector('#ctrl-play')?.addEventListener('click', () => this.opts.onTogglePlay());
    rootEl.querySelector('#ctrl-continue')?.addEventListener('click', () => this.opts.onContinue());
    rootEl.querySelector('#ctrl-stats')?.addEventListener('click', () => this.opts.onOpenStats());
    rootEl.querySelector('#ctrl-manager')?.addEventListener('click', () => this.opts.onOpenManager());
    this.#renderLabels();
    this._unsub = this.locale.onChange(() => this.#renderLabels());
  }

  #renderLabels() {
    if (!this.root) return;
    const t = (/** @type {string} */ k) => this.locale.t(k);
    const statsBtn = this.root.querySelector('#ctrl-stats');
    const mgrBtn = this.root.querySelector('#ctrl-manager');
    if (statsBtn) statsBtn.textContent = t('panels.stats');
    if (mgrBtn) mgrBtn.textContent = t('panels.manager');
    if (this.lastFrame) this.update(this.lastFrame);
  }

  /** @param {any} frame */
  update(frame) {
    this.lastFrame = frame;
    if (!this.root) return;
    const t = (/** @type {string} */ k) => this.locale.t(k);
    const playBtn = this.root.querySelector('#ctrl-play');
    const pacingBadge = this.root.querySelector('#ctrl-pacing');
    const contBtn = this.root.querySelector('#ctrl-continue');

    const playing = frame.playbackState === 'FULL_MATCH' || frame.playbackState === 'FAST_FORWARD';
    if (playBtn) playBtn.textContent = playing ? t('buttons.pause') : t('buttons.play');

    if (pacingBadge) {
      const ind = pacingIndicator(frame);
      pacingBadge.classList.toggle('is-fast', ind.kind === 'fast');
      pacingBadge.classList.toggle('is-live', ind.kind === 'live');
      pacingBadge.classList.toggle('is-paused', ind.kind === 'paused');
      pacingBadge.textContent = ind.icon;
      const label = t(ind.labelKey);
      pacingBadge.setAttribute('title', label);
      pacingBadge.setAttribute('aria-label', label);
    }

    if (contBtn) {
      const showCont = frame.playbackState === 'PAUSED_HIGHLIGHT' || frame.playbackState === 'HALF_TIME';
      contBtn.classList.toggle('is-hidden', !showCont);
      if (frame.playbackState === 'PAUSED_HIGHLIGHT' && frame.countdownRemaining > 0) {
        contBtn.textContent = `${t('buttons.continue')} (${Math.ceil(frame.countdownRemaining)}s)`;
      } else {
        contBtn.textContent = t('buttons.continue');
      }
    }
  }

  destroy() {
    this._unsub?.();
    super.destroy();
  }
}
