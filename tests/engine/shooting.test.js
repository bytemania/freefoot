import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { decideCarrier, shotUtility } from '../../src/engine/decisions/CarrierDecision.js';
import { decideOffBall } from '../../src/engine/decisions/OffBallDecision.js';
import { computeAnchors } from '../../src/engine/tactics/Formation.js';
import { ACTION } from '../../src/engine/decisions/Perception.js';
import { seedSfc32 } from '../../src/engine/rng/streams.js';
import { config, sampleInput } from './helpers.js';

const STRIKER = 9; // home 4-3-3: 1 LB, 6 CM, 8 LW, 9 ST
const AWAY_GK = 18;

/**
 * A scene in open play, home attacking x = 105: the carrier at (x, y), the
 * home team-mates back at halfway, the away keeper on the line and the away
 * outfield players where `defenders` puts them (others parked deep and wide).
 * @param {{x: number, y: number}} at
 * @param {{x: number, y: number}[]} defenders
 * @param {any} [cfg]
 * @param {number} [carrier]
 */
function scene(at, defenders, cfg = config, carrier = STRIKER) {
  const engine = MatchEngine.create(sampleInput(1), cfg);
  const s = engine.state;
  s.restart.state = 'IN_PLAY';
  for (let i = 1; i < 11; i++) {
    const p = s.players[i];
    p.x = p.prevX = 45;
    p.y = p.prevY = 5 + i * 5.8;
  }
  s.players[0].x = 3;
  s.players[0].y = 34;
  const gk = s.players[AWAY_GK];
  gk.x = gk.prevX = 104;
  gk.y = gk.prevY = 34;
  for (let i = 19; i < 29; i++) {
    const p = s.players[i];
    const d = defenders[i - 19];
    p.x = p.prevX = d ? d.x : 60;
    p.y = p.prevY = d ? d.y : i % 2 === 0 ? 2 : 66;
  }
  const c = s.players[carrier];
  c.x = c.prevX = at.x;
  c.y = c.prevY = at.y;
  s.ball.x = s.ball.prevX = at.x;
  s.ball.y = s.ball.prevY = at.y;
  s.ball.owner = carrier;
  s.ball.pass = null;
  s.ball.flight = null;
  return engine;
}

/**
 * Share of carrier decisions that are shots over `trials` RNG draws.
 * @param {() => MatchEngine} make
 * @param {number} [trials]
 */
function shotRate(make, trials = 300) {
  let shots = 0;
  for (let t = 0; t < trials; t++) {
    const engine = make();
    const s = engine.state;
    seedSfc32(s.rng, 1000 + t);
    s.tickEvents.length = 0;
    decideCarrier(s, s.players[s.ball.owner]);
    if (s.tickEvents.some((e) => e.type === 'SHOT')) shots++;
  }
  return shots / trials;
}

/** A copy of the config without the box-propensity weights (the old shot model). */
function withoutBoxWeights() {
  const cfg = structuredClone(config);
  const w = cfg.weights.decision.w.shot;
  for (const k of ['box', 'clearLane', 'oneOnOne', 'longRange']) w[k].value = 0;
  return cfg;
}

test('shot utility: inside the 16.5 m box (box x xG, clear lane, 1v1) beats a 27 m shot; a blocked cone lowers it', () => {
  const box = scene({ x: 95, y: 30 }, []);
  const p = box.state.players[STRIKER];
  const inBox = shotUtility(box.state, p, 0);
  assert.ok(inBox && inBox.inBox && inBox.oneOnOne && inBox.cone === 0);

  const outside = scene({ x: 78, y: 34 }, [{ x: 70, y: 20 }]);
  const far = shotUtility(outside.state, outside.state.players[STRIKER], 0);
  assert.ok(far && !far.inBox);
  const w = config.weights.decision.w.shot;
  // The box bonus (box x xG, clear lane, 1v1) comes on top of the better chance itself.
  const bonus = w.box.value * inBox.xg + w.clearLane.value + w.oneOnOne.value;
  assert.ok(inBox.score - far.score > bonus, `${inBox.score.toFixed(3)} vs ${far.score.toFixed(3)} (bonus ${bonus.toFixed(3)})`);

  // Same spot, a defender in the shooting cone: no clear-lane or 1v1 bonus.
  const crowded = scene({ x: 95, y: 30 }, [{ x: 99, y: 31 }]);
  const blocked = shotUtility(crowded.state, crowded.state.players[STRIKER], 0);
  assert.ok(blocked && blocked.cone === 1 && !blocked.oneOnOne);
  assert.ok(blocked.score < inBox.score);
  // Out of range (beyond shotMaxDist) there is no shot at all.
  const halfway = scene({ x: 55, y: 34 }, []);
  assert.equal(shotUtility(halfway.state, halfway.state.players[STRIKER], 0), null);
});

