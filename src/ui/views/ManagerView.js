/**
 * Manager view (design §15, item 68, G5):
 * - Formation switcher (4-3-3 / 4-4-2) with optimal role reordering preview
 * - Responsive side-by-side 2D tactical pitch minimap (left) & substitutes
 *   bench (right)
 * - Draft staging: click two minimap players to stage a slot swap, click pitch +
 *   bench (in either order) to stage a substitution, undo any draft item, or
 *   press Confirm to dispatch SET_FORMATION, SWAP_POSITIONS & SUBSTITUTE
 * - Pending confirmed subs list with Cancel
 * - Non-dismissible forced-decision prompt (HIGH injury / GK red card)
 * - Translated error-code messages via `locale.t('errors.' + code)`
 * - Disabled while playbackState === 'REPLAY'
 */
import { computeOptimalSlotAssignments } from '../../engine/tactics/Formation.js';
import { View } from './View.js';

const PARTIAL = `
<div class="manager-panel">
  <div class="mgr-error is-hidden" id="mgr-error" role="alert"></div>
  <div class="mgr-status is-hidden" id="mgr-status" role="status"></div>
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
  <div class="mgr-tactical-wrap">
    <div class="mgr-map-col">
      <div class="mgr-hint muted" id="mgr-hint">Tap 2 pitch players to swap, or pitch + bench to sub</div>
      <div class="mgr-minimap" id="mgr-minimap"></div>
    </div>
    <div class="mgr-bench-col">
      <strong class="muted" id="mgr-bench-title">Bench</strong>
      <div class="mgr-list" id="mgr-bench"></div>
    </div>
  </div>
  <div class="mgr-section mgr-draft-sec">
    <strong class="muted" id="mgr-staged-title">Staged Changes</strong>
    <div class="mgr-staged-list" id="mgr-staged-list"></div>
    <div class="mgr-footer">
      <button type="button" class="btn btn-sm" id="mgr-discard" data-discard-draft="1">Discard</button>
      <button type="button" class="btn btn-sm btn-primary" id="mgr-confirm" data-confirm-draft="1">Confirm</button>
    </div>
  </div>
  <div class="mgr-section">
    <strong id="mgr-pending-title">Pending (Next Dead Ball)</strong>
    <div class="mgr-pending-list" id="mgr-pending-list"></div>
  </div>
</div>
`;

/**
 * Derives a compact positional badge (GK, LB, CB, RB, LCM, CM, RCM, LW, RW, ST)
 * from a slot's generic role and fractional coordinates.
 * @param {{role: string, defend: [number, number]}} slot
 * @returns {string}
 */
