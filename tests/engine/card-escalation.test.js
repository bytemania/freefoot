// @ts-nocheck -- scene helpers over engine internals; the engine code they exercise is fully type-checked.
// Slice 17: the referee is lenient early, strict late, and harder on a repeat offender; last-man fouls card at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { cardProbability, judgeContact } from '../../src/engine/officiating/Referee.js';
import { config, sampleInput } from './helpers.js';

const MIN = 1200;

/** Puts the match clock at minute `m` (the escalation reads the clock, not the tick). */
function setMinute(s, m) {
  s.clock.half = m < 45 ? 1 : 2;
  s.clock.halfTick = (m < 45 ? m : m - 45) * MIN;
}

function scene() {
  const engine = MatchEngine.create(sampleInput(4, { homeControl: 'ai', awayControl: 'ai' }), config);
  return engine.state;
}

test('the same moderate foul is less likely a yellow in minute 8 than in minute 78', () => {
  const s = scene();
  setMinute(s, 8);
  const early = cardProbability(s, 5, 0.4, false);
  setMinute(s, 45);
  const mid = cardProbability(s, 5, 0.4, false);
  setMinute(s, 78);
  const late = cardProbability(s, 5, 0.4, false);
  assert.ok(early < mid && mid < late, `${early} < ${mid} < ${late}`);
  assert.ok(late > 1.5 * early);
});

test('a repeat offender is more likely to be carded, up to a cap', () => {
  const s = scene();
  setMinute(s, 40);
  const p = s.players[5];
  p.fouls = 0;
  const first = cardProbability(s, 5, 0.4, false);
  p.fouls = 3;
  const third = cardProbability(s, 5, 0.4, false);
  p.fouls = 50;
  const capped = cardProbability(s, 5, 0.4, false);
  p.fouls = config.officiating.card.repeatCap.value;
  assert.ok(third > first);
  assert.equal(capped, cardProbability(s, 5, 0.4, false));
});

test('a last-man foul is carded at the same strictness in minute 8 as in minute 78', () => {
  const s = scene();
  setMinute(s, 8);
  const early = cardProbability(s, 5, 0.9, true);
  setMinute(s, 78);
  assert.equal(cardProbability(s, 5, 0.9, true), early);
  assert.ok(early > cardProbability(s, 5, 0.4, false), 'a severe last-man foul is more likely carded than a routine early one');
});

/** Cards shown over `n` judged fouls by player 5 on player 23 at minute `m`, from one RNG start. */
function cardsAt(m, foul, n = 300) {
  const s = scene();
  setMinute(s, m);
  const out = { yellow: 0, red: 0 };
  for (let i = 0; i < n; i++) {
    s.players[5].fouls = 0;
    const v = judgeContact({ state: s, tackler: 5, fouled: 23, otherOpponentDist: 5, inBox: false, ...foul });
    if (v.card === 1) out.yellow++;
    else if (v.card === 2) out.red++;
  }
  return out;
}

test('judged over many fouls: routine ones are booked less early, a last-man professional foul is carded alike at 8 and 78', () => {
  const routine = { fromBehind: false, tacklerSpeed: 7, lastMan: false };
  const early = cardsAt(8, routine);
  const late = cardsAt(78, routine);
  assert.ok(early.yellow < late.yellow, `routine yellows ${early.yellow} early v ${late.yellow} late`);
  const dogso = { fromBehind: true, tacklerSpeed: 8, lastMan: true };
  const d8 = cardsAt(8, dogso);
  const d78 = cardsAt(78, dogso);
  assert.deepEqual(d8, d78, 'no leniency for a last-man foul');
  assert.ok(d8.red > 0 && (d8.red + d8.yellow) / 300 > 0.4, `last-man foul: ${d8.red} red, ${d8.yellow} yellow of 300`);
});
