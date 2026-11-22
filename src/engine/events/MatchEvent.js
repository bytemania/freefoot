/**
 * Event factory (design §13, item 34).
 */

const PITCH_LENGTH = 105;
const PITCH_WIDTH = 68;
const BANDS = 6;
const CHANNELS = 3;

/**
 * Zone 1-18 in the 6 x 3 grid relative to the attacking team (§2): bands run
 * along the length from the team's own goal, channels across, zones count
 * across then forward. Returns -1 for events without a location.
 * @param {number} x
 * @param {number} y
 * @param {number} attackDir +1 when the team attacks toward x = 105, otherwise -1
 * @returns {number}
 */
export function zoneOf(x, y, attackDir) {
  if (x < 0 || y < 0) return -1;
  const along = attackDir > 0 ? x : PITCH_LENGTH - x;
  const across = attackDir > 0 ? y : PITCH_WIDTH - y;
  let band = Math.floor((along / PITCH_LENGTH) * BANDS);
  let channel = Math.floor((across / PITCH_WIDTH) * CHANNELS);
  band = band < 0 ? 0 : band >= BANDS ? BANDS - 1 : band;
  channel = channel < 0 ? 0 : channel >= CHANNELS ? CHANNELS - 1 : channel;
  return band * CHANNELS + channel + 1;
}

/**
 * @typedef {object} MatchEvent
 * @property {1} v
 * @property {number} seq
 * @property {number} tick
 * @property {string} type
 * @property {number} teamIndex
 * @property {number} actorIndex -1 when there is no actor
 * @property {number[]} secondaryIndices
 * @property {number} x -1 when there is no location
 * @property {number} y
 * @property {number} zone
 * @property {Record<string, number | string | boolean>} meta
 */

/**
 * Builds an event, assigning `v`, `seq` and `tick` and computing `zone`.
 * In debug mode it validates against the event registry.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {string} type
 * @param {{teamIndex?: number, actorIndex?: number, secondaryIndices?: number[], x?: number, y?: number, meta?: Record<string, number | string | boolean>}} [fields]
 * @returns {MatchEvent}
 */
export function makeEvent(state, type, fields = {}) {
  const teamIndex = fields.teamIndex ?? -1;
  const x = fields.x ?? -1;
  const y = fields.y ?? -1;
  /** @type {MatchEvent} */
  const event = {
    v: 1,
    seq: state.eventSeq++,
    tick: state.tick,
    type,
    teamIndex,
    actorIndex: fields.actorIndex ?? -1,
    secondaryIndices: fields.secondaryIndices ?? [],
    x,
    y,
    zone: teamIndex < 0 ? -1 : zoneOf(x, y, state.attackDir(teamIndex)),
    meta: fields.meta ?? {},
  };
  if (state.debug) validateEvent(event, state.config.events.types);
  return event;
}

/**
 * Throws if `event` does not match its registry entry.
 * @param {MatchEvent} event
 * @param {Record<string, any>} types `config.events.types`
 */
export function validateEvent(event, types) {
  const def = types[event.type];
  if (!def) throw new Error(`event ${event.seq}: unknown type ${event.type}`);
  if (def.actors.includes('actor') && event.actorIndex < 0) {
    throw new Error(`event ${event.seq} (${event.type}): missing actor`);
  }
  if (def.actors.includes('secondary') && event.secondaryIndices.length === 0) {
    throw new Error(`event ${event.seq} (${event.type}): missing secondary participant`);
  }
  for (const [key, value] of Object.entries(event.meta)) {
    const spec = def.meta[key];
    if (spec === undefined) throw new Error(`event ${event.seq} (${event.type}): unknown meta field ${key}`);
    if (typeof spec === 'object') {
      if (!spec.values.includes(value)) {
        throw new Error(`event ${event.seq} (${event.type}): meta.${key} must be one of ${spec.values.join(', ')}`);
      }
    } else if (typeof value !== spec) {
      throw new Error(`event ${event.seq} (${event.type}): meta.${key} must be a ${spec}`);
    }
  }
}
