// @ts-nocheck -- scene-building helpers over engine internals; the engine code they exercise is fully type-checked.
// Team instructions (docs/designs/tactics_instructions.md): knob resolution, exact no-op defaults, the
// SET_INSTRUCTIONS command (carried out at the next stoppage), and one mechanism test per instruction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import {
  IDENTITY_KNOBS, KNOBS, NEVER, defaultInstructions, isDefaultInstructions, normalizeInstructions, resolveKnobs, setInstructions, validateInstructions,
} from '../../src/engine/tactics/Instructions.js';
import { computeAnchors } from '../../src/engine/tactics/Formation.js';
import { updatePhases } from '../../src/engine/tactics/Phase.js';
import { giveBall } from '../../src/engine/decisions/Actions.js';
import { passScore, applyIntent, updateDefensiveLines } from '../../src/engine/decisions/CarrierDecision.js';
import { decideOffBall } from '../../src/engine/decisions/OffBallDecision.js';
import { ACTION, along } from '../../src/engine/decisions/Perception.js';
import { startRestart } from '../../src/engine/restarts/RestartMachine.js';
import { judgeContact } from '../../src/engine/officiating/Referee.js';
import { updateFitness } from '../../src/engine/fitness/Fitness.js';
import { PHASE } from '../../src/engine/state/TeamState.js';
import { evaluate } from '../../src/engine/ai/AiCoach.js';
import { config, runMatch, sampleInput } from './helpers.js';

const CFG = config.tactics.instructions;

/** A new engine stepped into open play, both teams AI-free (human), the ball with `owner`'s team. */
function scene(seed = 6) {
  const engine = MatchEngine.create(sampleInput(seed), config);
  engine.step(100);
  const s = engine.state;
  s.restart.state = 'IN_PLAY';
  return { engine, s };
}

/** Puts the ball at the feet of `index` at own-frame depth `a`, width `y`. */
function giveAt(s, index, a, y = 34) {
  const p = s.players[index];
  const dir = s.attackDir(p.team);
  p.x = p.prevX = dir > 0 ? a : 105 - a;
  p.y = p.prevY = y;
  s.ball.owner = index;
  s.ball.pass = null;
  s.ball.x = p.x;
  s.ball.y = p.y;
  return p;
}

/** Own-frame depth of a team's player's anchor. */
function anchorAlong(s, p) {
  return along(s, p.team, p.tx);
}

/** On-pitch players of team 0 in slots of `role`. */
function ofRole(s, team, role) {
  const slots = config.tactics.formations[s.teams[team].formationId].slots;
  return s.players.filter((p) => p.team === team && p.onPitch === 1 && p.slot >= 0 && slots[p.slot].role === role);
}

test('config: nine instructions, every default option is {} and every option sets known knobs and declares a trade-off', () => {
  assert.deepEqual(Object.keys(CFG), ['tempo', 'directness', 'attackFocus', 'attackTransition', 'timeWasting', 'defensiveLine', 'marking', 'defensiveTransition', 'tackling']);
  assert.deepEqual(Object.keys(CFG.attackFocus.options), ['wings', 'mixed', 'center']);
  assert.equal(CFG.attackFocus.default, 'mixed');
  for (const [id, def] of Object.entries(CFG)) {
    assert.deepEqual(def.options[def.default], {}, `${id} default`);
    for (const [opt, body] of Object.entries(def.options)) {
      if (opt === def.default) continue;
      for (const k of Object.keys(body.knobs)) assert.ok(k in KNOBS, `${id}.${opt}: ${k}`);
      assert.ok(body.upside && body.downside, `${id}.${opt} trade-off`);
    }
  }
});