test('box-entry shooting propensity: carriers shoot far more often inside the box than from outside it, and more than before', () => {
  // The same picture 13 m apart: a marker 2.5 m to the carrier's side and two covering defenders.
  const inScene = (/** @type {any} */ cfg) => scene({ x: 96, y: 32 }, [{ x: 95, y: 29.5 }, { x: 102, y: 26 }, { x: 102, y: 42 }], cfg);
  const outScene = (/** @type {any} */ cfg) => scene({ x: 83, y: 32 }, [{ x: 82, y: 29.5 }, { x: 91, y: 26 }, { x: 91, y: 42 }], cfg);
  const inBox = shotRate(() => inScene(config));
  const outside = shotRate(() => outScene(config));
  assert.ok(inBox > outside + 0.15, `in box ${inBox.toFixed(2)} vs outside ${outside.toFixed(2)}`);
  assert.ok(outside < 0.1, `speculative long shots stay rare (${outside.toFixed(2)})`);

  const old = withoutBoxWeights();
  const oldInBox = shotRate(() => inScene(old));
  const oldOutside = shotRate(() => outScene(old));
  assert.ok(inBox >= oldInBox, `in-box rate up (${oldInBox.toFixed(2)} -> ${inBox.toFixed(2)})`);
  assert.ok(outside <= oldOutside, `long-range rate down (${oldOutside.toFixed(2)} -> ${outside.toFixed(2)})`);
});

test('a free carrier inside the box with a clear lane gets a shot utility that beats holding the ball, and shoots more often', () => {
  // Central in the box, empty cone, no defender near; a team-mate waits beside them.
  const free = (/** @type {any} */ cfg) => {
    const engine = scene({ x: 99, y: 34 }, [{ x: 70, y: 10 }, { x: 70, y: 58 }], cfg);
    const mate = engine.state.players[8];
    mate.x = mate.prevX = 99;
    mate.y = mate.prevY = 46;
    return engine;
  };
  const e = free(config);
  const u = shotUtility(e.state, e.state.players[STRIKER], 0);
  assert.ok(u && u.inBox && u.cone === 0 && u.oneOnOne, 'in the box, empty shooting cone');
  const hold = config.weights.decision.w.hold.free.value;
  assert.ok(u.score > hold, `shot ${u.score.toFixed(2)} outscores holding the ball (${hold})`);

  const old = structuredClone(config);
  old.weights.decision.w.shot.boxFree.value = 0;
  const eo = free(old);
  const before = /** @type {any} */ (shotUtility(eo.state, eo.state.players[STRIKER], 0)).score;
  assert.ok(u.score > before + 0.3, `the free-in-box bonus lifts the shot (${before.toFixed(2)} -> ${u.score.toFixed(2)})`);
  const rate = shotRate(() => free(config));
  assert.ok(rate > shotRate(() => free(old)), `shoots ${rate.toFixed(2)} of the time, more than before`);

  // Pressed in the box the bonus fades.
  const pressed = /** @type {any} */ (shotUtility(e.state, e.state.players[STRIKER], 1));
  assert.ok(pressed.score < u.score - 0.3);
  // A free team-mate beside the carrier can still win the decision: the pass lever moves shot volume too hard to
  // use here (a sideways-pass penalty of 0.12 took shots per match from 27 to 32).
});

