// @ts-nocheck -- dense table-driven checks with untyped helper lambdas; the engine code they exercise is fully type-checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passOutcome, firstTouch } from '../../src/engine/resolve/passing.js';
import { dribbleOutcome, tackleOutcome, aerialDuel, contestOutcome } from '../../src/engine/resolve/duels.js';
import { shotPlacement, saveOutcome } from '../../src/engine/resolve/shooting.js';
import { xg, psxg } from '../../src/engine/xg/ShotModels.js';
import { buildTickConfig } from '../../src/engine/TickConfig.js';
import { config } from './helpers.js';

const k = buildTickConfig(config).weights;

const pass = { pComplete: 0, errM: 0, accurate: false };
const touch = { pControl: 0, controlled: false };
const beat = { pBeat: 0, beat: false };
const tack = { pWin: 0, pFoul: 0, won: false, foul: false };
const aer = { pWinA: 0, aWins: false };
const cont = { pWin: 0, won: false };
const place = { goalY: 0, goalZ: 0, vShot: 0, onTarget: false, woodwork: false };
const save = { pSave: 0, saved: false, kind: /** @type {'HELD' | 'PARRIED' | 'TIPPED'} */ ('HELD') };

/** Asserts `f` never decreases (or never increases) along a list of inputs. */
function monotonic(values, f, direction, label) {
  let prev = f(values[0]);
  for (const v of values.slice(1)) {
    const cur = f(v);
    assert.ok(direction === 'up' ? cur >= prev - 1e-12 : cur <= prev + 1e-12, `${label}: ${prev} -> ${cur} at ${v}`);
    prev = cur;
  }
}

const attrs = Array.from({ length: 20 }, (_, i) => i + 1);
const unit = Array.from({ length: 11 }, (_, i) => i / 10);

test('pass: better passing and technique, less pressure, a safer lane and a shorter pass never lower pComplete', () => {
  const p = (dist, threat, pressure, passing, technique) => {
    passOutcome(dist, threat, pressure, passing, technique, k, 0.5, pass);
    return pass.pComplete;
  };
  monotonic(attrs, (a) => p(20, 0.3, 0.3, a, 12), 'up', 'passing');
  monotonic(attrs, (a) => p(20, 0.3, 0.3, 12, a), 'up', 'technique');
  monotonic(unit, (x) => p(20, 0.3, x, 12, 12), 'down', 'receiver pressure');
  monotonic(unit, (x) => p(20, x, 0.3, 12, 12), 'down', 'lane threat');
  monotonic([5, 10, 20, 30, 50], (d) => p(d, 0.3, 0.3, 12, 12), 'down', 'distance');
});

test('pass: the direction error grows with distance and shrinks with passing; accuracy follows the draw', () => {
  passOutcome(10, 0.2, 0.2, 10, 10, k, 0, pass);
  const short = pass.errM;
  passOutcome(40, 0.2, 0.2, 10, 10, k, 0, pass);
  assert.ok(pass.errM > short);
  passOutcome(40, 0.2, 0.2, 20, 10, k, 0, pass);
  assert.ok(pass.errM < short * 4);
  assert.equal(pass.accurate, true);
  passOutcome(10, 0.2, 0.2, 10, 10, k, 0.9999999, pass);
  assert.equal(pass.accurate, pass.pComplete > 0.9999999);
});

test('first touch: better firstTouch and technique, less pressure and a slower ball never lower pControl', () => {
  const p = (speed, pressure, ft, tech) => {
    firstTouch(speed, pressure, ft, tech, k, 0.5, touch);
    return touch.pControl;
  };
  monotonic(attrs, (a) => p(12, 0.3, a, 12), 'up', 'firstTouch');
  monotonic(attrs, (a) => p(12, 0.3, 12, a), 'up', 'technique');
  monotonic(unit, (x) => p(12, x, 12, 12), 'down', 'pressure');
  monotonic([0, 5, 10, 20, 30], (s) => p(s, 0.3, 12, 12), 'down', 'ball speed');
});

test('dribble: better dribbler never loses, better defender never wins; tackle and aerial duels are monotonic', () => {
  const d = (dribbling, agility, flair, tackling, positioning) => {
    dribbleOutcome(dribbling, agility, flair, tackling, positioning, k, 0.5, beat);
    return beat.pBeat;
  };
  monotonic(attrs, (a) => d(a, 12, 12, 12, 12), 'up', 'dribbling');
  monotonic(attrs, (a) => d(12, a, 12, 12, 12), 'up', 'agility');
  monotonic(attrs, (a) => d(12, 12, a, 12, 12), 'up', 'flair');
  monotonic(attrs, (a) => d(12, 12, 12, a, 12), 'down', 'defender tackling');
  monotonic(attrs, (a) => d(12, 12, 12, 12, a), 'down', 'defender positioning');

  const t = (tackling, strength, dribbling, balance) => {
    tackleOutcome(tackling, strength, dribbling, balance, 12, 1, 0, 0, k, 0.99, 0.5, tack);
    return tack.pWin;
  };
  monotonic(attrs, (a) => t(a, 12, 12, 12), 'up', 'tackling');
  monotonic(attrs, (a) => t(12, a, 12, 12), 'up', 'strength');
  monotonic(attrs, (a) => t(12, 12, a, 12), 'down', 'carrier dribbling');
  monotonic(attrs, (a) => t(12, 12, 12, a), 'down', 'carrier balance');

  const f = (aggression, tackling, fitness, behind, injury) => {
    tackleOutcome(12, 12, 12, 12, aggression, fitness, behind, injury, k, 0.5, 0.5, tack);
    return tack.pFoul;
  };
  monotonic(attrs, (a) => f(a, 12, 1, 0, 0), 'up', 'aggression');
  monotonic(attrs, (a) => f(12, a, 1, 0, 0), 'down', 'tackling skill');
  monotonic([1, 0.8, 0.6, 0.4, 0.2, 0], (x) => f(12, 12, x, 0, 0), 'up', 'tiredness');
  assert.ok(f(12, 12, 1, 1, 0) > f(12, 12, 1, 0, 0));
  monotonic([0, 1, 2, 3], (l) => f(12, 12, 1, 0, l), 'up', 'injury level');

  const a = (x) => {
    aerialDuel(x, 12, k, 0.5, aer);
    return aer.pWinA;
  };
  monotonic(attrs, a, 'up', 'aerial');
  // The draw decides: below pWin wins, above loses; a foul excludes a won tackle.
  tackleOutcome(12, 12, 12, 12, 20, 0, 1, 3, k, 0, 0, tack);
  assert.equal(tack.foul, true);
  assert.equal(tack.won, false);
});

