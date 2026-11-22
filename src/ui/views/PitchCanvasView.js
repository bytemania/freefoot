/**
 * 2D vertical pitch canvas view (design §2, §15, item 64) + Step 6 tactical
 * debug overlays (player roles/FSM states, ball & decision vectors, shot cone
 * & live xG preview, defensive line height & width spread, click-to-inspect).
 *
 * Engine coordinates (105 x 68 m) are rotated to portrait:
 *   pitch x (0..105) -> canvas vertical (bottom = 0, top = 105, so home attacks UP in H1)
 *   pitch y (0..68)  -> canvas horizontal (left = 0, right = 68)
 */
import {
  SNAP_BALL,
  SNAP_PLAYERS,
  SNAP_PLAYER_STRIDE,
} from '../../engine/MatchEngine.js';
import { PITCH_LENGTH, PITCH_WIDTH, TOTAL_PLAYERS } from '../../engine/state/MatchState.js';
import pitchHtml from '../partials/pitch.html?raw';
import { View } from './View.js';

const PAD = 22;
const GOAL_HALF_W = 3.66;
const BOX_DEPTH = 16.5;
const BOX_HALF_W = 20.16;
const SIX_DEPTH = 5.5;
const SIX_HALF_W = 9.16;

const TEAM_COLORS = [
  { fill: '#2563eb', stroke: '#dbeafe', gk: '#0ea5e9', line: 'rgba(59, 130, 246, 0.85)' },
  { fill: '#dc2626', stroke: '#fee2e2', gk: '#f97316', line: 'rgba(239, 68, 68, 0.85)' },
];

