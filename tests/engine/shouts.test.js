// @ts-nocheck -- scene-building helpers over engine internals; the engine code they exercise is fully type-checked.
// Coach shouts (docs/designs/coach_shouts.md): config, zero regression without shouts, ISSUE_SHOUT validation,
// temporary and contextual effects, role and pitch-zone targeting in both attacking directions, morale-driven
// acceptance, silence drift, the spam penalty, and replay / restore determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { IDENTITY_KNOBS, KNOBS } from '../../src/engine/tactics/Instructions.js';
import { activeShout, inPitchZone, issueShout, scaledShoutKnobs, shoutReactions, shoutReceptiveness } from '../../src/engine/tactics/Shouts.js';
import { computeAnchors } from '../../src/engine/tactics/Formation.js';
import { along } from '../../src/engine/decisions/Perception.js';
import { PHASE } from '../../src/engine/state/TeamState.js';
import { config, runMatch, sampleInput } from './helpers.js';

const SH = config.shouts;
const IDS = ['focus', 'pushForward', 'tightenUp', 'encourage', 'demandMore', 'fireUp', 'calmDown', 'praise', 'getCreative', 'berate'];

/** A new engine stepped into open play (both teams human-controlled, so nothing shouts on its own). */
function scene(seed = 6, input = sampleInput(seed)) {
  const engine = MatchEngine.create(input, config);
  engine.step(100);
  const s = engine.state;
  s.restart.state = 'IN_PLAY';
  return { engine, s };
}

/** Swaps in a copy of the shouts config with shout `id` patched (for example to always accept). */
function patchShout(s, id, patch) {
  const cur = s.config.shouts;
  const shouts = { ...cur.shouts, [id]: { ...cur.shouts[id], ...patch } };
  s.config = { ...s.config, shouts: { ...cur, shouts } };
}
const ALWAYS = { accept: { base: 30, morale: 0, leading: 0, level: 0, trailing: 0 }, backfire: 0 };
const NEVER_ACCEPT = { accept: { base: -30, morale: 0, leading: 0, level: 0, trailing: 0 }, backfire: 1 };

/** Team `team`'s on-pitch players with their slot roles. */
function roster(s, team) {
  const slots = config.tactics.formations[s.teams[team].formationId].slots;
  return s.players.filter((p) => p.team === team && p.onPitch === 1).map((p) => ({ p, role: slots[p.slot].role }));
}

/** Places every on-pitch player of `team` at own-frame depth `depthOf(role)`. */
function place(s, team, depthOf) {
  const dir = s.attackDir(team);
  for (const { p, role } of roster(s, team)) {
    const a = depthOf(role);
    p.x = p.prevX = dir > 0 ? a : 105 - a;
  }
}

/** Sets every on-pitch player of `team` to morale level `lv`. */
function setMorale(s, team, lv) {
  for (const { p } of roster(s, team)) p.moraleLevel = lv;
}

test('config: ten shouts with roles, pitch zones, durations, cooldowns and mul/add knobs', () => {
  assert.deepEqual(Object.keys(SH.shouts), IDS);
  const zone = Object.fromEntries(IDS.map((id) => [id, SH.shouts[id].pitchZone]));
  assert.deepEqual(zone, {
    focus: 'any', pushForward: 'offensive', tightenUp: 'defensive', encourage: 'any', demandMore: 'any',
    fireUp: 'any', calmDown: 'defensive', praise: 'any', getCreative: 'offensive', berate: 'any',
  });
  for (const [id, def] of Object.entries(SH.shouts)) {
    assert.ok(def.durationTicks >= 8 * 1200 && def.durationTicks <= 10 * 1200, `${id} lasts 8-10 minutes`);
    assert.ok(def.cooldownTicks >= 5 * 1200, `${id} cooldown`);
    for (const k of Object.keys(def.knobs)) assert.ok(KNOBS[k] && KNOBS[k].compose !== 'min', `${id}: ${k}`);
  }
  assert.ok(SH.shouts.tightenUp.roles.includes('CB') && !SH.shouts.tightenUp.roles.includes('ST'));
  assert.ok(!SH.shouts.pushForward.roles.includes('CB') && SH.shouts.getCreative.roles.includes('ST'));
});

