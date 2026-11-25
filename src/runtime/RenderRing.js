/**
 * Preallocated RenderSnapshot ring buffer (design §14, item 54).
 * Stores up to `capacity` frames (default 500) of `SNAP_LEN` float64s plus
 * each frame's tick and index range into the controller's event log, and
 * what the pitch needs to draw that frame that the snapshot does not hold:
 * the restart (dead-ball set piece) and the ball carrier as they stood on
 * that tick. A replay or an Auto Highlights pre-roll then draws the set-piece
 * overlay and the carrier of the moment shown, never the live engine's.
 */
import { FLAG_DEAD_BALL, SNAP_LEN } from '../engine/MatchEngine.js';

/**
 * @typedef {{state: string, kind: string, teamIndex: number, x: number, y: number, direct: boolean, taker: number}} ShownRestart
 */

export class RenderRing {
  /**
   * @param {number} [capacity]
   */
  constructor(capacity = 500) {
    this.capacity = capacity;
    this.data = new Float64Array(capacity * SNAP_LEN);
    this.ticks = new Int32Array(capacity).fill(-1);
    this.eventStarts = new Int32Array(capacity);
    this.eventEnds = new Int32Array(capacity);
    // Per frame: restart state / kind (codes into the name tables), team, spot, direct, taker; ball owner.
    this.rState = new Int16Array(capacity).fill(-1);
    this.rKind = new Int16Array(capacity);
    this.rTeam = new Int8Array(capacity);
    this.rX = new Float64Array(capacity);
    this.rY = new Float64Array(capacity);
    this.rDirect = new Uint8Array(capacity);
    this.rTaker = new Int16Array(capacity);
    this.owner = new Int16Array(capacity);
    /** @type {string[]} restart state / kind names seen so far (index = code) */
    this.names = [];
    this.head = 0;
    this.count = 0;
  }

  /**
   * Pushes one RenderSnapshot into the ring.
   * @param {Float64Array} snapshot
   * @param {number} tick
   * @param {number} eventStart
   * @param {number} eventEnd
   * @param {{restart: {state: string, kind: string, teamIndex: number, x: number, y: number, direct: boolean, taker: number}, ball: {owner: number}}} [state]
   *   the engine state on this tick (its restart and ball carrier are kept with the frame)
   */
  push(snapshot, tick, eventStart, eventEnd, state) {
    const slot = this.head;
    this.data.set(snapshot, slot * SNAP_LEN);
    this.ticks[slot] = tick;
    this.eventStarts[slot] = eventStart;
    this.eventEnds[slot] = eventEnd;
    if (state) {
      const r = state.restart;
      this.rState[slot] = this.#code(r.state);
      this.rKind[slot] = this.#code(r.kind ?? '');
      this.rTeam[slot] = r.teamIndex;
      this.rX[slot] = r.x;
      this.rY[slot] = r.y;
      this.rDirect[slot] = r.direct ? 1 : 0;
      this.rTaker[slot] = r.taker;
      this.owner[slot] = state.ball.owner;
    } else {
      this.rState[slot] = -1;
    }
    this.head = (slot + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** @returns {number} oldest tick currently stored, or -1 if empty */
  oldestTick() {
    if (this.count === 0) return -1;
    const oldestSlot = (this.head - this.count + this.capacity) % this.capacity;
    return this.ticks[oldestSlot];
  }

  /** @returns {number} most recent tick stored, or -1 if empty */
  latestTick() {
    if (this.count === 0) return -1;
    const latestSlot = (this.head - 1 + this.capacity) % this.capacity;
    return this.ticks[latestSlot];
  }

  /**
   * Finds the stored frame for `tick`, or `null` if evicted/absent.
   * @param {number} tick
   * @returns {{snapshot: Float64Array, tick: number, eventStart: number, eventEnd: number} | null}
   */
  frameAt(tick) {
    const slot = this.#slotOf(tick);
    if (slot < 0) return null;
    return {
      snapshot: this.data.subarray(slot * SNAP_LEN, (slot + 1) * SNAP_LEN),
      tick,
      eventStart: this.eventStarts[slot],
      eventEnd: this.eventEnds[slot],
    };
  }

  /**
   * What the pitch draws with the frame of `tick`: its restart and ball carrier. A frame stored without the
   * engine state (or evicted) falls back to the snapshot's dead-ball flag, with no set piece and no carrier.
   * @param {number} tick
   * @param {Float64Array} [snapshot] the frame's snapshot, for the fallback
   * @returns {{restart: ShownRestart, owner: number}}
   */
  viewAt(tick, snapshot) {
    const slot = this.#slotOf(tick);
    if (slot < 0 || this.rState[slot] < 0) {
      const dead = snapshot !== undefined && (snapshot[5] & FLAG_DEAD_BALL) !== 0;
      return { restart: { state: dead ? 'DEAD_BALL' : 'IN_PLAY', kind: '', teamIndex: -1, x: 0, y: 0, direct: false, taker: -1 }, owner: -1 };
    }
    return {
      restart: {
        state: this.names[this.rState[slot]],
        kind: this.names[this.rKind[slot]],
        teamIndex: this.rTeam[slot],
        x: this.rX[slot],
        y: this.rY[slot],
        direct: this.rDirect[slot] === 1,
        taker: this.rTaker[slot],
      },
      owner: this.owner[slot],
    };
  }

  /** @param {number} tick @returns {number} the slot holding `tick`, or -1 */
  #slotOf(tick) {
    for (let i = 0; i < this.count; i++) {
      const slot = (this.head - 1 - i + this.capacity) % this.capacity;
      if (this.ticks[slot] === tick) return slot;
    }
    return -1;
  }

  /** @param {string} name @returns {number} */
  #code(name) {
    let c = this.names.indexOf(name);
    if (c < 0) {
      c = this.names.length;
      this.names.push(name);
    }
    return c;
  }

  clear() {
    this.head = 0;
    this.count = 0;
    this.ticks.fill(-1);
    this.rState.fill(-1);
  }
}
