/**
 * Manager view (design §15, item 68, G5):
 * - Formation switcher (4-3-3 / 4-4-2)
 * - On-pitch list with fitness & badges; bench list
 * - Tap-out then tap-in substitution queueing; pending list with cancel
 * - Substitutions remaining counter
 * - Non-dismissible forced-decision prompt (HIGH injury / GK red card)
 * - Translated error-code messages via `locale.t('errors.' + code)`
 * - Disabled while playbackState === 'REPLAY'
 */
import { View } from './View.js';

const PARTIAL = `
<div class="manager-panel">
  <div class="mgr-error is-hidden" id="mgr-error" role="alert"></div>
  <div class="mgr-forced is-hidden" id="mgr-forced"></div>
  <div class="mgr-section">
    <div class="mgr-row">
      <strong id="mgr-form-title">Formation</strong>
      <div class="mgr-btn-group">
        <button type="button" class="btn btn-sm" data-formation="4-3-3">4-3-3</button>
        <button type="button" class="btn btn-sm" data-formation="4-4-2">4-4-2</button>
      </div>
      <span class="muted" id="mgr-subs-left">Subs: 5</span>
    </div>
  </div>
  <div class="mgr-section">
    <strong id="mgr-pending-title">Pending</strong>
    <div class="mgr-pending-list" id="mgr-pending-list"></div>
  </div>
  <div class="mgr-lists">
    <div class="mgr-col">
      <strong class="muted">On Pitch (tap out)</strong>
      <div class="mgr-list" id="mgr-onpitch"></div>
    </div>
    <div class="mgr-col">
      <strong class="muted">Bench (tap in)</strong>
      <div class="mgr-list" id="mgr-bench"></div>
    </div>
  </div>
</div>
`;

/**
 * Pure helper used by ManagerView and tests: translates a command result into
 * a user-facing error message (or null when ok).
 * @param {{ok: boolean, code: string | null}} res
 * @param {import('../../i18n/Locale.js').LocaleManager} locale
 * @returns {string | null}
 */
export function formatCommandError(res, locale) {
  if (res.ok) return null;
  const code = res.code ?? 'UNKNOWN_TYPE';
  if (code === 'REPLAY_ACTIVE') return locale.t('errors.DECISION_PENDING');
  return locale.t(`errors.${code}`);
}

export class ManagerView extends View {
  /**
   * @param {{
   *   locale: import('../../i18n/Locale.js').LocaleManager,
   *   teamIndex?: number,
   *   onCommand: (cmd: {issuer: 'human', type: string, teamIndex: number, payload: Record<string, any>}) => {ok: boolean, code: string | null},
   * }} opts
   */
  constructor({ locale, teamIndex = 0, onCommand }) {
    super(PARTIAL);
    this.locale = locale;
    this.teamIndex = teamIndex;
    this.onCommand = onCommand;
    this.selectedOut = -1;
    this.errorMsg = '';
    this.lastState = null;
    this.lastPlaybackState = 'PAUSED';
  }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    super.mount(rootEl);
    rootEl.addEventListener('click', (ev) => {
      if (this.lastPlaybackState === 'REPLAY') return;
      const el = /** @type {HTMLElement | null} */ (ev.target);
      const formBtn = el?.closest?.('[data-formation]');
      if (formBtn) {
        const formationId = formBtn.getAttribute('data-formation');
        this.#dispatch({ issuer: 'human', type: 'SET_FORMATION', teamIndex: this.teamIndex, payload: { formationId } });
        return;
      }
      const cancelBtn = el?.closest?.('[data-cancel-seq]');
      if (cancelBtn) {
        const seq = Number(cancelBtn.getAttribute('data-cancel-seq'));
        this.#dispatch({ issuer: 'human', type: 'CANCEL_SUBSTITUTION', teamIndex: this.teamIndex, payload: { seq } });
        return;
      }
      const forcedNone = el?.closest?.('[data-forced-none]');
      if (forcedNone) {
        this.#dispatch({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: this.teamIndex, payload: { inIndex: null, outIndex: null } });
        return;
      }
      const outBtn = el?.closest?.('[data-out-index]');
      if (outBtn) {
        const idx = Number(outBtn.getAttribute('data-out-index'));
        this.selectedOut = this.selectedOut === idx ? -1 : idx;
        this.#render();
        return;
      }
      const inBtn = el?.closest?.('[data-in-index]');
      if (inBtn) {
        const inIndex = Number(inBtn.getAttribute('data-in-index'));
        const team = this.lastState?.teams?.[this.teamIndex];
        if (team?.forcedDecision) {
          const outIndex = team.forcedKind === 2 ? (this.selectedOut >= 0 ? this.selectedOut : null) : null;
          this.#dispatch({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: this.teamIndex, payload: { inIndex, outIndex } });
          this.selectedOut = -1;
        } else if (this.selectedOut >= 0) {
          this.#dispatch({ issuer: 'human', type: 'SUBSTITUTE', teamIndex: this.teamIndex, payload: { outIndex: this.selectedOut, inIndex } });
          this.selectedOut = -1;
        }
      }
    });
    this._unsub = this.locale.onChange(() => this.#render());
  }

