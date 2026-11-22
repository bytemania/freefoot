import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(root, 'scripts', 'build-config.mjs');
const fixtures = path.join(root, 'tests', 'config', 'fixtures');

/**
 * Runs build-config on a fixture into a fresh temp directory.
 * @param {string} name fixture directory name
 * @param {string[]} [extra] extra CLI flags
 */
function build(name, extra = []) {
  const out = mkdtempSync(path.join(tmpdir(), 'freefoot-config-'));
  const result = spawnSync(
    process.execPath,
    [script, '--config-dir', path.join(fixtures, name), '--out-dir', out, ...extra],
    { encoding: 'utf8' },
  );
  return { ...result, out, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

test('bad-key: a misspelled key fails with file, line and column', () => {
  const r = build('bad-key');
  try {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /weights\.yaml:\d+:\d+: error: unknown key "n00"/);
  } finally {
    r.cleanup();
  }
});

test('missing-template: an event type without templates in a locale fails', () => {
  const r = build('missing-template');
  try {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /en-GB\.yaml:\d+:\d+: error: no templates for event type GOAL/);
  } finally {
    r.cleanup();
  }
});

test('valid: built twice gives the same configHash', () => {
  const first = build('valid');
  const second = build('valid');
  try {
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const text = readFileSync(path.join(first.out, 'config.js'), 'utf8');
    assert.match(text, /export const configHash = "[0-9a-f]{64}";/);
    assert.equal(
      readFileSync(path.join(first.out, 'config.js'), 'utf8'),
      readFileSync(path.join(second.out, 'config.js'), 'utf8'),
    );
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test('valid: emits config, events, squads and golden modules', async () => {
  const r = build('valid');
  try {
    assert.equal(r.status, 0, r.stderr);
    const { config, configHash, configHash8 } = await import(path.join(r.out, 'config.js'));
    assert.equal(configHash8, configHash.slice(0, 8));
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.events.types.GOAL));
    assert.ok('GOAL' in config.events.types);
    const { EventType } = await import(path.join(r.out, 'events.js'));
    assert.equal(EventType.GOAL, 'GOAL');
    const home = (await import(path.join(r.out, 'squads', 'sample-home.js'))).default;
    assert.equal(home.players.length, 18);
    assert.equal(typeof (await import(path.join(r.out, 'golden.js'))).golden, 'object');
  } finally {
    r.cleanup();
  }
});

test('few-variations: passes without --strict-i18n and fails with it', () => {
  const lenient = build('few-variations');
  const strict = build('few-variations', ['--strict-i18n']);
  try {
    assert.equal(lenient.status, 0, lenient.stderr);
    assert.notEqual(strict.status, 0);
    assert.match(strict.stderr, /GOAL has 2 variation\(s\), needs at least 3/);
  } finally {
    lenient.cleanup();
    strict.cleanup();
  }
});

test('full-variations: passes with --strict-i18n', () => {
  const r = build('full-variations', ['--strict-i18n']);
  try {
    assert.equal(r.status, 0, r.stderr);
  } finally {
    r.cleanup();
  }
});
