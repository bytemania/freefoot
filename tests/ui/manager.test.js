// Manager panel flows (src/ui/views/ManagerView.js + src/runtime/managerPending.js): the mandatory
// injury replacement, the single Pending list with Confirm locked while a batch waits for the next
// dead ball, and the PT / EN strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { LocaleManager } from '../../src/i18n/Locale.js';
import { MatchController } from '../../src/runtime/MatchController.js';
import { hasPendingSubmission, mandatoryReplacement, pendingSubmission } from '../../src/runtime/managerPending.js';
import { ManagerView } from '../../src/ui/views/ManagerView.js';
import { generateSquad } from '../../src/shared/squadgen.js';
import { startRestart } from '../../src/engine/restarts/RestartMachine.js';
import { raiseForced } from '../../src/engine/commands/Forced.js';
import { fakeElement } from './fakedom.js';

/** @param {number} seed */
function makeController(seed) {
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'human' });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  return new MatchController({ input: { v: 1, seed, configHash, home, away }, config, mode: 'full', schedule: () => 1, cancelSchedule: () => {} });
}

/** @param {MatchController} ctrl */
function toOpenPlay(ctrl) {
  for (let i = 0; i < 2000 && ctrl.engine.state.restart.state !== 'IN_PLAY'; i++) ctrl.stepTicks(1);
  assert.equal(ctrl.engine.state.restart.state, 'IN_PLAY');
}

/**
 * A mounted ManagerView over a fake DOM, with `tap(attr, value)` delivering a click on an element
 * carrying `attr` (the way the real click delegation sees it).
 * @param {MatchController} ctrl
 * @param {LocaleManager} locale
 */
function mountedManager(ctrl, locale) {
  const view = new ManagerView({ locale, teamIndex: 0, onCommand: (cmd) => ctrl.queueCommand(cmd) });
  /** @type {Record<string, any>} */
  const els = {};
  const root = /** @type {any} */ (fakeElement());
  root.querySelector = (/** @type {string} */ sel) => (els[sel] ??= fakeElement());
  root.querySelectorAll = () => [];
  /** @type {(ev: any) => void} */
  let onClick = () => {};
  root.addEventListener = (/** @type {string} */ type, /** @type {(ev: any) => void} */ fn) => {
    if (type === 'click') onClick = fn;
  };
  view.mount(root);
  const html = root.innerHTML;
  /** @param {string} attr @param {number | string} [value] */
  const tap = (attr, value = '1') => {
    onClick({ target: { closest: (/** @type {string} */ sel) => (sel === `[${attr}]` ? { getAttribute: (/** @type {string} */ k) => (k === attr ? String(value) : null) } : null) } });
  };
  const refresh = () => view.update({ state: ctrl.engine.state, playbackState: ctrl.playbackState });
  return { view, els, tap, refresh, html };
}

/** The pending list items as `class|text` (button text dropped). @param {string} html */
const listItems = (html) =>
  [...html.matchAll(/<div class="mgr-pend-item ([^"]*)"><span>(.*?)<\/span>/g)].map((m) => `${m[1]}|${m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);

/** Injures home player `idx` badly in open play, as the engine does. @param {MatchController} ctrl @param {number} idx */
function highInjury(ctrl, idx) {
  const s = ctrl.engine.state;
  s.players[idx].injury = 3;
  startRestart(s, 'DROP_BALL', 1, s.ball.x, s.ball.y, { holdSeconds: 3 });
  raiseForced(s, s.teams[0], 1, idx);
  ctrl.stepTicks(1);
}

