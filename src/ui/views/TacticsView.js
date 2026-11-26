/**
 * Tactics panel (docs/designs/tactics_instructions.md & docs/designs/matchday_loop_phase1.md):
 * - When `team.tacticalPlans !== null`, displays a Plan A / Plan B pill bar with live familiarity %
 *   and tier, staged Plan switch preview (with out-of-position count & familiarity delta preview),
 *   and a "Reset to plan" action.
 * - Below (or standalone when `tacticalPlans === null`), displays the team's nine instructions in
 *   two tabs: In possession (`Com Bola`) and Out of possession (`Sem Bola`).
 * - Disabled while `playbackState === 'REPLAY'`.
 */
import { View } from './View.js';
import { formatCommandError } from './ManagerView.js';
import { defaultInstructions, normalizeInstructions } from '../../engine/tactics/Instructions.js';
import { deriveEffectiveFamiliarity } from '../../engine/tactics/Familiarity.js';
import { computeOptimalSlotAssignments } from '../../engine/tactics/Formation.js';
import { pendingInstructions, pendingPlanSwitch } from '../../runtime/managerPending.js';

const PARTIAL = `
<div class="tactics-panel">
  <div class="mgr-error is-hidden" id="tac-error" role="alert"></div>
  <div class="tac-plan-bar is-hidden" id="tac-plan-bar"></div>
  <div class="tac-fam-preview is-hidden" id="tac-fam-preview"></div>
  <div class="tac-tabs" id="tac-tabs" role="tablist"></div>
  <div class="tac-rows" id="tac-rows"></div>
  <div class="tac-status is-hidden" id="tac-status" role="status"></div>
  <div class="mgr-footer">
    <button type="button" class="btn btn-sm" id="tac-reset" data-tac-reset="1"></button>
    <button type="button" class="btn btn-sm btn-primary" id="tac-confirm" data-tac-confirm="1"></button>
  </div>
</div>
`;

/** The two tabs, in order. */
export const TACTICS_GROUPS = Object.freeze(['inPossession', 'outOfPossession']);

/** @param {string} s */
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** @param {string} s */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param {Record<string, string>} a
 * @param {Record<string, string>} b
 */
const sameInstructions = (a, b) => Object.keys(a).every((k) => a[k] === b[k]) && Object.keys(b).every((k) => a[k] === b[k]);

export class TacticsView extends View {
  /**
   * @param {{
   *   locale: import('../../i18n/Locale.js').LocaleManager,
   *   instructions: Record<string, any>,
   *   teamIndex?: number,
   *   onCommand: (cmd: {issuer: 'human', type: string, teamIndex: number, payload: Record<string, any>}) => {ok: boolean, code: string | null},
   * }} opts
   */
  constructor({ locale, instructions, teamIndex = 0, onCommand }) {
    super(PARTIAL);
    this.locale = locale;
    this.cfg = instructions;
    this.teamIndex = teamIndex;
    this.onCommand = onCommand;
    /** @type {'inPossession' | 'outOfPossession'} */
    this.tab = 'inPossession';
    /** Staged choices, or null while nothing is staged (the panel then shows what is in effect or waiting). */
    /** @type {Record<string, string> | null} */
    this.draft = null;
    /** Staged tactical plan switch ('A' or 'B'), or null when no plan switch is staged. */
    /** @type {'A' | 'B' | null} */
    this.stagedPlan = null;
    this.errorMsg = '';
    this.lastState = null;
    this.lastPlaybackState = 'PAUSED';
    this._lastRenderKey = '';
  }