test('resolveKnobs: all defaults give the shared identity; mul multiplies, add adds, min keeps the lowest', () => {
  const defaults = defaultInstructions(CFG);
  assert.equal(resolveKnobs(CFG, defaults), IDENTITY_KNOBS);
  assert.ok(isDefaultInstructions(CFG, defaults));
  for (const [k, v] of Object.entries(KNOBS)) assert.equal(IDENTITY_KNOBS[k], v.identity, k);
  assert.equal(IDENTITY_KNOBS.wasteFromMinute, NEVER);
  const k = resolveKnobs(CFG, { ...defaults, tempo: 'fast', marking: 'manToMan', defensiveTransition: 'counterPress', timeWasting: 'sometimes' });
  const fast = CFG.tempo.options.fast.knobs;
  assert.equal(k.settleMul, fast.settleMul);
  assert.equal(k.drainMul, fast.drainMul * CFG.marking.options.manToMan.knobs.drainMul * CFG.defensiveTransition.options.counterPress.knobs.drainMul);
  assert.equal(k.cpCountAdd, CFG.defensiveTransition.options.counterPress.knobs.cpCountAdd);
  assert.equal(k.wasteFromMinute, 75);
  assert.ok(Object.isFrozen(k));
  assert.throws(() => resolveKnobs({ x: { group: 'inPossession', default: 'a', options: { a: {}, b: { knobs: { nope: 1 } } } } }, { x: 'b' }), /unknown knob/);
});

test('validateInstructions / normalizeInstructions: codes for bad input, missing instructions take their default', () => {
  assert.equal(validateInstructions(CFG, { tempo: 'fast', attackFocus: 'wings' }), null);
  assert.equal(validateInstructions(CFG, null), 'BAD_INSTRUCTIONS');
  assert.equal(validateInstructions(CFG, ['fast']), 'BAD_INSTRUCTIONS');
  assert.equal(validateInstructions(CFG, { pace: 'fast' }), 'UNKNOWN_INSTRUCTION');
  assert.equal(validateInstructions(CFG, { tempo: 'warp' }), 'UNKNOWN_OPTION');
  assert.equal(validateInstructions(CFG, { toString: 'x' }), 'UNKNOWN_INSTRUCTION');
  const full = normalizeInstructions(CFG, { attackFocus: 'center' });
  assert.equal(Object.keys(full).length, 9);
  assert.equal(full.attackFocus, 'center');
  assert.equal(full.tempo, 'standard');
});

test('explicit all-default input instructions give the same hash stream as none, and serialize() leaves them out', () => {
  const a = runMatch(sampleInput(42), [], { every: 2000 });
  const input = sampleInput(42);
  input.home.instructions = defaultInstructions(CFG);
  input.away.instructions = { tempo: 'standard' };
  const b = runMatch(input, [], { every: 2000 });
  assert.deepEqual(b.hashes, a.hashes);
  assert.equal(b.final, a.final);
  assert.ok(!('instructions' in b.engine.state.serialize().teams[0]));
});

test('non-default instructions are saved, restored with their knobs, and change the match', () => {
  const input = sampleInput(42);
  input.home.instructions = { tempo: 'fast', defensiveLine: 'high' };
  const engine = MatchEngine.create(input, config);
  engine.step(3000);
  const data = JSON.parse(JSON.stringify(engine.state.serialize()));
  assert.deepEqual(data.teams[0].instructions, normalizeInstructions(CFG, input.home.instructions));
  assert.ok(!('instructions' in data.teams[1]));
  const back = MatchEngine.fromState(data, input, config);
  assert.equal(back.state.teams[0].knobs.settleMul, CFG.tempo.options.fast.knobs.settleMul);
  assert.equal(back.state.teams[1].knobs, IDENTITY_KNOBS);
  assert.equal(back.hash(), engine.hash());
  const plain = MatchEngine.create(sampleInput(42), config);
  plain.step(3000);
  assert.notEqual(plain.hash(), engine.hash());
});

test('MatchInput rejects unknown instructions or options', () => {
  const input = sampleInput(1);
  input.home.instructions = { tempo: 'warp' };
  assert.throws(() => MatchEngine.create(input, config), /instructions: UNKNOWN_OPTION/);
});

