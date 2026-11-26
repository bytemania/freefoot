/**
 * Post-Match Report screen (docs/designs/matchday_loop_phase1.md):
 * Mobile-first 3-tab layout (`Summary` | `Events & Stats` | `Ratings`) with a `PT`/`EN` toggle
 * and a sticky `Next Match` bar. Consumes an immutable `MatchReport` snapshot.
 */
import { View } from './View.js';
import { StatsView } from './StatsView.js';
import { ratingClass } from './ManagerView.js';
import { positionLabel, roleCode } from '../positions.js';

const PARTIAL = `
<div class="matchday-shell rep-shell">
  <header class="md-header">
    <strong class="md-title" id="rep-title"></strong>
    <button type="button" class="btn btn-sm sb-lang" id="rep-lang-btn">PT</button>
  </header>
  <div class="md-tabs" id="rep-tabs" role="tablist"></div>
  <div class="md-body">
    <section class="rep-tab-panel" id="rep-panel-summary"></section>
    <section class="rep-tab-panel is-hidden" id="rep-panel-events">
      <div class="rep-card">
        <strong class="rep-card-title" id="rep-events-title"></strong>
        <div class="rep-events-list" id="rep-events-list"></div>
      </div>
      <div class="rep-card">
        <strong class="rep-card-title" id="rep-stats-title"></strong>
        <div id="rep-stats-mount"></div>
      </div>
    </section>
    <section class="rep-tab-panel is-hidden" id="rep-panel-ratings"></section>
  </div>
  <footer class="md-footer rep-footer">
    <span class="rep-next-note muted" id="rep-next-note"></span>
    <button type="button" class="btn btn-primary rep-next-btn" id="rep-next" data-rep-next="1"></button>
  </footer>
</div>
`;

/** @param {string} s */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** @param {number} eff */
const tierOf = (eff) => (eff >= 80 ? 'fluid' : eff >= 50 ? 'competent' : 'unfamiliar');

export class PostMatchReportView extends View {
  /**
   * @param {{
   *   locale: import('../../i18n/Locale.js').LocaleManager,
   *   report: import('../../runtime/matchday/MatchReport.js').MatchReport,
   *   config: any,
   *   onNextMatch: () => void,
   * }} opts
   */
  constructor({ locale, report, config, onNextMatch }) {
    super(PARTIAL);
    this.locale = locale;
    this.report = report;
    this.config = config;
    this.onNextMatch = onNextMatch;
    /** @type {'summary' | 'events' | 'ratings'} */
    this.tab = 'summary';
    this.statsView = new StatsView({ locale });
  }

