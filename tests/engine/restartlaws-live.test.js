// Live Laws of the Game audit: real AI-vs-AI matches, real player positions, checked on
// the exact tick every restart is released (Laws 8, 13, 14, 15, 16, 17). The geometry below
// is written out from the Laws on purpose, with no clearance and without importing laws.js,
// so the test cannot pass by repeating a mistake of the implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { PITCH_LENGTH, PITCH_WIDTH } from '../../src/engine/state/MatchState.js';
import { findRestartViolations, snapRestartViolators, GRACE_TICKS } from '../../src/engine/restarts/laws.js';
import { startRestart } from '../../src/engine/restarts/RestartMachine.js';
import { config, sampleInput } from './helpers.js';

const CX = PITCH_LENGTH / 2;
const CY = PITCH_WIDTH / 2;
const EPS = 1e-6;
const SEEDS = Number(process.env.RESTART_LAW_SEEDS ?? 20);

/** @param {number} ax @param {number} ay @param {number} bx @param {number} by */
const dist = (ax, ay, bx, by) => Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));

/** Strictly inside the penalty area of the goal on line `gx` (the law line, no clearance). */
const inBox = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ gx) =>
  Math.abs(x - gx) < 16.5 - EPS && Math.abs(y - CY) < 20.16 - EPS;

/** A keeper on their goal line between the posts may stand inside the 10 yards (Laws 13, 17). */
const onGoalLine = (/** @type {any} */ p) =>
  p.isKeeper === 1 && Math.min(p.x, PITCH_LENGTH - p.x) <= 1.5 && Math.abs(p.y - CY) <= 3.66 + 0.5;

/**
 * The Laws, written out. Returns the breaches for a released restart.
 * @param {any} s match state, on the tick the restart was released
 * @param {{kind: string, teamIndex: number, x: number, y: number, taker: number}} r
 * @returns {string[]}
 */
function breaches(s, r) {
  /** @type {string[]} */
  const out = [];
  let kickersInCircle = 0;
  for (const i of s.onPitchList) {
    if (i === r.taker) continue;
    const p = s.players[i];
    const opp = p.team !== r.teamIndex;
    const d = dist(p.x, p.y, r.x, r.y);
    switch (r.kind) {
      case 'KICK_OFF': {
        const along = s.attackDir(p.team) > 0 ? p.x : PITCH_LENGTH - p.x;
        if (along > CX + EPS) out.push(`${i} not in own half (${along.toFixed(2)})`);
        const dc = dist(p.x, p.y, CX, CY);
        if (opp && dc < 9.15 - EPS) out.push(`${i} defender ${dc.toFixed(2)} m from the centre spot`);
        if (!opp && dc < 9.15 - EPS) kickersInCircle++;
        break;
      }
      case 'FREE_KICK':
      case 'CORNER':
        if (opp && d < 9.15 - EPS && !onGoalLine(p)) out.push(`${i} ${d.toFixed(2)} m from the ${r.kind} spot`);
        break;
      case 'THROW_IN':
        if (opp && d < 2 - EPS) out.push(`${i} ${d.toFixed(2)} m from the throw-in`);
        break;
      case 'GOAL_KICK':
        if (opp && inBox(p.x, p.y, r.x < CX ? 0 : PITCH_LENGTH)) out.push(`${i} opponent inside the goal-kick area`);
        break;
      case 'PENALTY': {
        if (p.isKeeper === 1) break;
        const gx = r.x < CX ? 0 : PITCH_LENGTH;
        if (inBox(p.x, p.y, gx)) out.push(`${i} inside the penalty area`);
        if (d < 9.15 - EPS) out.push(`${i} ${d.toFixed(2)} m from the penalty spot`);
        break;
      }
      default:
    }
  }
  if (r.kind === 'KICK_OFF' && kickersInCircle > 1) out.push(`${kickersInCircle} kicking-side players besides the taker in the centre circle`);
  return out;
}

test('every restart of 20 AI-vs-AI matches is released with all players where the Laws say', () => {
  /** @type {Record<string, number>} */
  const released = {};
  /** @type {Record<string, number>} */
  const snapped = {};
  /** @type {string[]} */
  const failures = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const engine = MatchEngine.create(sampleInput(seed, { homeControl: 'ai', awayControl: 'ai' }), config);
    const s = engine.state;
    // The probe sees the live positions as play resumes: by the end of that tick a goal
    // from the restart may already have put everybody back on their kick-off spots.
    s.onRelease = (st, rel) => {
      released[rel.kind] = (released[rel.kind] ?? 0) + 1;
      if (rel.snapped > 0) snapped[rel.kind] = (snapped[rel.kind] ?? 0) + 1;
      for (const b of breaches(st, rel)) failures.push(`seed ${seed} tick ${st.tick} ${rel.kind}: ${b}`);
      assert.deepEqual(findRestartViolations(st, rel), [], `seed ${seed} tick ${st.tick} ${rel.kind}: laws.js disagrees`);
    };
    while (s.restart.state !== 'FULL_TIME') engine.step(200);
  }
  for (const kind of ['KICK_OFF', 'FREE_KICK', 'GOAL_KICK', 'CORNER', 'THROW_IN']) {
    assert.ok((released[kind] ?? 0) > 0, `${kind} never released`);
  }
  assert.deepEqual(failures.slice(0, 10), [], `${failures.length} breach(es) at release; restarts released ${JSON.stringify(released)}`);
  // The referee's snap is a last resort, not the way restarts normally get legal.
  const total = Object.values(released).reduce((a, b) => a + b, 0);
  const snaps = Object.values(snapped).reduce((a, b) => a + b, 0);
  assert.ok(snaps <= total * 0.1, `${snaps} of ${total} restarts needed the referee to move players: ${JSON.stringify(snapped)}`);
});

