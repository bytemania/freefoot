// Defensive compactness (ball-side line shift with depth scaling and minimum spacing) and the counter-press.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { computeAnchors } from '../../src/engine/tactics/Formation.js';
import { decideOffBall } from '../../src/engine/decisions/OffBallDecision.js';
import { giveBall } from '../../src/engine/decisions/Actions.js';
import { ACTION } from '../../src/engine/decisions/Perception.js';
import { config, sampleInput } from './helpers.js';

const ob = Object.fromEntries(Object.entries(config.weights.offBall).map(([k, v]) => [k, /** @type {any} */ (v).value]));
const HOME_CARRIER = 9;
const AWAY = 18;

/** Away team's CB/FB/MF anchors (own frame y) with home holding the ball at (x, y). */
/**
 * @param {number} x
 * @param {number} y
 */
function awayLines(x, y) {
  const engine = MatchEngine.create(sampleInput(1), config);
  const s = engine.state;
  s.restart.state = 'IN_PLAY';
  s.ball.owner = HOME_CARRIER;
  s.ball.x = x;
  s.ball.y = y;
  computeAnchors(s, s.teams[1]);
  const slots = config.tactics.formations[s.teams[1].formationId].slots;
  const line = (/** @type {string[]} */ roles) => {
    const ys = [];
    for (let i = AWAY; i < AWAY + 11; i++) if (roles.includes(slots[s.players[i].slot].role)) ys.push(68 - s.players[i].ty); // own frame
    return ys.sort((a, b) => a - b);
  };
  return { back: line(['CB', 'FB']), mid: line(['MF']), s };
}
const mean = (/** @type {number[]} */ a) => a.reduce((p, c) => p + c, 0) / a.length;
const width = (/** @type {number[]} */ a) => a[a.length - 1] - a[0];

test('out of possession the defence and midfield lines narrow and slide toward the ball side, keeping their spacing', () => {
  // Ball on the home side of the pitch, y = 8 -> away own frame y = 60.
  const mid = awayLines(52, 8);
  const centre = awayLines(52, 34);
  assert.ok(width(mid.back) < width(centre.back) + 1e-9 || mean(mid.back) > mean(centre.back), 'back line shifts');
  assert.ok(mean(mid.back) > mean(centre.back) + 3, `back line slid toward the ball (${mean(mid.back).toFixed(1)} vs ${mean(centre.back).toFixed(1)})`);
  assert.ok(mean(mid.mid) > mean(centre.mid) + 3, 'midfield slid too');
  // Narrower than the base shape (no shift) when the ball is central: ball-side shift on a wide ball compresses nothing below the minimum gap.
  for (const line of [mid.back, mid.mid]) {
    for (let i = 1; i < line.length; i++) assert.ok(line[i] - line[i - 1] >= ob.lineMinGap - 1e-6, `gap ${(line[i] - line[i - 1]).toFixed(2)} >= ${ob.lineMinGap}`);
  }
  assert.ok(width(centre.back) < 60, 'a compact block');
});

test('the shift is smaller when the ball is wide in the defensive third than in midfield', () => {
  // Away defends x = 105: ball at x = 95 is deep in the away third (own-frame x = 10), x = 52 is midfield.
  const deep = awayLines(95, 8);
  const midfield = awayLines(52, 8);
  const shiftOf = (/** @type {{back: number[]}} */ l, /** @type {number} */ base) => mean(l.back) - base;
  const base = mean(awayLines(52, 34).back);
  assert.ok(shiftOf(deep, base) < shiftOf(midfield, base), 'stays central when the ball is wide behind them');
});

