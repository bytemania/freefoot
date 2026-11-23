/**
 * Match playback controls view (design §14–15, item 65):
 * icon-only Coach (tactics board) and Stats (bar chart) buttons with localized
 * `aria-label` / `title`, Continue, and, pinned to the bar's right edge, the
 * compact FM-style `Auto Highlights` speed badge (`>>` fast-forwarding calm
 * play at 60x, `>` live at 1x; dimmed while paused, showing the speed play
 * resumes at, so it never shows a pause glyph; the full wording lives in the
 * tooltip / accessible label only) with the Play / Pause button right beside
 * it (`||` while playing, to pause; `|>` while paused, to play; localized
 * `aria-label` / `title`). The badge is a button: tapping it replays the
 * latest moments (and tapping again skips that replay). No manual speed
 * slider or continuous full-match mode toggle.
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
 * The Play / Pause button for a playback frame (pure; used by ControlsView and tests).
 * @param {{playbackState?: string}} frame
 * @returns {{icon: '||' | '|>', labelKey: 'buttons.pause' | 'buttons.play'}}
 */
export function playPauseIndicator(frame) {
  const playing = frame.playbackState === 'FULL_MATCH' || frame.playbackState === 'FAST_FORWARD';
  return playing ? { icon: '||', labelKey: 'buttons.pause' } : { icon: '|>', labelKey: 'buttons.play' };
}

/**
 * The speed icon for a playback frame (pure; used by ControlsView and tests).
 * The badge only ever shows a speed (`>>` or `>`), never a pause glyph: the
 * Play / Pause toggle beside it is the one control that shows `||` / `|>`.
 * While paused it shows the speed play will resume at, with `kind: 'paused'`
 * (dimmed by `.is-paused`) and the resume speed's label in `resumeLabelKey`.
 * @param {{playbackState?: string, mode?: string, autoPacing?: string}} frame
 * @returns {{
 *   icon: '>>' | '>',
 *   kind: 'fast' | 'live' | 'paused',
 *   labelKey: 'buttons.pacingFast' | 'buttons.pacingLive' | 'buttons.pacingPaused',
 *   resumeLabelKey: 'buttons.pacingFast' | 'buttons.pacingLive',
 * }}
 */
export function pacingIndicator(frame) {
  const moving = frame.playbackState === 'FULL_MATCH' || frame.playbackState === 'FAST_FORWARD' || frame.playbackState === 'REPLAY';
  const fast = frame.playbackState === 'FAST_FORWARD' || (frame.mode === 'auto_highlights' && frame.autoPacing === 'FAST');
  const icon = fast ? '>>' : '>';
  const resumeLabelKey = fast ? 'buttons.pacingFast' : 'buttons.pacingLive';
  if (!moving) return { icon, kind: 'paused', labelKey: 'buttons.pacingPaused', resumeLabelKey };
  return { icon, kind: fast ? 'fast' : 'live', labelKey: resumeLabelKey, resumeLabelKey };
}

const PARTIAL = `
<div class="ctrl-bar">
  <div class="ctrl-row">
    <button type="button" class="btn btn-icon" id="ctrl-stats" aria-label="Match statistics" title="Match statistics">${STATS_ICON}</button>
    <button type="button" class="btn btn-icon" id="ctrl-manager" aria-label="Coach &amp; tactics" title="Coach &amp; tactics">${COACH_ICON}</button>
    <button type="button" class="btn btn-primary is-hidden" id="ctrl-continue">Continue</button>
    <div class="ctrl-transport">
      <button type="button" class="pacing-badge is-paused" id="ctrl-pacing" aria-live="polite">&gt;</button>
      <button type="button" class="btn btn-primary btn-playpause" id="ctrl-play" aria-label="Play" title="Play">|&gt;</button>
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
   *   onReplay?: () => void,
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
    rootEl.querySelector('#ctrl-pacing')?.addEventListener('click', () => this.opts.onReplay?.());
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
    const pacingBadge = this.root.querySelector('#ctrl-pacing');
    const contBtn = this.root.querySelector('#ctrl-continue');

    if (playBtn) {
      const pp = playPauseIndicator(frame);
      playBtn.textContent = pp.icon;
      playBtn.setAttribute('aria-label', t(pp.labelKey));
      playBtn.setAttribute('title', t(pp.labelKey));
    }

    if (pacingBadge) {
      const ind = pacingIndicator(frame);
      pacingBadge.classList.toggle('is-fast', ind.kind === 'fast');
      pacingBadge.classList.toggle('is-live', ind.kind === 'live');
      pacingBadge.classList.toggle('is-paused', ind.kind === 'paused');
      pacingBadge.textContent = ind.icon;
      const hint = t(frame.playbackState === 'REPLAY' ? 'buttons.replaySkip' : 'buttons.replayHint');
      const speed = ind.kind === 'paused' ? `${t(ind.labelKey)} · ${t(ind.resumeLabelKey)}` : t(ind.labelKey);
      const label = `${speed} · ${hint}`;
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