test('SET_INSTRUCTIONS: validated, waits in play, a newer one replaces it, and it is carried out at the next stoppage', () => {
  const { engine, s } = scene(3);
  const send = (instructions) => engine.applyCommand({ issuer: 'human', type: 'SET_INSTRUCTIONS', teamIndex: 0, payload: { instructions } });
  assert.equal(send({ tempo: 'warp' }).code, 'UNKNOWN_OPTION');
  assert.equal(send({ pace: 'fast' }).code, 'UNKNOWN_INSTRUCTION');
  assert.equal(send('fast').code, 'BAD_INSTRUCTIONS');
  assert.ok(send({ tempo: 'fast' }).ok);
  assert.ok(send({ tempo: 'slow', attackFocus: 'wings' }).ok);
  const pending = s.pendingCommands.filter((c) => c.type === 'SET_INSTRUCTIONS');
  assert.equal(pending.length, 1, 'the newer change replaces the older one');
  assert.equal(Object.keys(pending[0].payload.instructions).length, 9, 'all nine instructions travel together');
  // In play the instructions wait (the ball stays in play for these ticks in this scene, or they apply at a stop).
  let applied = false;
  for (let i = 0; i < 4000 && !applied; i++) {
    const wasStopped = s.restart.state === 'DEAD_BALL' || s.restart.state === 'HALF_TIME';
    engine.step(1);
    applied = s.teams[0].instructions.tempo === 'slow';
    if (applied) assert.ok(wasStopped || s.restart.state !== 'IN_PLAY', 'carried out at a stoppage');
    else assert.equal(s.teams[0].knobs, IDENTITY_KNOBS);
  }
  assert.ok(applied, 'applied by the next stoppage');
  assert.equal(s.teams[0].instructions.attackFocus, 'wings');
  assert.equal(s.pendingCommands.filter((c) => c.type === 'SET_INSTRUCTIONS').length, 0);
  // Confirmed while the ball is dead: carried out at once.
  while (s.restart.state !== 'DEAD_BALL') engine.step(1);
  assert.ok(send({ tackling: 'getStuckIn' }).ok);
  assert.equal(s.teams[0].instructions.tackling, 'getStuckIn');
  assert.equal(s.teams[0].instructions.tempo, 'standard', 'the payload is the whole set');
});

test('SET_INSTRUCTIONS replays: the same log gives the same match', () => {
  const log = [
    { seq: 1, tick: 20000, issuer: 'human', type: 'SET_INSTRUCTIONS', teamIndex: 0, payload: { instructions: { tempo: 'fast', attackFocus: 'center', marking: 'manToMan' } } },
    { seq: 2, tick: 40000, issuer: 'human', type: 'SET_INSTRUCTIONS', teamIndex: 1, payload: { instructions: { defensiveLine: 'low', timeWasting: 'always' } } },
  ];
  const a = runMatch(sampleInput(2), log, { every: 10000 });
  const b = runMatch(sampleInput(2), log, { every: 10000 });
  assert.deepEqual(a.hashes, b.hashes);
  const plain = runMatch(sampleInput(2), [], { every: 10000 });
  assert.notEqual(a.final, plain.final);
});

test('tempo: the settle time scales with settleMul (fast settles sooner, slow later)', () => {
  const { s } = scene();
  const p = s.players[6];
  giveBall(s, p.index, false);
  const base = p.decisionTimer;
  setInstructions(CFG, s.teams[0], { tempo: 'fast' });
  giveBall(s, p.index, false);
  assert.equal(p.decisionTimer, Math.round(base * CFG.tempo.options.fast.knobs.settleMul));
  setInstructions(CFG, s.teams[0], { tempo: 'slow' });
  giveBall(s, p.index, false);
  assert.ok(p.decisionTimer > base);
});

test('directness and attacking corridor: passScore favours long / through balls, wide or central targets', () => {
  const { s } = scene();
  const p = giveAt(s, 6, 45, 34);
  const line = 105;
  const r = s.players[9];
  const dir = s.attackDir(0);
  // A long forward pass to a wide target.
  r.x = r.prevX = dir > 0 ? 82 : 23;
  r.y = r.prevY = 6;
  r.vx = r.vy = 0;
  const base = passScore(s, p, r, line);
  setInstructions(CFG, s.teams[0], { directness: 'direct' });
  assert.ok(passScore(s, p, r, line) > base, 'direct');
  setInstructions(CFG, s.teams[0], { directness: 'short' });
  assert.ok(passScore(s, p, r, line) < base, 'short');
  setInstructions(CFG, s.teams[0], { attackFocus: 'wings' });
  assert.ok(Math.abs(passScore(s, p, r, line) - base - CFG.attackFocus.options.wings.knobs.widePassBias) < 1e-12, 'wings: wide target');
  // Centre adds its central bias only to central targets (any other change is its through-ball knob).
  const center = CFG.attackFocus.options.center.knobs;
  const through = center.throughPassAdd ?? 0;
  /** @param {number} delta @param {number} bias */
  const onlyBias = (delta, bias) => Math.abs(delta - bias) < 1e-12 || Math.abs(delta - bias - through) < 1e-12;
  setInstructions(CFG, s.teams[0], { attackFocus: 'center' });
  assert.ok(onlyBias(passScore(s, p, r, line) - base, 0), 'centre: wide target gets no corridor bias');
  r.y = r.prevY = 34;
  setInstructions(CFG, s.teams[0], {});
  const central = passScore(s, p, r, line);
  setInstructions(CFG, s.teams[0], { attackFocus: 'center' });
  assert.ok(onlyBias(passScore(s, p, r, line) - central, center.centerPassBias), 'centre: central target');
});

