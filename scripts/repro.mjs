// Repro record runner (design item 25, §20, CUJ 3).
//
// Usage: node scripts/repro.mjs <record.json> [--tick N]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ENGINE_VERSION, MatchEngine } from '../src/engine/MatchEngine.js';
import { canonicalJson, sha256Hex } from '../src/shared/canonicalJson.js';

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tick: { type: 'string' },
  },
});

const filePath = positionals[0];
if (!filePath) {
  console.error('Usage: node scripts/repro.mjs <record.json> [--tick N]');
  process.exit(2);
}

const record = JSON.parse(readFileSync(filePath, 'utf8'));
if (record.engineVersion !== ENGINE_VERSION) {
  console.error(`repro: engineVersion mismatch (record=${record.engineVersion}, current=${ENGINE_VERSION})`);
  process.exit(1);
}

const computedHash = await sha256Hex(canonicalJson(record.config));
if (computedHash !== record.configHash) {
  console.error(`repro: configHash mismatch (computed=${computedHash}, record=${record.configHash})`);
  process.exit(1);
}

const targetTick = flags.tick !== undefined ? Number(flags.tick) : record.tick;
const { engine } = MatchEngine.replay(record.input, record.config, record.commandLog ?? [], targetTick, { debug: true });

if (flags.tick !== undefined) {
  console.log(JSON.stringify(engine.serialize(), null, 2));
  process.exit(0);
}

const actualHash = engine.hash();
if (actualHash !== record.stateHash) {
  console.error(`repro: stateHash mismatch at tick ${targetTick} (actual=${actualHash}, expected=${record.stateHash})`);
  process.exit(1);
}

console.log(`repro: ok (tick ${engine.tick}, hash ${actualHash.toString(16).padStart(8, '0')})`);
