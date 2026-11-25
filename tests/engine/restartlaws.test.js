// Laws of the Game restart positioning (Laws 8, 11, 13, 14, 15, 16, 17).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { PITCH_LENGTH, PITCH_WIDTH } from '../../src/engine/state/MatchState.js';
import { positionForRestart, startFoulRestart, startRestart } from '../../src/engine/restarts/RestartMachine.js';
import { ARRIVAL_SLOP, CLEARANCE } from '../../src/engine/restarts/laws.js';
import { launchPass } from '../../src/engine/decisions/Actions.js';
import { attackGoalX, along, GOAL_Y, keeperOf, PENALTY_SPOT } from '../../src/engine/decisions/Perception.js';
import { config, sampleInput } from './helpers.js';

const CX = PITCH_LENGTH / 2;
const CY = PITCH_WIDTH / 2;
const EPS = 1e-6;

/** @param {number} ax @param {number} ay @param {number} bx @param {number} by */
const dist = (ax, ay, bx, by) => Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));

/** @param {number} seed */
function engineAt(seed) {
  return MatchEngine.create(sampleInput(seed), config);
}

/**
 * Runs the engine until it is in open play, then returns it.
 * @param {number} seed
 */
function inPlay(seed) {
  const engine = engineAt(seed);
  engine.step(100);
  assert.equal(engine.state.restart.state, 'IN_PLAY');
  return engine;
}

/**
 * Checks Law 8 on both targets and current positions for the restart's kicking team.
 * @param {any} s
 * @param {'t' | 'pos'} which
 */
function assertKickOffLegal(s, which) {
  const kicking = s.restart.teamIndex;
  let kickersInCircle = 0;
  for (const i of s.onPitchList) {
    const p = s.players[i];
    const x = which === 't' ? p.tx : p.x;
    const y = which === 't' ? p.ty : p.y;
    const d = dist(x, y, CX, CY);
    assert.ok(along(s, p.team, x) <= CX + EPS, `player ${i} (${which}) must be in their own half, along=${along(s, p.team, x)}`);
    if (p.team === kicking) {
      if (d < 9.15) kickersInCircle++;
    } else {
      assert.ok(d >= 9.15 - EPS, `defender ${i} (${which}) is ${d.toFixed(2)} m from the centre spot`);
    }
  }
  assert.ok(kickersInCircle <= 2, `at most 2 kicking-off players in the centre circle, got ${kickersInCircle}`);
  return kickersInCircle;
}

test('KICK_OFF: taker + one support in the circle, everyone in their own half, defenders outside 9.15 m', () => {
  // Opening kick-off (settled at create) and its positioning targets.
  for (const seed of [1, 2, 3]) {
    const engine = engineAt(seed);
    const s = engine.state;
    positionForRestart(s);
    assert.equal(assertKickOffLegal(s, 't'), 2, 'taker on the spot + one support team-mate');
    assertKickOffLegal(s, 'pos');
  }

  // A kick-off after a goal and the second-half kick-off (sides swapped).
  const engine = inPlay(4);
  const s = engine.state;
  startRestart(s, 'KICK_OFF', 1, CX, CY);
  assertKickOffLegal(s, 'pos');
  positionForRestart(s);
  assertKickOffLegal(s, 't');
  const taker = s.players[s.restart.taker];
  assert.deepEqual([taker.tx, taker.ty], [CX, CY]);
  const support = s.onPitchList.filter((i) => i !== s.restart.taker && s.players[i].team === 1 && dist(s.players[i].tx, s.players[i].ty, CX, CY) < 9.15);
  assert.equal(support.length, 1);
  const sd = dist(s.players[support[0]].tx, s.players[support[0]].ty, CX, CY);
  assert.ok(sd > 1.5 && sd < 2.5, `support ~2 m from the taker, got ${sd.toFixed(2)}`);

  s.clock.half = 2;
  startRestart(s, 'KICK_OFF', 0, CX, CY);
  positionForRestart(s);
  assertKickOffLegal(s, 't');
  assertKickOffLegal(s, 'pos');
});

test('KICK_OFF positions hold while the kick-off hold runs', () => {
  const engine = engineAt(9);
  const s = engine.state;
  for (let t = 0; t < 40; t++) {
    engine.step(1);
    if (s.restart.state !== 'DEAD_BALL') break;
    assertKickOffLegal(s, 'pos');
  }
});