test('attacking corridor: wings widens the shape in possession, centre narrows it', () => {
  const { s } = scene();
  giveAt(s, 6, 50, 34);
  s.teams[0].phase = PHASE.PROGRESSION;
  const spread = () => {
    computeAnchors(s, s.teams[0]);
    return ofRole(s, 0, 'W').concat(ofRole(s, 0, 'FB')).reduce((sum, p) => sum + Math.abs(p.ty - 34), 0);
  };
  const base = spread();
  setInstructions(CFG, s.teams[0], { attackFocus: 'wings' });
  assert.ok(spread() > base);
  setInstructions(CFG, s.teams[0], { attackFocus: 'center' });
  assert.ok(spread() < base);
});

test('attacking transition: counter pushes forwards and midfield further and lasts longer; hold shape the opposite', () => {
  const { s } = scene();
  giveAt(s, 6, 50, 34);
  s.teams[0].phase = PHASE.TRANSITION_ATT;
  s.teams[0].phaseTick = 0;
  const st = ofRole(s, 0, 'ST')[0];
  const mf = ofRole(s, 0, 'MF')[0];
  computeAnchors(s, s.teams[0]);
  const stBase = anchorAlong(s, st);
  const mfBase = anchorAlong(s, mf);
  setInstructions(CFG, s.teams[0], { attackTransition: 'counter' });
  computeAnchors(s, s.teams[0]);
  assert.ok(anchorAlong(s, st) > stBase && anchorAlong(s, mf) > mfBase);
  setInstructions(CFG, s.teams[0], { attackTransition: 'holdShape' });
  computeAnchors(s, s.teams[0]);
  assert.ok(anchorAlong(s, st) < stBase);
  // Length of the spell: still in transition after the default 40 ticks with counter, out of it sooner with hold shape.
  const lasts = (instr) => {
    setInstructions(CFG, s.teams[0], instr);
    s.teams[0].phase = PHASE.TRANSITION_ATT;
    s.teams[0].phaseTick = 0;
    let ticks = 0;
    while (s.teams[0].phase === PHASE.TRANSITION_ATT && ticks < 500) {
      updatePhases(s);
      ticks += 5;
    }
    return ticks;
  };
  const normal = lasts({});
  assert.ok(lasts({ attackTransition: 'counter' }) > normal);
  assert.ok(lasts({ attackTransition: 'holdShape' }) < normal);
});

test('defensive line: high moves the back and midfield lines up out of possession, low drops them', () => {
  const { s } = scene();
  giveAt(s, 24, 50, 34); // team 1 has the ball
  s.teams[0].phase = PHASE.DEFEND;
  const cb = ofRole(s, 0, 'CB')[0];
  const mf = ofRole(s, 0, 'MF')[0];
  computeAnchors(s, s.teams[0]);
  const cbBase = anchorAlong(s, cb);
  const mfBase = anchorAlong(s, mf);
  setInstructions(CFG, s.teams[0], { defensiveLine: 'high' });
  computeAnchors(s, s.teams[0]);
  assert.ok(Math.abs(anchorAlong(s, cb) - cbBase - CFG.defensiveLine.options.high.knobs.lineBackM) < 1e-9);
  assert.ok(Math.abs(anchorAlong(s, mf) - mfBase - CFG.defensiveLine.options.high.knobs.lineMidM) < 1e-9);
  setInstructions(CFG, s.teams[0], { defensiveLine: 'low' });
  computeAnchors(s, s.teams[0]);
  assert.ok(anchorAlong(s, cb) < cbBase);
});

