import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../generated/config.js';
import { Commentator } from '../../src/i18n/Commentator.js';
import { LocaleManager } from '../../src/i18n/Locale.js';
import { CommentaryView } from '../../src/ui/views/CommentaryView.js';

function createElStub(className = '') {
  /** @type {Record<string, string>} */
  const props = {};
  return {
    className,
    innerHTML: '',
    style: {
      /** @param {string} k @param {string} v */
      setProperty(k, v) { props[k] = String(v); },
      /** @param {string} k */
      removeProperty(k) { delete props[k]; },
      /** @param {string} k */
      getPropertyValue(k) { return props[k] ?? ''; },
    },
    childrenMap: /** @type {Record<string, any>} */ ({}),
    /** @param {string} sel */
    querySelector(sel) { return this.childrenMap[sel] ?? null; },
  };
}

test('CommentaryView broadcast bar styles with active team colors and applies is-flash on GOAL / RED_CARD', () => {
  const commentator = new Commentator(config.commentary);
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  const view = new CommentaryView({ commentator, locale });

  const broadcast = createElStub('comm-broadcast');
  const feed = createElStub('commentary-feed');
  const root = createElStub();
  root.childrenMap['.comm-broadcast'] = broadcast;
  root.childrenMap['.commentary-feed'] = feed;
  view.root = /** @type {any} */ (root);

  const players = [];
  for (let i = 0; i < 36; i++) {
    players.push({ id: `p-${i}`, name: `Player ${i}`, shortName: `P. ${i}`, gender: 'masc' });
  }
  const home = { id: 'h', name: 'Rio Azul', gender: 'masc', artDef: 'o', contractionDe: 'do', contractionEm: 'no' };
  const away = { id: 'a', name: 'Estrela', gender: 'masc', artDef: 'o', contractionDe: 'do', contractionEm: 'no' };

  view.setContext({
    matchSeed: 1,
    teams: [home, away],
    players,
    teamColors: [{ primary: '#2563eb', secondary: '#dbeafe' }, { primary: '#dc2626', secondary: '#fee2e2' }],
  });

  // Normal foul by home player -> active home team color, no blink flash
  view.update({
    score: [0, 0],
    newEvents: [{ seq: 1, type: 'FOUL', teamIndex: 0, actorIndex: 4, clockSeconds: 620 }],
  });
  assert.equal(broadcast.style.getPropertyValue('--team-primary'), '#2563eb');
  assert.equal(broadcast.className.includes('is-flash'), false);
  assert.ok(broadcast.innerHTML.includes('P. 4'));
  assert.ok(broadcast.innerHTML.includes('0 - 0'));

  // Goal by away player -> away kit colors, is-goal is-flash blink class, updated scoreline
  view.update({
    score: [0, 1],
    newEvents: [{ seq: 2, type: 'GOAL', teamIndex: 1, actorIndex: 20, clockSeconds: 1500 }],
  });
  assert.equal(broadcast.style.getPropertyValue('--team-primary'), '#dc2626');
  assert.equal(broadcast.className.includes('is-flash'), true);
  assert.equal(broadcast.className.includes('is-goal'), true);
  assert.ok(broadcast.innerHTML.includes('P. 20'));
  assert.ok(broadcast.innerHTML.includes('26\''));
  assert.ok(broadcast.innerHTML.includes('0 - 1'));

  // Yellow card -> highlighted yellow banner with booked player
  view.update({
    score: [0, 1],
    newEvents: [{ seq: 3, type: 'YELLOW_CARD', teamIndex: 0, actorIndex: 5, clockSeconds: 1800 }],
  });
  assert.equal(broadcast.className.includes('is-yellow'), true);
  assert.ok(broadcast.innerHTML.includes('P. 5'));

  // Red card -> highlighted red banner with sent-off player
  view.update({
    score: [0, 1],
    newEvents: [{ seq: 4, type: 'RED_CARD', teamIndex: 1, actorIndex: 21, clockSeconds: 2100 }],
  });
  assert.equal(broadcast.className.includes('is-red'), true);
  assert.equal(broadcast.className.includes('is-flash'), true);
  assert.ok(broadcast.innerHTML.includes('P. 21'));

  // Injury -> clean white banner with bold crimson text and medical cross
  view.update({
    score: [0, 1],
    newEvents: [{ seq: 5, type: 'INJURY', teamIndex: 0, actorIndex: 9, clockSeconds: 2400, meta: { level: 'MEDIUM' } }],
  });
  assert.equal(broadcast.className.includes('is-injury'), true);
  assert.ok(broadcast.innerHTML.includes('comm-med-cross'));
  assert.ok(broadcast.innerHTML.includes('P. 9'));
});