test('FREE_KICK wall: only direct kicks within 32 m of goal, a straight line across the goal-centre line at the 10-yard ring (9.15 m plus clearance), inside bounds, never the GK', () => {
  const engine = inPlay(7);
  const s = engine.state;
  const sp = s.k.weights.setPieces;
  /** The wall forms on the 10-yard ring plus the free-kick clearance and arrival slop, so it is legal as it forms. */
  const ring = sp.wallDist + CLEARANCE.FREE_KICK + ARRIVAL_SLOP;
  const gx = attackGoalX(s, 0);
  const dir = s.attackDir(0);

  /** Wall members, as the wall was set. */
  const wallOf = () => s.wall.members.slice();

  const cases = [
    { x: gx - dir * 23, y: GOAL_Y - 6 },
    { x: gx - dir * 20, y: GOAL_Y },
    { x: gx - dir * 29, y: GOAL_Y + 10 },
    { x: gx - dir * 3, y: GOAL_Y - 17.5 }, // near the byline: wall must stay in the pitch
    { x: gx - dir * 0.6, y: GOAL_Y + 20.5 },
  ];
  for (const c of cases) {
    startFoulRestart(s, 0, c.x, c.y, false, 14, 9);
    positionForRestart(s);
    const wall = wallOf();
    assert.ok(wall.length >= sp.wallMinPlayers && wall.length <= sp.wallMaxPlayers, `wall of ${wall.length} at (${c.x}, ${c.y})`);
    for (const i of wall) {
      const p = s.players[i];
      assert.ok(p.tx >= 0.5 && p.tx <= 104.5, `wall x ${p.tx}`);
      assert.ok(p.ty >= 1.0 && p.ty <= 67.0, `wall y ${p.ty}`);
      assert.equal(p.team, 1);
      assert.ok(dist(p.tx, p.ty, c.x, c.y) >= ring - 1e-6, 'at least the 10-yard ring (9.15 m plus clearance) from the ball');
      assert.ok(dist(p.tx, p.ty, c.x, c.y) <= ring + 2, 'and in front of it');
    }
    assert.ok(wall.every((i) => i !== keeperOf(s, 1)), 'never the goalkeeper');
    // Every other defender is at least 9.15 m away; attackers keep 1 m off the wall.
    for (const i of s.onPitchList) {
      const p = s.players[i];
      if (p.team === 1) assert.ok(dist(p.tx, p.ty, c.x, c.y) >= 9.15 - 1e-6, `defender ${i} too close`);
      else if (i !== s.restart.taker) {
        for (const w of wall) {
          assert.ok(dist(p.tx, p.ty, s.players[w].tx, s.players[w].ty) >= 1.0 - 1e-6, `attacker ${i} inside the wall`);
        }
      }
    }
  }

  // No wall: beyond 32 m, in the defending half, or an indirect free kick.
  for (const [x, y, direct] of [[gx - dir * 34, GOAL_Y, true], [gx - dir * 70, GOAL_Y, true], [gx - dir * 20, GOAL_Y, false]]) {
    startRestart(s, 'FREE_KICK', 0, /** @type {number} */ (x), /** @type {number} */ (y), { direct: /** @type {boolean} */ (direct) });
    positionForRestart(s);
    assert.equal(s.wall.members.length, 0, `no wall at ${x}, direct=${direct}`);
  }
});

test('FREE_KICK wall skips substituted and sent-off players', () => {
  const engine = inPlay(8);
  const s = engine.state;
  const gx = attackGoalX(s, 0);
  const dir = s.attackDir(0);
  startFoulRestart(s, 0, gx - dir * 22, GOAL_Y, false, 14, 9);
  positionForRestart(s);
  const sp = s.k.weights.setPieces;
  const firstWall = s.wall.members.slice();
  const gone = firstWall[0];
  s.players[gone].onPitch = 0;
  s.players[gone].out = 1;
  s.rebuildOnPitchList();
  positionForRestart(s);
  const wall2 = s.wall.members.slice();
  assert.ok(!wall2.includes(gone));
  assert.ok(wall2.length >= sp.wallMinPlayers);
});

