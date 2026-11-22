/**
 * Carrier Decision, Pinned Player & Filterable Event Timeline inspector panel
 * (Step 6 `#seed` Debug Viewer).
 */
import inspectorHtml from '../partials/debug-inspector.html?raw';
import { View } from './View.js';

const SET_PIECE_TYPES = new Set(['KICK_OFF', 'THROW_IN', 'GOAL_KICK', 'CORNER', 'FREE_KICK', 'PENALTY_AWARDED', 'DROP_BALL']);
const CARD_TYPES = new Set(['YELLOW_CARD', 'RED_CARD']);

/**
 * Matches a MatchEvent against the active timeline filter.
 * @param {any} ev
 * @param {string} filter
 * @returns {boolean}
 */
export function matchesEventFilter(ev, filter) {
  if (filter === 'ALL') return true;
  if (filter === 'GOAL') return ev.type === 'GOAL';
  if (filter === 'SHOT') return ev.type === 'SHOT';
  if (filter === 'PASS_FAIL') return ev.type === 'PASS' && ev.meta?.completed === false;
  if (filter === 'FOUL') return ev.type === 'FOUL';
  if (filter === 'CARD') return CARD_TYPES.has(ev.type);
  if (filter === 'SET_PIECE') return SET_PIECE_TYPES.has(ev.type);
  return true;
}

/** @param {number} v @param {number} [d] */
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');