  /** @returns {any} */
  #team() {
    return this.lastState?.teams?.[this.teamIndex] ?? null;
  }

  /**
   * @param {'A' | 'B'} plan
   * @returns {any}
   */
  #planSlot(plan) {
    const plans = this.#team()?.tacticalPlans;
    if (!plans) return null;
    return plan === 'B' ? plans.planB : plans.planA;
  }

  /** @param {string} id */
  #formationLabel(id) {
    const k = `formations.${id}`;
    const v = this.locale.t(k);
    return v === k ? id : v;
  }

  /** The instructions the team plays with now. */
  get current() {
    return normalizeInstructions(this.cfg, this.#team()?.instructions);
  }

  /** Confirmed instructions still waiting for a stoppage, or null. */
  get pending() {
    return this.lastState ? (pendingInstructions(this.lastState, this.teamIndex)?.instructions ?? null) : null;
  }

  /** Confirmed Plan A/B switch still waiting for a stoppage, or null. */
  get pendingPlan() {
    return this.lastState ? pendingPlanSwitch(this.lastState, this.teamIndex) : null;
  }

  /** The tactical plan slot currently targeted by staging, queued switch, or active play. */
  get targetPlan() {
    const team = this.#team();
    return /** @type {'A' | 'B'} */ (this.stagedPlan ?? this.pendingPlan?.plan ?? team?.activePlan ?? 'A');
  }

  /** Instructions baseline before any local `this.draft` tweaks. */
  get baseline() {
    const team = this.#team();
    if (team?.tacticalPlans) {
      if (this.stagedPlan !== null) {
        return normalizeInstructions(this.cfg, this.#planSlot(this.stagedPlan)?.instructions);
      }
      if (this.pending !== null) return this.pending;
      if (this.pendingPlan !== null) {
        return normalizeInstructions(this.cfg, this.#planSlot(this.pendingPlan.plan)?.instructions);
      }
      return this.current;
    }
    return this.pending ?? this.current;
  }

  /** What the panel shows: the draft, else what waits for the next stoppage, else what is in effect. */
  get shown() {
    return this.draft ?? this.baseline;
  }

  /** Whether Confirm would change anything (a staged plan switch or a draft differing from baseline). */
  get dirty() {
    if (this.stagedPlan !== null) return true;
    return this.draft !== null && !sameInstructions(this.draft, this.baseline);
  }

  /** Drops the staged choices (closing the panel without confirming). */
  discardDraft() {
    this.draft = null;
    this.stagedPlan = null;
    this.errorMsg = '';
    this._lastRenderKey = '';
    this.#render();
  }

  /** @param {'inPossession' | 'outOfPossession'} group */
  selectTab(group) {
    if (!TACTICS_GROUPS.includes(group)) return;
    this.tab = group;
    this.#render();
  }

  /**
   * Stages a Plan A / Plan B switch (or cancels a queued switch when tapping the active plan).
   * @param {'A' | 'B'} plan
   */
  selectPlan(plan) {
    const team = this.#team();
    if (this.lastPlaybackState === 'REPLAY' || !team?.tacticalPlans || (plan !== 'A' && plan !== 'B')) return;
    this.errorMsg = '';
    if (plan === team.activePlan) {
      if (this.pendingPlan !== null) {
        const res = this.onCommand({ issuer: 'human', type: 'CANCEL_TACTIC_PLAN', teamIndex: this.teamIndex, payload: {} });
        this.errorMsg = formatCommandError(res, this.locale) ?? '';
      }
      this.stagedPlan = null;
      this.draft = null;
    } else if (this.pendingPlan?.plan === plan) {
      this.stagedPlan = null;
      this.draft = null;
    } else {
      this.stagedPlan = this.stagedPlan === plan ? null : plan;
      this.draft = null;
    }
    this._lastRenderKey = '';
    this.#render();
  }

  /**
   * Stages one option.
   * @param {string} id
   * @param {string} option
   */
  choose(id, option) {
    if (this.lastPlaybackState === 'REPLAY' || !this.cfg[id] || !(option in this.cfg[id].options)) return;
    this.draft = { ...this.shown, [id]: option };
    this.errorMsg = '';
    this.#render();
  }

  /** Stages every instruction at its active plan's trained values (or global defaults without plans). */
  reset() {
    if (this.lastPlaybackState === 'REPLAY') return;
    const slot = this.#planSlot(this.targetPlan);
    this.draft = slot ? normalizeInstructions(this.cfg, slot.instructions) : defaultInstructions(this.cfg);
    this.errorMsg = '';
    this.#render();
  }

  /** Sends staged plan switch and/or instructions. */
  confirm() {
    if (!this.lastState || this.lastPlaybackState === 'REPLAY' || !this.dirty) return;
    if (this.stagedPlan !== null) {
      const targetPlan = this.stagedPlan;
      const targetSlot = this.#planSlot(targetPlan);
      const res = this.onCommand({
        issuer: 'human',
        type: 'SWITCH_TACTIC_PLAN',
        teamIndex: this.teamIndex,
        payload: { plan: targetPlan },
      });
      this.errorMsg = formatCommandError(res, this.locale) ?? '';
      if (!res.ok) {
        this._lastRenderKey = '';
        this.#render();
        return;
      }
      this.stagedPlan = null;
      const trained = normalizeInstructions(this.cfg, targetSlot?.instructions);
      if (this.draft !== null && !sameInstructions(this.draft, trained)) {
        const res2 = this.onCommand({
          issuer: 'human',
          type: 'SET_INSTRUCTIONS',
          teamIndex: this.teamIndex,
          payload: { instructions: { ...this.draft } },
        });
        this.errorMsg = formatCommandError(res2, this.locale) ?? '';
        if (res2.ok) this.draft = null;
      } else {
        this.draft = null;
      }
      this._lastRenderKey = '';
      this.#render();
      return;
    }

    if (this.draft === null) return;
    const res = this.onCommand({
      issuer: 'human',
      type: 'SET_INSTRUCTIONS',
      teamIndex: this.teamIndex,
      payload: { instructions: { ...this.draft } },
    });
    this.errorMsg = formatCommandError(res, this.locale) ?? '';
    if (res.ok) this.draft = null;
    this._lastRenderKey = '';
    this.#render();
  }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    super.mount(rootEl);
    rootEl.addEventListener('click', (ev) => {
      const el = /** @type {HTMLElement | null} */ (ev.target);
      const planBtn = el?.closest?.('[data-plan]');
      if (planBtn) {
        this.selectPlan(/** @type {any} */ (planBtn.getAttribute('data-plan')));
        return;
      }
      const tab = el?.closest?.('[data-tac-tab]');
      if (tab) {
        this.selectTab(/** @type {any} */ (tab.getAttribute('data-tac-tab')));
        return;
      }
      const opt = el?.closest?.('[data-instr]');
      if (opt) {
        this.choose(opt.getAttribute('data-instr') ?? '', opt.getAttribute('data-opt') ?? '');
        return;
      }
      if (el?.closest?.('[data-tac-reset]')) {
        this.reset();
        return;
      }
      if (el?.closest?.('[data-tac-confirm]')) this.confirm();
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

  /**
   * Counts how many currently on-pitch players would play out of their natural role in `formationId`.
   * @param {string} formationId
   * @returns {number}
   */
  #outOfPositionCount(formationId) {
    const s = this.lastState;
    if (!s?.config?.tactics?.formations || !s.config?.roles) return 0;
    const base = this.teamIndex * 18;
    const onPitch = [];
    for (let i = base; i < base + 18; i++) {
      if (s.players[i]?.onPitch === 1) onPitch.push(s.players[i]);
    }
    const key = onPitch.length === 10 ? 'ten' : onPitch.length === 9 ? 'nine' : null;
    const effectiveFormId = key
      ? (s.config.tactics.formations[formationId]?.reducedTo?.[key] ?? s.config.tactics.emergencyShape?.[key] ?? formationId)
      : formationId;
    const slots = s.config.tactics.formations[effectiveFormId]?.slots;
    if (!slots) return 0;
    const assigned = computeOptimalSlotAssignments(onPitch, slots, s.config.roles);
    let count = 0;
    for (const p of onPitch) {
      const slotIdx = assigned.get(p.index);
      const slot = slotIdx !== undefined ? slots[slotIdx] : null;
      const role = p.cold?.role ?? p.role;
      if (slot && role !== slot.role) count++;
    }
    return count;
  }

  #render() {
    if (!this.root) return;
    const t = (/** @type {string} */ k) => this.locale.t(k);
    const team = this.#team();
    const plans = team?.tacticalPlans ?? null;
    const pendingPlan = this.pendingPlan;
    const shown = this.shown;
    const pending = this.pending;
    const disabled = this.lastPlaybackState === 'REPLAY';
    const key = [
      this.locale.getLocale(),
      this.tab,
      plans !== null ? 1 : 0,
      team?.activePlan ?? '',
      team?.formationId ?? '',
      pendingPlan?.plan ?? '',
      this.stagedPlan ?? '',
      JSON.stringify(shown),
      JSON.stringify(pending),
      this.draft === null ? 0 : 1,
      this.dirty ? 1 : 0,
      disabled ? 1 : 0,
      this.errorMsg,
    ].join('|');
    if (key === this._lastRenderKey) return;
    this._lastRenderKey = key;
    this.root.classList.toggle('is-disabled', disabled);

    const errEl = this.root.querySelector('#tac-error');
    if (errEl) {
      errEl.textContent = this.errorMsg;
      errEl.classList.toggle('is-hidden', !this.errorMsg);
    }

    const planBarEl = this.root.querySelector('#tac-plan-bar');
    const previewEl = this.root.querySelector('#tac-fam-preview');
    if (planBarEl) {
      if (!plans) {
        planBarEl.classList.add('is-hidden');
        planBarEl.innerHTML = '';
      } else {
        planBarEl.classList.remove('is-hidden');
        planBarEl.innerHTML = (/** @type {const} */ (['A', 'B']))
          .map((planKey) => {
            const slot = planKey === 'A' ? plans.planA : plans.planB;
            const isActive = team.activePlan === planKey;
            const isPending = pendingPlan?.plan === planKey;
            const isStaged = this.stagedPlan === planKey;
            const fam = deriveEffectiveFamiliarity(this.cfg, slot, isActive ? this.current : slot.instructions);
            const planLabel = t(planKey === 'A' ? 'tacticPlan.planA' : 'tacticPlan.planB');
            const presetName = t(`tacticPresets.${slot.tacticId}`);
            const formName = this.#formationLabel(slot.formationId);
            const tierName = t(`tacticPlan.${fam.tier}`);
            const badges =
              (isActive && fam.modified ? `<span class="tac-pill-badge is-modified">${esc(t('tacticPlan.modified'))}</span>` : '') +
              (isPending ? `<span class="tac-pill-badge is-queued">${esc(t('panels.pendingSubmitted'))}</span>` : '');
            const cls = `tac-plan-pill${isActive ? ' is-active' : ''}${isStaged ? ' is-staged' : ''}${isPending ? ' is-queued' : ''}`;
            return `<button type="button" class="${cls}" data-plan="${planKey}"${disabled ? ' disabled' : ''}>
              <span class="tac-pill-top"><strong>${esc(planLabel)}</strong><span class="tac-pill-form">${esc(formName)}</span>${badges}</span>
              <span class="tac-pill-sub">${esc(presetName)} · <span class="fam-tier is-${fam.tier}">${fam.effective}% ${esc(tierName)}</span></span>
            </button>`;
          })
          .join('');
      }
    }

    if (previewEl) {
      if (!plans || (this.stagedPlan === null && this.draft === null)) {
        previewEl.classList.add('is-hidden');
        previewEl.innerHTML = '';
      } else {
        const curSlot = this.#planSlot(team.activePlan);
        const curFam = deriveEffectiveFamiliarity(this.cfg, curSlot, this.current);
        const nextSlot = this.#planSlot(this.targetPlan);
        const nextFam = deriveEffectiveFamiliarity(this.cfg, nextSlot, shown);
        const parts = [
          `<span class="tac-prev-main">${esc(this.locale.t('tacticPlan.familiarityPreview', { from: curFam.effective, to: nextFam.effective }))}</span>`,
        ];
        if (nextFam.tier !== curFam.tier && nextFam.effective < curFam.effective) {
          parts.push(`<span class="tac-prev-warn">${esc(this.locale.t('tacticPlan.dropsTo', { tier: t(`tacticPlan.${nextFam.tier}`) }))}</span>`);
        }
        if (nextFam.capped) {
          const lowPart = nextFam.formFam <= nextFam.instrFamLive ? t('tacticPlan.formation') : t('tacticPlan.instructions');
          parts.push(`<span class="tac-prev-note">${esc(this.locale.t('tacticPlan.partBelowMin', { part: lowPart, min: 65 }))}</span>`);
        }
        if (this.stagedPlan !== null && nextSlot.formationId !== curSlot.formationId) {
          const oop = this.#outOfPositionCount(nextSlot.formationId);
          if (oop > 0) {
            parts.push(`<span class="tac-prev-warn">${esc(this.locale.t('tacticPlan.outOfPositionCount', { count: oop }))}</span>`);
          }
        }
        previewEl.classList.remove('is-hidden');
        previewEl.innerHTML = parts.join(' ');
      }
    }

    const changed = (/** @type {string} */ group) => Object.entries(this.cfg).some(([id, def]) => def.group === group && shown[id] !== def.default);
    const tabsEl = this.root.querySelector('#tac-tabs');
    if (tabsEl) {
      tabsEl.innerHTML = TACTICS_GROUPS.map((g) => {
        const on = g === this.tab;
        const dot = changed(g) ? '<span class="tac-dot" aria-hidden="true"></span>' : '';
        return `<button type="button" class="tac-tab${on ? ' is-active' : ''}" role="tab" aria-selected="${on}" data-tac-tab="${g}">${esc(t(`tactics.tab${cap(g)}`))}${dot}</button>`;
      }).join('');
    }

    const rowsEl = this.root.querySelector('#tac-rows');
    if (rowsEl) {
      const rows = [];
      for (const [id, def] of Object.entries(this.cfg)) {
        if (def.group !== this.tab) continue;
        const label = t(`tactics.${id}`);
        const opts = Object.keys(def.options).map((opt) => {
          const on = shown[id] === opt;
          const cls = `tac-opt${on ? ' is-active' : ''}${opt === def.default ? ' is-default' : ''}`;
          return `<button type="button" class="${cls}" role="radio" aria-checked="${on}" data-instr="${id}" data-opt="${opt}"${disabled ? ' disabled' : ''}>${esc(t(`tactics.${id}${cap(opt)}`))}</button>`;
        });
        rows.push(
          `<div class="tac-row" data-row="${id}"><div class="tac-label">${esc(label)}</div>` +
            `<div class="tac-seg" role="radiogroup" aria-label="${esc(label)}">${opts.join('')}</div>` +
            `<div class="tac-hint">${esc(t(`tactics.${id}${cap(shown[id])}Hint`))}</div></div>`,
        );
      }
      rowsEl.innerHTML = rows.join('');
    }

    const statusEl = this.root.querySelector('#tac-status');
    if (statusEl) {
      let note = '';
      if (this.draft === null && this.stagedPlan === null) {
        if (pendingPlan !== null) {
          note = this.locale.t('tacticPlan.switchQueued', {
            plan: t(pendingPlan.plan === 'B' ? 'tacticPlan.planB' : 'tacticPlan.planA'),
          });
        } else if (pending !== null) {
          note = t('tactics.pendingNote');
        }
      }
      statusEl.textContent = note;
      statusEl.classList.toggle('is-hidden', !note);
    }

    const resetBtn = /** @type {HTMLButtonElement | null} */ (this.root.querySelector('#tac-reset'));
    if (resetBtn) {
      if (plans) {
        const targetSlot = this.#planSlot(this.targetPlan);
        const trained = normalizeInstructions(this.cfg, targetSlot?.instructions);
        resetBtn.textContent = t('tacticPlan.resetToPlan');
        resetBtn.disabled = disabled || sameInstructions(shown, trained);
      } else {
        resetBtn.textContent = t('tactics.reset');
        resetBtn.disabled = disabled || sameInstructions(shown, defaultInstructions(this.cfg));
      }
    }
    const confirmBtn = /** @type {HTMLButtonElement | null} */ (this.root.querySelector('#tac-confirm'));
    if (confirmBtn) {
      confirmBtn.textContent = t('tactics.confirm');
      confirmBtn.disabled = disabled || !this.dirty;
    }
  }

  destroy() {
    this._unsub?.();
    super.destroy();
  }
}