test('penalties are released legally too (forced penalty, debug invariants on)', () => {
  let penalties = 0;
  for (const seed of [3, 4, 5, 6]) {
    const engine = MatchEngine.create(sampleInput(seed, { homeControl: 'ai', awayControl: 'ai' }), config, { debug: true });
    const s = engine.state;
    engine.step(400);
    /** @type {string[][]} */
    const found = [];
    s.onRelease = (st, rel) => found.push(breaches(st, rel));
    for (const team of [0, 1]) {
      const gx = team === 0 ? PITCH_LENGTH : 0;
      startRestart(s, 'PENALTY', team, gx === 0 ? 11 : PITCH_LENGTH - 11, CY);
      const before = found.length;
      for (let t = 0; t < 400 && found.length === before; t++) engine.step(1);
      assert.equal(found.length, before + 1, 'the penalty was released');
      penalties++;
      assert.equal(s.released?.kind, 'PENALTY');
      engine.step(300);
    }
    assert.deepEqual(found.flat(), []);
  }
  assert.equal(penalties, 8);
});

test('a restart waits for stragglers, then the referee moves only the violators, deterministically', () => {
  const engine = MatchEngine.create(sampleInput(7, { homeControl: 'ai', awayControl: 'ai' }), config, { debug: true });
  const s = engine.state;
  engine.step(600);
  // A free kick in midfield; park an opponent on top of the spot, far from any chance to walk away in time.
  startRestart(s, 'FREE_KICK', 0, 40, 20, { direct: false });
  const victim = s.onPitchList.find((i) => s.players[i].team === 1 && s.players[i].isKeeper !== 1);
  assert.notEqual(victim, undefined);
  const hold = s.restart.resumeTick;
  const bystander = s.onPitchList.find((i) => i !== victim && s.players[i].team === 1 && s.players[i].isKeeper !== 1);
  assert.ok(typeof victim === 'number' && typeof bystander === 'number');
  const v = s.players[/** @type {number} */ (victim)];
  v.x = v.prevX = 40.5;
  v.y = v.prevY = 20.5;
  // Keep the victim pinned: re-park them every tick so only the referee can fix it.
  let releaseTick = -1;
  /** @type {number} */
  let atRelease = -1;
  s.onRelease = (st) => {
    atRelease = dist(v.x, v.y, 40, 20);
    releaseTick = st.tick;
  };
  while (s.restart.state === 'DEAD_BALL') {
    engine.step(1);
    if (s.restart.state === 'DEAD_BALL') {
      v.x = v.prevX = 40.5;
      v.y = v.prevY = 20.5;
    }
  }
  assert.ok(releaseTick >= hold + GRACE_TICKS, `released at ${releaseTick}, hold ended ${hold}, grace ${GRACE_TICKS}`);
  assert.ok(releaseTick <= hold + GRACE_TICKS + 1, 'released as soon as the grace period ended');
  assert.equal(s.released?.snapped, 1, 'only the pinned player was moved');
  assert.ok(atRelease >= 9.15, `the pinned player stands 10 yards away, got ${atRelease.toFixed(2)}`);
});

test('snapRestartViolators is deterministic and idempotent', () => {
  const run = () => {
    const engine = MatchEngine.create(sampleInput(11, { homeControl: 'ai', awayControl: 'ai' }), config);
    const s = engine.state;
    engine.step(500);
    startRestart(s, 'THROW_IN', 0, 30, 0.2);
    for (const i of s.onPitchList) {
      const p = s.players[i];
      if (p.team === 1 && p.isKeeper !== 1) {
        p.x = p.prevX = 30 + (i % 3) * 0.4;
        p.y = p.prevY = 0.8 + (i % 4) * 0.3;
      }
    }
    const spec = { kind: 'THROW_IN', teamIndex: 0, x: 30, y: 0.2, taker: s.restart.taker };
    const first = snapRestartViolators(s, spec);
    const second = snapRestartViolators(s, spec);
    return { first, second, hash: s.hash(), clear: findRestartViolations(s, spec).length };
  };
  const a = run();
  assert.ok(a.first > 0);
  assert.equal(a.second, 0);
  assert.equal(a.clear, 0);
  assert.deepEqual(run(), a);
});
