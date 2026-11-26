/**
 * Manager view (design §15, item 68, G5):
 * - Formation switcher (4-3-3 / 4-4-2) with optimal role reordering preview
 * - Responsive side-by-side 2D tactical pitch minimap (left) & substitutes
 *   bench (right)
 * - Draft staging: click two minimap players to stage a slot swap, click pitch +
 *   bench (in either order) to stage a substitution, undo any draft item, or
 *   press Confirm to dispatch SET_FORMATION, SWAP_POSITIONS & SUBSTITUTE
 * - One "Pending" list: the staged drafts, then the confirmed changes the match
 *   has not carried out yet (a queued substitution can be cancelled). While a
 *   confirmed batch waits for the next stoppage, Confirm and staging are locked.
 * - Mandatory injury replacement: when a human player suffers a HIGH injury the
 *   panel opens with him selected and cannot be closed (nor play resumed) until a
 *   bench replacement is confirmed; more swaps / subs can go in the same batch.
 * - Non-dismissible goalkeeper-sent-off prompt (replace him, or play on)
 * - Translated error-code messages via `locale.t('errors.' + code)`
 * - Localized position badges (en-GB GK/CB/LB..., pt-PT GR/DC/DE...) on the
 *   minimap and the bench, with the full position name as the tooltip
 * - Player telemetry on both the minimap nodes and the bench rows: the live
 *   match rating badge (0.0-10.0: red below 6.0, neutral 6.0-6.9, green from
 *   7.0, cyan/gold from 8.0), fitness % with a colour
 *   bar, individual morale % with a coloured trend icon, yellow / red card
 *   badges and an injury badge
 * - A confirmed substitution made at once when the ball is already stopped
 *   ("substitution made"), otherwise queued for the next stoppage
 * - Disabled while playbackState === 'REPLAY'
 */
import { computeOptimalSlotAssignments } from '../../engine/tactics/Formation.js';
import { View } from './View.js';
import { positionCode, positionLabel, roleCode } from '../positions.js';
import { MINI_PITCH_LINES_HTML, miniPitchCoords } from './pitchMini.js';
import { canDismissManager, hasPendingSubmission, mandatoryReplacement, pendingSubmission, pendingTargetFormation } from '../../runtime/managerPending.js';

const PARTIAL = `
<div class="manager-panel">
  <div class="mgr-error is-hidden" id="mgr-error" role="alert"></div>
  <div class="mgr-status is-hidden" id="mgr-status" role="status"></div>
  <div class="mgr-forced is-hidden" id="mgr-forced"></div>
  <div class="mgr-section">
    <div class="mgr-row">
      <strong id="mgr-form-title">Formation</strong>
      <div class="mgr-btn-group" id="mgr-form-btns">
        <button type="button" class="btn btn-sm" data-formation="4-3-3">4-3-3</button>
        <button type="button" class="btn btn-sm" data-formation="4-4-2">4-4-2</button>
      </div>
      <span class="mgr-plan-badge is-hidden" id="mgr-plan-badge"></span>
      <span class="muted" id="mgr-subs-left">Subs: 5</span>
    </div>
  </div>
  <div class="mgr-tactical-wrap">
    <div class="mgr-map-col">
      <div class="mgr-hint muted" id="mgr-hint"></div>
      <div class="mgr-minimap" id="mgr-minimap"></div>
    </div>
    <div class="mgr-bench-col">
      <strong class="muted" id="mgr-bench-title">Bench</strong>
      <div class="mgr-list" id="mgr-bench"></div>
    </div>
  </div>
  <div class="mgr-section mgr-draft-sec">
    <strong id="mgr-pending-title"></strong>
    <div class="mgr-pending-list" id="mgr-pending-list"></div>
    <div class="mgr-footer">
      <button type="button" class="btn btn-sm" id="mgr-discard" data-discard-draft="1"></button>
      <button type="button" class="btn btn-sm btn-primary" id="mgr-confirm" data-confirm-draft="1"></button>
    </div>
  </div>
</div>
`;