/** Home carrier loses the ball to an away player at (70, 34); returns the engine. */
/** @param {{x: number, y: number}} [at] */
function turnover(at = { x: 70, y: 34 }) {
  const engine = MatchEngine.create(sampleInput(1), config);
  const s = engine.state;
  s.restart.state = 'IN_PLAY';
  for (let i = 0; i < 11; i++) {
    const p = s.players[i];
    p.x = p.prevX = 40 + i * 3; // home players spread behind, increasing distance
    p.y = p.prevY = 34;
  }
  s.players[0].x = 3;
  s.players[HOME_CARRIER].x = s.players[HOME_CARRIER].prevX = 69;
  s.players[HOME_CARRIER].y = s.players[HOME_CARRIER].prevY = 36;
  s.ball.owner = HOME_CARRIER;
  s.ball.pass = null;
  s.ball.flight = null;
  const thief = s.players[AWAY + 6];
  thief.x = thief.prevX = at.x;
  thief.y = thief.prevY = at.y;
  s.ball.x = at.x;
  s.ball.y = at.y;
  giveBall(s, AWAY + 6);
  return engine;
}

test('after a turnover up the pitch the nearest two press at once; the third does not; the press ends after the window', () => {
  const engine = turnover();
  const s = engine.state;
  assert.equal(s.teams[0].pressTicks, ob.counterPressTicks);
  assert.equal(s.teams[1].pressTicks, 0);
  const carrier = s.players[AWAY + 6];
  /** @type {number[]} */
  const pressers = [];
  for (let i = 1; i < 11; i++) {
    const p = s.players[i];
    decideOffBall(s, p);
    if (p.pendingAction === ACTION.PRESS) pressers.push(i);
  }
  assert.ok(pressers.length >= 1 && pressers.length <= 2, `one or two press: ${pressers}`);
  // They are the nearest to the new carrier.
  const dist = (/** @type {number} */ i) => Math.hypot(s.players[i].x - carrier.x, s.players[i].y - carrier.y);
  const others = [...Array(10).keys()].map((i) => i + 1).filter((i) => !pressers.includes(i));
  for (const q of pressers) for (const o of others) assert.ok(dist(q) <= dist(o) + 1e-9);

  // Just outside the normal press zone but inside the counter-press zone: pressed only while the window lasts.
  const nearestIdx = pressers.reduce((a, b) => (dist(a) <= dist(b) ? a : b));
  const n = s.players[nearestIdx];
  const nSlot = config.tactics.formations[s.teams[0].formationId].slots[n.slot];
  for (let i = 1; i < 11; i++) if (i !== nearestIdx) s.players[i].x = s.players[i].prevX = 20; // everyone else far behind
  const dir = n.x < carrier.x ? -1 : 1;
  n.x = n.prevX = carrier.x + dir * (nSlot.pressZone * (1 + ob.counterPressZone) / 2);
  n.y = n.prevY = carrier.y;
  decideOffBall(s, n);
  assert.equal(n.pendingAction, ACTION.PRESS, 'pressed during the window');
  s.teams[0].pressTicks = 0; // the window is over: back to the normal rules
  decideOffBall(s, n);
  assert.notEqual(n.pendingAction, ACTION.PRESS, 'settles back once the window expires');
  // The timer counts down in play.
  const e2 = turnover();
  e2.step(10);
  assert.ok(e2.state.teams[0].pressTicks <= ob.counterPressTicks - 9);
});

test('a turnover deep in the loser\'s own third starts no counter-press', () => {
  const engine = turnover({ x: 20, y: 34 }); // home own frame x = 20 < counterPressFrom
  assert.equal(engine.state.teams[0].pressTicks, 0);
});

test('the counter-press timer survives serialize/restore: the same hash after the window', () => {
  const input = sampleInput(8, { homeControl: 'ai', awayControl: 'ai' });
  const a = MatchEngine.create(input, config);
  while (a.tick < 6000) a.step(6000 - a.tick);
  a.state.teams[0].pressTicks = 40;
  const saved = JSON.parse(JSON.stringify(a.serialize()));
  assert.equal(saved.teams[0].pressTicks, 40);
  const b = MatchEngine.fromState(saved, input, config);
  assert.equal(b.state.teams[0].pressTicks, 40);
  assert.equal(b.hash(), a.hash());
  a.step(300);
  b.step(300);
  assert.equal(b.hash(), a.hash());
});
