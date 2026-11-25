import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../generated/config.js';
import { Commentator } from '../../src/i18n/Commentator.js';
import { LocaleManager } from '../../src/i18n/Locale.js';
import { CommentaryView, matchMinuteLabel } from '../../src/ui/views/CommentaryView.js';

function createElStub(className = '') {
  /** @type {Record<string, string>} */
  const props = {};
  return {
    className,
    innerHTML: '',
    dataset: /** @type {Record<string, string>} */ ({}),
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

/**
 * Slots of the bar's innerHTML, in order.
 * @param {string} html
 */
function slots(html) {
  const out = [];
  const re = /<span class="(comm-min|comm-icon[^"]*|comm-text)"[^>]*>([\s\S]*?)<\/span>(?=<span class="comm-|$)/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push({ cls: m[1], body: m[2] });
  return out;
}

function setup(initial = 'en-GB') {
  const commentator = new Commentator(config.commentary);
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: /** @type {any} */ (initial) });
  const view = new CommentaryView({ commentator, locale });
  const broadcast = createElStub('comm-broadcast');
  const root = createElStub();
  root.childrenMap['.comm-broadcast'] = broadcast;
  view.root = /** @type {any} */ (root);
  const players = [];
  for (let i = 0; i < 36; i++) players.push({ id: `p-${i}`, name: `Player ${i}`, shortName: `P. ${i}`, gender: 'masc' });
  players[30] = { id: 'p-30', name: 'Bernardo Silva', shortName: 'B. Silva', gender: 'masc' };
  players[9] = { id: 'p-9', name: 'João Félix', shortName: 'J. Félix', gender: 'masc' };
  const home = { id: 'h', name: 'Rio Azul', gender: 'masc', artDef: 'o', contractionDe: 'do', contractionEm: 'no' };
  const away = { id: 'a', name: 'Estrela', gender: 'masc', artDef: 'o', contractionDe: 'do', contractionEm: 'no' };
  view.setContext({
    matchSeed: 1,
    teams: [home, away],
    players,
    teamColors: [{ primary: '#2563eb', secondary: '#dbeafe' }, { primary: '#dc2626', secondary: '#fee2e2' }],
  });
  return { view, broadcast, locale };
}

test('matchMinuteLabel uses the live tick, with added-time labels once the half is known', () => {
  assert.equal(matchMinuteLabel(0), "1'");
  assert.equal(matchMinuteLabel(44 * 1200 + 5), "45'");
  assert.equal(matchMinuteLabel(71 * 1200), "72'");
  // First-half added time once the second half has started.
  assert.equal(matchMinuteLabel(45 * 1200 + 100, 47 * 1200), "45+1'");
  // Second half counts from the HALF_TIME tick.
  assert.equal(matchMinuteLabel(47 * 1200 + 26 * 1200 + 10, 47 * 1200), "72'");
  assert.equal(matchMinuteLabel(47 * 1200 + 46 * 1200, 47 * 1200), "90+2'");
});

