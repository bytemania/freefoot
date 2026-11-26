import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { LocaleManager } from '../../src/i18n/Locale.js';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { generateSquad } from '../../src/shared/squadgen.js';
import { positionCode, positionLabel, roleCode } from '../../src/ui/positions.js';
import { ManagerView, slotLabel } from '../../src/ui/views/ManagerView.js';
import { fakeRoot } from './fakedom.js';

const pt = new LocaleManager({ uiStrings: config.uiStrings, initial: 'pt-PT' });
const en = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });

test('pt-PT position abbreviations and names', () => {
  const expected = {
    GK: ['GR', 'Guarda-Redes'],
    CB: ['DC', 'Defesa-Central'],
    LB: ['DE', 'Defesa-Esquerdo'],
    RB: ['DD', 'Defesa-Direito'],
    LWB: ['AE', 'Ala-Esquerdo'],
    RWB: ['AD', 'Ala-Direito'],
    DM: ['MDC', 'Médio-Defensivo'],
    CM: ['MC', 'Médio-Centro'],
    AM: ['MO', 'Médio-Ofensivo'],
    LW: ['EE', 'Extremo-Esquerdo'],
    RW: ['ED', 'Extremo-Direito'],
    ST: ['PL', 'Ponta-de-Lança'],
    CF: ['PL', 'Ponta-de-Lança'],
  };
  for (const [code, [abbr, name]] of Object.entries(expected)) {
    assert.deepEqual(positionLabel(code, pt), { abbr, name }, code);
  }
});

test('en-GB position abbreviations and names', () => {
  const expected = {
    GK: ['GK', 'Goalkeeper'],
    CB: ['CB', 'Centre-Back'],
    LB: ['LB', 'Left-Back'],
    RB: ['RB', 'Right-Back'],
    LWB: ['LWB', 'Left Wing-Back'],
    RWB: ['RWB', 'Right Wing-Back'],
    DM: ['DM', 'Defensive Midfielder'],
    CM: ['CM', 'Central Midfielder'],
    AM: ['AM', 'Attacking Midfielder'],
    LW: ['LW', 'Left Winger'],
    RW: ['RW', 'Right Winger'],
    ST: ['ST', 'Striker'],
    CF: ['ST', 'Striker'],
  };
  for (const [code, [abbr, name]] of Object.entries(expected)) {
    assert.deepEqual(positionLabel(code, en), { abbr, name }, code);
  }
});

test('both locales define every position code', () => {
  const codes = Object.keys(config.uiStrings['en-GB'].positions);
  assert.deepEqual(Object.keys(config.uiStrings['pt-PT'].positions).sort(), codes.slice().sort());
  assert.deepEqual(Object.keys(config.uiStrings['pt-PT'].positionNames).sort(), codes.slice().sort());
  assert.equal(positionLabel('XYZ', pt).abbr, 'XYZ', 'unknown codes fall back to the code');
});

test('slot geometry maps to tactical positions', () => {
  const slots433 = config.tactics.formations['4-3-3'].slots.map(positionCode);
  assert.deepEqual(slots433, ['GK', 'LB', 'CB', 'CB', 'RB', 'LCM', 'CM', 'RCM', 'LW', 'ST', 'RW']);
  assert.deepEqual(config.tactics.formations['4-4-2'].slots.map(positionCode), ['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST']);
  assert.equal(positionCode({ role: 'MF', defend: [0.28, 0.5] }), 'DM');
  assert.equal(positionCode({ role: 'MF', defend: [0.5, 0.5] }), 'AM');
  assert.equal(positionCode({ role: 'FB', defend: [0.36, 0.1] }), 'LWB');
  assert.equal(positionCode({ role: 'FB', defend: [0.36, 0.9] }), 'RWB');
  assert.equal(slotLabel(config.tactics.formations['4-3-3'].slots[9]), 'ST');
  assert.deepEqual(['GK', 'CB', 'FB', 'MF', 'W', 'ST'].map(roleCode), ['GK', 'CB', 'FB', 'CM', 'W', 'ST']);
});

