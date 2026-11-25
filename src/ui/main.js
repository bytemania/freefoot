/**
 * Application bootstrap & hash router (design item 61).
 *
 * Routes:
 *   - Default (`""` or `#match`): Full Match portrait UI (sample squads,
 *     Auto Highlights, Manager, Stats, Commentary). Saving lives between
 *     matches in the outer app, so the match screen has no save / resume.
 *   - `#seed=<n>&scenario=<A|B>`: Interactive `#seed` Match Debug Viewer (Step 6)
 *   - `#bench`: WebView performance benchmark (`BenchView`)
 */
import './styles/base.css';
import './styles/pitch.css';
import './styles/debug.css';
import './styles/match.css';

import { config, configHash } from '#generated/config.js';
import homeSquad from '#generated/squads/sample-home.js';
import awaySquad from '#generated/squads/sample-away.js';
import { inspectCarrierDecision, inspectPitch } from '../engine/debug/inspect.js';
import { Commentator } from '../i18n/Commentator.js';
import { LocaleManager } from '../i18n/Locale.js';
import { MatchController } from '../runtime/MatchController.js';
import { capacitorStorage } from '../runtime/storage.js';
import { generateSquad } from '../shared/squadgen.js';
import { BenchView } from './views/BenchView.js';
import { CommentaryView } from './views/CommentaryView.js';
import { ControlsView } from './views/ControlsView.js';
import { DebugInspectorView } from './views/DebugInspectorView.js';
import { DialogView } from './views/DialogView.js';
import { Drawer } from './views/Drawer.js';
import { ManagerView } from './views/ManagerView.js';
import { PitchCanvasView } from './views/PitchCanvasView.js';
import { ScoreboardView } from './views/ScoreboardView.js';
import { StatsView } from './views/StatsView.js';
import { TacticsView } from './views/TacticsView.js';
import { ShoutsView } from './views/ShoutsView.js';

const appRoot = /** @type {HTMLElement} */ (document.getElementById('app'));
const dialogRoot = /** @type {HTMLElement} */ (document.getElementById('dialog-mount'));

const storage = capacitorStorage();
const locale = new LocaleManager({ uiStrings: config.uiStrings, storage, initial: 'pt-PT' });
const commentator = new Commentator(config.commentary);
const dialogView = new DialogView();
dialogView.mount(dialogRoot);

/** @type {(() => void) | null} */
let teardownRoute = null;

