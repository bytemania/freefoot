/**
 * Match playback controls view (design §14–15, item 65):
 * speed slider with snap points (0, 1, 2, 5, 10, 30, 60), Full Match / Best
 * Moments toggle, Continue + countdown in PAUSED_HIGHLIGHT, and drawer/repro triggers.
 */
import { View } from './View.js';

const SPEED_SNAPS = [0, 1, 2, 5, 10, 30, 60];

const PARTIAL = `
<div class="ctrl-bar">
  <div class="ctrl-row">
    <button type="button" class="btn btn-primary" id="ctrl-play">Play</button>
    <button type="button" class="btn" id="ctrl-mode">Full match</button>
    <label class="ctrl-speed-wrap">
      <span id="ctrl-speed-label">1x</span>
      <input type="range" id="ctrl-speed" min="0" max="6" step="1" value="1" />
    </label>
  </div>
  <div class="ctrl-row ctrl-actions">
    <button type="button" class="btn" id="ctrl-stats">Stats</button>
    <button type="button" class="btn" id="ctrl-manager">Manager</button>
    <button type="button" class="btn" id="ctrl-repro">Repro</button>
    <button type="button" class="btn btn-primary is-hidden" id="ctrl-continue">Continue</button>
  </div>
</div>
`;

export class ControlsView extends View {
  /**
   * @param {{
   *   locale: import('../../i18n/Locale.js').LocaleManager,
   *   onTogglePlay: () => void,
   *   onSpeedChange: (speed: number) => void,
   *   onToggleMode: () => void,
   *   onContinue: () => void,
   *   onOpenStats: () => void,
   *   onOpenManager: () => void,
   *   onCopyRepro: () => void,
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
    rootEl.querySelector('#ctrl-mode')?.addEventListener('click', () => this.opts.onToggleMode());
    rootEl.querySelector('#ctrl-continue')?.addEventListener('click', () => this.opts.onContinue());
    rootEl.querySelector('#ctrl-stats')?.addEventListener('click', () => this.opts.onOpenStats());
    rootEl.querySelector('#ctrl-manager')?.addEventListener('click', () => this.opts.onOpenManager());
    rootEl.querySelector('#ctrl-repro')?.addEventListener('click', () => this.opts.onCopyRepro());
    const slider = /** @type {HTMLInputElement | null} */ (rootEl.querySelector('#ctrl-speed'));
    slider?.addEventListener('input', () => {
      const sp = SPEED_SNAPS[Number(slider.value)] ?? 1;
      const lbl = rootEl.querySelector('#ctrl-speed-label');
      if (lbl) lbl.textContent = `${sp}x`;
      this.opts.onSpeedChange(sp);
    });
    this.#renderLabels();
    this._unsub = this.locale.onChange(() => this.#renderLabels());
  }

  #renderLabels() {
    if (!this.root) return;
    const t = (/** @type {string} */ k) => this.locale.t(k);
    const statsBtn = this.root.querySelector('#ctrl-stats');
    const mgrBtn = this.root.querySelector('#ctrl-manager');
    const reproBtn = this.root.querySelector('#ctrl-repro');
    if (statsBtn) statsBtn.textContent = t('panels.stats');
    if (mgrBtn) mgrBtn.textContent = t('panels.manager');
    if (reproBtn) reproBtn.textContent = t('buttons.copyRepro');
    if (this.lastFrame) this.update(this.lastFrame);
  }

  /** @param {any} frame */
  update(frame) {
    this.lastFrame = frame;
    if (!this.root) return;
    const t = (/** @type {string} */ k) => this.locale.t(k);
    const playBtn = this.root.querySelector('#ctrl-play');
    const modeBtn = this.root.querySelector('#ctrl-mode');
    const contBtn = this.root.querySelector('#ctrl-continue');
    const slider = /** @type {HTMLInputElement | null} */ (this.root.querySelector('#ctrl-speed'));
    const speedLbl = this.root.querySelector('#ctrl-speed-label');

    const playing = frame.playbackState === 'FULL_MATCH' || frame.playbackState === 'FAST_FORWARD';
    if (playBtn) playBtn.textContent = playing ? t('buttons.pause') : t('buttons.play');
    if (modeBtn) modeBtn.textContent = frame.mode === 'best_moments' ? t('buttons.fastForward') : t('buttons.fullMatch');
    if (slider) {
      slider.disabled = frame.playbackState === 'FAST_FORWARD' || frame.playbackState === 'REPLAY';
    }
    if (speedLbl) speedLbl.textContent = `${frame.speed}x`;

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
