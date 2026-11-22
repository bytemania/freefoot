import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Template } from '../../src/i18n/Template.js';

const ctx = {
  minute: 12,
  player: { name: 'Rui', number: 9, gender: 'masc' },
  player2: { name: 'Ana', gender: 'fem' },
  team: { name: 'Rio Azul', artDef: 'o', contractionDe: 'do', contractionEm: 'no', gender: 'masc' },
  opponent: { name: 'Estrela', artDef: 'a' },
  meta: { xg: 0.31 },
};

test('renders the token namespace', () => {
  const t = Template.compile("{minute}' {player.name} ({player.number}) marca pel{team.artDef} {team.name}; xG {meta.xg}");
  assert.equal(t.render(ctx), "12' Rui (9) marca pelo Rio Azul; xG 0.31");
});

test('picks a word by gender', () => {
  const t = Template.compile('{player.g:substituído|substituída} e {player2.g:substituído|substituída}');
  assert.equal(t.render(ctx), 'substituído e substituída');
});

test('gender defaults to masculine when the subject has none', () => {
  assert.equal(Template.compile('{opponent.g:o|a}').render({ opponent: { name: 'X' } }), 'o');
});

test('unknown tokens render as ? and throw when strict', () => {
  assert.equal(Template.compile('a {nope} b').render(ctx), 'a ? b');
  assert.equal(Template.compile('{player.height}').render(ctx), '?');
  assert.equal(Template.compile('{player.name}').render({}), '?');
  assert.throws(() => Template.compile('a {nope} b', { strict: true }), /unknown token \{nope\}/);
  assert.throws(() => Template.compile('{player.name}', { strict: true }).render({}), /no value/);
});

test('exposes tokens for build-time checks and supports literal braces', () => {
  const t = Template.compile('{{x}} {player.name}');
  assert.deepEqual(t.tokens.map((k) => k.kind), ['literal', 'field']);
  assert.equal(t.render(ctx), '{x} Rui');
});
