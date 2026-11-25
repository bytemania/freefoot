/**
 * Match playback controls view (design §14–15, item 65):
 * icon-only Coach (tactics board) and Stats (bar chart) buttons with localized
 * `aria-label` / `title`, Continue, and, pinned to the bar's right edge, one
 * compact Play / Pause button: `>` while paused (before kick-off, at a stop,
 * at half-time) to play or resume, `||` while playing to pause. While playing
 * it is tinted by the Auto Highlights pacing (amber fast-forwarding calm play,
 * green live at 1x); the localized label and tooltip carry the wording. No
 * manual speed slider, separate speed badge or full-match mode toggle.
 */
import { View } from './View.js';

/** Tactics board (formation dots on a pitch) icon for the Coach button. */
export const COACH_ICON =
  '<svg class="ctrl-icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">' +
  '<rect x="2" y="2.5" width="16" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
  '<path d="M2 10h16" stroke="currentColor" stroke-width="1.1" opacity=".6"/>' +
  '<circle cx="10" cy="10" r="2.2" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".6"/>' +
  '<circle cx="6" cy="6" r="1.4" fill="currentColor"/><circle cx="14" cy="6" r="1.4" fill="currentColor"/>' +
  '<circle cx="6.5" cy="14" r="1.4" fill="currentColor"/><circle cx="13.5" cy="14" r="1.4" fill="currentColor"/>' +
  '<path d="M7.5 6.5l5 6" stroke="currentColor" stroke-width="1.2" stroke-dasharray="1.6 1.4"/>' +
  '</svg>';

/** Bar chart icon for the Stats button. */
export const STATS_ICON =
  '<svg class="ctrl-icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">' +
  '<path d="M2.5 17.5h15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
  '<rect x="4" y="10" width="3" height="6" rx=".6" fill="currentColor"/>' +
  '<rect x="8.5" y="5" width="3" height="11" rx=".6" fill="currentColor"/>' +
  '<rect x="13" y="7.5" width="3" height="8.5" rx=".6" fill="currentColor"/>' +
  '</svg>';

/**
 * The single Play / Pause button for a playback frame (pure; used by ControlsView and tests).
 * `kind` is `'paused'` when the button plays (shows `>`), otherwise the pacing it is playing at.
 * @param {{playbackState?: string, mode?: string, autoPacing?: string}} frame
 * @returns {{icon: '>' | '||', kind: 'paused' | 'fast' | 'live', labelKey: 'buttons.pause' | 'buttons.play'}}
 */
export function playPauseIndicator(frame) {
  const playing = frame.playbackState === 'FULL_MATCH' || frame.playbackState === 'FAST_FORWARD';
  if (!playing) return { icon: '>', kind: 'paused', labelKey: 'buttons.play' };
  const fast = frame.playbackState === 'FAST_FORWARD' || (frame.mode === 'auto_highlights' && frame.autoPacing === 'FAST');
  return { icon: '||', kind: fast ? 'fast' : 'live', labelKey: 'buttons.pause' };
}

const PARTIAL = `
<div class="ctrl-bar">
  <div class="ctrl-row">
    <button type="button" class="btn btn-icon" id="ctrl-stats" aria-label="Match statistics" title="Match statistics">${STATS_ICON}</button>
    <button type="button" class="btn btn-icon" id="ctrl-manager" aria-label="Coach &amp; tactics" title="Coach &amp; tactics">${COACH_ICON}</button>
    <button type="button" class="btn btn-primary is-hidden" id="ctrl-continue">Continue</button>
    <div class="ctrl-transport">
      <button type="button" class="pacing-badge is-paused" id="ctrl-play" aria-label="Play" title="Play">&gt;</button>
    </div>
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
    // Icon-only buttons: the localized name lives in aria-label and the tooltip.
    if (statsBtn) {
      statsBtn.setAttribute('aria-label', t('buttons.statsAria'));
      statsBtn.setAttribute('title', t('buttons.statsAria'));
    }
    if (mgrBtn) {
      mgrBtn.setAttribute('aria-label', t('buttons.coachAria'));
      mgrBtn.setAttribute('title', t('buttons.coachAria'));
    }
    this.update(this.lastFrame ?? { playbackState: 'PAUSED' });
  }

  /** @param {any} frame */
  update(frame) {
    this.lastFrame = frame;
    if (!this.root) return;
    const t = (/** @type {string} */ k) => this.locale.t(k);
    const playBtn = this.root.querySelector('#ctrl-play');
    const contBtn = this.root.querySelector('#ctrl-continue');

    if (playBtn) {
      const pp = playPauseIndicator(frame);
      playBtn.textContent = pp.icon;
      playBtn.classList.toggle('is-paused', pp.kind === 'paused');
      playBtn.classList.toggle('is-fast', pp.kind === 'fast');
      playBtn.classList.toggle('is-live', pp.kind === 'live');
      playBtn.setAttribute('aria-label', t(pp.labelKey));
      playBtn.setAttribute('title', t(pp.labelKey));
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
