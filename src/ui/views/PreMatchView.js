/**
 * Pre-Match setup screen (docs/designs/matchday_loop_phase1.md):
 * Mobile-first 2-tab layout (`Tactics` | `Squad`) with a `PT`/`EN` toggle and sticky `Kick Off` bar.
 * - Tab 1 (`Tactics`): 10 tactical preset browser with 50%/80% familiarity bar markers, expandable
 *   60/40 formation & instruction breakdown, and Plan A / Plan B assignment (`Plan A !== Plan B`).
 * - Tab 2 (`Squad`): vertical mini-pitch (`pitchMini.js`) with `Preview Plan A` / `Preview Plan B`,
 *   binary role-fit indicators, tap-to-swap Starting XI & 7-man bench (GK restricted to slot 0),
 *   and `Auto-Pick Best XI`.
 */
import { View } from './View.js';
import { deriveEffectiveFamiliarity } from '../../engine/tactics/Familiarity.js';
import { computeOptimalSlotAssignments } from '../../engine/tactics/Formation.js';
import { positionCode, positionLabel, roleCode } from '../positions.js';
import { MINI_PITCH_LINES_HTML, miniPitchCoords } from './pitchMini.js';

const PARTIAL = `
<div class="matchday-shell pm-shell">
  <header class="md-header">
    <div class="md-header-info">
      <strong class="md-title" id="pm-title"></strong>
      <div class="md-subtitle muted" id="pm-matchup"></div>
    </div>
    <button type="button" class="btn btn-sm sb-lang" id="pm-lang-btn">PT</button>
  </header>
  <div class="md-tabs" id="pm-tabs" role="tablist"></div>
  <div class="md-body">
    <section class="pm-tab-panel" id="pm-panel-tactics">
      <p class="pm-note muted" id="pm-inmatch-note"></p>
      <div class="mgr-error is-hidden" id="pm-plan-warn" role="alert"></div>
      <div class="pm-presets" id="pm-presets"></div>
    </section>
    <section class="pm-tab-panel is-hidden" id="pm-panel-squad">
      <div class="pm-squad-bar">
        <div class="pm-preview-group" id="pm-preview-group"></div>
        <button type="button" class="btn btn-sm" id="pm-autopick" data-pm-autopick="1"></button>
      </div>
      <div class="pm-squad-layout">
        <div class="pm-pitch-col">
          <div class="pm-sec-head"><strong id="pm-xi-title"></strong><span class="muted" id="pm-xi-form"></span></div>
          <div class="mgr-minimap pm-minimap" id="pm-minimap"></div>
        </div>
        <div class="pm-bench-col">
          <strong class="muted" id="pm-bench-title"></strong>
          <div class="mgr-list pm-bench-list" id="pm-bench"></div>
        </div>
      </div>
    </section>
  </div>
  <footer class="md-footer pm-footer">
    <div class="pm-slots-summary" id="pm-slots-summary"></div>
    <button type="button" class="btn btn-primary pm-kickoff-btn" id="pm-kickoff" data-pm-kickoff="1"></button>
  </footer>
</div>
`;

