import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { Commentator } from '../../src/i18n/Commentator.js';
import { LocaleManager } from '../../src/i18n/Locale.js';
import { memoryStorage } from '../../src/runtime/storage.js';
import { generateSquad } from '../../src/shared/squadgen.js';

const MASC_TEAM = { name: 'Sporting CP', gender: 'masc', artDef: 'o', contractionDe: 'do', contractionEm: 'no' };
const FEM_TEAM = { name: 'Académica', gender: 'fem', artDef: 'a', contractionDe: 'da', contractionEm: 'na' };
const MASC_PLAYER = { name: 'João Silva', number: 9, role: 'ST', gender: 'masc' };
const FEM_PLAYER = { name: 'Ana Costa', number: 10, role: 'ST', gender: 'fem' };

test('Commentator renders every event type in both en-GB and pt-PT with strict mode and zero unknown tokens', () => {
  const commentator = new Commentator(config.commentary, { strict: true });
  const ctx = {
    matchSeed: 12345,
    teams: /** @type {[any, any]} */ ([MASC_TEAM, FEM_TEAM]),
    players: [MASC_PLAYER, FEM_PLAYER],
  };

  let seq = 1;
  for (const [type, def] of Object.entries(/** @type {Record<string, any>} */ (config.events.types))) {
    /** @type {Record<string, any>} */
    const meta = {};
    for (const [k, spec] of Object.entries(/** @type {Record<string, any>} */ (def.meta))) {
      if (spec === 'number') meta[k] = 12;
      else if (spec === 'boolean') meta[k] = true;
      else if (spec === 'string') meta[k] = '4-3-3';
      else if (spec?.values) meta[k] = spec.values[0];
    }
    const ev = {
      seq: seq++,
      tick: 12000,
      type,
      teamIndex: 0,
      actorIndex: def.actors.includes('actor') ? 0 : -1,
      secondaryIndices: def.actors.includes('secondary') ? [1] : [],
      meta,
    };

    const en = commentator.lineFor(ev, 'en-GB', ctx);
    const pt = commentator.lineFor(ev, 'pt-PT', ctx);
    assert.ok(en.length > 0 && !en.includes('?'), `en-GB ${type}: ${en}`);
    assert.ok(pt.length > 0 && !pt.includes('?'), `pt-PT ${type}: ${pt}`);

    // Same variation index across both locales
    const countEn = config.commentary['en-GB'][type].length;
    const countPt = config.commentary['pt-PT'][type].length;
    assert.equal(countEn, countPt, `${type} variation count must match across locales`);
  }
});

test('Commentator applies masculine and feminine Portuguese gender agreement', () => {
  const commentator = new Commentator(config.commentary, { strict: true });
  const ctx = {
    matchSeed: 1,
    teams: /** @type {[any, any]} */ ([MASC_TEAM, FEM_TEAM]),
    players: [MASC_PLAYER, FEM_PLAYER],
  };

  // Find a seq that selects variation 1 of INJURY ("... está lesionad{player.g:o|a}.")
  const count = config.commentary['pt-PT'].INJURY.length;
  let targetSeq = 0;
  for (let s = 1; s < 50; s++) {
    if (commentator.variationIndex(1, s, count) === 1) {
      targetSeq = s;
      break;
    }
  }
  const mascLine = commentator.lineFor({ seq: targetSeq, tick: 6000, type: 'INJURY', teamIndex: 0, actorIndex: 0, meta: { level: 'LIGHT' } }, 'pt-PT', ctx);
  const femLine = commentator.lineFor({ seq: targetSeq, tick: 6000, type: 'INJURY', teamIndex: 1, actorIndex: 1, meta: { level: 'LIGHT' } }, 'pt-PT', ctx);
  assert.match(mascLine, /no Sporting CP.*lesionado/);
  assert.match(femLine, /na Académica.*lesionada/);
});

test('Switching locale never affects the engine state hash', () => {
  const home = generateSquad('A', (7 ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'ai' });
  const away = generateSquad('A', (7 ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  const engA = MatchEngine.create({ v: 1, seed: 7, configHash, home, away }, config);
  const engB = MatchEngine.create({ v: 1, seed: 7, configHash, home, away }, config);
  const commentator = new Commentator(config.commentary);

  const rA = engA.step(1000);
  const rB = engB.step(1000);
  const ctx = { matchSeed: 7, teams: /** @type {[any, any]} */ ([home, away]), players: [...home.players, ...away.players] };
  for (const ev of rA.events) commentator.lineFor(ev, 'en-GB', ctx);
  for (const ev of rB.events) commentator.lineFor(ev, 'pt-PT', ctx);
  assert.equal(engA.hash(), engB.hash());
});

test('LocaleManager persists locale choice and translates UI strings', async () => {
  const storage = memoryStorage();
  const loc = new LocaleManager({ uiStrings: config.uiStrings, storage });
  assert.equal(loc.getLocale(), 'pt-PT');
  assert.equal(loc.t('buttons.play'), 'Reproduzir');
  loc.toggle();
  assert.equal(loc.getLocale(), 'en-GB');
  assert.equal(loc.t('buttons.play'), 'Play');

  const loc2 = new LocaleManager({ uiStrings: config.uiStrings, storage });
  await loc2.init();
  assert.equal(loc2.getLocale(), 'en-GB');
});