test('scaledShoutKnobs: a multiplier moves toward 1 and an offset toward 0 with the accepted share', () => {
  assert.deepEqual(scaledShoutKnobs({ noiseMul: 1.2, lineMidM: 2 }, 0.5), { noiseMul: 1.1, lineMidM: 1 });
  assert.throws(() => scaledShoutKnobs({ wasteFromMinute: 70 }, 1), /mul or add/);
});

test('no shouts: no shout state, nothing serialized, and `shouts: false` hashes exactly as before', () => {
  const a = runMatch(sampleInput(42), [], { every: 4000 });
  const input = sampleInput(42);
  input.home.shouts = false;
  const b = runMatch(input, [], { every: 4000 });
  assert.deepEqual(b.hashes, a.hashes);
  const data = b.engine.state.serialize();
  assert.ok(!('shout' in data.teams[0]) && !('shout' in data.teams[1]));
  assert.ok(data.players.every((p) => !('focus' in p)));
  assert.equal(b.engine.state.teams[0].knobs, IDENTITY_KNOBS);
});

test('MatchInput rejects a non-boolean `shouts`', () => {
  const input = sampleInput(1);
  input.home.shouts = 'yes';
  assert.throws(() => MatchEngine.create(input, config), /home.shouts must be a boolean/);
});

test('ISSUE_SHOUT: unknown shouts, one already waiting and a shout cooling down are refused; it is carried out next tick', () => {
  const { engine, s } = scene(3);
  const send = (shout) => engine.applyCommand({ issuer: 'human', type: 'ISSUE_SHOUT', teamIndex: 0, payload: { shout } });
  assert.equal(send('sing').code, 'UNKNOWN_SHOUT');
  assert.equal(send(undefined).code, 'UNKNOWN_SHOUT');
  assert.equal(send('toString').code, 'UNKNOWN_SHOUT');
  assert.ok(send('focus').ok);
  assert.equal(send('praise').code, 'SHOUT_PENDING');
  assert.equal(s.teams[0].shout, null, 'waits for step 1 of the next tick');
  const r = engine.step(1);
  assert.ok(s.teams[0].shout !== null);
  const ev = r.events.find((e) => e.type === 'SHOUT_REACTION');
  assert.ok(ev, 'one SHOUT_REACTION event');
  assert.equal(ev.teamIndex, 0);
  assert.equal(ev.meta.shout, 'focus');
  assert.equal(send('focus').code, 'SHOUT_COOLDOWN');
  engine.step(SH.shouts.focus.cooldownTicks);
  assert.ok(send('focus').ok, 'the cooldown runs out');
});

test('a shout given while the ball is dead takes effect at once', () => {
  const engine = MatchEngine.create(sampleInput(5), config);
  assert.equal(engine.state.restart.state, 'DEAD_BALL', 'kick-off');
  const res = engine.applyCommand({ issuer: 'human', type: 'ISSUE_SHOUT', teamIndex: 1, payload: { shout: 'encourage' } });
  assert.ok(res.ok);
  assert.ok(res.events.some((e) => e.type === 'SHOUT_REACTION' && e.teamIndex === 1));
  assert.ok(engine.state.teams[1].shout.lastTick === engine.state.tick);
});

