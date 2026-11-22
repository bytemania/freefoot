/**
 * Match statistics comparison bars view (design §15, item 67).
 */
import { View } from './View.js';

const PARTIAL = `<div class="stats-panel"></div>`;

const ROWS = [
  { key: 'goals', label: 'Goals', dec: 0 },
  { key: 'possessionPct', label: 'Possession %', dec: 0 },
  { key: 'shots', label: 'Shots', dec: 0 },
  { key: 'shotsOnTarget', label: 'Shots on target', dec: 0 },
  { key: 'passes', label: 'Passes', dec: 0 },
  { key: 'passCompletionPct', label: 'Pass accuracy %', dec: 0 },
  { key: 'foulsCommitted', label: 'Fouls', dec: 0 },
  { key: 'yellowCards', label: 'Yellow Cards', dec: 0 },
  { key: 'redCards', label: 'Red Cards', dec: 0 },
  { key: 'distanceKm', label: 'Distance (km)', dec: 1 },
];

export class StatsView extends View {
  constructor() {
    super(PARTIAL);
  }

  /** @param {any} frame */
  update(frame) {
    const el = this.root?.querySelector('.stats-panel');
    if (!el || !frame?.stats) return;
    const h = frame.stats.home;
    const a = frame.stats.away;
    el.innerHTML = ROWS.map((r) => {
      const hv = Number(h[r.key] ?? 0);
      const av = Number(a[r.key] ?? 0);
      const tot = hv + av;
      const pct = tot > 0 ? (100 * hv) / tot : 50;
      return `<div class="stat-row">
        <div class="stat-nums"><span>${hv.toFixed(r.dec)}</span><span class="muted">${r.label}</span><span>${av.toFixed(r.dec)}</span></div>
        <div class="stat-bar"><div class="stat-fill-home" style="width:${pct.toFixed(1)}%"></div></div>
      </div>`;
    }).join('');
  }
}