test('marking: man-to-man finds a man around the player, keeps him, and turns screening off', () => {
  const { s } = scene();
  const carrier = giveAt(s, 24, 50, 34);
  s.teams[0].phase = PHASE.DEFEND;
  computeAnchors(s, s.teams[0]);
  updateDefensiveLines(s);
  const mf = ofRole(s, 0, 'MF')[0];
  // An opponent 15 m from the midfielder's anchor but right next to the midfielder himself.
  const o = s.players.find((q) => q.team === 1 && q.onPitch === 1 && q.isKeeper === 0 && q.index !== carrier.index);
  mf.x = mf.prevX = mf.tx + 15;
  mf.y = mf.prevY = mf.ty;
  o.x = o.prevX = mf.x + 1;
  o.y = o.prevY = mf.y;
  for (const q of s.players) if (q.team === 1 && q.index !== o.index && q.index !== carrier.index) q.x = q.prevX = -50; // out of reach
  decideOffBall(s, mf);
  assert.notEqual(mf.markTarget, o.index, 'zonal: the man is outside the anchor zone');
  setInstructions(CFG, s.teams[0], { marking: 'manToMan' });
  decideOffBall(s, mf);
  assert.equal(mf.pendingAction, ACTION.MARK);
  assert.equal(mf.markTarget, o.index);
  // Kept while he stays within reach, even with another free man nearer.
  const other = s.players.find((q) => q.team === 1 && q.onPitch === 1 && q.isKeeper === 0 && q.index !== carrier.index && q.index !== o.index);
  o.x = o.prevX = mf.x + 10;
  other.x = other.prevX = mf.x + 2;
  other.y = other.prevY = mf.y;
  decideOffBall(s, mf);
  assert.equal(mf.markTarget, o.index, 'sticks to his man');
  setInstructions(CFG, s.teams[0], { marking: 'manToMan' }); // same knobs, but a fresh decision with no previous man
  mf.markTarget = -1;
  decideOffBall(s, mf);
  assert.equal(mf.markTarget, other.index, 'a fresh pick takes the nearer man');
  other.x = other.prevX = -50;
  // Screening: a back-line player holding his zone drops goal-side of a runner behind his anchor when zonal, not
  // when man-to-man.
  const cb = ofRole(s, 0, 'CB')[0];
  const screened = (instr) => {
    setInstructions(CFG, s.teams[0], instr);
    computeAnchors(s, s.teams[0]);
    updateDefensiveLines(s);
    cb.pendingAction = ACTION.HOLD;
    const tx = cb.tx;
    const ty = cb.ty;
    o.x = o.prevX = cb.tx - s.attackDir(0) * 3;
    o.y = o.prevY = cb.ty + 2;
    applyIntent(s, cb, carrier.index);
    return cb.tx !== tx || cb.ty !== ty;
  };
  assert.ok(screened({}), 'zonal screens');
  assert.ok(!screened({ marking: 'manToMan' }), 'man-to-man does not');
});

test('defensive transition: counter-press presses longer from deeper, regroup never counter-presses', () => {
  const { s } = scene();
  const loser = giveAt(s, 6, 70, 34);
  const winner = s.players[24];
  winner.x = loser.x;
  winner.y = loser.y;
  const turnover = (instr) => {
    setInstructions(CFG, s.teams[0], instr);
    s.ball.owner = loser.index;
    s.teams[0].pressTicks = 0;
    giveBall(s, winner.index, false);
    return s.teams[0].pressTicks;
  };
  const normal = turnover({});
  assert.ok(normal > 0);
  assert.equal(turnover({ defensiveTransition: 'counterPress' }), Math.round(normal * CFG.defensiveTransition.options.counterPress.knobs.cpTicksMul));
  assert.equal(turnover({ defensiveTransition: 'regroup' }), 0);
});

test('time-wasting: only when leading, from the option minute; the hold grows, some time is added back', () => {
  const { s } = scene();
  s.teams[0].score = 1;
  s.clock.half = 2;
  s.clock.halfTick = 20 * 60 * 20; // 65'
  const hold = (instr, team = 0) => {
    setInstructions(CFG, s.teams[0], instr);
    const before = s.clock.addedSeconds;
    startRestart(s, 'THROW_IN', team, 50, 0);
    return { ticks: s.restart.resumeTick - s.tick, added: s.clock.addedSeconds - before };
  };
  const normal = hold({});
  assert.deepEqual(hold({ timeWasting: 'sometimes' }), normal, 'sometimes: not before 75\'');
  const always = hold({ timeWasting: 'always' });
  assert.equal(always.ticks, normal.ticks + Math.round(normal.ticks * (CFG.timeWasting.options.always.knobs.wasteHoldMul - 1)));
  assert.ok(always.added > 0);
  s.clock.halfTick = 31 * 60 * 20; // 76'
  assert.ok(hold({ timeWasting: 'sometimes' }).ticks > normal.ticks);
  s.teams[1].score = 1;
  assert.deepEqual(hold({ timeWasting: 'always' }), normal, 'never when level');
});

