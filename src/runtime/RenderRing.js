/**
 * Preallocated RenderSnapshot ring buffer (design §14, item 54).
 * Stores up to `capacity` frames (default 500) of `SNAP_LEN` float64s plus
 * each frame's tick and index range into the controller's event log.
 */
import { SNAP_LEN } from '../engine/MatchEngine.js';

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
    this.head = 0;
    this.count = 0;
  }

  /**
   * Pushes one RenderSnapshot into the ring.
   * @param {Float64Array} snapshot
   * @param {number} tick
   * @param {number} eventStart
   * @param {number} eventEnd
   */
  push(snapshot, tick, eventStart, eventEnd) {
    const slot = this.head;
    this.data.set(snapshot, slot * SNAP_LEN);
    this.ticks[slot] = tick;
    this.eventStarts[slot] = eventStart;
    this.eventEnds[slot] = eventEnd;
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
    for (let i = 0; i < this.count; i++) {
      const slot = (this.head - 1 - i + this.capacity) % this.capacity;
      if (this.ticks[slot] === tick) {
        return {
          snapshot: this.data.subarray(slot * SNAP_LEN, (slot + 1) * SNAP_LEN),
          tick,
          eventStart: this.eventStarts[slot],
          eventEnd: this.eventEnds[slot],
        };
      }
    }
    return null;
  }

  clear() {
    this.head = 0;
    this.count = 0;
    this.ticks.fill(-1);
  }
}