  /** @param {{issuer: 'human', type: string, teamIndex: number, payload: Record<string, any>}} cmd */
  #dispatch(cmd) {
    const res = this.onCommand(cmd);
    this.errorMsg = formatCommandError(res, this.locale) ?? '';
    this.#render();
  }

  /**
   * @param {{state: any, playbackState: string}} frame
   */
  update(frame) {
    this.lastState = frame.state;
    this.lastPlaybackState = frame.playbackState;
    this.#render();
  }

  #render() {
    if (!this.root || !this.lastState) return;
    const s = this.lastState;
    const team = s.teams[this.teamIndex];
    const disabled = this.lastPlaybackState === 'REPLAY';
    this.root.classList.toggle('is-disabled', disabled);

    const errEl = this.root.querySelector('#mgr-error');
    if (errEl) {
      errEl.textContent = this.errorMsg;
      errEl.classList.toggle('is-hidden', !this.errorMsg);
    }

    const forcedEl = this.root.querySelector('#mgr-forced');
    if (forcedEl) {
      forcedEl.classList.toggle('is-hidden', !team.forcedDecision);
      if (team.forcedDecision) {
        const extra = team.forcedKind === 2 ? ' (GK sent off: tap an outfield player to make way, then tap a bench player, or continue without sub)' : '';
        forcedEl.innerHTML = `<strong>${this.locale.t('prompts.forcedDecision')}</strong>${extra}
          <button type="button" class="btn btn-sm" data-forced-none="1">Play on without sub</button>`;
      }
    }

    const pendingTeam = s.pendingSubs.filter((/** @type {any} */ p) => p.teamIndex === this.teamIndex);
    const subsLeft = Math.max(0, 5 - team.subsUsed - pendingTeam.length);
    const subsEl = this.root.querySelector('#mgr-subs-left');
    if (subsEl) subsEl.textContent = `${this.locale.t('panels.subs')}: ${subsLeft}/5`;

    const pendingForm = [...(s.pendingCommands ?? [])].reverse().find((c) => c.type === 'SET_FORMATION' && c.teamIndex === this.teamIndex);
    const activeFormation = pendingForm ? pendingForm.payload.formationId : team.formationId;
    for (const btn of Array.from(this.root.querySelectorAll('[data-formation]'))) {
      btn.classList.toggle('btn-primary', btn.getAttribute('data-formation') === activeFormation);
      /** @type {HTMLButtonElement} */ (btn).disabled = disabled;
    }

    const pendEl = this.root.querySelector('#mgr-pending-list');
    if (pendEl) {
      pendEl.innerHTML =
        pendingTeam.length === 0
          ? '<span class="muted">—</span>'
          : pendingTeam
              .map((/** @type {any} */ sub) => {
                const outP = s.players[sub.outIndex];
                const inP = s.players[sub.inIndex];
                return `<div class="mgr-pend-item">
                  <span>#${outP.cold.number} ${outP.cold.name} → #${inP.cold.number} ${inP.cold.name}</span>
                  <button type="button" class="btn btn-sm" data-cancel-seq="${sub.seq}">${this.locale.t('buttons.cancel')}</button>
                </div>`;
              })
              .join('');
    }

    const base = this.teamIndex * 18;
    const onPitch = [];
    const bench = [];
    for (let i = base; i < base + 18; i++) {
      const p = s.players[i];
      if (p.onPitch === 1) onPitch.push(p);
      else if (p.out === 0 && p.card !== 2) bench.push(p);
    }

    const opEl = this.root.querySelector('#mgr-onpitch');
    if (opEl) {
      opEl.innerHTML = onPitch
        .map((p) => {
          const sel = this.selectedOut === p.index ? ' is-selected' : '';
          const badges = `${p.card === 1 ? '🟨' : ''}${p.injury > 0 ? '🩹' : ''}`;
          return `<button type="button" class="mgr-player${sel}" data-out-index="${p.index}" ${disabled ? 'disabled' : ''}>
            <span>#${p.cold.number} ${p.cold.name} (${p.cold.role}) ${badges}</span>
            <span class="muted">${Math.round(p.fitness * 100)}%</span>
          </button>`;
        })
        .join('');
    }

    const bnEl = this.root.querySelector('#mgr-bench');
    if (bnEl) {
      bnEl.innerHTML = bench
        .map((p) => {
          return `<button type="button" class="mgr-player" data-in-index="${p.index}" ${disabled ? 'disabled' : ''}>
            <span>#${p.cold.number} ${p.cold.name} (${p.cold.role})</span>
            <span class="muted">100%</span>
          </button>`;
        })
        .join('');
    }
  }

  destroy() {
    this._unsub?.();
    super.destroy();
  }
}