test('tackling: get stuck in reads as a more severe foul, stay on feet as a milder one', () => {
  const { s } = scene();
  const ctx = { state: s, tackler: 3, fouled: 24, fromBehind: true, tacklerSpeed: 0, lastMan: false, inBox: false, otherOpponentDist: 0 };
  const sev = () => {
    s.players[3].card = 0;
    return judgeContact(ctx).severity;
  };
  const base = sev();
  setInstructions(CFG, s.teams[0], { tackling: 'getStuckIn' });
  assert.ok(sev() > base);
  setInstructions(CFG, s.teams[0], { tackling: 'stayOnFeet' });
  assert.ok(sev() < base);
});

test('fitness: drainMul scales the drain (fast tempo tires players, regroup spares them)', () => {
  const { s } = scene();
  const drain = (instr) => {
    setInstructions(CFG, s.teams[0], instr);
    for (const i of s.onPitchList) {
      const p = s.players[i];
      p.fitness = 0.9;
      p.vx = 6;
      p.vy = 0;
    }
    updateFitness(s);
    return 0.9 - s.players[5].fitness;
  };
  const normal = drain({});
  assert.ok(drain({ tempo: 'fast' }) > normal);
  assert.ok(drain({ defensiveTransition: 'regroup' }) < normal);
});

test('directional: over the same seeds, get stuck in commits more fouls than stay on feet', () => {
  let hard = 0;
  let soft = 0;
  for (const seed of [11, 12]) {
    for (const [instr, add] of [[{ tackling: 'getStuckIn' }, (n) => (hard += n)], [{ tackling: 'stayOnFeet' }, (n) => (soft += n)]]) {
      const input = sampleInput(seed);
      input.home.instructions = instr;
      const { engine } = runMatch(input, [], { every: 54000 });
      add(engine.eventLog.filter((e) => e.type === 'FOUL' && e.teamIndex === 0).length);
    }
  }
  assert.ok(hard > soft, `fouls: get stuck in ${hard}, stay on feet ${soft}`);
});

test('AI coach: game-state instructions only when enabled; chasing late, back to defaults when level', () => {
  const rules = { ...config.aiCoach, instructions: { ...config.aiCoach.instructions, enabled: true } };
  const make = (cfg) => {
    const engine = MatchEngine.create(sampleInput(5, { homeControl: 'ai', awayControl: 'ai' }), { ...config, aiCoach: cfg });
    engine.step(100);
    return engine.state;
  };
  const off = make(config.aiCoach);
  off.teams[0].score = 0;
  off.teams[1].score = 1;
  off.clock.half = 2;
  off.clock.halfTick = 30 * 60 * 20;
  evaluate(off, off.teams[0]);
  assert.ok(!off.pendingCommands.some((c) => c.type === 'SET_INSTRUCTIONS'), 'disabled in v1');
  const s = make(rules);
  s.teams[1].score = 1;
  s.clock.half = 2;
  s.clock.halfTick = 30 * 60 * 20; // 75'
  evaluate(s, s.teams[0]);
  const cmd = s.pendingCommands.find((c) => c.type === 'SET_INSTRUCTIONS' && c.teamIndex === 0);
  assert.ok(cmd, 'chasing');
  assert.equal(cmd.payload.instructions.tempo, 'fast');
  assert.ok(s.teams[0].aiFired.includes('INSTR:CHASING'));
  evaluate(s, s.teams[0]);
  assert.equal(s.commandLog.filter((c) => c.type === 'SET_INSTRUCTIONS').length, 1, 'not repeated');
  s.teams[0].score = 1;
  evaluate(s, s.teams[0]);
  assert.equal(s.teams[0].aiFired.at(-1), 'INSTR:-');
  assert.ok(isDefaultInstructions(CFG, s.pendingCommands.find((c) => c.type === 'SET_INSTRUCTIONS').payload.instructions));
});