/**
 * Position code of a slot (GK, LB, CB, RB, LCM, CM, RCM, DM, AM, LW, RW, ST, ...).
 * Kept for callers of the old name; see `positionCode`.
 * @param {{role: string, defend: [number, number]}} slot
 * @returns {string}
 */
export function slotLabel(slot) {
  return positionCode(slot);
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

/** @param {number} v */
const pct = (v) => Math.max(0, Math.min(100, Math.round(v)));

/**
 * Display class for a 0-10 match rating: red below 6.0, neutral 6.0-6.9,
 * green from 7.0, cyan/gold from 8.0.
 * @param {number} rating
 * @returns {'is-poor' | 'is-avg' | 'is-good' | 'is-elite'}
 */
export function ratingClass(rating) {
  const r = Math.round(rating * 10) / 10;
  return r >= 8 ? 'is-elite' : r >= 7 ? 'is-good' : r >= 6 ? 'is-avg' : 'is-poor';
}

/**
 * Pure telemetry for one player (used by ManagerView and tests): live match
 * rating, fitness, individual morale, cards and injury, with display classes.
 * @param {any} p a `PlayerMatchState`
 * @returns {{rating: string, ratingCls: string, fitness: number, fitCls: string, morale: number, moraleCls: string, moraleIcon: string, card: number, injury: number}}
 */
export function playerTelemetry(p) {
  const fitness = pct(p.fitness * 100);
  const morale = pct(p.morale ?? 75);
  const level = p.moraleLevel ?? 0;
  const rating = Math.max(0, Math.min(10, typeof p.rating === 'number' ? p.rating : 6));
  return {
    rating: rating.toFixed(1),
    ratingCls: ratingClass(rating),
    fitness,
    fitCls: fitness >= 80 ? 'is-good' : fitness >= 65 ? 'is-warn' : 'is-low',
    morale,
    moraleCls: level > 0 ? 'is-high' : level < 0 ? 'is-low' : 'is-mid',
    moraleIcon: level > 0 ? '▲' : level < 0 ? '▼' : '●',
    card: p.card ?? 0,
    injury: p.injury ?? 0,
  };
}

/**
 * HTML fragments for a player's telemetry (rating badge, fitness bar,
 * morale indicator, card / injury badges), shared by the minimap and the bench.
 * @param {any} p
 * @param {import('../../i18n/Locale.js').LocaleManager} locale
 * @returns {{rating: string, fitness: string, morale: string, badges: string}}
 */
export function telemetryHtml(p, locale) {
  const t = playerTelemetry(p);
  const ratingTitle = `${locale.t('panels.rating')} ${t.rating}`;
  const fitTitle = `${locale.t('panels.fitness')} ${t.fitness}%`;
  const moraleTitle = `${locale.t('panels.morale')} ${t.morale}%`;
  const badges =
    (t.card === 1 ? `<span class="mgr-b-yc" title="${locale.t('panels.yellowCard')}" aria-label="${locale.t('panels.yellowCard')}"></span>` : '') +
    (t.card === 2 ? `<span class="mgr-b-rc" title="${locale.t('panels.redCard')}" aria-label="${locale.t('panels.redCard')}"></span>` : '') +
    (t.injury > 0 ? `<span class="mgr-b-inj is-l${t.injury}" title="${locale.t('panels.injured')}" aria-label="${locale.t('panels.injured')}">+</span>` : '');
  return {
    rating: `<span class="mgr-rating ${t.ratingCls}" title="${ratingTitle}" aria-label="${ratingTitle}">${t.rating}</span>`,
    fitness: `<span class="mgr-node-fit" title="${fitTitle}" aria-label="${fitTitle}">
              <span class="mgr-fit-bar"><span class="mgr-fit-fill ${t.fitCls}" style="width:${t.fitness}%"></span></span>
              <span class="mgr-fit-pct ${t.fitCls}">${t.fitness}%</span>
            </span>`,
    morale: `<span class="mgr-morale ${t.moraleCls}" title="${moraleTitle}" aria-label="${moraleTitle}"><span class="mgr-morale-icon" aria-hidden="true">${t.moraleIcon}</span>${t.morale}%</span>`,
    badges,
  };
}

/** @param {any} p */
const telemetryKey = (p) => `${Math.round((p.rating ?? 6) * 10)}:${Math.round(p.fitness * 100)}:${Math.round(p.morale ?? 75)}:${p.moraleLevel ?? 0}:${p.card}:${p.injury}`;

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
    /** ui-strings key of the last Confirm outcome, or '' */
    this.confirmedKey = '';
    this.lastState = null;
    this.lastPlaybackState = 'PAUSED';
    this._lastRenderKey = '';
  }

  /** Localized last Confirm outcome, or ''. */
  get confirmedMsg() {
    return this.confirmedKey ? this.locale.t(this.confirmedKey) : '';
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

  /** The injured player who must be replaced before play goes on, or -1. */
  get forcedPlayer() {
    return this.lastState ? mandatoryReplacement(this.lastState, this.teamIndex) : -1;
  }

  /** The staged replacement for the injured player, if one is chosen. */
  get forcedReplacement() {
    const forced = this.forcedPlayer;
    return forced >= 0 ? this.stagedSubs.find((sub) => sub.outIndex === forced) : undefined;
  }

  /**
   * Whether a confirmed batch is still waiting for the match (the next dead ball): Confirm and staging
   * stay locked until it is carried out. A forced decision overrides the lock.
   */
  get locked() {
    if (!this.lastState || this.lastState.teams[this.teamIndex].forcedDecision) return false;
    return hasPendingSubmission(this.lastState, this.teamIndex);
  }

  /** Whether the panel may be closed (not while a forced decision is owed). */
  get dismissible() {
    return !this.lastState || canDismissManager(this.lastState, this.teamIndex);
  }

  /**
   * Commits all staged formation, position-swap, and substitution changes. With an injured player to
   * replace, his replacement goes first (it resolves the forced decision) and is required.
   */
  confirmDraft() {
    if (!this.lastState || this.lastPlaybackState === 'REPLAY' || this.locked) return;
    if (this.stagedFormation === null && this.stagedSwaps.length === 0 && this.stagedSubs.length === 0) return;
    const forcedSub = this.forcedReplacement;
    if (this.forcedPlayer >= 0 && !forcedSub) return;

    this.errorMsg = '';
    const hadSubs = this.stagedSubs.length > 0;
    /** @param {{ok: boolean, code: string | null}} res */
    const failed = (res) => {
      if (res.ok) return false;
      this.errorMsg = formatCommandError(res, this.locale) ?? '';
      this._lastRenderKey = '';
      this.#render();
      return true;
    };
    // Each item leaves the draft once the match has accepted it, so a later failure can be fixed and
    // confirmed again without repeating what already went through.
    if (forcedSub) {
      const res = this.onCommand({
        issuer: 'human',
        type: 'RESOLVE_FORCED',
        teamIndex: this.teamIndex,
        payload: { inIndex: forcedSub.inIndex, outIndex: null },
      });
      if (failed(res)) return;
      this.stagedSubs.splice(this.stagedSubs.indexOf(forcedSub), 1);
    }
    if (this.stagedFormation !== null) {
      const res = this.onCommand({
        issuer: 'human',
        type: 'SET_FORMATION',
        teamIndex: this.teamIndex,
        payload: { formationId: this.stagedFormation },
      });
      if (failed(res)) return;
      this.stagedFormation = null;
    }
    while (this.stagedSwaps.length > 0) {
      const [playerA, playerB] = this.stagedSwaps[0];
      const res = this.onCommand({ issuer: 'human', type: 'SWAP_POSITIONS', teamIndex: this.teamIndex, payload: { playerA, playerB } });
      if (failed(res)) return;
      this.stagedSwaps.shift();
    }
    while (this.stagedSubs.length > 0) {
      const sub = this.stagedSubs[0];
      const res = this.onCommand({
        issuer: 'human',
        type: 'SUBSTITUTE',
        teamIndex: this.teamIndex,
        payload: { outIndex: sub.outIndex, inIndex: sub.inIndex },
      });
      if (failed(res)) return;
      this.stagedSubs.shift();
    }

    this.selectedOut = -1;
    this.selectedIn = -1;
    const stillQueued = (this.lastState?.pendingSubs ?? []).some((/** @type {any} */ p) => p.teamIndex === this.teamIndex);
    this.confirmedKey = hadSubs ? (stillQueued ? 'prompts.subQueued' : 'prompts.subMade') : 'prompts.shapeApplied';
    this._lastRenderKey = '';
    this.#render();
    this.onConfirmComplete();
  }

  /**
   * In-play substitution windows the team has left (half-time is free). Staged or queued
   * substitutions that are not yet part of a window will open one.
   * @param {any} s
   * @param {any} team
   * @param {any[]} pendingTeam
   * @returns {{halfTime: boolean, left: number, max: number, exhausted: boolean}}
   */
  #windowsLeft(s, team, pendingTeam) {
    const max = s.config?.aiCoach?.substitutionPlan?.maxWindows ?? 3;
    const halfTime = s.restart?.state === 'HALF_TIME';
    const joining = team.inSubWindow || pendingTeam.length > 0 || this.stagedSubs.length > 0;
    const opened = (team.subWindows ?? 0) + (!team.inSubWindow && (pendingTeam.length > 0 || this.stagedSubs.length > 0) ? 1 : 0);
    return { halfTime, left: Math.max(0, max - opened), max, exhausted: !halfTime && !joining && (team.subWindows ?? 0) >= max };
  }

  /** Test hook: the staging guard the tap handlers use. @param {number} outIndex @param {number} inIndex */
  stageSubForTest(outIndex, inIndex) {
    this.#stageSub(outIndex, inIndex);
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
    if (this.#windowsLeft(s, team, pendingTeam).exhausted) {
      this.errorMsg = this.locale.t('errors.NO_WINDOWS_LEFT');
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
    this.confirmedKey = '';
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
      // A confirmed sub or queued plan switch can be withdrawn, even while the batch locks the board.
      const cancelBtn = el?.closest?.('[data-cancel-seq]');
      if (cancelBtn) {
        const seq = Number(cancelBtn.getAttribute('data-cancel-seq'));
        this.#dispatch({ issuer: 'human', type: 'CANCEL_SUBSTITUTION', teamIndex: this.teamIndex, payload: { seq } });
        return;
      }
      const cancelPlanBtn = el?.closest?.('[data-cancel-plan]');
      if (cancelPlanBtn) {
        this.#dispatch({ issuer: 'human', type: 'CANCEL_TACTIC_PLAN', teamIndex: this.teamIndex, payload: {} });
        return;
      }
      // Waiting for the next stoppage to carry out the confirmed batch: nothing new can be staged.
      if (this.locked) return;
      const confirmBtn = el?.closest?.('[data-confirm-draft]');
      if (confirmBtn) {
        this.confirmDraft();
        return;
      }
      const discardBtn = el?.closest?.('[data-discard-draft]');
      if (discardBtn) {
        this.confirmedKey = '';
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
        if (team?.tacticalPlans !== null && team?.tacticalPlans !== undefined) return;
        this.stagedFormation = formationId === team?.formationId ? null : formationId;
        this.stagedSwaps = [];
        this.selectedOut = -1;
        this.selectedIn = -1;
        this.confirmedKey = '';
        this.errorMsg = '';
        this._lastRenderKey = '';
        this.#render();
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
        if (team?.forcedDecision && team.forcedKind === 2) {
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
        // The injured player cannot swap places: tapping him (or another player after him) selects.
        const forced = this.forcedPlayer;
        if (forced >= 0 && (idx === forced || this.selectedOut === forced)) {
          this.selectedOut = idx;
          this._lastRenderKey = '';
          this.#render();
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
          this.confirmedKey = '';
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
        if (team?.forcedDecision && team.forcedKind === 2) {
          const outIndex = this.selectedOut >= 0 ? this.selectedOut : null;
          this.#dispatch({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: this.teamIndex, payload: { inIndex, outIndex } });
          this.selectedOut = -1;
          this.selectedIn = -1;
        } else if (this.selectedOut >= 0) {
          const outIdx = this.selectedOut;
          this.selectedOut = -1;
          this.selectedIn = -1;
          this.#stageSub(outIdx, inIndex);
        } else if (this.forcedPlayer >= 0 && !this.forcedReplacement) {
          // Nothing selected and the injured player still unreplaced: this bench player replaces him.
          this.#stageSub(this.forcedPlayer, inIndex);
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
    const locked = this.locked;
    const forced = this.forcedPlayer;
    const forcedSub = this.forcedReplacement;
    // The injured player starts selected, ready for a tap on the bench.
    if (forced >= 0 && !forcedSub && this.selectedOut < 0 && this.selectedIn < 0) this.selectedOut = forced;
    this.root.classList.toggle('is-disabled', disabled);
    this.root.classList.toggle('is-locked', locked);
    const name = (/** @type {number} */ i) => `#${s.players[i].cold.number} ${s.players[i].shortName}`;

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
      forcedEl.classList.toggle('is-injury', forced >= 0);
      if (forced >= 0) {
        // Mandatory: no "play on" here, the injured player must be replaced.
        forcedEl.innerHTML = `<strong>${this.locale.t('prompts.injuryReplace', { player: name(forced) })}</strong>
          <span>${this.locale.t(forcedSub ? 'prompts.injuryConfirm' : 'prompts.injuryChoose')}</span>`;
      } else if (team.forcedDecision) {
        forcedEl.innerHTML = `<strong>${this.locale.t('prompts.forcedDecision')}</strong>
          <span>${this.locale.t('prompts.gkSentOffHint')}</span>
          <button type="button" class="btn btn-sm" data-forced-none="1">${this.locale.t('buttons.playOnWithoutSub')}</button>`;
      }
    }
    const hintEl = this.root.querySelector('#mgr-hint');
    if (hintEl) hintEl.textContent = this.locale.t(locked ? 'panels.pendingLocked' : 'panels.managerHint');
    const pendTitle = this.root.querySelector('#mgr-pending-title');
    if (pendTitle) pendTitle.textContent = this.locale.t('panels.pending');

    const pendingTeam = s.pendingSubs.filter((/** @type {any} */ p) => p.teamIndex === this.teamIndex);
    const pendingOutSet = new Set(pendingTeam.map((/** @type {any} */ p) => p.outIndex));
    const pendingInSet = new Set(pendingTeam.map((/** @type {any} */ p) => p.inIndex));
    const stagedOutMap = new Map(this.stagedSubs.map((sub) => [sub.outIndex, sub.inIndex]));
    const stagedInMap = new Map(this.stagedSubs.map((sub) => [sub.inIndex, sub.outIndex]));
    const subsLeft = Math.max(0, 5 - team.subsUsed - pendingTeam.length - this.stagedSubs.length);
    const subsEl = this.root.querySelector('#mgr-subs-left');
    const win = this.#windowsLeft(s, team, pendingTeam);
    const winText = win.halfTime ? this.locale.t('panels.windowsHalfTime') : this.locale.t('panels.windowsLeft', { left: String(win.left), max: String(win.max) });
    if (subsEl) subsEl.textContent = `${this.locale.t('panels.subs')}: ${subsLeft}/5 · ${winText}`;

    const formTitle = this.root.querySelector('#mgr-form-title');
    if (formTitle) formTitle.textContent = this.locale.t('panels.formation');
    const benchTitle = this.root.querySelector('#mgr-bench-title');
    if (benchTitle) benchTitle.textContent = this.locale.t('panels.bench');

    const hasPlans = team.tacticalPlans !== null && team.tacticalPlans !== undefined;
    const liveFormation = pendingTargetFormation(s, this.teamIndex) ?? team.formationId;
    const activeFormation = this.stagedFormation ?? liveFormation;
    const formBtnsEl = this.root.querySelector('#mgr-form-btns');
    const planBadgeEl = this.root.querySelector('#mgr-plan-badge');
    if (formBtnsEl) formBtnsEl.classList.toggle('is-hidden', hasPlans);
    if (planBadgeEl) {
      planBadgeEl.classList.toggle('is-hidden', !hasPlans);
      if (hasPlans) {
        const planLabel = this.locale.t(team.activePlan === 'B' ? 'tacticPlan.planB' : 'tacticPlan.planA');
        const fKey = `formations.${activeFormation}`;
        const fText = this.locale.t(fKey);
        const formLabel = fText === fKey ? activeFormation : fText;
        planBadgeEl.textContent = `${planLabel} · ${formLabel}`;
      }
    }
    for (const btn of Array.from(this.root.querySelectorAll('[data-formation]'))) {
      btn.classList.toggle('btn-primary', btn.getAttribute('data-formation') === activeFormation);
      /** @type {HTMLButtonElement} */ (btn).disabled = disabled || locked || hasPlans;
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
      confirmBtn.disabled = disabled || locked || !hasDraft || (forced >= 0 && !forcedSub);
    }
    if (discardBtn) {
      discardBtn.textContent = this.locale.t('buttons.cancel');
      discardBtn.disabled = disabled || locked || !hasDraft;
    }
    const submitted = pendingSubmission(s, this.teamIndex);

    const baseKey = [
      this.locale.getLocale(),
      this.errorMsg,
      this.confirmedMsg,
      hasPlans ? 1 : 0,
      team.activePlan ?? '',
      team.formationId,
      activeFormation,
      this.stagedFormation ?? '',
      team.subsUsed,
      team.forcedDecision ? team.forcedKind : 0,
      this.selectedOut,
      this.selectedIn,
      disabled ? 1 : 0,
      locked ? 1 : 0,
      forced,
      submitted.map((it) => JSON.stringify(it)).join(','),
      this.stagedSwaps.map(([a, b]) => `${a}-${b}`).join(','),
      this.stagedSubs.map((sub) => `${sub.outIndex}-${sub.inIndex}`).join(','),
      pendingTeam.map((/** @type {any} */ sub) => `${sub.seq}:${sub.outIndex}-${sub.inIndex}`).join(','),
      onPitch.map((p) => `${p.index}:${p.slot}:${telemetryKey(p)}`).join(','),
      bench.map((p) => `${p.index}:${telemetryKey(p)}`).join(','),
    ].join('|');
    if (baseKey === this._lastRenderKey) return;
    this._lastRenderKey = baseKey;

    // Preview slot assignments: apply staged or queued formation optimal fit, then staged swaps
    const slotByPlayer =
      (this.stagedFormation !== null || activeFormation !== team.formationId) && s.config?.roles
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

    // One Pending list: what this team has confirmed and the match has not carried out yet, then the
    // drafts staged since (the injured player's replacement first).
    const pendEl = this.root.querySelector('#mgr-pending-list');
    if (pendEl) {
      const cancel = this.locale.t('buttons.cancel');
      const tag = `<span class="mgr-pend-tag">${this.locale.t('panels.pendingSubmitted')}</span>`;
      /** @param {string} cls @param {string} label @param {string} [btn] */
      const item = (cls, label, btn = '') => `<div class="mgr-pend-item ${cls}"><span>${label}</span>${btn}</div>`;
      /** @param {any} it */
      const labelOf = (it) => {
        if (it.kind === 'PLAN_SWITCH') {
          const plan = this.locale.t(it.plan === 'B' ? 'tacticPlan.planB' : 'tacticPlan.planA');
          return this.locale.t('tacticPlan.switchQueued', { plan });
        }
        if (it.kind === 'INSTRUCTIONS') return this.locale.t('panels.pendingInstructions');
        if (it.kind === 'FORMATION') return this.locale.t('panels.pendingFormation', { formation: it.formationId });
        if (it.kind === 'SWAP') return this.locale.t('panels.pendingSwap', { a: name(it.playerA), b: name(it.playerB) });
        return this.locale.t('panels.pendingSub', { out: name(it.outIndex), in: name(it.inIndex) });
      };
      const items = submitted.map((it) => {
        const btn =
          it.kind === 'SUB'
            ? `<button type="button" class="btn btn-sm" data-cancel-seq="${it.seq}">${cancel}</button>`
            : it.kind === 'PLAN_SWITCH'
              ? `<button type="button" class="btn btn-sm" data-cancel-plan="1">${this.locale.t('tacticPlan.cancelSwitch')}</button>`
              : '';
        return item('is-queued', `${labelOf(it)}${tag}`, btn);
      });
      if (this.stagedFormation !== null) items.push(item('is-draft', labelOf({ kind: 'FORMATION', formationId: this.stagedFormation })));
      const subOrder = this.stagedSubs.map((sub, idx) => ({ sub, idx })).sort((a, b) => Number(b.sub === forcedSub) - Number(a.sub === forcedSub));
      for (const { sub, idx } of subOrder) {
        const cls = sub === forcedSub ? 'is-draft is-forced' : 'is-draft';
        items.push(item(cls, labelOf({ kind: 'SUB', ...sub }), `<button type="button" class="btn btn-sm" data-undo-sub="${idx}">${cancel}</button>`));
      }
      this.stagedSwaps.forEach(([a, b], idx) => {
        items.push(item('is-draft', labelOf({ kind: 'SWAP', playerA: a, playerB: b }), `<button type="button" class="btn btn-sm" data-undo-swap="${idx}">${cancel}</button>`));
      });
      pendEl.innerHTML = items.length > 0 ? items.join('') : '<span class="muted">—</span>';
    }

    const mapEl = this.root.querySelector('#mgr-minimap');
    if (mapEl) {
      const nodesHtml = onPitch
        .map((p, idx) => {
          const slIdx = slotByPlayer.get(p.index) ?? idx;
          const slot = slots[slIdx >= 0 ? slIdx : idx] ?? slots[0];
          const { leftPct, topPct } = miniPitchCoords(slot?.defend);
          const sel = (this.selectedOut === p.index ? ' is-selected' : '') + (p.index === forced ? ' is-forced' : '');
          const stagedIn = stagedOutMap.get(p.index);
          const pend = pendingOutSet.has(p.index) || stagedIn !== undefined ? ' is-pending-out' : '';
          const pos = positionLabel(positionCode(slot), this.locale);
          const subTag = stagedIn !== undefined ? `<span class="mgr-b-sub">→#${s.players[stagedIn].cold.number}</span>` : pendingOutSet.has(p.index) ? '<span class="mgr-b-sub">⇄</span>' : '';
          const tel = telemetryHtml(p, this.locale);
          return `<button type="button" class="mgr-node${sel}${pend}" data-out-index="${p.index}" style="left:${leftPct.toFixed(1)}%;top:${topPct.toFixed(1)}%;" ${disabled || locked ? 'disabled' : ''}>
            <span class="mgr-node-top">
              <span class="mgr-role-tag" title="${pos.name}">${pos.abbr}</span>
              ${tel.rating}${tel.badges}${subTag}
            </span>
            <span class="mgr-node-name">${p.shortName}</span>
            ${tel.fitness}
            ${tel.morale}
          </button>`;
        })
        .join('');
      mapEl.innerHTML = MINI_PITCH_LINES_HTML + nodesHtml;
    }

    const bnEl = this.root.querySelector('#mgr-bench');
    if (bnEl) {
      bnEl.innerHTML = bench
        .map((p) => {
          const sel = this.selectedIn === p.index ? ' is-selected' : '';
          const stagedOut = stagedInMap.get(p.index);
          const pend = pendingInSet.has(p.index) || stagedOut !== undefined ? ' is-pending-in' : '';
          const pos = positionLabel(roleCode(p.cold.role), this.locale);
          const linkTag = stagedOut !== undefined ? ` <span class="mgr-b-sub">←#${s.players[stagedOut].cold.number}</span>` : '';
          const tel = telemetryHtml(p, this.locale);
          return `<button type="button" class="mgr-player${sel}${pend}" data-in-index="${p.index}" ${disabled || locked ? 'disabled' : ''}>
            <span class="mgr-bench-name"><span class="mgr-role-tag" title="${pos.name}">${pos.abbr}</span> #${p.cold.number} ${p.shortName}${linkTag}</span>
            <span class="mgr-bench-tel">${tel.rating}${tel.fitness}${tel.morale}${tel.badges}</span>
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