test('PENALTY: every outfield player but the taker behind the box line and outside the 9.15 m arc; GK on the line', () => {
  for (const [seed, half] of [[11, 1], [12, 2]]) {
    const engine = inPlay(seed);
    const s = engine.state;
    s.clock.half = half;
    for (const team of [0, 1]) {
      startFoulRestart(s, team, 0, 0, true, 14, 9);
      positionForRestart(s);
      const gx = attackGoalX(s, team);
      const spotX = gx === 0 ? PENALTY_SPOT : PITCH_LENGTH - PENALTY_SPOT;
      assert.deepEqual([s.restart.x, s.restart.y], [spotX, GOAL_Y]);
      const taker = s.players[s.restart.taker];
      assert.deepEqual([taker.tx, taker.ty], [spotX, GOAL_Y]);
      const gk = s.players[keeperOf(s, 1 - team)];
      assert.ok(Math.abs(gk.tx - gx) <= 0.5 && Math.abs(gk.ty - GOAL_Y) <= 3.66, 'GK on the goal line between the posts');
      let outfield = 0;
      for (const i of s.onPitchList) {
        const p = s.players[i];
        if (i === s.restart.taker || p.isKeeper === 1) continue;
        outfield++;
        if (gx === PITCH_LENGTH) assert.ok(p.tx < 88.5, `player ${i} x=${p.tx} inside the box`);
        else assert.ok(p.tx > 16.5, `player ${i} x=${p.tx} inside the box`);
        assert.ok(dist(p.tx, p.ty, spotX, GOAL_Y) >= 9.15, `player ${i} inside the penalty arc`);
      }
      assert.equal(outfield, 19);
    }
  }
});

test('GOAL_KICK: kicking team may build up in its box, all 11 opponents stay outside it', () => {
  const engine = inPlay(13);
  const s = engine.state;
  for (const team of [0, 1]) {
    const ownGoal = attackGoalX(s, 1 - team);
    startRestart(s, 'GOAL_KICK', team, ownGoal === 0 ? 5.5 : PITCH_LENGTH - 5.5, GOAL_Y);
    // Crowd the opponents into the box first: positioning must clear them.
    for (const i of s.onPitchList) {
      const p = s.players[i];
      if (p.team !== team) {
        p.x = ownGoal === 0 ? 8 : PITCH_LENGTH - 8;
      }
    }
    positionForRestart(s);
    let opponents = 0;
    for (const i of s.onPitchList) {
      const p = s.players[i];
      if (p.team === team) continue;
      opponents++;
      if (ownGoal === 0) assert.ok(p.tx > 16.5, `opponent ${i} x=${p.tx} in the box`);
      else assert.ok(p.tx < 88.5, `opponent ${i} x=${p.tx} in the box`);
    }
    assert.equal(opponents, 11);
  }
});

test('CORNER keeps every defender 9.15 m from the corner spot; THROW_IN keeps opponents 2 m away', () => {
  const engine = inPlay(14);
  const s = engine.state;
  for (const team of [0, 1]) {
    const gx = attackGoalX(s, team);
    for (const cy of [0, PITCH_WIDTH]) {
      startRestart(s, 'CORNER', team, gx, cy);
      // Park a defender right at the flag before positioning.
      const def = s.onPitchList.find((i) => s.players[i].team !== team && s.players[i].isKeeper !== 1);
      s.players[Number(def)].tx = gx;
      positionForRestart(s);
      for (const i of s.onPitchList) {
        const p = s.players[i];
        if (p.team !== team) assert.ok(dist(p.tx, p.ty, gx, cy) >= 9.15 - EPS, `defender ${i} ${dist(p.tx, p.ty, gx, cy).toFixed(2)} m from the corner`);
      }
    }
  }
  for (const [x, y] of [[30, 0], [80, PITCH_WIDTH], [0.5, 0], [104.5, PITCH_WIDTH]]) {
    startRestart(s, 'THROW_IN', 0, x, y);
    positionForRestart(s);
    for (const i of s.onPitchList) {
      const p = s.players[i];
      if (p.team === 1) assert.ok(dist(p.tx, p.ty, x, y) >= 2.0 - EPS, `opponent ${i} too close to the throw`);
    }
  }
});

test('Law 11: no offside for the direct receiver of a goal kick, throw-in or corner (but yes from a free kick)', () => {
  for (const restart of ['GOAL_KICK', 'THROW_IN', 'CORNER', '']) {
    const engine = inPlay(5);
    const s = engine.state;
    const passer = s.players[5];
    const receiver = s.players[9];
    passer.x = 40;
    passer.y = 34;
    receiver.x = 85;
    receiver.y = 30;
    for (const i of s.onPitchList) {
      const q = s.players[i];
      if (q.team === 1) {
        q.x = q.isKeeper === 1 ? 104 : 70;
        q.y = 34 + (i % 5) * 3;
      }
    }
    s.ball.owner = 5;
    s.tickEvents.length = 0;
    const ok = launchPass(s, passer, 9, restart === '' ? 'SHORT' : 'LONG', restart);
    const flagged = s.tickEvents.some((e) => e.type === 'OFFSIDE');
    if (restart === '') {
      assert.equal(ok, false, 'open play: offside');
      assert.equal(flagged, true);
    } else {
      assert.equal(ok, true, `${restart}: receiver exempt`);
      assert.equal(flagged, false, `${restart}: no OFFSIDE event`);
    }
  }
});
