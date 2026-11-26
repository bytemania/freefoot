/**
 * In-app `#bench` performance benchmark view (design §18b, item 69, G4).
 *
 * Runs a full match at 20 ticks/frame + pitch drawing, checks golden hash
 * against `#generated/golden.js`, measures full-match re-simulation time,
 * reports mean/p95 ms, and lets the user copy JSON results via `copyText`.
 */
import { config, configHash } from '#generated/config.js';
import { golden } from '#generated/golden.js';
import homeSquad from '#generated/squads/sample-home.js';
import awaySquad from '#generated/squads/sample-away.js';
import { ENGINE_VERSION, MatchEngine, SNAP_LEN } from '../../engine/MatchEngine.js';
import { mean, percentile } from '../../shared/stats.js';
import { copyText } from '../copyText.js';
import { View } from './View.js';

const PARTIAL = `
<div class="bench-page">
  <header class="bench-head">
    <h2>freefoot #bench (WebView Performance Gate)</h2>
    <div class="bench-btns">
      <button type="button" class="btn btn-primary" id="bench-run">Run Benchmark</button>
      <button type="button" class="btn" id="bench-copy" disabled>Copy JSON</button>
      <a class="btn" href="#match">Back to Match</a>
    </div>
  </header>
  <pre class="bench-output" id="bench-output">Click "Run Benchmark" to measure 20-tick engine work, canvas draw time, re-simulation time, and golden hash.</pre>
  <canvas class="bench-canvas" id="bench-canvas" width="240" height="360"></canvas>
</div>
`;

export class BenchView extends View {
  /** @param {{onFallbackCopy?: (text: string) => void}} [opts] */
  constructor({ onFallbackCopy } = {}) {
    super(PARTIAL);
    this.onFallbackCopy = onFallbackCopy;
    this.lastJson = '';
  }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    super.mount(rootEl);
    rootEl.querySelector('#bench-run')?.addEventListener('click', () => this.run());
    rootEl.querySelector('#bench-copy')?.addEventListener('click', () => {
      if (this.lastJson) void copyText(this.lastJson, { onFallback: this.onFallbackCopy });
    });
  }

  run() {
    const out = this.root?.querySelector('#bench-output');
    const copyBtn = /** @type {HTMLButtonElement | null} */ (this.root?.querySelector('#bench-copy'));
    const canvas = /** @type {HTMLCanvasElement | null} */ (this.root?.querySelector('#bench-canvas'));
    const ctx = canvas?.getContext('2d');
    if (!out) return;
    out.textContent = 'Running benchmark (1 full match @ 20 ticks/frame + golden hash check)...';

    setTimeout(() => {
      const input = /** @type {any} */ (JSON.parse(JSON.stringify({
        v: 1,
        seed: 1,
        configHash,
        home: { ...homeSquad, controlledBy: 'ai' },
        away: { ...awaySquad, controlledBy: 'ai' },
      })));

      const engine = MatchEngine.create(input, config);
      const snap = new Float64Array(SNAP_LEN);
      /** @type {number[]} */
      const engMs = [];
      /** @type {number[]} */
      const drawMs = [];

      const simStart = performance.now();
      while (true) {
        const t0 = performance.now();
        const r = engine.step(20);
        engine.getSnapshot(snap);
        const t1 = performance.now();
        engMs.push(t1 - t0);

        if (ctx && canvas) {
          ctx.fillStyle = '#18532f';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect((snap[8] / 105) * canvas.width, (snap[9] / 68) * canvas.height, 4, 4);
        }
        drawMs.push(performance.now() - t1);

        if (r.stoppedFor === 'FULL_TIME' || r.stoppedFor === 'FORCED_DECISION') break;
      }
      const resimMs = performance.now() - simStart;

      // Golden hash check on seed 1 (human-controlled, matching golden.js)
      const goldenSeed = golden.seeds?.[0];
      let goldenOk = false;
      let actualGolden = 'n/a';
      if (goldenSeed) {
        const gInput = /** @type {any} */ (JSON.parse(JSON.stringify({
          v: 1,
          seed: goldenSeed.seed,
          configHash,
          home: { ...homeSquad, controlledBy: 'human' },
          away: { ...awaySquad, controlledBy: 'human' },
        })));
        const gEng = MatchEngine.create(gInput, config);
        const human = (golden.commandLog ?? []).filter((/** @type {any} */ e) => e.issuer === 'human').sort((/** @type {any} */ a, /** @type {any} */ b) => a.seq - b.seq);
        let nextCmd = 0;
        while (true) {
          while (nextCmd < human.length && human[nextCmd].tick <= gEng.tick) {
            const e = human[nextCmd++];
            gEng.applyCommand({ issuer: 'human', type: e.type, teamIndex: e.teamIndex, payload: e.payload });
          }
          const target = Math.min(1000, golden.everyTicks - (gEng.tick % golden.everyTicks));
          const r = gEng.step(target);
          if (r.stoppedFor === 'FULL_TIME') break;
          if (r.stoppedFor === 'FORCED_DECISION') {
            for (let t = 0; t < 2; t++) {
              if (gEng.state.teams[t].forcedDecision) {
                gEng.applyCommand({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: t, payload: { inIndex: null, outIndex: null } });
              }
            }
          }
        }
        actualGolden = gEng.hash().toString(16).padStart(8, '0');
        goldenOk = actualGolden === goldenSeed.final;
      }

      const engSorted = engMs.slice().sort((a, b) => a - b);
      const drawSorted = drawMs.slice().sort((a, b) => a - b);
      const frameSorted = engMs.map((e, i) => e + drawMs[i]).sort((a, b) => a - b);

      const report = {
        engineVersion: ENGINE_VERSION,
        configHash,
        windows: engMs.length,
        engineMsMean: Number(mean(engMs).toFixed(4)),
        engineMsP95: Number(percentile(engSorted, 0.95).toFixed(4)),
        drawMsMean: Number(mean(drawMs).toFixed(4)),
        drawMsP95: Number(percentile(drawSorted, 0.95).toFixed(4)),
        frameMsP95: Number(percentile(frameSorted, 0.95).toFixed(4)),
        fullMatchResimMs: Number(resimMs.toFixed(1)),
        goldenSeed1: { expected: goldenSeed?.final ?? null, actual: actualGolden, match: goldenOk },
        gates: {
          engineP95Under2ms: percentile(engSorted, 0.95) < 2.0,
          frameP95Under16_7ms: percentile(frameSorted, 0.95) <= 16.7,
          resimUnder12s: resimMs < 12000,
        },
      };
      this.lastJson = JSON.stringify(report, null, 2);
      out.textContent = this.lastJson;
      if (copyBtn) copyBtn.disabled = false;
    }, 20);
  }
}