export function slotLabel(slot) {
  if (!slot) return 'SUB';
  const y = slot.defend?.[1] ?? 0.5;
  const x = slot.defend?.[0] ?? 0.3;
  switch (slot.role) {
    case 'GK':
      return 'GK';
    case 'CB':
      return 'CB';
    case 'FB':
      return y < 0.4 ? 'LB' : y > 0.6 ? 'RB' : 'FB';
    case 'MF':
      return y < 0.36 ? 'LCM' : y > 0.64 ? 'RCM' : 'CM';
    case 'W':
      return x >= 0.45 ? (y < 0.5 ? 'LW' : 'RW') : (y < 0.5 ? 'LM' : 'RM');
    case 'ST':
      return 'ST';
    default:
      return slot.role;
  }
}

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
   *   onConfirmComplete?: () => void,
   * }} opts
   */
  constructor({ locale, teamIndex = 0, onCommand, onConfirmComplete = () => {} }) {
    super(PARTIAL);
    this.locale = locale;
    this.teamIndex = teamIndex;
    this.onCommand = onCommand;
    this.onConfirmComplete = onConfirmComplete;
    this.selectedOut = -1;
    this.selectedIn = -1;
    /** @type {string | null} */
    this.stagedFormation = null;
    /** @type {Array<[number, number]>} */
    this.stagedSwaps = [];
    /** @type {Array<{outIndex: number, inIndex: number}>} */
    this.stagedSubs = [];
    this.errorMsg = '';
    this.confirmedMsg = '';
    this.lastState = null;
    this.lastPlaybackState = 'PAUSED';
    this._lastRenderKey = '';
  }

  /** Discards any unconfirmed staged formation/swap/substitution drafts. */
  discardDraft() {
    this.stagedFormation = null;
    this.stagedSwaps = [];
    this.stagedSubs = [];
    this.selectedOut = -1;
    this.selectedIn = -1;
    this.errorMsg = '';
    this._lastRenderKey = '';
    this.#render();
  }

  /** Commits all staged formation, position-swap, and substitution changes. */
  confirmDraft() {
    if (!this.lastState || this.lastPlaybackState === 'REPLAY') return;
    if (this.stagedFormation === null && this.stagedSwaps.length === 0 && this.stagedSubs.length === 0) return;

    this.errorMsg = '';
    const hadSubs = this.stagedSubs.length > 0;
    if (this.stagedFormation !== null) {
      const res = this.onCommand({
        issuer: 'human',
        type: 'SET_FORMATION',
        teamIndex: this.teamIndex,
        payload: { formationId: this.stagedFormation },
      });
      if (!res.ok) {
        this.errorMsg = formatCommandError(res, this.locale) ?? '';
        this.#render();
        return;
      }
    }
    for (const [playerA, playerB] of this.stagedSwaps) {
      const res = this.onCommand({
        issuer: 'human',
        type: 'SWAP_POSITIONS',
        teamIndex: this.teamIndex,
        payload: { playerA, playerB },
      });
      if (!res.ok) {
        this.errorMsg = formatCommandError(res, this.locale) ?? '';
        this.#render();
        return;
      }
    }
    for (const sub of this.stagedSubs) {
      const res = this.onCommand({
        issuer: 'human',
        type: 'SUBSTITUTE',
        teamIndex: this.teamIndex,
        payload: { outIndex: sub.outIndex, inIndex: sub.inIndex },
      });
      if (!res.ok) {
        this.errorMsg = formatCommandError(res, this.locale) ?? '';
        this.#render();
        return;
      }
    }

    this.stagedFormation = null;
    this.stagedSwaps = [];
    this.stagedSubs = [];
    this.selectedOut = -1;
    this.selectedIn = -1;
    this.confirmedMsg = hadSubs ? 'Confirmed — queued for next stoppage' : 'Confirmed — applied to active shape';
    this._lastRenderKey = '';
    this.#render();
    this.onConfirmComplete();
  }

  /** @param {number} outIndex @param {number} inIndex */
  #stageSub(outIndex, inIndex) {
    if (!this.lastState) return;
    const s = this.lastState;
    const team = s.teams[this.teamIndex];
    const pendingTeam = s.pendingSubs.filter((/** @type {any} */ p) => p.teamIndex === this.teamIndex);
    const usedOrQueued = team.subsUsed + pendingTeam.length + this.stagedSubs.length;
    if (usedOrQueued >= 5) {
      this.errorMsg = this.locale.t('errors.NO_SUBS_LEFT');
      this.#render();
      return;
    }
    const duplicate =
      pendingTeam.some((/** @type {any} */ p) => p.outIndex === outIndex || p.inIndex === inIndex) ||
      this.stagedSubs.some((p) => p.outIndex === outIndex || p.inIndex === inIndex);
    if (duplicate) {
      this.errorMsg = this.locale.t('errors.ALREADY_PENDING');
      this.#render();
      return;
    }
    this.errorMsg = '';
    this.confirmedMsg = '';
    this.stagedSubs.push({ outIndex, inIndex });
    this._lastRenderKey = '';
    this.#render();
  }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    super.mount(rootEl);
    rootEl.addEventListener('click', (ev) => {
      if (this.lastPlaybackState === 'REPLAY') return;
      const el = /** @type {HTMLElement | null} */ (ev.target);
      const confirmBtn = el?.closest?.('[data-confirm-draft]');
      if (confirmBtn) {
        this.confirmDraft();
        return;
      }
      const discardBtn = el?.closest?.('[data-discard-draft]');
      if (discardBtn) {
        this.confirmedMsg = '';
        this.discardDraft();
        return;
      }
      const undoSubBtn = el?.closest?.('[data-undo-sub]');
      if (undoSubBtn) {
        const idx = Number(undoSubBtn.getAttribute('data-undo-sub'));
        if (idx >= 0 && idx < this.stagedSubs.length) this.stagedSubs.splice(idx, 1);
        this._lastRenderKey = '';
        this.#render();
        return;
      }
      const undoSwapBtn = el?.closest?.('[data-undo-swap]');
      if (undoSwapBtn) {
        const idx = Number(undoSwapBtn.getAttribute('data-undo-swap'));
        if (idx >= 0 && idx < this.stagedSwaps.length) this.stagedSwaps.splice(idx, 1);
        this._lastRenderKey = '';
        this.#render();
        return;
      }
      const formBtn = el?.closest?.('[data-formation]');
      if (formBtn) {
        const formationId = formBtn.getAttribute('data-formation');
        const team = this.lastState?.teams?.[this.teamIndex];
        this.stagedFormation = formationId === team?.formationId ? null : formationId;
        this.stagedSwaps = [];
        this.selectedOut = -1;
        this.selectedIn = -1;
        this.confirmedMsg = '';
        this.errorMsg = '';
        this._lastRenderKey = '';
        this.#render();
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
        const team = this.lastState?.teams?.[this.teamIndex];
        if (team?.forcedDecision) {
          this.selectedOut = this.selectedOut === idx ? -1 : idx;
          this._lastRenderKey = '';
          this.#render();
          return;
        }
        if (this.selectedIn >= 0) {
          const inIdx = this.selectedIn;
          this.selectedIn = -1;
          this.selectedOut = -1;
          this.#stageSub(idx, inIdx);
          return;
        }
        if (this.selectedOut === idx) {
          this.selectedOut = -1;
          this._lastRenderKey = '';
          this.#render();
          return;
        }
        if (this.selectedOut >= 0) {
          this.stagedSwaps.push([this.selectedOut, idx]);
          this.selectedOut = -1;
          this.confirmedMsg = '';
          this.errorMsg = '';
          this._lastRenderKey = '';
          this.#render();
          return;
        }
        this.selectedOut = idx;
        this._lastRenderKey = '';
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
          this.selectedIn = -1;
        } else if (this.selectedOut >= 0) {
          const outIdx = this.selectedOut;
          this.selectedOut = -1;
          this.selectedIn = -1;
          this.#stageSub(outIdx, inIndex);
        } else {
          this.selectedIn = this.selectedIn === inIndex ? -1 : inIndex;
          this._lastRenderKey = '';
          this.#render();
        }
      }
    });
    this._unsub = this.locale.onChange(() => {
      this._lastRenderKey = '';
      this.#render();
    });
  }

  /** @param {{issuer: 'human', type: string, teamIndex: number, payload: Record<string, any>}} cmd */
  #dispatch(cmd) {
    const res = this.onCommand(cmd);
    this.errorMsg = formatCommandError(res, this.locale) ?? '';
    this._lastRenderKey = '';
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
    const statusEl = this.root.querySelector('#mgr-status');
    if (statusEl) {
      statusEl.textContent = this.confirmedMsg;
      statusEl.classList.toggle('is-hidden', !this.confirmedMsg);
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
    const pendingOutSet = new Set(pendingTeam.map((/** @type {any} */ p) => p.outIndex));
    const pendingInSet = new Set(pendingTeam.map((/** @type {any} */ p) => p.inIndex));
    const stagedOutMap = new Map(this.stagedSubs.map((sub) => [sub.outIndex, sub.inIndex]));
    const stagedInMap = new Map(this.stagedSubs.map((sub) => [sub.inIndex, sub.outIndex]));
    const subsLeft = Math.max(0, 5 - team.subsUsed - pendingTeam.length - this.stagedSubs.length);
    const subsEl = this.root.querySelector('#mgr-subs-left');
    if (subsEl) subsEl.textContent = `${this.locale.t('panels.subs')}: ${subsLeft}/5`;

    const formTitle = this.root.querySelector('#mgr-form-title');
    if (formTitle) formTitle.textContent = this.locale.t('panels.formation');
    const benchTitle = this.root.querySelector('#mgr-bench-title');
    if (benchTitle) benchTitle.textContent = this.locale.t('panels.bench');

    const pendingForm = [...(s.pendingCommands ?? [])].reverse().find((c) => c.type === 'SET_FORMATION' && c.teamIndex === this.teamIndex);
    const liveFormation = pendingForm ? pendingForm.payload.formationId : team.formationId;
    const activeFormation = this.stagedFormation ?? liveFormation;
    for (const btn of Array.from(this.root.querySelectorAll('[data-formation]'))) {
      btn.classList.toggle('btn-primary', btn.getAttribute('data-formation') === activeFormation);
      /** @type {HTMLButtonElement} */ (btn).disabled = disabled;
    }

    const base = this.teamIndex * 18;
    const onPitch = [];
    const bench = [];
    for (let i = base; i < base + 18; i++) {
      const p = s.players[i];
      if (p.onPitch === 1) onPitch.push(p);
      else if (p.out === 0 && p.card !== 2) bench.push(p);
    }

    const slots = s.config?.tactics?.formations?.[activeFormation]?.slots ?? [];
    const hasDraft = this.stagedFormation !== null || this.stagedSwaps.length > 0 || this.stagedSubs.length > 0;
    const confirmBtn = /** @type {HTMLButtonElement | null} */ (this.root.querySelector('#mgr-confirm'));
    const discardBtn = /** @type {HTMLButtonElement | null} */ (this.root.querySelector('#mgr-discard'));
    if (confirmBtn) {
      confirmBtn.textContent = this.locale.t('buttons.confirm');
      confirmBtn.disabled = disabled || !hasDraft;
    }
    if (discardBtn) {
      discardBtn.textContent = this.locale.t('buttons.cancel');
      discardBtn.disabled = disabled || !hasDraft;
    }

    const baseKey = [
      this.locale.getLocale(),
      this.errorMsg,
      this.confirmedMsg,
      activeFormation,
      this.stagedFormation ?? '',
      team.subsUsed,
      team.forcedDecision ? team.forcedKind : 0,
      this.selectedOut,
      this.selectedIn,
      disabled ? 1 : 0,
      this.stagedSwaps.map(([a, b]) => `${a}-${b}`).join(','),
      this.stagedSubs.map((sub) => `${sub.outIndex}-${sub.inIndex}`).join(','),
      pendingTeam.map((/** @type {any} */ sub) => `${sub.seq}:${sub.outIndex}-${sub.inIndex}`).join(','),
      onPitch.map((p) => `${p.index}:${p.slot}:${Math.round(p.fitness * 100)}:${p.card}:${p.injury}`).join(','),
      bench.map((p) => `${p.index}:${Math.round(p.fitness * 100)}`).join(','),
    ].join('|');
    if (baseKey === this._lastRenderKey) return;
    this._lastRenderKey = baseKey;

    // Preview slot assignments: apply staged formation optimal fit, then staged swaps
    const slotByPlayer =
      this.stagedFormation !== null && s.config?.roles
        ? computeOptimalSlotAssignments(onPitch, slots, s.config.roles)
        : new Map(onPitch.map((p) => [p.index, p.slot]));
    for (const [a, b] of this.stagedSwaps) {
      const sa = slotByPlayer.get(a);
      const sb = slotByPlayer.get(b);
      if (sa !== undefined && sb !== undefined) {
        slotByPlayer.set(a, sb);
        slotByPlayer.set(b, sa);
      }
    }

    const stagedEl = this.root.querySelector('#mgr-staged-list');
    if (stagedEl) {
      const items = [];
      if (this.stagedFormation !== null) {
        items.push(`<div class="mgr-pend-item"><span>Formation → ${this.stagedFormation}</span></div>`);
      }
      this.stagedSwaps.forEach(([a, b], idx) => {
        const pA = s.players[a];
        const pB = s.players[b];
        items.push(`<div class="mgr-pend-item">
          <span>Swap #${pA.cold.number} ${pA.shortName} ⇄ #${pB.cold.number} ${pB.shortName}</span>
          <button type="button" class="btn btn-sm" data-undo-swap="${idx}">${this.locale.t('buttons.cancel')}</button>
        </div>`);
      });
      this.stagedSubs.forEach((sub, idx) => {
        const outP = s.players[sub.outIndex];
        const inP = s.players[sub.inIndex];
        items.push(`<div class="mgr-pend-item">
          <span>Sub #${outP.cold.number} ${outP.shortName} → #${inP.cold.number} ${inP.shortName}</span>
          <button type="button" class="btn btn-sm" data-undo-sub="${idx}">${this.locale.t('buttons.cancel')}</button>
        </div>`);
      });
      stagedEl.innerHTML = items.length > 0 ? items.join('') : '<span class="muted">—</span>';
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
                  <span>#${outP.cold.number} ${outP.shortName} → #${inP.cold.number} ${inP.shortName}</span>
                  <button type="button" class="btn btn-sm" data-cancel-seq="${sub.seq}">${this.locale.t('buttons.cancel')}</button>
                </div>`;
              })
              .join('');
    }

    const mapEl = this.root.querySelector('#mgr-minimap');
    if (mapEl) {
      const linesHtml = `
        <div class="mgr-pitch-half"></div>
        <div class="mgr-pitch-box-top"></div>
        <div class="mgr-pitch-box-bot"></div>
        <div class="mgr-pitch-circle"></div>
      `;
      const nodesHtml = onPitch
        .map((p, idx) => {
          const slIdx = slotByPlayer.get(p.index) ?? idx;
          const slot = slots[slIdx >= 0 ? slIdx : idx] ?? slots[0];
          const xFrac = slot?.defend?.[0] ?? 0.3;
          const yFrac = slot?.defend?.[1] ?? 0.5;
          const leftPct = Math.max(12, Math.min(88, yFrac * 100));
          const topPct = Math.max(11, Math.min(89, 92 - xFrac * 135));
          const pct = Math.max(0, Math.min(100, Math.round(p.fitness * 100)));
          const fitCls = pct >= 80 ? 'is-good' : pct >= 65 ? 'is-warn' : 'is-low';
          const sel = this.selectedOut === p.index ? ' is-selected' : '';
          const stagedIn = stagedOutMap.get(p.index);
          const pend = pendingOutSet.has(p.index) || stagedIn !== undefined ? ' is-pending-out' : '';
          const role = slotLabel(slot);
          const subTag = stagedIn !== undefined ? `<span class="mgr-b-sub">→#${s.players[stagedIn].cold.number}</span>` : pendingOutSet.has(p.index) ? '<span class="mgr-b-sub">⇄</span>' : '';
          const badges = `${p.card === 1 ? '<span class="mgr-b-yc"></span>' : ''}${p.injury > 0 ? '<span class="mgr-b-inj">+</span>' : ''}${subTag}`;
          return `<button type="button" class="mgr-node${sel}${pend}" data-out-index="${p.index}" style="left:${leftPct.toFixed(1)}%;top:${topPct.toFixed(1)}%;" ${disabled ? 'disabled' : ''}>
            <span class="mgr-node-top">
              <span class="mgr-role-tag">${role}</span>
              ${badges}
            </span>
            <span class="mgr-node-name">${p.shortName}</span>
            <span class="mgr-node-fit">
              <span class="mgr-fit-bar"><span class="mgr-fit-fill ${fitCls}" style="width:${pct}%"></span></span>
              <span class="mgr-fit-pct ${fitCls}">${pct}%</span>
            </span>
          </button>`;
        })
        .join('');
      mapEl.innerHTML = linesHtml + nodesHtml;
    }

    const bnEl = this.root.querySelector('#mgr-bench');
    if (bnEl) {
      bnEl.innerHTML = bench
        .map((p) => {
          const sel = this.selectedIn === p.index ? ' is-selected' : '';
          const stagedOut = stagedInMap.get(p.index);
          const pend = pendingInSet.has(p.index) || stagedOut !== undefined ? ' is-pending-in' : '';
          const linkTag = stagedOut !== undefined ? ` <span class="mgr-b-sub">←#${s.players[stagedOut].cold.number}</span>` : '';
          return `<button type="button" class="mgr-player${sel}${pend}" data-in-index="${p.index}" ${disabled ? 'disabled' : ''}>
            <span class="mgr-bench-name">#${p.cold.number} ${p.shortName} (${p.cold.role})${linkTag}</span>
            <span class="muted">${Math.round(p.fitness * 100)}%</span>
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