export class DebugInspectorView extends View {
  /**
   * @param {{onJumpToTick?: (tick: number) => void}} [opts]
   */
  constructor({ onJumpToTick = () => {} } = {}) {
    super(inspectorHtml);
    this.onJumpToTick = onJumpToTick;
    this.filter = 'ALL';
    this.selectedPlayer = -1;
    this.lastEventCount = -1;
    this.lastFilter = '';
    /** @type {any} */
    this.lastFrame = null;
  }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    super.mount(rootEl);
    rootEl.addEventListener('click', (ev) => {
      const target = /** @type {HTMLElement | null} */ (ev.target);
      const filterBtn = target?.closest?.('.filter-btn');
      if (filterBtn) {
        const next = filterBtn.getAttribute('data-filter') ?? 'ALL';
        this.filter = next;
        for (const btn of Array.from(rootEl.querySelectorAll('.filter-btn'))) {
          btn.classList.toggle('is-active', btn.getAttribute('data-filter') === next);
        }
        this.lastEventCount = -1;
        if (this.lastFrame) this.update(this.lastFrame);
        return;
      }
      const row = target?.closest?.('.timeline-row');
      if (row) {
        const tick = Number(row.getAttribute('data-tick'));
        if (Number.isFinite(tick)) this.onJumpToTick(tick);
      }
    });
  }

  /** @param {number} playerIndex */
  setSelectedPlayer(playerIndex) {
    this.selectedPlayer = playerIndex;
    if (this.lastFrame) this.#renderPlayer(this.lastFrame.pitchInfo);
  }

  /**
   * @param {{carrierDecision?: any, pitchInfo?: any, eventLog?: any[], tick?: number}} frame
   */
  update(frame) {
    this.lastFrame = frame;
    this.#renderCarrier(frame.carrierDecision);
    this.#renderPlayer(frame.pitchInfo);
    this.#renderTimeline(frame.eventLog ?? [], frame.tick ?? 0);
  }

  /** @param {any} c */
  #renderCarrier(c) {
    const el = this.root?.querySelector('.carrier-body');
    if (!el) return;
    if (!c) {
      el.innerHTML = '<div class="muted">Ball in flight / loose / dead ball</div>';
      return;
    }
    const teamTag = c.teamIndex === 0 ? 'HOME' : 'AWAY';
    const topPass = c.passes[0];
    const topDrib = c.dribbles[0];
    const rows = [
      {
        label: 'SHOT',
        score: c.shot.available ? c.shot.score : null,
        detail: c.shot.available
          ? `xG=${f(c.shot.xg, 3)} dist=${f(c.shot.distance, 1)}m blk=${c.shot.defendersInCone}`
          : `out of range (${f(c.shot.distance, 1)}m)`,
      },
      {
        label: topPass ? `PASS (${topPass.passKind} #${topPass.number})` : 'PASS',
        score: topPass ? topPass.score : null,
        detail: topPass
          ? `safe=${f(topPass.laneSafety)} prog=${f(topPass.progress)} rPress=${f(topPass.receiverPressure)}${topPass.offside ? ' OFFSIDE' : ''}`
          : 'no target',
      },
      {
        label: topDrib ? `DRIBBLE (${topDrib.dir})` : 'DRIBBLE',
        score: !c.isKeeper && topDrib ? topDrib.score : null,
        detail: topDrib ? `space=${f(topDrib.space, 1)}m` : '—',
      },
      {
        label: 'CROSS',
        score: c.cross.available ? c.cross.score : null,
        detail: c.cross.inWideZone ? `matesInBox=${c.cross.matesInBox}` : 'not wide zone',
      },
      {
        label: 'CLEAR',
        score: c.clearance.available ? c.clearance.score : null,
        detail: `along=${f(c.clearance.along, 1)}m press=${f(c.clearance.pressure)}`,
      },
      {
        label: 'HOLD',
        score: !c.isKeeper ? c.hold.score : null,
        detail: `press=${f(c.hold.pressure)} settle=${c.decisionTimer}t`,
      },
    ];

    const winner = c.bestKind;
    el.innerHTML = `
      <div class="carrier-head">
        <strong>${teamTag} #${c.number} ${c.name}</strong>
        <span class="badge">${c.role}</span>
        <span class="badge badge-win">Best: ${winner}</span>
        <span class="muted">press ${f(c.pressure)} · settle ${c.decisionTimer}t</span>
      </div>
      <table class="score-table">
        <thead><tr><th>Action</th><th>Score</th><th>Features</th></tr></thead>
        <tbody>
          ${rows
            .map((r) => {
              const isWin = r.label.startsWith(winner);
              return `<tr class="${isWin ? 'is-winner' : ''}">
                <td>${r.label}</td>
                <td class="num">${r.score !== null ? f(r.score, 2) : '—'}</td>
                <td class="muted">${r.detail}</td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    `;
  }

  /** @param {any} pitchInfo */
  #renderPlayer(pitchInfo) {
    const el = this.root?.querySelector('.player-body');
    if (!el) return;
    const p = this.selectedPlayer >= 0 ? pitchInfo?.players?.[this.selectedPlayer] : null;
    if (!p) {
      el.innerHTML = '<div class="muted">Click any player on the pitch to pin attributes & target.</div>';
      return;
    }
    const a = p.attrs;
    const teamTag = p.team === 0 ? 'HOME' : 'AWAY';
    el.innerHTML = `
      <div class="carrier-head">
        <strong>${teamTag} #${p.number} ${p.name}</strong>
        <span class="badge">${p.role}</span>
        <span class="badge">${p.actionName}</span>
        <span class="muted">CA ${f(p.ca, 1)} · Fit ${Math.round(p.fitness * 100)}%</span>
      </div>
      <div class="muted" style="margin-bottom:6px">
        pos (${f(p.x, 1)}, ${f(p.y, 1)}) → target (${f(p.tx, 1)}, ${f(p.ty, 1)}) · v=(${f(p.vx, 1)}, ${f(p.vy, 1)})
      </div>
      <div class="attr-grid">
        <span>PAC <b>${f(a.pace, 1)}</b></span>
        <span>PAS <b>${f(a.passing, 1)}</b></span>
        <span>FIN <b>${f(a.finishing, 1)}</b></span>
        <span>DRI <b>${f(a.dribbling, 1)}</b></span>
        <span>TAK <b>${f(a.tackling, 1)}</b></span>
        <span>POS <b>${f(a.positioning, 1)}</b></span>
        <span>AGG <b>${f(a.aggression, 1)}</b></span>
        <span>CMP <b>${f(a.composure, 1)}</b></span>
        <span>DEC <b>${f(a.decisions, 1)}</b></span>
      </div>
    `;
  }

  /**
   * @param {any[]} eventLog
   * @param {number} currentTick
   */
  #renderTimeline(eventLog, currentTick) {
    const el = this.root?.querySelector('.timeline-list');
    if (!el) return;
    if (eventLog.length === this.lastEventCount && this.filter === this.lastFilter) return;
    this.lastEventCount = eventLog.length;
    this.lastFilter = this.filter;

    const filtered = [];
    for (let i = eventLog.length - 1; i >= 0 && filtered.length < 150; i--) {
      if (matchesEventFilter(eventLog[i], this.filter)) filtered.push(eventLog[i]);
    }
    if (filtered.length === 0) {
      el.innerHTML = '<div class="muted" style="padding:8px">No matching events yet.</div>';
      return;
    }
    el.innerHTML = filtered
      .map((ev) => {
        const min = Math.floor(ev.tick / 1200);
        const side = ev.teamIndex === 0 ? 'H' : ev.teamIndex === 1 ? 'A' : '-';
        let meta = '';
        if (ev.type === 'SHOT') {
          meta = `${ev.meta.result} xG=${f(ev.meta.xg, 2)} d=${f(ev.meta.distance, 1)}m`;
        } else if (ev.type === 'GOAL') {
          meta = ev.meta.kind ?? '';
        } else if (ev.type === 'PASS') {
          meta = `${ev.meta.kind} ${ev.meta.completed ? 'ok' : 'fail'}`;
        } else if (ev.type === 'RED_CARD') {
          meta = ev.meta.secondYellow ? '2nd yellow' : 'straight';
        }
        const active = ev.tick === currentTick ? ' is-current' : '';
        return `<button type="button" class="timeline-row${active}" data-tick="${ev.tick}">
          <span class="tl-min">${min}'</span>
          <span class="tl-side tl-${side}">${side}</span>
          <span class="tl-type">${ev.type}</span>
          <span class="tl-meta">${meta}</span>
          <span class="tl-tick">t${ev.tick}</span>
        </button>`;
      })
      .join('');
  }
}
