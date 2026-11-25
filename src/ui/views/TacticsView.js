/**
 * Tactics panel (docs/designs/tactics_instructions.md): the human team's instructions in two tabs, In possession
 * (`Com Bola`) and Out of possession (`Sem Bola`), one row per instruction with a segmented control and a one-line
 * hint naming the chosen option's trade-off. A dot marks a tab with options off their default.
 *
 * Choices are staged; Confirm sends one SET_INSTRUCTIONS with every instruction, carried out at the next stoppage
 * (at once when the ball is already dead), and a later Confirm replaces one still waiting. Reset stages the
 * defaults. The rows are built from `config.tactics.instructions`, so a new instruction or option needs only config
 * and strings. Disabled while playbackState === 'REPLAY'.
 */
import { View } from './View.js';
import { formatCommandError } from './ManagerView.js';
import { defaultInstructions, normalizeInstructions } from '../../engine/tactics/Instructions.js';
import { pendingInstructions } from '../../runtime/managerPending.js';

const PARTIAL = `
<div class="tactics-panel">
  <div class="mgr-error is-hidden" id="tac-error" role="alert"></div>
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
    this.errorMsg = '';
    this.lastState = null;
    this.lastPlaybackState = 'PAUSED';
    this._lastRenderKey = '';
  }

  /** The instructions the team plays with now. */
  get current() {
    return normalizeInstructions(this.cfg, this.lastState?.teams[this.teamIndex].instructions);
  }

  /** Confirmed instructions still waiting for a stoppage, or null. */
  get pending() {
    return this.lastState ? (pendingInstructions(this.lastState, this.teamIndex)?.instructions ?? null) : null;
  }

  /** What the panel shows: the draft, else what waits for the next stoppage, else what is in effect. */
  get shown() {
    return this.draft ?? this.pending ?? this.current;
  }

  /** Whether Confirm would change anything (the draft differs from what is waiting or in effect). */
  get dirty() {
    return this.draft !== null && !sameInstructions(this.draft, this.pending ?? this.current);
  }

  /** Drops the staged choices (closing the panel without confirming). */
  discardDraft() {
    this.draft = null;
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

  /** Stages every instruction at its default. */
  reset() {
    if (this.lastPlaybackState === 'REPLAY') return;
    this.draft = defaultInstructions(this.cfg);
    this.errorMsg = '';
    this.#render();
  }

  /** Sends the staged instructions (all of them) as one SET_INSTRUCTIONS. */
  confirm() {
    if (!this.lastState || this.lastPlaybackState === 'REPLAY' || !this.dirty || this.draft === null) return;
    const res = this.onCommand({ issuer: 'human', type: 'SET_INSTRUCTIONS', teamIndex: this.teamIndex, payload: { instructions: { ...this.draft } } });
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

  #render() {
    if (!this.root) return;
    const t = (/** @type {string} */ k) => this.locale.t(k);
    const shown = this.shown;
    const pending = this.pending;
    const disabled = this.lastPlaybackState === 'REPLAY';
    const key = [this.locale.getLocale(), this.tab, JSON.stringify(shown), JSON.stringify(pending), this.draft === null ? 0 : 1, this.dirty ? 1 : 0, disabled ? 1 : 0, this.errorMsg].join('|');
    if (key === this._lastRenderKey) return;
    this._lastRenderKey = key;
    this.root.classList.toggle('is-disabled', disabled);

    const errEl = this.root.querySelector('#tac-error');
    if (errEl) {
      errEl.textContent = this.errorMsg;
      errEl.classList.toggle('is-hidden', !this.errorMsg);
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
      const note = pending !== null && this.draft === null ? t('tactics.pendingNote') : '';
      statusEl.textContent = note;
      statusEl.classList.toggle('is-hidden', !note);
    }
    const resetBtn = /** @type {HTMLButtonElement | null} */ (this.root.querySelector('#tac-reset'));
    if (resetBtn) {
      resetBtn.textContent = t('tactics.reset');
      resetBtn.disabled = disabled || sameInstructions(shown, defaultInstructions(this.cfg));
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
