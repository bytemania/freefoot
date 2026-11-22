import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import sampleHome from '../../generated/squads/sample-home.js';
import sampleAway from '../../generated/squads/sample-away.js';
import { formatShortName } from '../../src/engine/contracts/MatchInput.js';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { inspectPitch } from '../../src/engine/debug/inspect.js';
import { Commentator } from '../../src/i18n/Commentator.js';
import { Template } from '../../src/i18n/Template.js';
import { generateSquad } from '../../src/shared/squadgen.js';

test('formatShortName handles two-word, multi-word, and single-word names deterministically', () => {
  assert.equal(formatShortName('João Silva'), 'J. Silva');
  assert.equal(formatShortName('Bruno Miguel Fernandes'), 'B. Fernandes');
  assert.equal(formatShortName('Silva'), 'Silva');
  assert.equal(formatShortName('  Rui   Nogueira  '), 'R. Nogueira');
  assert.equal(formatShortName(''), '');
});

test('sample squads and generated squads propagate shortName into MatchState and inspectPitch', () => {
  assert.equal(sampleHome.players[0].shortName, 'R. Nogueira');
  assert.equal(sampleAway.players[0].shortName, 'C. Mourão');
  for (const p of [...sampleHome.players, ...sampleAway.players]) {
    assert.ok(typeof p.shortName === 'string' && p.shortName.length > 0);
  }

  // Fallback when shortName is omitted on input players
  const home = generateSquad('A', 101, config, { side: 'home', controlledBy: 'ai' });
  const away = generateSquad('A', 202, config, { side: 'away', controlledBy: 'ai' });
  delete home.players[0].shortName;
  home.players[0].name = 'Rúben Dias';
  away.players[0].shortName = 'Custom GK';

  const engine = MatchEngine.create({ v: 1, seed: 1, configHash, home, away }, config);
  assert.equal(engine.state.players[0].shortName, 'R. Dias');
  assert.equal(engine.state.players[18].shortName, 'Custom GK');

  const pitch = inspectPitch(engine.state);
  assert.equal(pitch.players[0].shortName, 'R. Dias');
  assert.equal(pitch.players[18].shortName, 'Custom GK');
});

test('Template and Commentator support {player.shortName} and {player2.shortName}', () => {
  const tpl = Template.compile('{player.shortName} passes to {player2.shortName}.', { strict: true });
  const rendered = tpl.render({
    player: { name: 'Bruno Fernandes', shortName: 'B. Fernandes' },
    player2: { name: 'Rúben Dias', shortName: 'R. Dias' },
  });
  assert.equal(rendered, 'B. Fernandes passes to R. Dias.');

  const commentator = new Commentator(
    { 'en-GB': { PASS: ['{player.shortName} finds {player2.shortName}.'] } },
    { strict: true },
  );
  // Even when input players omit shortName, Commentator computes fallback deterministically
  const line = commentator.lineFor(
    { seq: 1, tick: 120, type: 'PASS', teamIndex: 0, actorIndex: 0, secondaryIndices: [1], meta: {} },
    'en-GB',
    {
      matchSeed: 1,
      teams: [{ name: 'Home' }, { name: 'Away' }],
      players: [{ name: 'João Silva' }, { name: 'Pedro' }],
    },
  );
  assert.equal(line, 'J. Silva finds Pedro.');
});