test('CommentaryView bar: dynamic minute, no scoreline, min | icon | comment slots', () => {
  const { view, broadcast } = setup();

  view.update({ score: [0, 0], newEvents: [{ seq: 1, tick: 44 * 1200 + 30, type: 'FOUL', teamIndex: 0, actorIndex: 4, secondaryIndices: [20] }] });
  let s = slots(broadcast.innerHTML);
  assert.deepEqual(s.map((x) => x.cls.split(' ')[0]), ['comm-min', 'comm-icon', 'comm-text']);
  assert.equal(s[0].body, "45'");
  assert.ok(s[1].cls.includes('comm-icon--whistle'));
  assert.ok(s[1].body.includes('<svg'));
  assert.ok(s[2].body.length > 0 && !s[2].body.includes('\n'));
  assert.equal(broadcast.style.getPropertyValue('--team-primary'), '#2563eb');
  assert.equal(broadcast.className.includes('is-flash'), false);
  assert.equal(broadcast.innerHTML.includes('comm-score'), false);
  assert.equal(/\d+\s*-\s*\d+/.test(broadcast.innerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '')), false, 'no scoreline in the bar');

  view.update({ score: [0, 1], newEvents: [{ seq: 2, tick: 71 * 1200 + 600, type: 'GOAL', teamIndex: 1, actorIndex: 20 }] });
  s = slots(broadcast.innerHTML);
  assert.equal(s[0].body, "72'");
  assert.ok(s[1].cls.includes('comm-icon--goal'));
  assert.equal(/^\d+'/.test(s[2].body), false, 'template minute prefix is stripped from the comment slot');
  assert.equal(broadcast.style.getPropertyValue('--team-primary'), '#dc2626');
  assert.ok(broadcast.className.includes('is-goal') && broadcast.className.includes('is-flash'));
  assert.equal(broadcast.innerHTML.includes('0 - 1'), false);

  view.update({ newEvents: [{ seq: 3, tick: 75 * 1200, type: 'YELLOW_CARD', teamIndex: 0, actorIndex: 5 }] });
  assert.ok(broadcast.className.includes('is-yellow'));
  assert.ok(slots(broadcast.innerHTML)[1].cls.includes('comm-icon--yellow-card'));

  view.update({ newEvents: [{ seq: 4, tick: 76 * 1200, type: 'RED_CARD', teamIndex: 1, actorIndex: 21 }] });
  assert.ok(broadcast.className.includes('is-red') && broadcast.className.includes('is-flash'));
  assert.ok(slots(broadcast.innerHTML)[1].cls.includes('comm-icon--red-card'));

  view.update({ newEvents: [{ seq: 5, tick: 77 * 1200, type: 'INJURY', teamIndex: 0, actorIndex: 9, meta: { level: 'MEDIUM' } }] });
  assert.ok(broadcast.className.includes('is-injury'));
  assert.ok(broadcast.innerHTML.includes('comm-med-cross'));

  // Half a minute apart, so no line still holds the bar (see the hold test below).
  let k = 0;
  for (const [type, kind] of [['SAVE', 'save'], ['CORNER', 'flag'], ['PENALTY_AWARDED', 'penalty'], ['KICK_OFF', 'kick-off'], ['FULL_TIME', 'clock'], ['FREE_KICK', 'whistle']]) {
    view.update({ newEvents: [{ seq: 10 + k, tick: 80 * 1200 + 600 * k++, type, teamIndex: 0, actorIndex: 3, secondaryIndices: [20] }] });
    assert.ok(slots(broadcast.innerHTML)[1].cls.includes(`comm-icon--${kind}`), `${type} -> ${kind}`);
  }
  view.update({ newEvents: [{ seq: 20, tick: 84 * 1200, type: 'SHOT', teamIndex: 0, actorIndex: 3, meta: { result: 'WOODWORK' } }] });
  assert.ok(slots(broadcast.innerHTML)[1].cls.includes('comm-icon--woodwork'));
});

test('CommentaryView renders SUBSTITUTION as "<min>\' | swap arrows | SUB | <IN>, <OUT>" in the substituting team colors', () => {
  const { view, broadcast, locale } = setup();
  view.update({ newEvents: [{ seq: 7, tick: 63 * 1200 + 40, type: 'SUBSTITUTION', teamIndex: 1, actorIndex: 9, secondaryIndices: [30] }] });
  const s = slots(broadcast.innerHTML);
  assert.equal(s[0].body, "64'");
  assert.ok(s[1].cls.includes('comm-icon--sub'));
  // Green arrow up (coming on), red arrow down (going off).
  assert.match(s[1].body, /comm-swap/);
  assert.match(s[1].body, /stroke="#4ade80"/);
  assert.match(s[1].body, /stroke="#f87171"/);
  assert.equal(s[2].body, 'B. Silva, J. Félix');
  assert.match(broadcast.innerHTML, /<span class="comm-badge comm-badge--substitution">SUB<\/span>/);
  assert.ok(broadcast.className.includes('is-sub'));
  assert.equal(broadcast.style.getPropertyValue('--team-primary'), '#dc2626');
  assert.equal(broadcast.style.getPropertyValue('--team-secondary'), '#fee2e2');

  locale.setLocale('pt-PT');
  view.setEvents([{ seq: 7, tick: 63 * 1200 + 40, type: 'SUBSTITUTION', teamIndex: 1, actorIndex: 9, secondaryIndices: [30] }]);
  assert.equal(slots(broadcast.innerHTML)[2].body, 'B. Silva, J. Félix');
});

test('CommentaryView uses the HALF_TIME tick to number second-half minutes', () => {
  const { view, broadcast } = setup();
  const ht = 47 * 1200;
  view.setEvents([
    { seq: 1, tick: ht, type: 'HALF_TIME', teamIndex: -1, actorIndex: -1 },
    { seq: 2, tick: ht + 26 * 1200 + 5, type: 'CORNER', teamIndex: 0, actorIndex: 7 },
  ]);
  assert.equal(slots(broadcast.innerHTML)[0].body, "72'");
});