test('a HIGH injury opens the Manager in mandatory replacement mode: preselected, not dismissible, play blocked until a confirmed bench replacement; extra changes go in the same batch', () => {
  const loc = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  const ctrl = makeController(81);
  toOpenPlay(ctrl);
  highInjury(ctrl, 8);
  const s = ctrl.engine.state;
  assert.equal(ctrl.playbackState, 'PAUSED_FORCED');
  assert.equal(ctrl.mandatoryReplacement(), 8);
  assert.equal(mandatoryReplacement(s, 1), -1, 'only the injured team owes the decision');

  const { view, els, tap, refresh } = mountedManager(ctrl, loc);
  refresh();
  const injured = `#${s.players[8].cold.number} ${s.players[8].shortName}`;
  assert.equal(view.selectedOut, 8, 'the injured player starts selected');
  assert.match(els['#mgr-forced'].innerHTML, new RegExp(`${injured} is injured and must come off`));
  assert.doesNotMatch(els['#mgr-forced'].innerHTML, /data-forced-none/, 'no "play on without a sub" for an injury');
  assert.ok(els['#mgr-forced'].classList.contains('is-injury'));
  assert.match(els['#mgr-minimap'].innerHTML, /class="mgr-node is-selected is-forced[^"]*" data-out-index="8"/);
  assert.equal(els['#mgr-confirm'].disabled, true, 'nothing to confirm without a replacement');
  assert.equal(view.dismissible, false);
  assert.equal(ctrl.canDismissManager(), false);
  ctrl.play();
  assert.equal(ctrl.playbackState, 'PAUSED_FORCED', 'play cannot resume');
  view.confirmDraft();
  assert.equal(s.teams[0].forcedDecision, true, 'Confirm does nothing without a replacement');

  // The injured player cannot swap: tapping another pitch player moves the selection instead.
  tap('data-out-index', 9);
  assert.equal(view.selectedOut, 9);
  assert.equal(view.stagedSwaps.length, 0);
  tap('data-out-index', 10); // 9 <-> 10: an extra swap in the same batch
  assert.deepEqual(view.stagedSwaps, [[9, 10]]);
  assert.equal(view.selectedOut, 8, 'back on the injured player');
  tap('data-in-index', 12); // his replacement
  assert.deepEqual(view.forcedReplacement, { outIndex: 8, inIndex: 12 });
  tap('data-out-index', 7);
  tap('data-in-index', 13); // and an extra substitution
  assert.equal(view.stagedSubs.length, 2);
  const items = listItems(els['#mgr-pending-list'].innerHTML);
  assert.equal(items.length, 3);
  assert.match(items[0], /^is-draft is-forced\|Sub #\d+ .+ → #\d+ .+$/, 'the replacement leads the list');
  assert.equal(els['#mgr-confirm'].disabled, false);
  assert.match(els['#mgr-forced'].innerHTML, /press Confirm to carry on/);
  assert.equal(view.dismissible, false, 'still not dismissible before Confirm');

  // Undo the replacement: Confirm is blocked again until another is chosen.
  const forcedAt = view.stagedSubs.findIndex((x) => x.outIndex === 8);
  tap('data-undo-sub', forcedAt);
  assert.equal(view.forcedReplacement, undefined);
  assert.equal(els['#mgr-confirm'].disabled, true);
  assert.equal(view.selectedOut, 8);
  tap('data-in-index', 14);

  const [slot9, slot10] = [s.players[9].slot, s.players[10].slot];
  tap('data-confirm-draft');
  assert.equal(s.teams[0].forcedDecision, false);
  assert.equal(s.players[8].onPitch, 0);
  assert.equal(s.players[14].onPitch, 1);
  assert.ok(s.players[14].slot >= 0, 'the replacement is in the shape');
  assert.equal(s.players[13].onPitch, 1, 'the extra sub is made at the same stoppage');
  assert.equal(s.players[7].onPitch, 0);
  assert.equal(view.errorMsg, '');
  assert.deepEqual([s.players[9].slot, s.players[10].slot], [slot10, slot9], 'and the swap applied');
  assert.equal(ctrl.hasPendingSubmission(), false);
  assert.match(view.confirmedMsg, /substitution made/);
  assert.equal(ctrl.playbackState, 'PAUSED');
  assert.equal(view.dismissible, true);
  ctrl.play();
  assert.equal(ctrl.playbackState, 'FULL_MATCH');
  ctrl.destroy();
});

test('no mandatory replacement when the team cannot make one: the player just goes off and the panel stays dismissible', () => {
  const ctrl = makeController(82);
  toOpenPlay(ctrl);
  ctrl.engine.state.teams[0].subsUsed = 5;
  highInjury(ctrl, 8);
  assert.notEqual(ctrl.playbackState, 'PAUSED_FORCED');
  assert.equal(ctrl.mandatoryReplacement(), -1);
  assert.equal(ctrl.canDismissManager(), true);
  assert.equal(ctrl.engine.state.players[8].onPitch, 0);
  ctrl.destroy();
});

test('one Pending list: drafts before Confirm, then the confirmed batch locks Confirm and staging until the next dead ball carries it out', () => {
  const loc = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  const ctrl = makeController(83);
  toOpenPlay(ctrl);
  const s = ctrl.engine.state;
  const { view, els, tap, refresh, html } = mountedManager(ctrl, loc);
  assert.equal((html.match(/id="mgr-pending-list"/g) ?? []).length, 1, 'a single list');
  assert.doesNotMatch(html, /Staged|Next Dead Ball|mgr-staged-list/);
  refresh();
  assert.equal(els['#mgr-pending-title'].textContent, 'Pending');
  assert.equal(els['#mgr-hint'].textContent, 'Tap 2 pitch players to swap, or pitch + bench to sub');

  tap('data-out-index', 9);
  tap('data-in-index', 12);
  assert.deepEqual(listItems(els['#mgr-pending-list'].innerHTML).map((x) => x.split('|')[0]), ['is-draft']);
  assert.equal(els['#mgr-confirm'].disabled, false);
  tap('data-confirm-draft');
  assert.match(view.confirmedMsg, /queued for the next stoppage/);

  // Waiting for the dead ball: the same list shows it as confirmed, and the board is locked.
  assert.equal(ctrl.hasPendingSubmission(), true);
  assert.deepEqual(pendingSubmission(s, 0).map((x) => x.kind), ['SUB']);
  assert.equal(view.locked, true);
  const queued = listItems(els['#mgr-pending-list'].innerHTML);
  assert.equal(queued.length, 1);
  assert.match(queued[0], /^is-queued\|Sub #\d+ .+ → #\d+ .+ confirmed$/);
  assert.match(els['#mgr-pending-list'].innerHTML, /data-cancel-seq=/, 'a queued sub can still be withdrawn');
  assert.equal(els['#mgr-confirm'].disabled, true);
  assert.equal(els['#mgr-discard'].disabled, true);
  assert.ok(view.root?.classList.contains('is-locked'));
  assert.equal(els['#mgr-hint'].textContent, 'Confirmed changes are waiting for the next stoppage');
  assert.match(els['#mgr-minimap'].innerHTML, /data-out-index="10"[^>]* disabled>/);
  tap('data-out-index', 10);
  tap('data-in-index', 13);
  tap('data-formation', '4-4-2');
  assert.equal(view.stagedSubs.length + view.stagedSwaps.length, 0, 'nothing can be staged');
  assert.equal(view.stagedFormation, null);
  assert.equal(view.selectedOut, -1);

  // The next dead ball carries it out: unlocked again.
  startRestart(s, 'THROW_IN', 0, 52.5, 0);
  const frame = ctrl.stepTicks(1);
  assert.ok(frame.newEvents.some((e) => e.type === 'SUBSTITUTION'));
  refresh();
  assert.equal(hasPendingSubmission(s, 0), false);
  assert.equal(view.locked, false);
  assert.equal(listItems(els['#mgr-pending-list'].innerHTML).length, 0);
  tap('data-out-index', 10);
  tap('data-in-index', 13);
  assert.equal(view.stagedSubs.length, 1, 'staging works again');
  assert.equal(els['#mgr-confirm'].disabled, false);

  // Withdrawing a queued sub also unlocks the board.
  toOpenPlay(ctrl);
  tap('data-confirm-draft');
  assert.equal(view.locked, true);
  tap('data-cancel-seq', s.pendingSubs[0].seq);
  assert.equal(view.locked, false);
  ctrl.destroy();
});

test('PT / EN: the swap / sub hint, the Pending header, the queued tag and the injury prompt are translated', () => {
  const loc = new LocaleManager({ uiStrings: config.uiStrings, initial: 'pt-PT' });
  const ctrl = makeController(84);
  toOpenPlay(ctrl);
  const { els, tap, refresh, html } = mountedManager(ctrl, loc);
  assert.doesNotMatch(html, /Tap 2|Pending|Confirm|Discard|Play on/, 'no English hard-coded in the panel markup');
  refresh();
  assert.equal(els['#mgr-hint'].textContent, 'Toque em 2 jogadores em campo para trocar, ou em campo + banco para substituir');
  assert.equal(els['#mgr-pending-title'].textContent, 'Pendente');
  assert.equal(els['#mgr-confirm'].textContent, 'Confirmar');
  tap('data-out-index', 9);
  tap('data-in-index', 12);
  tap('data-confirm-draft');
  assert.match(listItems(els['#mgr-pending-list'].innerHTML)[0], /^is-queued\|Subst\. #\d+ .+ → #\d+ .+ confirmado$/);
  assert.equal(els['#mgr-hint'].textContent, 'As alterações confirmadas aguardam a próxima paragem');
  loc.setLocale('en-GB');
  refresh();
  assert.equal(els['#mgr-hint'].textContent, 'Confirmed changes are waiting for the next stoppage');
  assert.equal(els['#mgr-pending-title'].textContent, 'Pending');
  tap('data-cancel-seq', ctrl.engine.state.pendingSubs[0].seq);
  assert.equal(els['#mgr-hint'].textContent, 'Tap 2 pitch players to swap, or pitch + bench to sub');

  // The injury prompt, in Portuguese.
  loc.setLocale('pt-PT');
  highInjury(ctrl, 8);
  refresh();
  assert.match(els['#mgr-forced'].innerHTML, /está lesionado e tem de sair/);
  assert.match(els['#mgr-forced'].innerHTML, /Escolha um substituto no banco/);

  // Every new key exists in both languages.
  for (const key of ['panels.managerHint', 'panels.pending', 'panels.pendingLocked', 'panels.pendingSubmitted', 'panels.pendingSub', 'panels.pendingSwap', 'panels.pendingFormation', 'prompts.injuryReplace', 'prompts.injuryChoose', 'prompts.injuryConfirm', 'prompts.gkSentOffHint', 'buttons.playOnWithoutSub']) {
    const [g, k] = key.split('.');
    assert.ok(config.uiStrings['en-GB'][g][k] && config.uiStrings['pt-PT'][g][k], key);
    assert.notEqual(config.uiStrings['en-GB'][g][k], config.uiStrings['pt-PT'][g][k], `${key} is translated`);
  }
  ctrl.destroy();
});

test('pt-PT: every position label on the substitution panel (pitch, full bench, injury replacement, pending) is Portuguese; en-GB English', () => {
  const ENGLISH = new Set(Object.keys(config.uiStrings['en-GB'].positions));
  const PT = new Set(Object.values(config.uiStrings['pt-PT'].positions));
  const loc = new LocaleManager({ uiStrings: config.uiStrings, initial: 'pt-PT' });
  const ctrl = makeController(81);
  toOpenPlay(ctrl);
  highInjury(ctrl, 8);
  const { els, tap, refresh } = mountedManager(ctrl, loc);
  refresh();
  // The injury replacement chosen from the bench, plus a swap: every part of the panel is filled in.
  const bench = [...els['#mgr-bench'].innerHTML.matchAll(/data-in-index="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(bench.length, 7, 'the full bench');
  tap('data-in-index', bench[0]);
  tap('data-out-index', 9);
  tap('data-out-index', 10);
  refresh();
  /** Position badges (text and full-name tooltip) anywhere on the panel. */
  const labels = () => {
    const html = Object.values(els).map((e) => e.innerHTML ?? '').join('\n');
    return [...html.matchAll(/mgr-role-tag" title="([^"]*)">([^<]+)</g)].map((m) => ({ name: m[1], abbr: m[2] }));
  };
  const ptLabels = labels();
  assert.equal(ptLabels.length, 11 + 7, 'eleven on the pitch, seven on the bench');
  for (const { abbr, name } of ptLabels) {
    assert.ok(PT.has(abbr), `"${abbr}" is a pt-PT badge`);
    assert.ok(!ENGLISH.has(abbr), `"${abbr}" is not an English code`);
    assert.ok(!/Goalkeeper|Back|Midfield|Winger|Striker|Forward|Substitute|Centre/.test(name), `"${name}" is Portuguese`);
  }
  // The injury prompt and the pending list carry names, no position codes at all.
  for (const sel of ['#mgr-forced', '#mgr-pending-list']) {
    const text = els[sel].innerHTML.replace(/<[^>]+>/g, ' ');
    for (const code of ENGLISH) assert.doesNotMatch(text, new RegExp(`\\b${code}\\b`), `${sel} has no "${code}"`);
  }
  // Switching to en-GB re-renders every badge in English.
  loc.setLocale('en-GB');
  refresh();
  for (const { abbr } of labels()) assert.ok(ENGLISH.has(abbr), `en-GB "${abbr}"`);
});
