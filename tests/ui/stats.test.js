import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../generated/config.js';
import { LocaleManager } from '../../src/i18n/Locale.js';
import { StatsView, STATS_ROWS, matchMinuteLabel } from '../../src/ui/views/StatsView.js';
import { fakeRoot } from './fakedom.js';

/** @param {Record<string, number>} over */
function side(over = {}) {
  return { goals: 0, possessionPct: 50, shots: 0, shotsOnTarget: 0, passes: 0, passCompletionPct: 0, foulsCommitted: 0, yellowCards: 0, redCards: 0, distanceKm: 0, ...over };
}

/**
 * @param {number} clockSeconds
 * @param {number} half
 * @param {Record<string, number>} [home]
 * @param {Record<string, number>} [away]
 */
function frame(clockSeconds, half, home = {}, away = {}) {
  return { stats: { home: side(home), away: side(away) }, clockSeconds, half, playbackState: 'FULL_MATCH' };
}

/** @param {'en-GB' | 'pt-PT'} initial */
function mounted(initial = 'en-GB') {
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial });
  const view = new StatsView({ locale });
  const root = fakeRoot();
  view.mount(root);
  return { view, locale, rows: root.querySelector('.stats-rows'), minute: root.querySelector('.stats-minute') };
}

test('matchMinuteLabel: the minute being played, with added time as 45+N / 90+N', () => {
  assert.equal(matchMinuteLabel(0, 1), "1'");
  assert.equal(matchMinuteLabel(59.9, 1), "1'");
  assert.equal(matchMinuteLabel(33 * 60 + 12, 1), "34'");
  assert.equal(matchMinuteLabel(44 * 60 + 59, 1), "45'");
  assert.equal(matchMinuteLabel(45 * 60, 1), "45+1'");
  assert.equal(matchMinuteLabel(46 * 60 + 30, 1), "45+2'");
  assert.equal(matchMinuteLabel(45 * 60, 2), "46'");
  assert.equal(matchMinuteLabel(89 * 60 + 59, 2), "90'");
  assert.equal(matchMinuteLabel(92 * 60 + 5, 2), "90+3'");
});

test('StatsView: every row label is a stats.* key defined in both locales', () => {
  for (const loc of /** @type {const} */ (['en-GB', 'pt-PT'])) {
    const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: loc });
    for (const r of STATS_ROWS) assert.notEqual(locale.t(r.labelKey), r.labelKey, `${loc} ${r.labelKey}`);
    assert.notEqual(locale.t('stats.header'), 'stats.header');
  }
});

test('StatsView: live updates while visible change the numbers and the minute header', () => {
  const { view, rows, minute } = mounted();
  view.setVisible(true);
  view.update(frame(5 * 60, 1, { passes: 15 }, { passes: 11 }));
  assert.equal(minute.textContent, "6' · H1");
  assert.match(rows.innerHTML, /<span>15<\/span><span class="muted">Passes<\/span><span>11<\/span>/);

  view.update(frame(7 * 60 + 3, 1, { passes: 16, goals: 1 }, { passes: 11 }));
  assert.equal(minute.textContent, "8' · H1");
  assert.match(rows.innerHTML, /<span>16<\/span><span class="muted">Passes<\/span>/);
  assert.match(rows.innerHTML, /<span>1<\/span><span class="muted">Goals<\/span><span>0<\/span>/);

  view.update(frame(47 * 60, 1, { passes: 40 }));
  assert.equal(minute.textContent, "45+3' · H1");
  view.update(frame(91 * 60 + 10, 2, { passes: 90 }));
  assert.equal(minute.textContent, "90+2' · H2");
  view.destroy();
});

test('StatsView: an unchanged frame does not rebuild the DOM; hidden updates do not touch it at all', () => {
  const { view, rows, minute } = mounted();
  view.setVisible(true);
  view.update(frame(60, 1, { passes: 3 }));
  rows.innerHTML = 'SENTINEL';
  // Same minute and values (e.g. a later tick in the same minute): no re-render.
  view.update(frame(80, 1, { passes: 3 }));
  assert.equal(rows.innerHTML, 'SENTINEL');

  view.setVisible(false);
  rows.innerHTML = 'HIDDEN';
  minute.textContent = 'HIDDEN';
  for (let s = 120; s < 600; s += 30) view.update(frame(s, 1, { passes: s / 10 }));
  assert.equal(rows.innerHTML, 'HIDDEN');
  assert.equal(minute.textContent, 'HIDDEN');
  view.destroy();
});

test('StatsView: becoming visible renders the latest frame at once', () => {
  const { view, rows, minute } = mounted();
  view.update(frame(60, 1, { passes: 1 }));
  view.update(frame(20 * 60, 1, { passes: 42, shots: 3 }, { passes: 30 }));
  assert.equal(rows.innerHTML, '', 'nothing rendered while hidden');
  view.setVisible(true);
  assert.equal(minute.textContent, "21' · H1");
  assert.match(rows.innerHTML, /<span>42<\/span><span class="muted">Passes<\/span><span>30<\/span>/);
  assert.match(rows.innerHTML, /<span>3<\/span><span class="muted">Shots<\/span>/);
  view.destroy();
});

test('StatsView: PT / EN labels switch on a locale change while visible', () => {
  const { view, locale, rows } = mounted('pt-PT');
  view.setVisible(true);
  view.update(frame(60, 1, { yellowCards: 1 }));
  assert.match(rows.innerHTML, /Golos/);
  assert.match(rows.innerHTML, /Cartões amarelos/);
  assert.match(rows.innerHTML, /Remates enquadrados/);
  assert.doesNotMatch(rows.innerHTML, /Goals/);

  locale.setLocale('en-GB');
  assert.match(rows.innerHTML, /Goals/);
  assert.match(rows.innerHTML, /Yellow Cards/);
  assert.match(rows.innerHTML, /Shots on target/);
  assert.doesNotMatch(rows.innerHTML, /Golos/);

  // A locale change while hidden shows up when the drawer opens again.
  view.setVisible(false);
  locale.setLocale('pt-PT');
  assert.match(rows.innerHTML, /Goals/);
  view.setVisible(true);
  assert.match(rows.innerHTML, /Golos/);
  view.destroy();
});
