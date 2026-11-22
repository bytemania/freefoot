import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine, SNAP_LEN, SNAP_PLAYERS, SNAP_PLAYER_STRIDE } from '../../src/engine/MatchEngine.js';
import { TOTAL_PLAYERS } from '../../src/engine/state/MatchState.js';
import { positionForRestart, startFoulRestart } from '../../src/engine/restarts/RestartMachine.js';
import { evalWallShot3D } from '../../src/engine/restarts/wall.js';
import { launchShot } from '../../src/engine/decisions/Actions.js';
import { attackGoalX, GOAL_Y, keeperOf } from '../../src/engine/decisions/Perception.js';
import { inspectPitch } from '../../src/engine/debug/inspect.js';
import { config, sampleInput } from './helpers.js';

test('direct FREE_KICK within 32m sets a 2-5 outfield wall at 9.15m and offsets GK far-post', () => {
  const engine = MatchEngine.create(sampleInput(7), config);
  const s = engine.state;
  const gx = attackGoalX(s, 0); // team 0 attacks x=105 in H1
  const dir = s.attackDir(0);
  const fkX = gx - dir * 23;
  const fkY = GOAL_Y - 6;

  startFoulRestart(s, 0, fkX, fkY, false, 14, 9);
  positionForRestart(s);

  const sp = s.k.weights.setPieces;
  const gkIdx = keeperOf(s, 1);
  const gk = s.players[gkIdx];
  assert.ok(gk.ty > GOAL_Y + 0.5, 'GK should be offset toward far post when FK is on y < GOAL_Y');

  // Count non-GK defenders positioned at 9.15m wall distance
  const wallPlayers = [];
  for (const i of s.onPitchList) {
    const p = s.players[i];
    if (p.team !== 1) continue;
    const d = Math.hypot(p.tx - fkX, p.ty - fkY);
    if (Math.abs(d - sp.wallDist) < 1.8) wallPlayers.push(p);
  }
  assert.ok(wallPlayers.length >= sp.wallMinPlayers && wallPlayers.length <= sp.wallMaxPlayers,
    `expected ${sp.wallMinPlayers}-${sp.wallMaxPlayers} wall players, got ${wallPlayers.length}`);
  assert.ok(wallPlayers.every((p) => p.isKeeper !== 1), 'GK must never be placed in the wall');
});

test('direct free-kick shot into wall emits BLOCK and deflects ball into live play', () => {
  const engine = MatchEngine.create(sampleInput(11), config);
  const s = engine.state;
  const sp = s.k.weights.setPieces;
  const gx = attackGoalX(s, 0);
  const dir = s.attackDir(0);
  const fkX = gx - dir * 22;
  const fkY = GOAL_Y;

  startFoulRestart(s, 0, fkX, fkY, false, 14, 9);
  positionForRestart(s);
  // Snap players to their dead-ball target positions and give taker poor skill so low shot hits jumping wall
  for (const i of s.onPitchList) {
    const p = s.players[i];
    p.x = p.prevX = p.tx;
    p.y = p.prevY = p.ty;
  }
  const taker = s.players[s.restart.taker];
  taker.cold.attributes.finishing = 2;
  taker.cold.attributes.technique = 2;
  // Boost wall players jumpingReach so shotHeight <= wallTop deterministically
  for (const i of s.onPitchList) {
    const q = s.players[i];
    if (q.team === 1 && q.isKeeper !== 1 && Math.abs(Math.hypot(q.x - fkX, q.y - fkY) - sp.wallDist) < 1.8) {
      q.cold.attributes.jumpingReach = 20;
    }
  }

  let sawBlock = false;
  let sawBlockedShot = false;
  let blockMeta = null;
  for (let attempt = 0; attempt < 8 && !sawBlock; attempt++) {
    s.tickEvents.length = 0;
    launchShot(s, taker, { freeKick: true });
    for (const ev of s.tickEvents) {
      if (ev.type === 'SHOT' && ev.meta?.result === 'BLOCKED') sawBlockedShot = true;
      if (ev.type === 'BLOCK') {
        sawBlock = true;
        blockMeta = ev.meta;
      }
    }
  }
  assert.equal(sawBlockedShot, true, 'expected a BLOCKED free-kick SHOT');
  assert.equal(sawBlock, true, 'expected wall to emit BLOCK event');
  assert.equal(s.ball.owner, -1, 'deflected ball should be loose in live play');
  assert.ok(typeof blockMeta?.z === 'number' && blockMeta.z <= 2.35, 'BLOCK event must carry impact z <= jumping wall height');
  assert.ok(typeof blockMeta?.heightBand === 'string');

  // High dipped shot with skilled taker clears the wall
  const overWall = evalWallShot3D(s, taker, gx, GOAL_Y, 2.2, 24, 0.9);
  assert.equal(overWall.blocked, false, 'dipped high free-kick trajectory should clear 9.15m wall');
  assert.ok(overWall.maxZ >= 2.2);
});