test('shooting: higher Finishing or Composure, or less pressure, never widens the placement spread', () => {
  const spread = (finishing, composure, pressure) => {
    let worst = 0;
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 20; j++) {
        shotPlacement(finishing, composure, pressure, 2, 0.5, 25, k, i / 20, j / 20, place);
        worst = Math.max(worst, Math.abs(place.goalY - 2), Math.abs(place.goalZ - 0.5));
      }
    }
    return worst;
  };
  monotonic(attrs, (a) => spread(a, 12, 0.3), 'down', 'finishing');
  monotonic(attrs, (a) => spread(12, a, 0.3), 'down', 'composure');
  monotonic(unit, (x) => spread(12, 12, x), 'up', 'pressure');
});

test('shooting: a result inside the frame is on target, the post band is woodwork, the rest is off target', () => {
  const at = (aimY, aimZ) => {
    shotPlacement(20, 20, 0, aimY, aimZ, 25, k, 0.5, 0.5, place);
    return { ...place };
  };
  assert.equal(at(0, 1).onTarget, true);
  assert.equal(at(3.7, 1).woodwork, true);
  assert.equal(at(3.7, 1).onTarget, false);
  assert.equal(at(5, 1).woodwork, false);
  assert.equal(at(0, 2.5).woodwork, true);
  assert.equal(at(0, 4).onTarget, false);
});

test('save: a faster shot, or one placed nearer a corner, never raises the save chance; better keepers save more', () => {
  const s = (reflexes, positioning, oneOnOnes, isOneOnOne, placement, v) => {
    saveOutcome(reflexes, positioning, oneOnOnes, isOneOnOne, placement, v, 1, k, 0.5, save);
    return save.pSave;
  };
  monotonic([5, 10, 15, 20, 25, 30, 40], (v) => s(12, 12, 12, false, 0.5, v), 'down', 'shot speed');
  monotonic(unit, (x) => s(12, 12, 12, false, x, 20), 'down', 'placement');
  monotonic(attrs, (a) => s(a, 12, 12, false, 0.5, 20), 'up', 'reflexes');
  monotonic(attrs, (a) => s(12, a, 12, false, 0.5, 20), 'up', 'positioning');
  monotonic(attrs, (a) => s(12, 12, a, true, 0.5, 20), 'up', 'one-on-ones');
  assert.equal(s(12, 12, 1, false, 0.5, 20), s(12, 12, 20, false, 0.5, 20)); // oneOnOnes only counts in a one-on-one
});

test('save kinds: slow is HELD, near the frame is TIPPED, otherwise PARRIED', () => {
  saveOutcome(12, 12, 12, false, 0.5, 10, 1, k, 0, save);
  assert.equal(save.kind, 'HELD');
  saveOutcome(12, 12, 12, false, 0.5, 25, 0.1, k, 0, save);
  assert.equal(save.kind, 'TIPPED');
  saveOutcome(12, 12, 12, false, 0.5, 25, 1, k, 0, save);
  assert.equal(save.kind, 'PARRIED');
});

test('contest: better anticipation, a slower ball and a closer path never lower the interception chance', () => {
  const c = (anticipation, speed, dist) => {
    contestOutcome(anticipation, speed, dist, 1, k, 0.5, cont);
    return cont.pWin;
  };
  monotonic(attrs, (a) => c(a, 12, 0.5), 'up', 'anticipation');
  monotonic([0, 5, 12, 20, 30], (v) => c(12, v, 0.5), 'down', 'speed');
  monotonic([0, 0.25, 0.5, 0.75, 1], (d) => c(12, 12, d), 'down', 'distance');
});

test('xG: closer, wider and unmarked shots are better; headers are worse; PSxG rewards corners and pace', () => {
  const c = config.xg.logistic;
  const base = { distance: 16, angle: 0.4, isHeader: false, defendersInCone: 0, assistType: 'none' };
  monotonic([5, 10, 16, 25, 35], (d) => xg({ ...base, distance: d }, c), 'down', 'distance');
  monotonic([0.1, 0.3, 0.5, 1, 1.5], (a) => xg({ ...base, angle: a }, c), 'up', 'angle');
  monotonic([0, 1, 2, 3], (n) => xg({ ...base, defendersInCone: n }, c), 'down', 'defenders');
  assert.ok(xg({ ...base, isHeader: true }, c) < xg(base, c));
  assert.ok(xg(base, c) > 0 && xg(base, c) < 1);
  const ps = config.xg.psxg;
  assert.ok(psxg(0.2, 3.3, 2.2, 28, ps) > psxg(0.2, 0, 0.5, 12, ps));
  assert.equal(psxg(0, 3, 2, 30, ps), 0);
  monotonic([5, 15, 25, 35], (v) => psxg(0.2, 1, 1, v, ps), 'up', 'shot speed');
});