test('long-range shots stay rare for a pressed, low-technique carrier and come with space and technique', () => {
  const make = (/** @type {number} */ skill, /** @type {{x: number, y: number}[]} */ defenders) => {
    const engine = scene({ x: 79, y: 34 }, defenders);
    const p = engine.state.players[STRIKER];
    /** @type {any} */ (p).cold = { ...p.cold, attributes: { ...p.cold.attributes, technique: skill, finishing: skill } };
    return engine;
  };
  const pressed = make(6, [{ x: 80, y: 35 }]);
  const free = make(20, []);
  const pressedU = shotUtility(pressed.state, pressed.state.players[STRIKER], 0.9);
  const freeU = shotUtility(free.state, free.state.players[STRIKER], 0);
  assert.ok(pressedU && freeU && !pressedU.inBox && !freeU.inBox);
  assert.ok(freeU.score > pressedU.score + 0.05, `free & skilled ${freeU.score.toFixed(3)} vs pressed ${pressedU.score.toFixed(3)}`);
});

test('final-third build-up: the ball-side full-back overlaps down the wide channel and the winger comes inside, both onside', () => {
  // Home carrier (the left winger) at 80 m on the left wing; the away back line at 90 m.
  const engine = scene({ x: 80, y: 9 }, [{ x: 90, y: 14 }, { x: 90, y: 28 }, { x: 90, y: 40 }, { x: 90, y: 54 }], config, 8);
  const s = engine.state;
  computeAnchors(s, s.teams[0]);
  const ob = s.k.weights.offBall;
  const lb = s.players[1];
  lb.x = lb.prevX = 60;
  lb.y = lb.prevY = 10;
  decideOffBall(s, lb);
  assert.equal(lb.pendingAction, ACTION.RUN, 'overlapping run');
  assert.equal(lb.py, ob.overlapWidth, 'down the wide channel');
  assert.ok(lb.px > lb.x && lb.px <= 90 - ob.runOnsideGap + 1e-9, `onside, ahead (${lb.px})`);

  // The ball-side central player in the winger slot comes inside to the half-space.
  const rw = s.players[10];
  rw.x = 80;
  decideOffBall(s, rw); // far wing: keeps its normal support run
  assert.notEqual(rw.py, 34 + ob.wingerInside);
  // Ball switched to the right wing: now the right winger comes inside.
  s.players[8].y = 60;
  s.ball.y = 60;
  computeAnchors(s, s.teams[0]);
  decideOffBall(s, rw);
  assert.equal(rw.pendingAction, ACTION.SUPPORT);
  assert.equal(rw.py, 34 + ob.wingerInside, 'into the half-space');
});

test('a striker makes a diagonal run between the centre-backs when a free midfielder looks up, ending onside', () => {
  // Home central midfielder (6) on the ball at 55 m, nobody near; away back four at 80 m.
  const engine = scene({ x: 55, y: 34 }, [{ x: 80, y: 14 }, { x: 80, y: 28 }, { x: 80, y: 40 }, { x: 80, y: 54 }], config, 6);
  const s = engine.state;
  computeAnchors(s, s.teams[0]);
  const st = s.players[STRIKER];
  st.x = st.prevX = 70;
  st.y = st.prevY = 26;
  decideOffBall(s, st);
  const ob = s.k.weights.offBall;
  assert.equal(st.pendingAction, ACTION.RUN, 'run in behind');
  assert.equal(st.py, 34, 'into the gap between the centre-backs (28 and 40)');
  assert.ok(Math.abs(st.px - (80 - ob.runOnsideGap)) < 1e-9, 'stays onside');
  // Under pressure the midfielder cannot look up: no run.
  const pressed = scene({ x: 55, y: 34 }, [{ x: 80, y: 14 }, { x: 80, y: 28 }, { x: 80, y: 40 }, { x: 80, y: 54 }, { x: 56, y: 34.5 }], config, 6);
  const ps = pressed.state;
  computeAnchors(ps, ps.teams[0]);
  ps.players[STRIKER].x = 70;
  decideOffBall(ps, ps.players[STRIKER]);
  assert.notEqual(ps.players[STRIKER].pendingAction, ACTION.RUN);
});