export class PitchCanvasView extends View {
  /**
   * @param {{onSelectPlayer?: (playerIndex: number) => void}} [opts]
   */
  constructor({ onSelectPlayer = () => {} } = {}) {
    super(pitchHtml);
    this.onSelectPlayer = onSelectPlayer;
    /** @type {HTMLCanvasElement | null} */
    this.canvas = null;
    /** @type {CanvasRenderingContext2D | null} */
    this.ctx = null;
    /** @type {HTMLCanvasElement | null} */
    this.bgCanvas = null;
    this.cssWidth = 0;
    this.cssHeight = 0;
    this.dpr = 1;
    this.scale = 1;
    this.originX = 0;
    this.originY = 0;

    this.overlays = { roles: true, vectors: true, defLines: true, names: false };
    this.selectedPlayer = -1;
    /** @type {any} */
    this.lastFrame = null;
    /** @type {any} */
    this.lastPitchInfo = null;
    /** @type {any} */
    this.lastCarrier = null;

    this._onClick = (/** @type {MouseEvent} */ ev) => this.#handleClick(ev);
    this._onResize = () => this.#resize();
    /** @type {ResizeObserver | null} */
    this._ro = null;
  }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    super.mount(rootEl);
    this.canvas = /** @type {HTMLCanvasElement | null} */ (rootEl.querySelector('.pitch-canvas'));
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.bgCanvas = document.createElement('canvas');
    this.canvas.addEventListener('click', this._onClick);
    window.addEventListener('resize', this._onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.#resize());
      this._ro.observe(rootEl);
    }
    this.#resize();
  }

  /** @param {{roles?: boolean, vectors?: boolean, defLines?: boolean, names?: boolean}} next */
  setOverlays(next) {
    Object.assign(this.overlays, next);
    if (this.lastFrame) this.render();
  }

  /** @param {number} playerIndex */
  setSelectedPlayer(playerIndex) {
    this.selectedPlayer = playerIndex;
    if (this.lastFrame) this.render();
  }

  /**
   * Converts engine metres (x in 0..105, y in 0..68) to CSS canvas pixels.
   * Home attacks toward x = 105 (top of the portrait pitch in half 1).
   * @param {number} px
   * @param {number} py
   */
  toCanvas(px, py) {
    return {
      cx: this.originX + py * this.scale,
      cy: this.originY + (PITCH_LENGTH - px) * this.scale,
    };
  }

  /**
   * Converts CSS canvas pixels to engine metres.
   * @param {number} cx
   * @param {number} cy
   */
  toPitch(cx, cy) {
    return {
      px: PITCH_LENGTH - (cy - this.originY) / this.scale,
      py: (cx - this.originX) / this.scale,
    };
  }

  #resize() {
    if (!this.canvas || !this.root) return;
    const rect = this.root.getBoundingClientRect();
    const w = Math.max(200, Math.floor(rect.width));
    const h = Math.max(200, Math.floor(rect.height || w * (PITCH_LENGTH / PITCH_WIDTH)));
    this.dpr = window.devicePixelRatio || 1;
    this.cssWidth = w;
    this.cssHeight = h;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    const availW = w - PAD * 2;
    const availH = h - PAD * 2;
    this.scale = Math.min(availW / PITCH_WIDTH, availH / (PITCH_LENGTH + 6));
    this.originX = (w - PITCH_WIDTH * this.scale) / 2;
    this.originY = (h - PITCH_LENGTH * this.scale) / 2;

    this.#drawStaticPitch();
    if (this.lastFrame) this.render();
  }

  #drawStaticPitch() {
    if (!this.bgCanvas) return;
    this.bgCanvas.width = Math.floor(this.cssWidth * this.dpr);
    this.bgCanvas.height = Math.floor(this.cssHeight * this.dpr);
    const ctx = this.bgCanvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0f2e1c';
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    const pw = PITCH_WIDTH * this.scale;
    const ph = PITCH_LENGTH * this.scale;

    // Alternating grass stripes
    const stripes = 12;
    const sh = ph / stripes;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#1b5e35' : '#18532f';
      ctx.fillRect(this.originX, this.originY + i * sh, pw, sh + 0.5);
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.lineWidth = 1.5;

    // Outer boundary
    ctx.strokeRect(this.originX, this.originY, pw, ph);

    // Halfway line & centre circle
    const mid = this.toCanvas(PITCH_LENGTH / 2, PITCH_WIDTH / 2);
    ctx.beginPath();
    ctx.moveTo(this.originX, mid.cy);
    ctx.lineTo(this.originX + pw, mid.cy);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(mid.cx, mid.cy, 9.15 * this.scale, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    ctx.arc(mid.cx, mid.cy, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Penalty areas, 6-yard boxes, penalty spots, goals (top = x=105, bottom = x=0)
    const drawEnd = (/** @type {boolean} */ top) => {
      const boxY = top ? this.originY : this.originY + ph - BOX_DEPTH * this.scale;
      const boxX = this.originX + (PITCH_WIDTH / 2 - BOX_HALF_W) * this.scale;
      ctx.strokeRect(boxX, boxY, BOX_HALF_W * 2 * this.scale, BOX_DEPTH * this.scale);

      const sixY = top ? this.originY : this.originY + ph - SIX_DEPTH * this.scale;
      const sixX = this.originX + (PITCH_WIDTH / 2 - SIX_HALF_W) * this.scale;
      ctx.strokeRect(sixX, sixY, SIX_HALF_W * 2 * this.scale, SIX_DEPTH * this.scale);

      const spot = this.toCanvas(top ? PITCH_LENGTH - 11 : 11, PITCH_WIDTH / 2);
      ctx.beginPath();
      ctx.arc(spot.cx, spot.cy, 2, 0, Math.PI * 2);
      ctx.fill();

      // Goal mouth
      const gx = this.originX + (PITCH_WIDTH / 2 - GOAL_HALF_W) * this.scale;
      const gw = GOAL_HALF_W * 2 * this.scale;
      const gd = 2.4 * this.scale;
      const gy = top ? this.originY - gd : this.originY + ph;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.strokeRect(gx, gy, gw, gd);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
    };
    drawEnd(true);
    drawEnd(false);
  }

  /**
   * @param {{renderSnapshot: Float64Array, alpha: number, pitchInfo?: any, carrierDecision?: any}} frame
   */
  update(frame) {
    this.lastFrame = frame;
    this.lastPitchInfo = frame.pitchInfo ?? null;
    this.lastCarrier = frame.carrierDecision ?? null;
    this.render();
  }

  render() {
    if (!this.ctx || !this.bgCanvas || !this.lastFrame) return;
    const ctx = this.ctx;
    const snap = this.lastFrame.renderSnapshot;
    const alpha = this.lastFrame.alpha ?? 1;
    const info = this.lastPitchInfo;
    const carrier = this.lastCarrier;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.drawImage(this.bgCanvas, 0, 0, this.cssWidth, this.cssHeight);

    // 1. Defensive line height & width spread overlay
    if (this.overlays.defLines && info?.teams) {
      for (const t of info.teams) {
        const col = TEAM_COLORS[t.teamIndex].line;
        const pLine = this.toCanvas(t.defensiveLineX, 0);
        const pMinY = this.toCanvas(t.defensiveLineX, t.widthMinY);
        const pMaxY = this.toCanvas(t.defensiveLineX, t.widthMaxY);

        ctx.save();
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(this.originX, pLine.cy);
        ctx.lineTo(this.originX + PITCH_WIDTH * this.scale, pLine.cy);
        ctx.stroke();

        // Width spread bracket
        ctx.setLineDash([]);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(pMinY.cx, pLine.cy - 4);
        ctx.lineTo(pMinY.cx, pLine.cy + 4);
        ctx.moveTo(pMaxY.cx, pLine.cy - 4);
        ctx.lineTo(pMaxY.cx, pLine.cy + 4);
        ctx.stroke();

        ctx.fillStyle = col;
        ctx.font = 'bold 10px ui-monospace, monospace';
        ctx.fillText(
          `T${t.teamIndex === 0 ? 'H' : 'A'} DEF ${t.defensiveLineAlong.toFixed(0)}m | W ${t.compactnessWidth.toFixed(0)}m`,
          this.originX + 4,
          pLine.cy - 5,
        );
        ctx.restore();
      }
    }

    // 2. Decision vectors & shot cone overlay
    if (this.overlays.vectors && info) {
      // Shot cone + live xG preview when carrier can shoot
      if (carrier?.shot?.available) {
        const cp = info.players[carrier.carrierIndex];
        const from = this.toCanvas(cp.x, cp.y);
        const leftPost = this.toCanvas(carrier.shot.goalX, PITCH_WIDTH / 2 - GOAL_HALF_W);
        const rightPost = this.toCanvas(carrier.shot.goalX, PITCH_WIDTH / 2 + GOAL_HALF_W);
        ctx.save();
        ctx.fillStyle = 'rgba(250, 204, 21, 0.16)';
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.65)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(from.cx, from.cy);
        ctx.lineTo(leftPost.cx, leftPost.cy);
        ctx.lineTo(rightPost.cx, rightPost.cy);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Live xG badge near carrier
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        const label = `xG ${carrier.shot.xg.toFixed(2)} (${carrier.shot.defendersInCone} blk)`;
        ctx.font = 'bold 10px ui-monospace, monospace';
        const tw = ctx.measureText(label).width;
        ctx.fillRect(from.cx + 10, from.cy - 22, tw + 8, 15);
        ctx.fillStyle = '#fde047';
        ctx.fillText(label, from.cx + 14, from.cy - 11);
        ctx.restore();
      }

      // Highlight top pass receiver candidate or active pass target
      const activePassIdx = info.ball.passTarget >= 0 ? info.ball.passTarget : (carrier?.bestKind === 'PASS' ? carrier.bestTarget : -1);
      if (activePassIdx >= 0 && info.players[activePassIdx]?.onPitch) {
        const fromPt = info.ball.owner >= 0
          ? this.toCanvas(info.players[info.ball.owner].x, info.players[info.ball.owner].y)
          : this.toCanvas(info.ball.x, info.ball.y);
        const toPl = info.players[activePassIdx];
        const toPt = this.toCanvas(toPl.x, toPl.y);
        ctx.save();
        ctx.strokeStyle = info.ball.passTarget >= 0 ? '#34d399' : 'rgba(52, 211, 153, 0.6)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(fromPt.cx, fromPt.cy);
        ctx.lineTo(toPt.cx, toPt.cy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(toPt.cx, toPt.cy, 13, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 3. Players
    const radius = Math.max(7, Math.min(11, this.scale * 1.45));
    for (let i = 0; i < TOTAL_PLAYERS; i++) {
      const o = SNAP_PLAYERS + SNAP_PLAYER_STRIDE * i;
      const onPitch = snap[o + 4];
      if (onPitch !== 1) continue;
      const px = snap[o] + (snap[o + 2] - snap[o]) * alpha;
      const py = snap[o + 1] + (snap[o + 3] - snap[o + 1]) * alpha;
      const team = snap[o + 5];
      const card = snap[o + 6];
      const injury = snap[o + 7];
      const isKeeper = snap[o + 8] === 1;
      const fitness = snap[o + 9];
      const pt = this.toCanvas(px, py);
      const pal = TEAM_COLORS[team] ?? TEAM_COLORS[0];
      const pInfo = info?.players?.[i];

      // Selected player target vector & ring
      if (i === this.selectedPlayer) {
        if (pInfo) {
          const tgt = this.toCanvas(pInfo.tx, pInfo.ty);
          ctx.save();
          ctx.strokeStyle = '#facc15';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(pt.cx, pt.cy);
          ctx.lineTo(tgt.cx, tgt.cy);
          ctx.stroke();
          ctx.restore();
        }
        ctx.save();
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(pt.cx, pt.cy, radius + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Player dot
      ctx.beginPath();
      ctx.arc(pt.cx, pt.cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = isKeeper ? pal.gk : pal.fill;
      ctx.fill();
      ctx.lineWidth = info?.ball?.owner === i ? 2.5 : 1.5;
      ctx.strokeStyle = info?.ball?.owner === i ? '#fde047' : pal.stroke;
      ctx.stroke();

      // Shirt number
      const shirt = pInfo ? String(pInfo.number) : String((i % 18) + 1);
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.max(8, Math.floor(radius * 0.95))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(shirt, pt.cx, pt.cy + 0.5);

      // Card badge (top-right corner)
      if (card > 0) {
        ctx.fillStyle = card === 1 ? '#facc15' : '#ef4444';
        ctx.fillRect(pt.cx + radius - 2, pt.cy - radius - 2, 5, 7);
      }

      // On-pitch injury badge: white box with crisp red medical cross (+), matching card badge corner style
      if (injury > 0 || pInfo?.injured) {
        const bx = pt.cx - radius - 4;
        const by = pt.cy - radius - 2;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(bx, by, 7, 7);
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)';
        ctx.lineWidth = 0.75;
        ctx.strokeRect(bx, by, 7, 7);
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(bx + 2.75, by + 1.25, 1.5, 4.5);
        ctx.fillRect(bx + 1.25, by + 2.75, 4.5, 1.5);
      }

      // Compact highlight pill above dot for inspected/selected player
      const isCarrier = info?.ball?.owner === i;
      const isTaker = info?.restartTaker === i;
      if (pInfo?.shortName && i === this.selectedPlayer) {
        ctx.save();
        ctx.font = '600 9px system-ui, sans-serif';
        const label = pInfo.shortName;
        const tw = ctx.measureText(label).width;
        const pillX = pt.cx - tw / 2 - 4;
        const pillY = pt.cy - radius - 16;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.fillRect(pillX, pillY, tw + 8, 13);
        ctx.fillStyle = '#fde047';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, pt.cx, pillY + 6.5);
        ctx.restore();
      }

      // Clean pitch readability: shortName + live fitness %/bar ONLY beneath ball carrier or set-piece taker
      if (isCarrier || isTaker) {
        const shortLabel = pInfo?.shortName ?? shirt;
        const pct = Math.max(0, Math.min(100, Math.round(fitness * 100)));
        const fitColor = pct >= 80 ? '#4ade80' : pct >= 65 ? '#facc15' : '#f87171';
        ctx.save();
        ctx.font = '700 8.5px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.85)';
        ctx.strokeText(shortLabel, pt.cx, pt.cy + radius + 2);
        ctx.fillStyle = '#fde047';
        ctx.fillText(shortLabel, pt.cx, pt.cy + radius + 2);

        const barW = Math.max(18, radius * 2.1);
        const barX = pt.cx - barW / 2 - 8;
        const barY = pt.cy + radius + 14;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.fillRect(barX, barY, barW, 3);
        ctx.fillStyle = fitColor;
        ctx.fillRect(barX, barY, barW * (pct / 100), 3);

        ctx.font = '700 7.5px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.strokeText(`${pct}%`, barX + barW + 2, barY + 1.5);
        ctx.fillStyle = fitColor;
        ctx.fillText(`${pct}%`, barX + barW + 2, barY + 1.5);
        ctx.restore();
      }

      // Debug tactical overlay (role + FSM action) when enabled in #seed viewer
      if (this.overlays.roles && pInfo) {
        ctx.save();
        ctx.font = '600 8px ui-monospace, monospace';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const roleY = isCarrier || isTaker ? pt.cy + radius + 20 : pt.cy + radius + 3;
        ctx.fillText(`${pInfo.role} ${pInfo.actionName}`, pt.cx, roleY);
        ctx.restore();
      }
    }

    // 4. Ball + 3D height cue (shadow + subtle radius/lift) + velocity vector
    const bx = snap[SNAP_BALL] + (snap[SNAP_BALL + 2] - snap[SNAP_BALL]) * alpha;
    const by = snap[SNAP_BALL + 1] + (snap[SNAP_BALL + 3] - snap[SNAP_BALL + 1]) * alpha;
    const bh = snap[SNAP_BALL + 4];
    const bPt = this.toCanvas(bx, by);

    if (this.overlays.vectors && info?.ball) {
      const vx = info.ball.vx;
      const vy = info.ball.vy;
      if (vx * vx + vy * vy > 0.25) {
        const end = this.toCanvas(bx + vx * 0.4, by + vy * 0.4);
        ctx.save();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bPt.cx, bPt.cy);
        ctx.lineTo(end.cx, end.cy);
        ctx.stroke();
        ctx.restore();
      }
    }

    if (bh > 0.05) {
      const shOffX = Math.min(12, bh * 1.4);
      const shOffY = Math.min(14, bh * 1.7);
      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
      ctx.beginPath();
      ctx.ellipse(bPt.cx + shOffX, bPt.cy + shOffY, 4.2, 2.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const liftY = bh > 0.05 ? Math.min(10, bh * 1.2) : 0;
    const ballR = bh > 0.25 ? 4.8 + Math.min(4.0, bh * 0.4) : 4.5;
    ctx.beginPath();
    ctx.arc(bPt.cx, bPt.cy - liftY, ballR, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#0f172a';
    ctx.stroke();
  }

  /** @param {MouseEvent} ev */
  #handleClick(ev) {
    if (!this.canvas || !this.lastFrame) return;
    const rect = this.canvas.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    const snap = this.lastFrame.renderSnapshot;

    let bestIdx = -1;
    let bestDistSq = 18 * 18;
    for (let i = 0; i < TOTAL_PLAYERS; i++) {
      const o = SNAP_PLAYERS + SNAP_PLAYER_STRIDE * i;
      if (snap[o + 4] !== 1) continue;
      const pt = this.toCanvas(snap[o + 2], snap[o + 3]);
      const dx = pt.cx - cx;
      const dy = pt.cy - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        bestIdx = i;
      }
    }
    this.selectedPlayer = bestIdx;
    this.onSelectPlayer(bestIdx);
    this.render();
  }

  destroy() {
    if (this.canvas) this.canvas.removeEventListener('click', this._onClick);
    window.removeEventListener('resize', this._onResize);
    this._ro?.disconnect();
    this._ro = null;
    super.destroy();
  }
}
