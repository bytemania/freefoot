// Shout reaction animations (docs/designs/coach_shouts.md): a SHOUT_REACTION event becomes one SHOUT cue whose
// reactions name only the players who reacted; the pitch animates exactly those tokens (green ring + up arrow,
// red ring + down arrow) for about 2.3 s, skips the cue while fast-forwarding and clears on a reset or seek.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cuesForEvents } from '../../src/runtime/animationCues.js';
import { ANIM_MS, PitchAnimations, isFastFrame, shoutMark, shoutMarks } from '../../src/ui/pitchAnimations.js';

/** A SHOUT_REACTION event: players 3 and 5 accepted, 8 rejected. @type {any} */
const EVENT = {
  v: 1, seq: 40, tick: 9000, type: 'SHOUT_REACTION', teamIndex: 0, actorIndex: -1,
  secondaryIndices: [3, 5, 8], x: -1, y: -1, zone: -1, meta: { shout: 'pushForward', positive: 2, negative: 1, overloaded: false },
};

test('a SHOUT_REACTION event becomes one SHOUT cue listing only the reacting players', () => {
  const cues = cuesForEvents([EVENT], null);
  assert.equal(cues.length, 1);
  const cue = /** @type {any} */ (cues[0]);
  assert.equal(cue.kind, 'SHOUT');
  assert.equal(cue.team, 0);
  assert.equal(cue.shout, 'pushForward');
  assert.deepEqual(cue.reactions, [
    { actor: 3, outcome: 'positive' },
    { actor: 5, outcome: 'positive' },
    { actor: 8, outcome: 'negative' },
  ]);
  assert.deepEqual(cuesForEvents([{ ...EVENT, secondaryIndices: [], meta: { ...EVENT.meta, positive: 0, negative: 0 } }], null), [], 'nobody reacted: no cue');
});

test('shoutMarks: only the reacting tokens animate, green up for positive, red down for negative', () => {
  let now = 0;
  const anims = new PitchAnimations(() => now);
  anims.ingest(cuesForEvents([EVENT], null), { tick: 9000 });
  now = 400;
  const marks = shoutMarks(anims.active());
  assert.deepEqual([...marks.keys()].sort(), [3, 5, 8]);
  assert.equal(marks.get(3)?.outcome, 'positive');
  assert.equal(marks.get(8)?.outcome, 'negative');
  assert.ok(!marks.has(4), 'a neutral player is not animated');
  // The ring expands and fades; the arrow floats up for positive and down for negative.
  const early = shoutMark('positive', 0.1);
  const late = shoutMark('positive', 0.9);
  assert.ok(late.ring > early.ring && late.alpha < early.alpha);
  assert.equal(early.arrow, '▲');
  assert.ok(late.lift > early.lift, 'floats upward');
  const down = shoutMark('negative', 0.9);
  assert.equal(down.arrow, '▼');
  assert.ok(down.lift < shoutMark('negative', 0.1).lift, 'sinks');
  assert.notEqual(down.color, late.color);
  // About 2.3 s, then gone.
  assert.ok(ANIM_MS.SHOUT >= 2000 && ANIM_MS.SHOUT <= 2500);
  now = ANIM_MS.SHOUT + 1;
  assert.equal(shoutMarks(anims.active()).size, 0);
});

test('fast-forward skips shout cues; a reset or seek (the tick going back) clears the running ones', () => {
  let now = 0;
  const anims = new PitchAnimations(() => now);
  const cue = cuesForEvents([EVENT], null);
  anims.ingest(cue, { tick: 9000, fast: true });
  assert.equal(anims.busy, false, 'skipped while fast-forwarding');
  anims.ingest(cue, { tick: 9001 });
  assert.equal(anims.busy, true);
  anims.ingest([], { tick: 9050 });
  assert.equal(anims.busy, true, 'later frames keep it running');
  anims.ingest([], { tick: 120 });
  assert.equal(anims.busy, false, 'seek back: cleared');
  anims.ingest(cue, { tick: 200 });
  anims.clear();
  assert.equal(anims.busy, false);
  assert.ok(isFastFrame({ playbackState: 'FAST_FORWARD' }));
  assert.ok(isFastFrame({ playbackState: 'FULL_MATCH', mode: 'auto_highlights', autoPacing: 'FAST' }));
  assert.ok(!isFastFrame({ playbackState: 'FULL_MATCH', mode: 'auto_highlights', autoPacing: 'WATCH' }));
});