test('all 7 new formations map to expected tactical position codes in both locales', () => {
  const expected = {
    '4-2-3-1': ['GK', 'LB', 'CB', 'CB', 'RB', 'DM', 'DM', 'LW', 'AM', 'RW', 'ST'],
    '4-1-2-1-2': ['GK', 'LB', 'CB', 'CB', 'RB', 'DM', 'LCM', 'RCM', 'AM', 'ST', 'ST'],
    '4-1-4-1': ['GK', 'LB', 'CB', 'CB', 'RB', 'DM', 'LM', 'CM', 'CM', 'RM', 'ST'],
    '3-5-2': ['GK', 'CB', 'CB', 'CB', 'LWB', 'DM', 'LCM', 'RCM', 'RWB', 'ST', 'ST'],
    '3-4-3': ['GK', 'CB', 'CB', 'CB', 'LWB', 'CM', 'CM', 'RWB', 'LW', 'ST', 'RW'],
    '4-2-4': ['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CM', 'LW', 'ST', 'ST', 'RW'],
    '5-4-1': ['GK', 'LB', 'CB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST'],
  };
  for (const [id, codes] of Object.entries(expected)) {
    const actual = config.tactics.formations[id].slots.map(positionCode);
    assert.deepEqual(actual, codes, id);
    for (const code of actual) {
      assert.notEqual(positionLabel(code, pt).abbr, '', `${id} pt-PT ${code}`);
      assert.notEqual(positionLabel(code, en).abbr, '', `${id} en-GB ${code}`);
    }
  }
  assert.deepEqual(
    config.tactics.formations['4-2-3-1'].slots.map((/** @type {any} */ s) => positionLabel(positionCode(s), pt).abbr),
    ['GR', 'DE', 'DC', 'DC', 'DD', 'MDC', 'MDC', 'EE', 'MO', 'ED', 'PL'],
  );
});

/** @param {'pt-PT' | 'en-GB'} initial */
function renderManager(initial) {
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial });
  const home = generateSquad('A', 7, config, { side: 'home', controlledBy: 'human' });
  const away = generateSquad('A', 8, config, { side: 'away', controlledBy: 'ai' });
  const engine = MatchEngine.create({ v: 1, seed: 3, configHash, home, away }, config);
  const view = new ManagerView({ locale, onCommand: () => ({ ok: true, code: null }) });
  const root = fakeRoot();
  view.root = root;
  view.update({ state: engine.state, playbackState: 'PAUSED' });
  const tags = (/** @type {string} */ html) => [...html.matchAll(/mgr-role-tag" title="[^"]*">([^<]+)</g)].map((m) => m[1]);
  return { minimap: tags(root.querySelector('#mgr-minimap').innerHTML), bench: tags(root.querySelector('#mgr-bench').innerHTML), html: root.querySelector('#mgr-minimap').innerHTML };
}

test('ManagerView renders pt-PT badges on the minimap and bench', () => {
  const r = renderManager('pt-PT');
  assert.deepEqual(r.minimap, ['GR', 'DE', 'DC', 'DC', 'DD', 'MCE', 'MC', 'MCD', 'EE', 'PL', 'ED']);
  assert.deepEqual(r.bench, ['GR', 'DC', 'DL', 'MC', 'MC', 'EX', 'PL']);
  assert.match(r.html, /title="Guarda-Redes"/);
});

test('ManagerView renders en-GB badges on the minimap and bench', () => {
  const r = renderManager('en-GB');
  assert.deepEqual(r.minimap, ['GK', 'LB', 'CB', 'CB', 'RB', 'LCM', 'CM', 'RCM', 'LW', 'ST', 'RW']);
  assert.deepEqual(r.bench, ['GK', 'CB', 'FB', 'CM', 'CM', 'W', 'ST']);
  assert.match(r.html, /title="Goalkeeper"/);
});
