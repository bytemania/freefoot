import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { buildTickConfig } from '../../src/engine/TickConfig.js';
import { validateMatchInput } from '../../src/engine/contracts/MatchInput.js';
import { levelOf, initialMorale, onGoal, onRedCard, updateMorale } from '../../src/engine/morale/Morale.js';
import { passOutcome } from '../../src/engine/resolve/passing.js';
import { shotPlacement } from '../../src/engine/resolve/shooting.js';
import { tackleOutcome } from '../../src/engine/resolve/duels.js';
import { generateRatedSquad } from '../../src/shared/squadgen.js';

const k = buildTickConfig(config);
const mw = k.weights.morale;

/** @param {number} homeMorale @param {number} awayMorale */
function engineWith(homeMorale, awayMorale) {
  const home = generateRatedSquad(80, 11, config, { side: 'home', morale: homeMorale });
  const away = generateRatedSquad(80, 12, config, { side: 'away', morale: awayMorale });
  return MatchEngine.create({ v: 1, seed: 5, configHash, home, away }, config);
}

test('morale level: 0 at 75, +1 at 95, -1 at 30, clamped', () => {
  assert.equal(levelOf(75, mw), 0);
  assert.equal(levelOf(95, mw), 1);
  assert.equal(levelOf(30, mw), -1);
  assert.equal(levelOf(100, mw), mw.maxLevel);
  assert.equal(levelOf(0, mw), -mw.maxLevel);
});

test('starting morale: player value, else team value, else neutral', () => {
  assert.equal(initialMorale({ morale: 40 }, { morale: 90 }, 75), 40);
  assert.equal(initialMorale({}, { morale: 90 }, 75), 90);
  assert.equal(initialMorale({}, {}, 75), 75);
  const e = engineWith(92, 35);
  assert.equal(e.state.players[0].morale, 92);
  assert.equal(e.state.players[18].morale, 35);
  assert.ok(e.state.players[0].moraleLevel > 0 && e.state.players[18].moraleLevel < 0);
});

test('MatchInput validates morale 0-100 on teams and players', () => {
  const home = generateRatedSquad(80, 1, config, { side: 'home', morale: 120 });
  const away = generateRatedSquad(80, 2, config, { side: 'away' });
  away.players[3].morale = -5;
  const errors = validateMatchInput({ v: 1, seed: 1, configHash, home, away }, config);
  assert.ok(errors.some((e) => e.startsWith('home.morale')));
  assert.ok(errors.some((e) => e.startsWith('away.players[3].morale')));
});

test('goals and red cards shift momentum, tempered by composure, and the shift decays', () => {
  const e = engineWith(75, 75);
  const s = e.state;
  onGoal(s, 0);
  assert.equal(s.teams[0].moraleShift, mw.events.goalFor);
  assert.equal(s.teams[1].moraleShift, -mw.events.goalAgainst);
  assert.ok(s.players[0].morale > 75 && s.players[18].morale < 75);

  // A composed, determined player swings less than a nervy one.
  const calm = s.players[1];
  const nervy = s.players[2];
  /** @type {any} */ (calm.cold.attributes).composure = 20;
  /** @type {any} */ (calm.cold.attributes).determination = 20;
  /** @type {any} */ (nervy.cold.attributes).composure = 1;
  /** @type {any} */ (nervy.cold.attributes).determination = 1;
  onRedCard(s, 0);
  assert.ok(Math.abs(calm.morale - 75) < Math.abs(nervy.morale - 75));

  const before = Math.abs(s.teams[1].moraleShift);
  for (let i = 0; i < 20 * 60; i++) {
    s.tick++;
    updateMorale(s);
  }
  assert.ok(Math.abs(s.teams[1].moraleShift) < before, 'decays toward 0');
});

test('morale modulates each execution channel, bounded (each well under 8% between 30 and 95)', () => {
  const out = { pComplete: 0, errM: 0, accurate: false };
  const p = (/** @type {number} */ lv) => {
    passOutcome(20, 0.3, 0.3, 15, 15, k.weights, 0.5, out, k.weights.morale.passLogit * lv);
    return out.pComplete;
  };
  const high = p(1);
  const low = p(-1);
  assert.ok(high > p(0) && p(0) > low);
  assert.ok((high - low) / p(0) > 0.005 && (high - low) / p(0) < 0.08, `pass swing ${(high - low) / p(0)}`);

  // Shot error radius: the confident shooter is tighter, by a bounded margin.
  const place = { goalY: 0, goalZ: 0, vShot: 0, onTarget: false, woodwork: false };
  const radius = (/** @type {number} */ steady) => {
    shotPlacement(15, 15, 0.5, 0, 0, 25, k.weights, 1, 1, place, steady);
    return place.goalY;
  };
  const cut = mw.shotRadius * 1 * (0.5 + 0.5);
  assert.ok(radius(cut) < radius(0) && radius(-cut) > radius(0));
  assert.ok(radius(-cut) / radius(cut) < 1.2);

  const tk = { pWin: 0, pFoul: 0, won: false, foul: false };
  tackleOutcome(15, 15, 15, 15, 10, 1, 0, 0, k.weights, 1, 1, tk, mw.tackleLogit * 2);
  const up = tk.pWin;
  tackleOutcome(15, 15, 15, 15, 10, 1, 0, 0, k.weights, 1, 1, tk, 0);
  assert.ok(up > tk.pWin && up - tk.pWin < 0.06);
});

test('morale state survives serialize / restore and changes the hash', () => {
  const e = engineWith(90, 40);
  e.step(600);
  onGoal(e.state, 1);
  const data = JSON.parse(JSON.stringify(e.serialize()));
  assert.equal(data.teams[1].moraleShift, e.state.teams[1].moraleShift);
  const r = MatchEngine.fromState(data, e.input, config);
  assert.equal(r.hash(), e.hash());
  assert.equal(r.state.players[18].morale, e.state.players[18].morale);
  assert.notEqual(engineWith(75, 75).hash(), engineWith(90, 40).hash());
});