/** @param {string} hash */
function routeKind(hash) {
  const clean = hash.replace(/^#/, '');
  if (clean === 'bench') return 'bench';
  if (clean.startsWith('seed=')) return 'debug';
  return 'match';
}

/** @param {string} hash */
function parseSeedHash(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const rawSeed = Number(params.get('seed'));
  const seed = Number.isInteger(rawSeed) && rawSeed >= 0 ? rawSeed : 1;
  const scenario = (params.get('scenario') ?? 'A').toUpperCase() === 'B' ? 'B' : 'A';
  return { seed, scenario: /** @type {'A' | 'B'} */ (scenario) };
}

/** Mounts `#bench` WebView benchmark route. */
function mountBenchRoute() {
  appRoot.innerHTML = '<div id="bench-mount"></div>';
  const view = new BenchView({
    onFallbackCopy: (text) => dialogView.showCopyFallback('Benchmark JSON', text, locale.t('buttons.close')),
  });
  view.mount(/** @type {HTMLElement} */ (document.getElementById('bench-mount')));
  teardownRoute = () => view.destroy();
}

/** Mounts `#seed=<n>&scenario=<A|B>` interactive debug viewer (Step 6). */
function mountDebugRoute() {
  appRoot.innerHTML = `
    <header class="topbar">
      <div class="topbar-row">
        <div class="brand">
          <strong>freefoot</strong>
          <span class="brand-sub" data-i18n="panels.debugViewer">Match Debug Viewer</span>
        </div>
        <form id="seed-form" class="seed-controls">
          <label class="field"><span>#seed</span><input id="seed-input" type="number" min="0" step="1" value="1" /></label>
          <select id="scenario-select" aria-label="Scenario">
            <option value="A">Scenario A: Balanced</option>
            <option value="B">Scenario B: Top-4 vs Bottom-4</option>
          </select>
          <button type="submit" class="btn btn-primary">Load</button>
          <button type="button" id="btn-random" class="btn">Random</button>
          <a class="btn btn-sm" href="#">Full Match</a>
        </form>
        <div class="scoreboard">
          <span class="team-badge team-home" id="home-label">HOME</span>
          <strong class="score-text" id="score-text">0 - 0</strong>
          <span class="team-badge team-away" id="away-label">AWAY</span>
          <span class="clock-text" id="clock-text">00:00</span>
        </div>
      </div>
      <div class="topbar-row topbar-controls">
        <div class="playback-group">
          <button type="button" id="btn-play" class="btn btn-primary">Play</button>
          <button type="button" id="btn-step1" class="btn">Step 1t</button>
          <button type="button" id="btn-step20" class="btn">Step 20t (1s)</button>
          <label class="field"><span>Speed</span>
            <select id="speed-select">
              <option value="0.5">0.5x</option><option value="1" selected>1x</option>
              <option value="2">2x</option><option value="4">4x</option>
              <option value="10">10x</option><option value="30">30x</option>
            </select>
          </label>
        </div>
        <div class="overlay-group">
          <label class="toggle"><input type="checkbox" id="ov-roles" checked /> Roles & FSM</label>
          <label class="toggle"><input type="checkbox" id="ov-vectors" checked /> Vectors & xG Cone</label>
          <label class="toggle"><input type="checkbox" id="ov-deflines" checked /> Def Lines</label>
        </div>
        <div class="live-stats" id="live-stats"></div>
      </div>
    </header>
    <main class="workspace">
      <div id="pitch-mount" class="pitch-pane"></div>
      <aside id="inspector-mount" class="inspector-pane"></aside>
    </main>
  `;

  const { seed, scenario } = parseSeedHash(window.location.hash);
  const seedForm = /** @type {HTMLFormElement} */ (document.getElementById('seed-form'));
  const seedInput = /** @type {HTMLInputElement} */ (document.getElementById('seed-input'));
  const scenarioSelect = /** @type {HTMLSelectElement} */ (document.getElementById('scenario-select'));
  const btnRandom = /** @type {HTMLButtonElement} */ (document.getElementById('btn-random'));
  const btnPlay = /** @type {HTMLButtonElement} */ (document.getElementById('btn-play'));
  const btnStep1 = /** @type {HTMLButtonElement} */ (document.getElementById('btn-step1'));
  const btnStep20 = /** @type {HTMLButtonElement} */ (document.getElementById('btn-step20'));
  const speedSelect = /** @type {HTMLSelectElement} */ (document.getElementById('speed-select'));
  const ovRoles = /** @type {HTMLInputElement} */ (document.getElementById('ov-roles'));
  const ovVectors = /** @type {HTMLInputElement} */ (document.getElementById('ov-vectors'));
  const ovDefLines = /** @type {HTMLInputElement} */ (document.getElementById('ov-deflines'));
  const scoreText = /** @type {HTMLElement} */ (document.getElementById('score-text'));
  const clockText = /** @type {HTMLElement} */ (document.getElementById('clock-text'));
  const homeLabel = /** @type {HTMLElement} */ (document.getElementById('home-label'));
  const awayLabel = /** @type {HTMLElement} */ (document.getElementById('away-label'));
  const liveStats = /** @type {HTMLElement} */ (document.getElementById('live-stats'));

  seedInput.value = String(seed);
  scenarioSelect.value = scenario;
  homeLabel.textContent = scenario === 'B' ? 'STRONG' : 'HOME A';
  awayLabel.textContent = scenario === 'B' ? 'WEAK' : 'AWAY A';

  const homeSide = scenario === 'A' ? 'A' : 'B_strong';
  const awaySide = scenario === 'A' ? 'A' : 'B_weak';
  const input = {
    v: /** @type {const} */ (1),
    seed,
    configHash,
    home: generateSquad(homeSide, (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'ai' }),
    away: generateSquad(awaySide, (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' }),
  };

  /** @type {MatchController} */
  let ctrl;
  const pitchView = new PitchCanvasView({ onSelectPlayer: (i) => inspectorView.setSelectedPlayer(i) });
  const inspectorView = new DebugInspectorView({ onJumpToTick: (tk) => ctrl.seekToTick(tk), locale });
  pitchView.mount(/** @type {HTMLElement} */ (document.getElementById('pitch-mount')));
  inspectorView.mount(/** @type {HTMLElement} */ (document.getElementById('inspector-mount')));

  /** @param {any} frame */
  const render = (frame) => {
    const st = ctrl.engine.state;
    const pitchInfo = inspectPitch(st);
    const carrierDecision = inspectCarrierDecision(st);
    const enriched = { ...frame, pitchInfo, carrierDecision, eventLog: ctrl.eventLog };
    pitchView.update(enriched);
    inspectorView.update(enriched);
    scoreText.textContent = `${st.teams[0].score} - ${st.teams[1].score}`;
    const secs = Math.floor(pitchInfo.clockSeconds);
    clockText.textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')} (H${pitchInfo.half} · t${frame.tick})`;
    const hs = frame.stats.home;
    const as = frame.stats.away;
    liveStats.textContent = `Poss ${hs.possessionPct.toFixed(0)}-${as.possessionPct.toFixed(0)}% | Sh ${hs.shots}(${hs.shotsOnTarget})-${as.shots}(${as.shotsOnTarget}) | xG ${hs.xG.toFixed(2)}-${as.xG.toFixed(2)}`;
    btnPlay.textContent = frame.playbackState === 'FULL_MATCH' ? 'Pause' : 'Play';
  };

  ctrl = new MatchController({ input, config, mode: 'debug', onFrame: render });
  render(ctrl.buildFrame([]));

  seedForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const s = Math.max(0, Math.floor(Number(seedInput.value) || 1));
    window.location.hash = `#seed=${s}&scenario=${scenarioSelect.value === 'B' ? 'B' : 'A'}`;
  });
  btnRandom.addEventListener('click', () => {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    window.location.hash = `#seed=${(buf[0] % 99999) + 1}&scenario=${scenarioSelect.value === 'B' ? 'B' : 'A'}`;
  });
  btnPlay.addEventListener('click', () => ctrl.togglePlay());
  btnStep1.addEventListener('click', () => { ctrl.pause(); ctrl.stepTicks(1); });
  btnStep20.addEventListener('click', () => { ctrl.pause(); ctrl.stepTicks(20); });
  speedSelect.addEventListener('change', () => ctrl.setSpeed(Number(speedSelect.value) || 1));
  const syncOv = () => pitchView.setOverlays({ roles: ovRoles.checked, vectors: ovVectors.checked, defLines: ovDefLines.checked });
  ovRoles.addEventListener('change', syncOv);
  ovVectors.addEventListener('change', syncOv);
  ovDefLines.addEventListener('change', syncOv);

  teardownRoute = () => {
    ctrl.destroy();
    pitchView.destroy();
    inspectorView.destroy();
  };
}

/** Mounts the main v1 portrait Full Match & Best Moments UI. */
async function mountMatchRoute() {
  appRoot.innerHTML = `
    <div class="match-shell">
      <div class="nav-strip">
        <a href="#seed=1&scenario=A">Debug #seed</a>
        <a href="#bench">#bench</a>
      </div>
      <div id="sb-mount"></div>
      <div id="comm-mount" class="commentary-mount"></div>
      <div id="match-pitch-mount" class="match-pitch"></div>
      <div id="ctrl-mount"></div>
    </div>
    <div class="drawer" id="stats-drawer" aria-hidden="true">
      <div class="drawer-head"><strong id="stats-drawer-title">Stats</strong><button type="button" class="btn btn-sm" id="close-stats">Close</button></div>
      <div id="stats-mount"></div>
    </div>
    <div class="drawer" id="mgr-drawer" aria-hidden="true">
      <div class="drawer-head"><strong id="mgr-drawer-title">Manager</strong><button type="button" class="btn btn-sm" id="close-mgr">Close</button></div>
      <div id="mgr-mount"></div>
    </div>
    <div class="drawer" id="tac-drawer" aria-hidden="true">
      <div class="drawer-head"><strong id="tac-drawer-title">Tactics</strong><button type="button" class="btn btn-sm" id="close-tac">Close</button></div>
      <div id="tac-mount"></div>
    </div>
    <div class="drawer" id="sh-drawer" aria-hidden="true">
      <div class="drawer-head"><strong id="sh-drawer-title">Shouts</strong><button type="button" class="btn btn-sm" id="close-sh">Close</button></div>
      <div id="sh-mount"></div>
    </div>
  `;

  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const matchSeed = (buf[0] % 999999) + 1;

  const input = /** @type {any} */ (JSON.parse(JSON.stringify({
    v: 1,
    seed: matchSeed,
    configHash,
    // The human side runs the coach-shout silence clock (docs/designs/coach_shouts.md).
    home: { ...homeSquad, controlledBy: 'human', shouts: true },
    away: { ...awaySquad, controlledBy: 'ai' },
  })));

  const statsDrawer = new Drawer(/** @type {HTMLElement} */ (document.getElementById('stats-drawer')));
  const mgrDrawer = new Drawer(/** @type {HTMLElement} */ (document.getElementById('mgr-drawer')));
  const tacDrawer = new Drawer(/** @type {HTMLElement} */ (document.getElementById('tac-drawer')));
  const shDrawer = new Drawer(/** @type {HTMLElement} */ (document.getElementById('sh-drawer')));

  const sbView = new ScoreboardView({ locale, homeName: input.home.name, awayName: input.away.name });
  const pitchView = new PitchCanvasView();
  pitchView.setOverlays({ roles: false, vectors: false, defLines: false });
  const commView = new CommentaryView({ commentator, locale, domCap: config.playback.commentaryDomCap });
  const statsView = new StatsView({ locale });
  /** The stats view renders only while its drawer is open. */
  const syncStatsVisible = () => statsView.setVisible(statsDrawer.openState);

  /** @type {MatchController} */
  let ctrl;
  let lastShownState = '';

  const mgrView = new ManagerView({
    locale,
    teamIndex: 0,
    onCommand: (cmd) => ctrl.queueCommand(cmd),
  });

  const tacView = new TacticsView({
    locale,
    instructions: config.tactics.instructions,
    teamIndex: 0,
    onCommand: (cmd) => ctrl.queueCommand(cmd),
  });
  /** Closes the Tactics panel, dropping anything staged in it. */
  const closeTactics = () => {
    if (!tacDrawer.openState) return;
    tacView.discardDraft();
    tacDrawer.close();
    ctrl.setManagerOpen(false);
  };

  const shView = new ShoutsView({
    locale,
    shouts: config.shouts?.shouts ?? {},
    teamIndex: 0,
    onCommand: (cmd) => ctrl.queueCommand(cmd),
  });
  /** Closes the Shouts panel. */
  const closeShouts = () => {
    if (!shDrawer.openState) return;
    shView.dismiss();
    shDrawer.close();
    ctrl.setManagerOpen(false);
  };

  const ctrlView = new ControlsView({
    locale,
    onTogglePlay: () => ctrl.togglePlay(),
    onContinue: () => ctrl.continue(),
    onOpenStats: () => {
      // An injured player to replace (or a sent-off keeper): the Manager panel cannot be left.
      if (mgrDrawer.openState && !mgrView.dismissible) return;
      if (mgrDrawer.openState) mgrView.discardDraft();
      mgrDrawer.close();
      closeTactics();
      closeShouts();
      ctrl.setManagerOpen(false);
      statsDrawer.toggle();
      syncStatsVisible();
    },
    onOpenManager: () => {
      statsDrawer.close();
      syncStatsVisible();
      closeTactics();
      closeShouts();
      const opening = !mgrDrawer.openState;
      if (!opening && !mgrView.dismissible) return;
      if (!opening) mgrView.discardDraft();
      mgrDrawer.toggle();
      ctrl.setManagerOpen(opening);
    },
    onOpenTactics: () => {
      // An injured player to replace (or a sent-off keeper): the Manager panel cannot be left.
      if (mgrDrawer.openState && !mgrView.dismissible) return;
      if (tacDrawer.openState) {
        closeTactics();
        return;
      }
      statsDrawer.close();
      syncStatsVisible();
      if (mgrDrawer.openState) mgrView.discardDraft();
      mgrDrawer.close();
      closeShouts();
      tacDrawer.open();
      // Like the Manager panel, play slows to 1x while the Tactics panel is open.
      ctrl.setManagerOpen(true);
    },
    onOpenShouts: () => {
      // An injured player to replace (or a sent-off keeper): the Manager panel cannot be left.
      if (mgrDrawer.openState && !mgrView.dismissible) return;
      if (shDrawer.openState) {
        closeShouts();
        return;
      }
      statsDrawer.close();
      syncStatsVisible();
      if (mgrDrawer.openState) mgrView.discardDraft();
      mgrDrawer.close();
      closeTactics();
      shDrawer.open();
      // Like the other panels, play slows to 1x while the Shouts panel is open (so the reactions play live).
      ctrl.setManagerOpen(true);
    },
  });

  sbView.mount(/** @type {HTMLElement} */ (document.getElementById('sb-mount')));
  pitchView.mount(/** @type {HTMLElement} */ (document.getElementById('match-pitch-mount')));
  ctrlView.mount(/** @type {HTMLElement} */ (document.getElementById('ctrl-mount')));
  commView.mount(/** @type {HTMLElement} */ (document.getElementById('comm-mount')));
  statsView.mount(/** @type {HTMLElement} */ (document.getElementById('stats-mount')));
  mgrView.mount(/** @type {HTMLElement} */ (document.getElementById('mgr-mount')));
  tacView.mount(/** @type {HTMLElement} */ (document.getElementById('tac-mount')));
  document.getElementById('close-tac')?.addEventListener('click', closeTactics);
  shView.mount(/** @type {HTMLElement} */ (document.getElementById('sh-mount')));
  document.getElementById('close-sh')?.addEventListener('click', closeShouts);

  document.getElementById('close-stats')?.addEventListener('click', () => {
    statsDrawer.close();
    syncStatsVisible();
  });
  const closeMgrBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('close-mgr'));
  closeMgrBtn?.addEventListener('click', () => {
    if (!mgrView.dismissible) return;
    mgrView.discardDraft();
    mgrDrawer.close();
    ctrl.setManagerOpen(false);
  });
  /** Drawer headers in the current language. */
  const localizeDrawers = () => {
    const set = (/** @type {string} */ id, /** @type {string} */ key) => {
      const el = document.getElementById(id);
      if (el) el.textContent = locale.t(key);
    };
    set('stats-drawer-title', 'panels.stats');
    set('mgr-drawer-title', 'panels.manager');
    set('close-stats', 'buttons.close');
    set('close-mgr', 'buttons.close');
    set('tac-drawer-title', 'tactics.title');
    set('close-tac', 'buttons.close');
    set('sh-drawer-title', 'shouts.title');
    set('close-sh', 'buttons.close');
  };
  localizeDrawers();
  const offLocale = locale.onChange(localizeDrawers);

  /** @param {any} frame */
  const render = (frame) => {
    const st = ctrl.engine.state;
    const addedMinutes = st.clock.announced ? Math.ceil(st.clock.addedSeconds / 60) : 0;
    sbView.update({ ...frame, addedMinutes });
    const pitchInfo = inspectPitch(st);
    // An Auto Highlights pre-roll shows recorded build-up: keep the names, but not the live carrier / taker marks.
    const shownInfo = frame.preRoll ? { ...pitchInfo, ball: { ...pitchInfo.ball, owner: -1, passTarget: -1 }, restartTaker: -1 } : pitchInfo;
    pitchView.update({ ...frame, pitchInfo: shownInfo });
    ctrlView.update(frame);
    commView.update(frame);
    // Live stats come from the live engine, so the minute does too (not the replayed snapshot).
    statsView.update({ ...frame, clockSeconds: pitchInfo.clockSeconds, half: pitchInfo.half });
    mgrView.update({ state: st, playbackState: frame.playbackState });
    tacView.update({ state: st, playbackState: frame.playbackState });
    shView.update({ state: st, playbackState: frame.playbackState });
    if (closeMgrBtn) closeMgrBtn.disabled = !mgrView.dismissible;

    if (frame.playbackState !== lastShownState) {
      lastShownState = frame.playbackState;
      if (frame.playbackState === 'PAUSED_FORCED') {
        // A forced decision (an injured player to replace, a sent-off keeper): the Manager panel opens
        // and stays open until it is resolved; play cannot resume before.
        statsDrawer.close();
        syncStatsVisible();
        closeTactics();
        closeShouts();
        mgrDrawer.open();
        ctrl.setManagerOpen(true);
      } else if (frame.playbackState === 'HALF_TIME') {
        dialogView.show({
          title: locale.t('prompts.halfTime'),
          bodyHtml: `<p>${input.home.name} ${st.teams[0].score} - ${st.teams[1].score} ${input.away.name}</p>`,
          actions: [{ label: locale.t('buttons.continue'), primary: true, onClick: () => ctrl.continue() }],
        });
      } else if (frame.playbackState === 'FULL_TIME') {
        dialogView.show({
          title: locale.t('prompts.fullTime'),
          bodyHtml: `<p>${input.home.name} ${st.teams[0].score} - ${st.teams[1].score} ${input.away.name}</p>`,
          actions: [{ label: locale.t('buttons.newMatch'), primary: true, onClick: () => window.location.reload() }],
        });
      }
    }
  };

  ctrl = new MatchController({ input, config, mode: 'auto_highlights', onFrame: render });
  commView.setContext({
    matchSeed: input.seed,
    teams: [input.home, input.away],
    players: [...input.home.players, ...input.away.players],
  });
  render(ctrl.buildFrame([]));

  // Development builds (and the e2e tests) get hooks into the live match; production leaves them out.
  /** @type {() => void} */
  let offDevHooks = () => {};
  if (import.meta.env.DEV) {
    void import('./devHooks.js').then((m) => {
      offDevHooks = m.installDevHooks(ctrl);
    });
  }

  // Backgrounding the app pauses the match (nothing is saved mid-match).
  const onVisibility = () => {
    if (document.visibilityState === 'hidden' && ctrl.playbackState !== 'FULL_TIME') ctrl.pause();
  };
  document.addEventListener('visibilitychange', onVisibility);

  teardownRoute = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    offLocale();
    offDevHooks();
    ctrl.destroy();
    sbView.destroy();
    pitchView.destroy();
    ctrlView.destroy();
    commView.destroy();
    statsView.destroy();
    mgrView.destroy();
    tacView.destroy();
    shView.destroy();
  };
}

function mountCurrentRoute() {
  teardownRoute?.();
  teardownRoute = null;
  const kind = routeKind(window.location.hash);
  if (kind === 'bench') mountBenchRoute();
  else if (kind === 'debug') mountDebugRoute();
  else void mountMatchRoute();
}

window.addEventListener('hashchange', mountCurrentRoute);
void locale.init().then(() => mountCurrentRoute());