test('pushForward: accepted, it pushes the anchors forward for its duration, then expires back to the instruction knobs', () => {
  const { engine, s } = scene();
  patchShout(s, 'pushForward', ALWAYS);
  place(s, 0, (role) => (role === 'GK' || role === 'CB' ? 20 : 70));
  // Out of possession, where the line offsets apply.
  s.ball.owner = roster(s, 1)[5].p.index;
  s.ball.pass = null;
  s.teams[0].phase = PHASE.DEFEND;
  computeAnchors(s, s.teams[0]);
  const mf = roster(s, 0).filter((r) => r.role === 'MF').map((r) => r.p);
  const before = mf.map((p) => along(s, 0, p.tx));
  const out = issueShout(s, 0, 'pushForward');
  assert.ok(out.share > 0.99, 'everyone in scope (all in the attacking half) accepted');
  assert.equal(s.teams[0].knobs.lineMidM, SH.shouts.pushForward.knobs.lineMidM);
  computeAnchors(s, s.teams[0]);
  mf.forEach((p, k) => assert.ok(along(s, 0, p.tx) > before[k], 'midfield anchors move up'));
  assert.equal(activeShout(s, 0).id, 'pushForward');
  // Expires after durationTicks (the scene's restart state is whatever play brings).
  for (let i = 0; i < SH.shouts.pushForward.durationTicks + 1; i++) engine.step(1);
  assert.equal(activeShout(s, 0), null);
  assert.equal(s.teams[0].knobs, IDENTITY_KNOBS);
});

test('calmDown lowers the foul logit; a shout nobody accepts leaves no tactical effect', () => {
  const { s } = scene();
  patchShout(s, 'calmDown', ALWAYS);
  place(s, 0, () => 25);
  issueShout(s, 0, 'calmDown');
  assert.ok(s.teams[0].knobs.tackleFoulLogit < 0);
  assert.ok(s.teams[0].knobs.severityAdd < 0);
  const { s: s2 } = scene();
  patchShout(s2, 'calmDown', NEVER_ACCEPT);
  place(s2, 0, () => 25);
  const out = issueShout(s2, 0, 'calmDown');
  assert.equal(out.share, 0);
  assert.equal(s2.teams[0].knobs, IDENTITY_KNOBS);
  assert.ok(out.negative.length > 0, 'everyone in scope rejected it badly');
});

test('calmDown weights booked and foul-prone players fully, the rest at otherWeight', () => {
  const { s } = scene();
  patchShout(s, 'calmDown', ALWAYS);
  place(s, 0, () => 25);
  const players = roster(s, 0).filter((r) => r.role !== 'GK').map((r) => r.p);
  players[0].card = 1;
  players[1].fouls = 3;
  for (const p of players) p.focus = 0;
  issueShout(s, 0, 'calmDown');
  const full = SH.shouts.calmDown.positive.focus;
  assert.ok(Math.abs(players[0].focus - full) < 1e-12);
  assert.ok(Math.abs(players[1].focus - full) < 1e-12);
  assert.ok(Math.abs(players[2].focus - full * SH.shouts.calmDown.otherWeight) < 1e-12);
});

test('pitch zones: offensive shouts reach the players in the opponent\'s half, defensive ones the own half, in both directions', () => {
  for (const half of [1, 2]) {
    for (const team of [0, 1]) {
      const { s } = scene(7);
      s.clock.half = half;
      patchShout(s, 'getCreative', ALWAYS);
      patchShout(s, 'tightenUp', ALWAYS);
      // Defenders deep, midfielders split across halfway, forwards high.
      const r = roster(s, team);
      const dir = s.attackDir(team);
      r.forEach(({ p, role }, k) => {
        const a = role === 'GK' ? 5 : role === 'CB' || role === 'FB' ? 25 : role === 'MF' ? (k % 2 === 0 ? 45 : 60) : 80;
        p.x = p.prevX = dir > 0 ? a : 105 - a;
      });
      const wantOff = r.filter(({ p, role }) => ['MF', 'W', 'ST'].includes(role) && along(s, team, p.x) > 52.5).map(({ p }) => p.index).sort();
      const off = issueShout(s, team, 'getCreative');
      assert.deepEqual([...off.positive].sort(), wantOff, `getCreative half ${half} team ${team}`);
      assert.ok(wantOff.length > 0 && r.some(({ role }) => role === 'CB'));
      const wantDef = r.filter(({ p, role }) => ['GK', 'CB', 'FB', 'MF'].includes(role) && along(s, team, p.x) < 52.5).map(({ p }) => p.index).sort();
      const def = issueShout(s, team, 'tightenUp');
      assert.deepEqual([...def.positive].sort(), wantDef, `tightenUp half ${half} team ${team}`);
    }
  }
  assert.ok(inPitchZone('offensive', 60, 1) && !inPitchZone('offensive', 60, -1));
  assert.ok(inPitchZone('defensive', 60, -1) && inPitchZone('any', 0, 1));
});