test('CORNER restart positions attacking box/edge/rest-defense and defending zonal/marker/outlet roles', () => {
  const engine = MatchEngine.create(sampleInput(13), config);
  const s = engine.state;
  const gx = attackGoalX(s, 0); // 105
  const dir = s.attackDir(0); // +1

  // Trigger corner directly via RestartMachine
  s.restart.state = 'DEAD_BALL';
  s.restart.kind = 'CORNER';
  s.restart.teamIndex = 0;
  s.restart.x = gx;
  s.restart.y = 0;
  s.restart.taker = 7;
  positionForRestart(s);

  const sp = s.k.weights.setPieces;
  const attBox = [];
  const attEdge = [];
  const attRest = [];
  const defOutlet = [];
  const defBox = [];
  for (const i of s.onPitchList) {
    const p = s.players[i];
    if (p.isKeeper === 1 || i === s.restart.taker) continue;
    const distFromGoalLine = (gx - p.tx) * dir;
    if (p.team === 0) {
      if (distFromGoalLine <= 10 && Math.abs(p.ty - GOAL_Y) <= 8) attBox.push(p);
      else if (Math.abs(distFromGoalLine - sp.cornerEdgeRadius) < 1) attEdge.push(p);
      else if (Math.abs(distFromGoalLine - sp.cornerRestDefX) < 1) attRest.push(p);
    } else {
      if (Math.abs(distFromGoalLine - sp.cornerOutletX) < 1) defOutlet.push(p);
      else if (distFromGoalLine <= 12 && Math.abs(p.ty - GOAL_Y) <= 10) defBox.push(p);
    }
  }
  assert.equal(attBox.length, 3, 'should assign 3 attacking aerial targets (near/central/far)');
  assert.ok(attEdge.length >= 1 && attEdge.length <= 2, 'should assign 1-2 edge-of-box runners');
  assert.equal(attRest.length, 2, 'should assign 2 rest-defense players near halfway');
  assert.equal(defOutlet.length, 1, 'should assign 1 defending outlet near halfway');
  assert.ok(defBox.length >= 4, 'should assign zonal near-post protector + man-markers in box');
});

test('90-minute match updates starter fitness into ~65-82% band and propagates fitness/injured to snapshot & inspectPitch', () => {
  const engine = MatchEngine.create(sampleInput(1, { homeControl: 'ai', awayControl: 'ai' }), config);
  /** @type {{stoppedFor: string | null}} */
  let r = { stoppedFor: null };
  while (r.stoppedFor !== 'FULL_TIME') {
    r = engine.step(10000);
  }

  const snap = new Float64Array(SNAP_LEN);
  engine.getSnapshot(snap);
  const outfieldFits = [];
  for (let i = 0; i < TOTAL_PLAYERS; i++) {
    const p = engine.state.players[i];
    const o = SNAP_PLAYERS + SNAP_PLAYER_STRIDE * i;
    assert.equal(snap[o + 9], p.fitness, 'snapshot must propagate live fitness');
    if (p.onPitch === 1 && p.isKeeper === 0 && p.ticksOnPitch > 90000) {
      outfieldFits.push(p.fitness * 100);
    }
  }
  const avgFit = outfieldFits.reduce((a, b) => a + b, 0) / outfieldFits.length;
  assert.ok(avgFit >= 65 && avgFit <= 82, `expected average 90-min starter fitness in 65-82%, got ${avgFit.toFixed(1)}%`);

  // Verify injured boolean in inspectPitch matches injury state & snapshot, plus ball-flight z metadata
  engine.state.players[9].injury = 2;
  engine.getSnapshot(snap);
  const info = inspectPitch(engine.state);
  const p9Info = info.players.find((pl) => pl.index === 9);
  assert.equal(p9Info?.injured, true);
  assert.equal(snap[SNAP_PLAYERS + SNAP_PLAYER_STRIDE * 9 + 7], 2);
  assert.equal(typeof info.restartTaker, 'number');
  assert.equal(typeof info.ball.z, 'number');

  const flightTypes = new Set(['SHOT', 'GOAL', 'SAVE', 'BLOCK', 'PASS', 'CROSS', 'CLEARANCE', 'AERIAL_DUEL']);
  const checked = engine.eventLog.filter((e) => flightTypes.has(e.type));
  assert.ok(checked.length > 20);
  for (const ev of checked) {
    assert.equal(typeof ev.meta.z, 'number', `${ev.type} missing numeric meta.z`);
    assert.equal(typeof ev.meta.maxZ, 'number', `${ev.type} missing numeric meta.maxZ`);
    assert.ok(['GROUND', 'LOW', 'WAIST', 'HEAD', 'HIGH', 'OVER_BAR'].includes(String(ev.meta.heightBand)), `${ev.type} invalid heightBand`);
  }
});
