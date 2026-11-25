/**
 * Commentary renderer (design §16, item 59).
 * Uses its own `sfc32` seeded from `(matchSeed, event.seq)` via `commentarySeed`
 * so switching languages never touches `engineRng` and always picks the same
 * variation index across locales.
 *
 * Most event types have one template list. A type with `commentaryBy` in the event registry (VAR_CHECK,
 * VAR_DECISION) is compiled by build-config as `{by, pools}`: one list per value of the meta field `by`.
 */
import { formatShortName } from '../engine/contracts/MatchInput.js';
import { nextUint32 } from '../engine/rng/sfc32.js';
import { commentarySeed, seedSfc32 } from '../engine/rng/streams.js';
import { Template } from './Template.js';

export class Commentator {
  /**
   * @param {Record<string, Record<string, string[] | {by: string, pools: Record<string, string[]>}>>} commentaryConfig `config.commentary`
   * @param {{strict?: boolean}} [options]
   */
  constructor(commentaryConfig, { strict = false } = {}) {
    /** @type {Record<string, Record<string, import('./Template.js').CompiledTemplate[]>>} */
    this.compiled = {};
    /** Per type with pools: the meta field that picks the pool (`config.events` `commentaryBy`). */
    /** @type {Record<string, string>} */
    this.poolBy = {};
    for (const [locale, byType] of Object.entries(commentaryConfig)) {
      this.compiled[locale] = {};
      for (const [type, entry] of Object.entries(byType)) {
        if (Array.isArray(entry)) {
          this.compiled[locale][type] = entry.map((src) => Template.compile(src, { strict }));
        } else {
          this.poolBy[type] = entry.by;
          for (const [value, list] of Object.entries(entry.pools)) {
            this.compiled[locale][`${type}.${value}`] = list.map((src) => Template.compile(src, { strict }));
          }
        }
      }
    }
    this.rng = new Uint32Array(4);
  }

  /**
   * The templates for an event: its type's list, or the pool its meta picks.
   * @param {string} locale
   * @param {{type: string, meta?: Record<string, any>}} event
   * @returns {import('./Template.js').CompiledTemplate[] | undefined}
   */
  templatesFor(locale, event) {
    const by = this.poolBy[event.type];
    return this.compiled[locale]?.[by === undefined ? event.type : `${event.type}.${event.meta?.[by]}`];
  }

  /**
   * Deterministic variation index for `(matchSeed, eventSeq)` — identical across locales.
   * @param {number} matchSeed
   * @param {number} eventSeq
   * @param {number} count
   * @returns {number}
   */
  variationIndex(matchSeed, eventSeq, count) {
    if (count <= 1) return 0;
    seedSfc32(this.rng, commentarySeed(matchSeed, eventSeq));
    return nextUint32(this.rng) % count;
  }

  /**
   * Renders one commentary line for `event` in `locale`.
   * @param {{seq: number, tick: number, type: string, teamIndex: number, actorIndex: number, secondaryIndices?: number[], meta?: Record<string, any>}} event
   * @param {string} locale
   * @param {{matchSeed: number, teams: [any, any], players: any[]}} ctx
   * @returns {string}
   */
  lineFor(event, locale, ctx) {
    const variations = this.templatesFor(locale, event);
    if (!variations || variations.length === 0) return event.type;
    const idx = this.variationIndex(ctx.matchSeed, event.seq, variations.length);
    const team = event.teamIndex === 0 || event.teamIndex === 1 ? ctx.teams[event.teamIndex] : ctx.teams[0];
    const opponent = event.teamIndex === 0 || event.teamIndex === 1 ? ctx.teams[1 - event.teamIndex] : ctx.teams[1];
    const rawPlayer = event.actorIndex >= 0 ? ctx.players[event.actorIndex] : undefined;
    const player = rawPlayer ? { ...rawPlayer, shortName: rawPlayer.shortName || formatShortName(rawPlayer.name) } : undefined;
    const secIdx = event.secondaryIndices?.[0] ?? -1;
    const rawPlayer2 = secIdx >= 0 ? ctx.players[secIdx] : undefined;
    const player2 = rawPlayer2 ? { ...rawPlayer2, shortName: rawPlayer2.shortName || formatShortName(rawPlayer2.name) } : undefined;

    /** @type {Record<string, any>} */
    const meta = {};
    if (event.meta) {
      for (const [k, v] of Object.entries(event.meta)) {
        meta[k] = typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(1)) : v;
      }
    }

    return variations[idx].render({
      minute: Math.floor(event.tick / 1200) + 1,
      team,
      opponent,
      player,
      player2,
      meta,
    });
  }
}