/** Total positive and negative reactions to `id` over `n` scenes with every player at morale level `lv`. */
function tally(id, lv, { n = 12, score = [0, 0] } = {}) {
  let pos = 0;
  let neg = 0;
  for (let k = 0; k < n; k++) {
    const { s } = scene(100 + k);
    s.teams[0].score = score[0];
    s.teams[1].score = score[1];
    setMorale(s, 0, lv);
    const out = issueShout(s, 0, id);
    pos += out.positive.length;
    neg += out.negative.length;
  }
  return { pos, neg };
}

test('morale-driven acceptance: low morale takes encouragement, rejects berating and demands; high morale the reverse', () => {
  const lowB = tally('berate', -1);
  const highB = tally('berate', 1);
  assert.ok(lowB.neg > lowB.pos, `berate on low morale backfires (${JSON.stringify(lowB)})`);
  assert.ok(highB.pos > lowB.pos && highB.neg < lowB.neg, 'berate lands better on high morale');
  const lowD = tally('demandMore', -1);
  const highD = tally('demandMore', 1);
  assert.ok(highD.pos > lowD.pos && lowD.neg > highD.neg, 'demandMore');
  const lowE = tally('encourage', -1);
  const highE = tally('encourage', 1);
  assert.ok(lowE.pos > highE.pos, 'encourage lifts the low-morale players');
});

test('context: praise lifts a winning side and backfires when trailing; berate backfires when leading', () => {
  const winning = tally('praise', 0, { score: [2, 0] });
  const trailing = tally('praise', 0, { score: [0, 2] });
  assert.ok(winning.pos > trailing.pos);
  assert.ok(trailing.neg > trailing.pos && trailing.neg > winning.neg, `praise when trailing (${JSON.stringify(trailing)})`);
  const leading = tally('berate', 0, { score: [2, 0] });
  const behind = tally('berate', 0, { score: [0, 1] });
  assert.ok(leading.neg > behind.neg && leading.pos < behind.pos);
});

test('reactions: the event lists positives then negatives; their morale and focus move accordingly', () => {
  const { engine, s } = scene(9);
  const before = s.players.map((p) => p.personalShift);
  engine.applyCommand({ issuer: 'human', type: 'ISSUE_SHOUT', teamIndex: 0, payload: { shout: 'berate' } });
  const ev = engine.step(1).events.find((e) => e.type === 'SHOUT_REACTION');
  const reactions = shoutReactions(ev);
  assert.equal(reactions.length, ev.secondaryIndices.length);
  assert.equal(reactions.filter((r) => r.outcome === 'positive').length, ev.meta.positive);
  for (const r of reactions) {
    const p = s.players[r.actor];
    assert.equal(p.team, 0);
    if (r.outcome === 'positive') assert.ok(p.focus > 0);
    else assert.ok(p.personalShift < before[r.actor] + 1e-9 && p.focus < 0);
  }
  assert.ok(ev.secondaryIndices.every((i) => s.players[i].team === 0));
});

test('silence: with `shouts: true`, after the threshold morale and focus drift down until the next shout; without it nothing happens', () => {
  const cad = SH.cadence;
  const quiet = sampleInput(11);
  quiet.home.shouts = true;
  const a = MatchEngine.create(quiet, config);
  const b = MatchEngine.create(sampleInput(11), config);
  a.step(cad.silenceThresholdTicks - 1);
  b.step(cad.silenceThresholdTicks - 1);
  assert.equal(a.hash(), b.hash(), 'identical until the silence threshold');
  assert.equal(shoutReceptiveness(a.state, 0), 'engaged');
  a.step(cad.silenceIntervalTicks * 3);
  b.step(cad.silenceIntervalTicks * 3);
  assert.notEqual(a.hash(), b.hash());
  assert.equal(shoutReceptiveness(a.state, 0), 'quiet');
  const home = a.state.players.filter((p) => p.team === 0 && p.onPitch === 1);
  assert.ok(home.every((p) => p.focus < 0), 'home players lose focus');
  assert.ok(a.state.players.filter((p) => p.team === 1).every((p) => p.focus === 0), 'the away side has no silence clock');
  const shift = (e) => e.state.players.filter((p) => p.team === 0 && p.onPitch === 1).reduce((t, p) => t + p.personalShift, 0);
  assert.ok(shift(a) < shift(b), 'and morale');
  // A shout resets the clock.
  a.applyCommand({ issuer: 'human', type: 'ISSUE_SHOUT', teamIndex: 0, payload: { shout: 'encourage' } });
  a.step(1);
  assert.equal(shoutReceptiveness(a.state, 0), 'engaged');
});