/** @param {string} s */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class PreMatchView extends View {
  /**
   * @param {{
   *   locale: import('../../i18n/Locale.js').LocaleManager,
   *   session: import('../../runtime/matchday/MatchdaySession.js').MatchdaySession,
   *   config: any,
   *   onKickOff: () => void,
   * }} opts
   */
  constructor({ locale, session, config, onKickOff }) {
    super(PARTIAL);
    this.locale = locale;
    this.session = session;
    this.config = config;
    this.onKickOff = onKickOff;
    /** @type {'tactics' | 'squad'} */
    this.tab = 'tactics';
    /** @type {'A' | 'B'} */
    this.previewPlan = 'A';
    /** @type {Set<string>} */
    this.expandedPresets = new Set();
    /** Selected player index in `session.homePlayers` (0..17) for direct swap, or -1. */
    this.selectedIdx = -1;
    this.planWarn = false;
  }

  /** @param {string} id */
  #formationLabel(id) {
    const k = `formations.${id}`;
    const v = this.locale.t(k);
    return v === k ? id : v;
  }

  /** @param {'tactics' | 'squad'} tab */
  selectTab(tab) {
    if (tab !== 'tactics' && tab !== 'squad') return;
    this.tab = tab;
    this.selectedIdx = -1;
    this.#render();
  }

  /** @param {'A' | 'B'} plan */
  setPreviewPlan(plan) {
    if (plan !== 'A' && plan !== 'B') return;
    this.previewPlan = plan;
    this.selectedIdx = -1;
    this.#render();
  }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    super.mount(rootEl);
    rootEl.addEventListener('click', (ev) => {
      const el = /** @type {HTMLElement | null} */ (ev.target);
      if (el?.closest?.('#pm-lang-btn')) {
        this.locale.toggle();
        return;
      }
      const tabBtn = el?.closest?.('[data-pm-tab]');
      if (tabBtn) {
        this.selectTab(/** @type {any} */ (tabBtn.getAttribute('data-pm-tab')));
        return;
      }
      const expBtn = el?.closest?.('[data-pm-expand]');
      if (expBtn) {
        const id = expBtn.getAttribute('data-pm-expand') ?? '';
        if (this.expandedPresets.has(id)) this.expandedPresets.delete(id);
        else this.expandedPresets.add(id);
        this.#render();
        return;
      }
      const assignA = el?.closest?.('[data-assign-a]');
      if (assignA) {
        const id = assignA.getAttribute('data-assign-a') ?? '';
        this.planWarn = !this.session.setPlan('A', id);
        this.#render();
        return;
      }
      const assignB = el?.closest?.('[data-assign-b]');
      if (assignB) {
        const id = assignB.getAttribute('data-assign-b') ?? '';
        this.planWarn = !this.session.setPlan('B', id);
        this.#render();
        return;
      }
      const prevBtn = el?.closest?.('[data-pm-preview]');
      if (prevBtn) {
        this.setPreviewPlan(/** @type {any} */ (prevBtn.getAttribute('data-pm-preview')));
        return;
      }
      if (el?.closest?.('[data-pm-autopick]')) {
        this.session.autoPick();
        this.selectedIdx = -1;
        this.#render();
        return;
      }
      const playerBtn = el?.closest?.('[data-pm-player]');
      if (playerBtn) {
        const idx = Number(playerBtn.getAttribute('data-pm-player'));
        if (!Number.isInteger(idx)) return;
        if (this.selectedIdx < 0) {
          this.selectedIdx = idx;
        } else if (this.selectedIdx === idx) {
          this.selectedIdx = -1;
        } else {
          this.session.swapPlayers(this.selectedIdx, idx);
          this.selectedIdx = -1;
        }
        this.#render();
        return;
      }
      if (el?.closest?.('[data-pm-kickoff]')) {
        this.onKickOff();
      }
    });
    this._unsub = this.locale.onChange(() => this.#render());
    this.#render();
  }

  #render() {
    if (!this.root) return;
    const t = (/** @type {string} */ k) => this.locale.t(k);
    const famRec = this.session.familiarity;
    const presets = this.config.tacticalPresets.presets;

    const titleEl = this.root.querySelector('#pm-title');
    if (titleEl) titleEl.textContent = t('preMatch.title');
    const matchupEl = this.root.querySelector('#pm-matchup');
    if (matchupEl) matchupEl.textContent = `${this.session.homeSquad.name} vs ${this.session.awaySquad.name}`;
    const langBtn = this.root.querySelector('#pm-lang-btn');
    if (langBtn) langBtn.textContent = this.locale.getLocale() === 'pt-PT' ? 'PT' : 'EN';

    const tabsEl = this.root.querySelector('#pm-tabs');
    if (tabsEl) {
      tabsEl.innerHTML = [
        { id: 'tactics', label: t('preMatch.tabTactics') },
        { id: 'squad', label: t('preMatch.tabSquad') },
      ]
        .map((tab) => {
          const on = this.tab === tab.id;
          return `<button type="button" class="md-tab${on ? ' is-active' : ''}" role="tab" aria-selected="${on}" data-pm-tab="${tab.id}">${esc(tab.label)}</button>`;
        })
        .join('');
    }

    const tacPanel = this.root.querySelector('#pm-panel-tactics');
    const sqPanel = this.root.querySelector('#pm-panel-squad');
    tacPanel?.classList.toggle('is-hidden', this.tab !== 'tactics');
    sqPanel?.classList.toggle('is-hidden', this.tab !== 'squad');

    const noteEl = this.root.querySelector('#pm-inmatch-note');
    if (noteEl) noteEl.textContent = t('preMatch.inMatchNote');

    const warnEl = this.root.querySelector('#pm-plan-warn');
    if (warnEl) {
      warnEl.textContent = this.planWarn ? t('preMatch.planMustDiffer') : '';
      warnEl.classList.toggle('is-hidden', !this.planWarn);
    }

    // Tab 1: 10 tactical presets
    const presetsEl = this.root.querySelector('#pm-presets');
    if (presetsEl) {
      presetsEl.innerHTML = presets
        .map((/** @type {any} */ preset) => {
          const isA = famRec.planA === preset.id;
          const isB = famRec.planB === preset.id;
          const formFam = famRec.formations[preset.formationId] ?? 50;
          const instrFam = famRec.tactics[preset.id] ?? 50;
          const fam = deriveEffectiveFamiliarity(
            this.config.tactics.instructions,
            { formFam, instrFam, instructions: preset.instructions },
            preset.instructions,
          );
          const expanded = this.expandedPresets.has(preset.id);
          const tierLabel = t(`tacticPlan.${fam.tier}`);
          const formLabel = this.#formationLabel(preset.formationId);
          const slotBadge = isA
            ? `<span class="pm-slot-badge is-a">${esc(t('tacticPlan.planA'))}</span>`
            : isB
              ? `<span class="pm-slot-badge is-b">${esc(t('tacticPlan.planB'))}</span>`
              : '';
          const capNote = fam.capped
            ? `<div class="pm-fam-cap">${esc(
                this.locale.t('tacticPlan.partBelowMin', {
                  part: fam.formFam <= fam.instrFamLive ? t('tacticPlan.formation') : t('tacticPlan.instructions'),
                  min: 65,
                }),
              )}</div>`
            : '';
          const breakdown = expanded
            ? `<div class="pm-fam-breakdown">
                <span>${esc(t('tacticPlan.formation'))} (60%): <strong>${fam.formFam}%</strong></span>
                <span>${esc(t('tacticPlan.instructions'))} (40%): <strong>${fam.instrFamLive}%</strong></span>
                ${capNote}
              </div>`
            : '';
          return `<div class="pm-preset-card${isA ? ' is-plan-a' : ''}${isB ? ' is-plan-b' : ''}" data-preset-id="${preset.id}">
            <div class="pm-preset-head">
              <div class="pm-preset-title">
                <strong>${esc(t(`tacticPresets.${preset.id}`))}</strong>
                <span class="pm-form-tag">${esc(formLabel)}</span>
                ${slotBadge}
              </div>
              <button type="button" class="pm-fam-summary" data-pm-expand="${preset.id}" aria-expanded="${expanded}">
                <span class="fam-tier is-${fam.tier}">${fam.effective}% · ${esc(tierLabel)}</span>
                <span class="pm-chevron" aria-hidden="true">${expanded ? '▾' : '▸'}</span>
              </button>
            </div>
            <div class="pm-preset-hint muted">${esc(t(`tacticPresets.${preset.id}Hint`))}</div>
            <div class="pm-fam-bar" aria-label="${fam.effective}%">
              <div class="pm-fam-fill is-${fam.tier}" style="width:${fam.effective}%"></div>
              <span class="pm-fam-tick" style="left:50%"></span>
              <span class="pm-fam-tick" style="left:80%"></span>
            </div>
            ${breakdown}
            <div class="pm-preset-actions">
              <button type="button" class="btn btn-sm${isA ? ' btn-primary' : ''}" data-assign-a="${preset.id}"${isA ? ' disabled' : ''}>${esc(t('preMatch.assignPlanA'))}</button>
              <button type="button" class="btn btn-sm${isB ? ' btn-primary' : ''}" data-assign-b="${preset.id}"${isB ? ' disabled' : ''}>${esc(t('preMatch.assignPlanB'))}</button>
            </div>
          </div>`;
        })
        .join('');
    }

    // Tab 2: Squad & Mini-Pitch
    const previewGroup = this.root.querySelector('#pm-preview-group');
    if (previewGroup) {
      previewGroup.innerHTML = [
        { plan: 'A', label: t('preMatch.previewPlanA') },
        { plan: 'B', label: t('preMatch.previewPlanB') },
      ]
        .map(
          (p) =>
            `<button type="button" class="btn btn-sm${this.previewPlan === p.plan ? ' btn-primary' : ''}" data-pm-preview="${p.plan}">${esc(p.label)}</button>`,
        )
        .join('');
    }
    const autoBtn = this.root.querySelector('#pm-autopick');
    if (autoBtn) autoBtn.textContent = t('preMatch.autoPick');
    const xiTitle = this.root.querySelector('#pm-xi-title');
    if (xiTitle) xiTitle.textContent = t('preMatch.startingXI');
    const benchTitle = this.root.querySelector('#pm-bench-title');
    if (benchTitle) benchTitle.textContent = t('preMatch.bench');

    const activePreset = this.session.presetById(this.previewPlan === 'B' ? famRec.planB : famRec.planA);
    const activeSlots = this.config.tactics.formations[activePreset.formationId].slots;
    const xiForm = this.root.querySelector('#pm-xi-form');
    if (xiForm) xiForm.textContent = `${this.#formationLabel(activePreset.formationId)} · ${t(`tacticPresets.${activePreset.id}`)}`;

    const starters = this.session.homePlayers.slice(0, 11);
    const bench = this.session.homePlayers.slice(11);
    /** @type {Map<number, number>} */
    const slotByStarterIdx =
      this.previewPlan === 'B'
        ? computeOptimalSlotAssignments(starters, activeSlots, this.config.roles)
        : new Map(starters.map((_, i) => [i, i]));

    const mapEl = this.root.querySelector('#pm-minimap');
    if (mapEl) {
      const nodesHtml = starters
        .map((p, idx) => {
          const slotIdx = slotByStarterIdx.get(idx) ?? idx;
          const slot = activeSlots[slotIdx] ?? activeSlots[0];
          const { leftPct, topPct } = miniPitchCoords(slot?.defend);
          const pos = positionLabel(positionCode(slot), this.locale);
          const fit = p.role === slot?.role;
          const sel = this.selectedIdx === idx ? ' is-selected' : '';
          const fitCls = fit ? ' is-fit' : ' is-oop';
          const fitDot = fit ? '' : '<span class="pm-oop-dot" title="!">!</span>';
          return `<button type="button" class="mgr-node pm-node${sel}${fitCls}" data-pm-player="${idx}" style="left:${leftPct.toFixed(1)}%;top:${topPct.toFixed(1)}%;">
            <span class="mgr-node-top">
              <span class="mgr-role-tag" title="${esc(pos.name)}">${esc(pos.abbr)}</span>
              <span class="pm-num">#${p.number}</span>${fitDot}
            </span>
            <span class="mgr-node-name">${esc(p.shortName || p.name)}</span>
          </button>`;
        })
        .join('');
      mapEl.innerHTML = MINI_PITCH_LINES_HTML + nodesHtml;
    }

    const benchEl = this.root.querySelector('#pm-bench');
    if (benchEl) {
      benchEl.innerHTML = bench
        .map((p, offset) => {
          const idx = 11 + offset;
          const pos = positionLabel(roleCode(p.role), this.locale);
          const sel = this.selectedIdx === idx ? ' is-selected' : '';
          return `<button type="button" class="mgr-player pm-bench-row${sel}" data-pm-player="${idx}">
            <span class="mgr-bench-name"><span class="mgr-role-tag" title="${esc(pos.name)}">${esc(pos.abbr)}</span> #${p.number} ${esc(p.shortName || p.name)}</span>
          </button>`;
        })
        .join('');
    }

    // Sticky Footer
    const planA = this.session.presetById(famRec.planA);
    const planB = this.session.presetById(famRec.planB);
    const summaryEl = this.root.querySelector('#pm-slots-summary');
    if (summaryEl) {
      summaryEl.innerHTML =
        `<span class="pm-foot-chip is-a"><strong>${esc(t('tacticPlan.planA'))}:</strong> ${esc(t(`tacticPresets.${planA.id}`))} (${esc(this.#formationLabel(planA.formationId))})</span>` +
        `<span class="pm-foot-chip is-b"><strong>${esc(t('tacticPlan.planB'))}:</strong> ${esc(t(`tacticPresets.${planB.id}`))} (${esc(this.#formationLabel(planB.formationId))})</span>`;
    }
    const kickoffBtn = this.root.querySelector('#pm-kickoff');
    if (kickoffBtn) kickoffBtn.textContent = t('preMatch.kickOff');
  }

  destroy() {
    this._unsub?.();
    super.destroy();
  }
}