test('commentary bar: Goal, Yellow Card, Red Card, VAR and Substitution each get their class, badge and icon (en-GB and pt-PT)', () => {
  const cases = [
    { ev: { type: 'GOAL', teamIndex: 1, actorIndex: 30 }, cls: 'is-goal', badge: 'goal', en: 'GOAL', pt: 'GOLO', icon: 'goal' },
    { ev: { type: 'YELLOW_CARD', teamIndex: 0, actorIndex: 5 }, cls: 'is-yellow', badge: 'yellowCard', en: 'YELLOW', pt: 'AMARELO', icon: 'yellow-card' },
    { ev: { type: 'RED_CARD', teamIndex: 1, actorIndex: 21 }, cls: 'is-red', badge: 'redCard', en: 'RED CARD', pt: 'VERMELHO', icon: 'red-card' },
    { ev: { type: 'VAR_CHECK', teamIndex: 0, actorIndex: 9, meta: { incident: 'GOAL' } }, cls: 'is-var', badge: 'var', en: 'VAR', pt: 'VAR', icon: 'var' },
    { ev: { type: 'VAR_DECISION', teamIndex: 0, actorIndex: 9, meta: { incident: 'GOAL', outcome: 'goalDisallowed', overturned: true } }, cls: 'is-var', badge: 'var', en: 'VAR', pt: 'VAR', icon: 'var' },
    { ev: { type: 'SUBSTITUTION', teamIndex: 0, actorIndex: 9, secondaryIndices: [30] }, cls: 'is-sub', badge: 'substitution', en: 'SUB', pt: 'SUBST.', icon: 'sub' },
  ];
  for (const locale of ['en-GB', 'pt-PT']) {
    for (const c of cases) {
      const { view, broadcast } = setup(locale);
      view.update({ newEvents: [{ seq: 1, tick: 30 * 1200, secondaryIndices: [], ...c.ev }] });
      assert.ok(broadcast.className.includes(c.cls), `${c.ev.type}: ${broadcast.className}`);
      assert.ok(broadcast.className.includes('is-major'));
      assert.equal(broadcast.dataset.category, c.badge);
      const text = locale === 'en-GB' ? c.en : c.pt;
      assert.ok(broadcast.innerHTML.includes(`<span class="comm-badge comm-badge--${c.badge}">${text}</span>`), `${locale} ${c.ev.type} badge`);
      assert.ok(slots(broadcast.innerHTML)[1].cls.includes(`comm-icon--${c.icon}`));
    }
  }
  // A minor event has no badge.
  const { view, broadcast } = setup();
  view.update({ newEvents: [{ seq: 1, tick: 100, type: 'CORNER', teamIndex: 0, actorIndex: 3 }] });
  assert.equal(broadcast.innerHTML.includes('comm-badge'), false);
  assert.equal(broadcast.className.includes('is-major'), false);
});

test('a goal stands out: bold scorer, gold-minute goal class and pulse, and it holds the bar against its own assist and the kick-off', () => {
  const { view, broadcast } = setup();
  const t = 71 * 1200 + 600;
  view.update({
    newEvents: [
      { seq: 1, tick: t, type: 'GOAL', teamIndex: 1, actorIndex: 30, secondaryIndices: [] },
      { seq: 2, tick: t, type: 'ASSIST', teamIndex: 1, actorIndex: 21, secondaryIndices: [30] },
    ],
  });
  assert.equal(view.shown.type, 'GOAL', 'the assist on the same tick does not replace the goal');
  assert.ok(broadcast.className.includes('is-goal') && broadcast.className.includes('is-flash'));
  assert.match(broadcast.innerHTML, /<strong class="comm-scorer">(Bernardo Silva|B\. Silva)<\/strong>/);
  // The kick-off a few seconds later is held back too; a minor line once the hold is over replaces it.
  view.update({ newEvents: [{ seq: 3, tick: t + 120, type: 'KICK_OFF', teamIndex: 0, actorIndex: 9, secondaryIndices: [] }] });
  assert.equal(view.shown.type, 'GOAL');
  view.update({ newEvents: [{ seq: 4, tick: t + 260, type: 'CORNER', teamIndex: 0, actorIndex: 9, secondaryIndices: [] }] });
  assert.equal(view.shown.type, 'CORNER');
  assert.equal(broadcast.className.includes('is-goal'), false);
  // A major line replaces a goal at once (a VAR check of it).
  view.update({ newEvents: [{ seq: 5, tick: t + 300, type: 'GOAL', teamIndex: 0, actorIndex: 9, secondaryIndices: [] }] });
  view.update({ newEvents: [{ seq: 6, tick: t + 340, type: 'VAR_CHECK', teamIndex: 0, actorIndex: 9, secondaryIndices: [], meta: { incident: 'GOAL' } }] });
  assert.equal(view.shown.type, 'VAR_CHECK');
  assert.ok(broadcast.className.includes('is-var'));
  // Rebuilding from the log (a seek) applies the same rule.
  view.setEvents([
    { seq: 1, tick: t, type: 'GOAL', teamIndex: 1, actorIndex: 30, secondaryIndices: [] },
    { seq: 2, tick: t, type: 'ASSIST', teamIndex: 1, actorIndex: 21, secondaryIndices: [30] },
  ]);
  assert.equal(view.shown.type, 'GOAL');
});