test('spam: rapid shouts push the load over the threshold, the side is overwhelmed and every player feels it', () => {
  const { s } = scene(13);
  place(s, 0, () => 40);
  let last = null;
  for (const id of ['focus', 'encourage', 'fireUp']) {
    last = issueShout(s, 0, id);
    s.tick += 30;
  }
  assert.ok(s.teams[0].shout.load > SH.cadence.spamThreshold);
  assert.equal(shoutReceptiveness(s, 0), 'overwhelmed');
  assert.ok(last.overload > 0);
  const onPitch = s.players.filter((p) => p.team === 0 && p.onPitch === 1).map((p) => p.index);
  assert.deepEqual([...last.positive, ...last.negative].sort(), [...onPitch].sort(), 'all of them react');
});

test('spam lowers acceptance: the same shout overwhelmed draws fewer positives than fresh', () => {
  let fresh = 0;
  let spammed = 0;
  for (let k = 0; k < 10; k++) {
    const a = scene(200 + k).s;
    fresh += issueShout(a, 0, 'focus').positive.length;
    const b = scene(200 + k).s;
    b.teams[0].shout = { lastTick: b.tick, count: 5, load: 6, active: null, cooldowns: {} };
    spammed += issueShout(b, 0, 'focus').positive.length;
  }
  assert.ok(spammed < fresh, `${spammed} < ${fresh}`);
});

test('the shout load decays over time', () => {
  const { engine, s } = scene(14);
  issueShout(s, 0, 'focus');
  const load = s.teams[0].shout.load;
  engine.step(20 * 600);
  assert.ok(Math.abs(s.teams[0].shout.load - load / 2) < 0.02, 'half-life about 10 minutes');
});

test('shouts replay and restore deterministically, and change the match', () => {
  const log = [
    { seq: 1, tick: 9000, issuer: 'human', type: 'ISSUE_SHOUT', teamIndex: 0, payload: { shout: 'pushForward' } },
    { seq: 2, tick: 15000, issuer: 'human', type: 'ISSUE_SHOUT', teamIndex: 1, payload: { shout: 'tightenUp' } },
    { seq: 3, tick: 15020, issuer: 'human', type: 'ISSUE_SHOUT', teamIndex: 0, payload: { shout: 'berate' } },
  ];
  const a = runMatch(sampleInput(2), log, { every: 10000 });
  const b = runMatch(sampleInput(2), log, { every: 10000 });
  assert.deepEqual(a.hashes, b.hashes);
  const plain = runMatch(sampleInput(2), [], { every: 10000 });
  assert.notEqual(a.final, plain.final);
  // Save mid-shout and restore: the same final hash.
  const input = sampleInput(4);
  const engine = MatchEngine.create(input, config);
  engine.step(5000);
  engine.applyCommand({ issuer: 'human', type: 'ISSUE_SHOUT', teamIndex: 0, payload: { shout: 'fireUp' } });
  engine.step(200);
  const data = JSON.parse(JSON.stringify(engine.state.serialize()));
  assert.equal(data.teams[0].shout.active?.id ?? 'none', engine.state.teams[0].shout.active?.id ?? 'none');
  const back = MatchEngine.fromState(data, input, config);
  assert.equal(back.state.teams[0].knobs.tackleFoulLogit, engine.state.teams[0].knobs.tackleFoulLogit);
  engine.step(3000);
  back.step(3000);
  assert.equal(back.hash(), engine.hash());
});