  /** @param {string} id */
  #formationLabel(id) {
    const k = `formations.${id}`;
    const v = this.locale.t(k);
    return v === k ? id : v;
  }

  /** @param {'summary' | 'events' | 'ratings'} tab */
  selectTab(tab) {
    if (tab !== 'summary' && tab !== 'events' && tab !== 'ratings') return;
    this.tab = tab;
    this.#render();
  }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    super.mount(rootEl);
    const statsMount = /** @type {HTMLElement | null} */ (rootEl.querySelector('#rep-stats-mount'));
    if (statsMount) {
      this.statsView.mount(statsMount);
      this.statsView.setVisible(true);
      this.statsView.update({ stats: this.report.stats });
    }
    rootEl.addEventListener('click', (ev) => {
      const el = /** @type {HTMLElement | null} */ (ev.target);
      if (el?.closest?.('#rep-lang-btn')) {
        this.locale.toggle();
        return;
      }
      const tabBtn = el?.closest?.('[data-rep-tab]');
      if (tabBtn) {
        this.selectTab(/** @type {any} */ (tabBtn.getAttribute('data-rep-tab')));
        return;
      }
      if (el?.closest?.('[data-rep-next]')) {
        this.onNextMatch();
      }
    });
    this._unsub = this.locale.onChange(() => this.#render());
    this.#render();
  }

  /**
   * Formats one key event line.
   * @param {import('../../runtime/matchday/MatchReport.js').KeyEventEntry} ev
   */
  #formatEvent(ev) {
    const t = (/** @type {string} */ k) => this.locale.t(k);
    let badge = ev.type;
    let detail = ev.actorName;
    if (ev.type === 'GOAL') {
      badge = t('commentaryBadges.goal');
      const tag = ev.meta?.kind === 'OWN_GOAL' ? ' (OG)' : ev.meta?.kind === 'PENALTY' ? ' (P)' : '';
      detail = `${ev.actorName}${tag}`;
    } else if (ev.type === 'YELLOW_CARD') {
      badge = t('commentaryBadges.yellowCard');
    } else if (ev.type === 'RED_CARD') {
      badge = t('commentaryBadges.redCard');
    } else if (ev.type === 'VAR_DECISION') {
      badge = t('commentaryBadges.var');
      const outcome = ev.meta?.outcome;
      detail = outcome ? t(`var.${outcome}`) : ev.actorName;
    } else if (ev.type === 'SUBSTITUTION') {
      badge = t('commentaryBadges.substitution');
      detail = ev.secondaryName ? `${ev.actorName} ← ${ev.secondaryName}` : ev.actorName;
    } else if (ev.type === 'FORMATION_CHANGE') {
      badge = t('panels.formation');
      const formId = ev.meta?.baseFormationId ?? ev.meta?.formationId ?? '';
      detail = formId ? this.#formationLabel(String(formId)) : '';
    }
    const cls = `rep-ev-row${ev.overturned ? ' is-overturned' : ''}`;
    return `<div class="${cls}">
      <span class="rep-ev-min">${esc(ev.minute)}</span>
      <span class="rep-ev-badge is-${ev.type.toLowerCase()}">${esc(badge)}</span>
      <span class="rep-ev-detail">${esc(detail)}</span>
    </div>`;
  }

  #render() {
    if (!this.root) return;
    const t = (/** @type {string} */ k) => this.locale.t(k);
    const r = this.report;

    const titleEl = this.root.querySelector('#rep-title');
    if (titleEl) titleEl.textContent = t('matchReport.title');
    const langBtn = this.root.querySelector('#rep-lang-btn');
    if (langBtn) langBtn.textContent = this.locale.getLocale() === 'pt-PT' ? 'PT' : 'EN';

    const tabsEl = this.root.querySelector('#rep-tabs');
    if (tabsEl) {
      tabsEl.innerHTML = [
        { id: 'summary', label: t('matchReport.tabSummary') },
        { id: 'events', label: t('matchReport.tabEventsStats') },
        { id: 'ratings', label: t('matchReport.tabRatings') },
      ]
        .map((tab) => {
          const on = this.tab === tab.id;
          return `<button type="button" class="md-tab${on ? ' is-active' : ''}" role="tab" aria-selected="${on}" data-rep-tab="${tab.id}">${esc(tab.label)}</button>`;
        })
        .join('');
    }

    const sumPanel = this.root.querySelector('#rep-panel-summary');
    const evPanel = this.root.querySelector('#rep-panel-events');
    const ratPanel = this.root.querySelector('#rep-panel-ratings');
    sumPanel?.classList.toggle('is-hidden', this.tab !== 'summary');
    evPanel?.classList.toggle('is-hidden', this.tab !== 'events');
    ratPanel?.classList.toggle('is-hidden', this.tab !== 'ratings');

    // Tab 1: Summary (Scoreboard + Scorers + MOTM + Familiarity Progression)
    if (sumPanel) {
      const renderScorers = (/** @type {import('../../runtime/matchday/MatchReport.js').ScorerEntry[]} */ list) =>
        list
          .map((s) => {
            const tag = s.ownGoal ? ' (OG)' : s.penalty ? ' (P)' : '';
            return `<div class="rep-scorer">${esc(s.shortName)}${tag} <span class="muted">${esc(s.minute)}</span></div>`;
          })
          .join('');

      const motmHtml = r.motm
        ? `<div class="rep-card rep-motm-card" id="rep-motm">
            <strong class="rep-card-title">${esc(t('matchReport.motm'))}</strong>
            <div class="rep-motm-row">
              <div>
                <strong>#${r.motm.number} ${esc(r.motm.name)}</strong>
                <div class="muted">${esc(r.motm.teamIndex === 0 ? r.teamNames.home : r.teamNames.away)} · ${Math.round(r.motm.minutes)}' · G ${r.motm.goals} · A ${r.motm.assists}</div>
              </div>
              <span class="mgr-rating ${ratingClass(r.motm.rating)}">${r.motm.rating.toFixed(1)}</span>
            </div>
          </div>`
        : '';

      const famHtml = r.familiarity
        ? `<div class="rep-card rep-fam-card" id="rep-familiarity">
            <strong class="rep-card-title">${esc(t('matchReport.familiarityGain'))}</strong>
            ${r.familiarity.plans
              .map((entry) => {
                const planLabel = t(entry.plan === 'B' ? 'tacticPlan.planB' : 'tacticPlan.planA');
                const presetName = t(`tacticPresets.${entry.tacticId}`);
                const formLabel = this.#formationLabel(entry.formationId);
                const diff = Math.max(0, entry.effectiveAfter - entry.effectiveBefore);
                const mins = Math.round(entry.minutes);
                const gainText =
                  mins > 0
                    ? this.locale.t('matchReport.gainMinutes', { n: diff, minutes: mins })
                    : t('matchReport.notUsed');
                const tier = tierOf(entry.effectiveAfter);
                const unlocked = entry.fluidUnlocked
                  ? `<span class="rep-fluid-badge">${esc(t('matchReport.fluidUnlocked'))}</span>`
                  : '';
                return `<div class="rep-fam-plan" data-rep-plan="${entry.plan}">
                  <div class="rep-fam-head">
                    <span><strong>${esc(planLabel)}</strong> · ${esc(presetName)} (${esc(formLabel)})</span>
                    <span class="fam-tier is-${tier}">${entry.effectiveBefore}% → ${entry.effectiveAfter}%</span>
                  </div>
                  <div class="pm-fam-bar">
                    <div class="pm-fam-fill is-${tier}" style="width:${entry.effectiveAfter}%"></div>
                    <span class="pm-fam-tick" style="left:50%"></span>
                    <span class="pm-fam-tick" style="left:80%"></span>
                  </div>
                  <div class="rep-fam-meta">
                    <span class="muted">${esc(gainText)}</span>
                    ${unlocked}
                  </div>
                </div>`;
              })
              .join('')}
          </div>`
        : '';

      sumPanel.innerHTML = `
        <div class="rep-card rep-score-card">
          <div class="rep-score-row">
            <span class="rep-team-name">${esc(r.teamNames.home)}</span>
            <strong class="rep-score-num" id="rep-score">${r.score.home} - ${r.score.away}</strong>
            <span class="rep-team-name is-away">${esc(r.teamNames.away)}</span>
          </div>
          <div class="rep-scorers-grid">
            <div class="rep-scorers-col">${renderScorers(r.scorers.home)}</div>
            <div class="rep-scorers-col is-away">${renderScorers(r.scorers.away)}</div>
          </div>
        </div>
        ${motmHtml}
        ${famHtml}
      `;
    }

    // Tab 2: Key Events + Embedded StatsView
    const evTitle = this.root.querySelector('#rep-events-title');
    if (evTitle) evTitle.textContent = t('matchReport.keyEvents');
    const stTitle = this.root.querySelector('#rep-stats-title');
    if (stTitle) stTitle.textContent = t('panels.stats');
    const evList = this.root.querySelector('#rep-events-list');
    if (evList) {
      evList.innerHTML =
        r.keyEvents.length > 0
          ? r.keyEvents.map((ev) => this.#formatEvent(ev)).join('')
          : `<div class="muted">${esc(t('matchReport.noKeyEvents'))}</div>`;
    }

    // Tab 3: Ratings
    if (ratPanel) {
      const renderTeamTable = (/** @type {number} */ teamIndex, /** @type {string} */ teamName) => {
        const rows = r.players
          .filter((p) => p.teamIndex === teamIndex)
          .sort((a, b) => Number(b.minutes > 0) - Number(a.minutes > 0) || b.rating - a.rating || a.index - b.index)
          .map((p) => {
            const pos = positionLabel(roleCode(p.role), this.locale);
            const fitPct = Math.max(0, Math.min(100, Math.round(p.fitness * 100)));
            const cardHtml =
              p.card === 2
                ? '<span class="mgr-b-rc"></span>'
                : p.card === 1
                  ? '<span class="mgr-b-yc"></span>'
                  : '—';
            const injHtml = p.injury > 0 ? `<span class="mgr-b-inj is-l${p.injury}">+</span>` : '—';
            return `<tr>
              <td><span class="mgr-role-tag" title="${esc(pos.name)}">${esc(pos.abbr)}</span> #${p.number} ${esc(p.shortName)}</td>
              <td>${Math.round(p.minutes)}'</td>
              <td><span class="mgr-rating ${ratingClass(p.rating)}">${p.rating.toFixed(1)}</span></td>
              <td>${fitPct}%</td>
              <td>${cardHtml}</td>
              <td>${injHtml}</td>
            </tr>`;
          })
          .join('');
        return `<div class="rep-card">
          <strong class="rep-card-title">${esc(teamName)}</strong>
          <div class="rep-table-wrap">
            <table class="rep-table">
              <thead>
                <tr>
                  <th></th>
                  <th>${esc(t('matchReport.colMinutes'))}</th>
                  <th>${esc(t('matchReport.colRating'))}</th>
                  <th>${esc(t('matchReport.colFitness'))}</th>
                  <th>${esc(t('matchReport.colCards'))}</th>
                  <th>${esc(t('matchReport.colInjury'))}</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;
      };
      ratPanel.innerHTML = renderTeamTable(0, r.teamNames.home) + renderTeamTable(1, r.teamNames.away);
    }

    // Footer
    const nextNote = this.root.querySelector('#rep-next-note');
    if (nextNote) nextNote.textContent = t('matchReport.nextMatchNote');
    const nextBtn = this.root.querySelector('#rep-next');
    if (nextBtn) nextBtn.textContent = t('matchReport.nextMatch');
  }

  destroy() {
    this._unsub?.();
    this.statsView.destroy();
    super.destroy();
  }
}
