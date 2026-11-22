/**
 * Match persistence & deterministic resume (design §20, item 55).
 *
 * Saves `{schemaVersion, engineVersion, configHash, config, input, commandLog,
 * tick, stateHash, playbackState, mode}` under `freefoot.match.v1`.
 * Resume verifies schema/engine versions and config SHA-256, re-simulates via
 * `MatchEngine.replay`, and checks `stateHash`.
 */
import { ENGINE_VERSION, MatchEngine } from '../engine/MatchEngine.js';
import { canonicalJson, sha256Hex } from '../shared/canonicalJson.js';

export const SAVE_KEY = 'freefoot.match.v1';
export const SCHEMA_VERSION = 1;

/**
 * Builds the serialisable save / repro record from a live controller (design §20).
 * @param {any} controller
 */
export function buildSaveRecord(controller) {
  return {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    configHash: controller.input.configHash,
    config: controller.config,
    input: controller.input,
    commandLog: controller.engine.getCommandLog(),
    tick: controller.engine.tick,
    stateHash: controller.engine.hash(),
    playbackState: controller.playbackState,
    mode: controller.mode,
  };
}

export class Persistence {
  /**
   * @param {{storage: import('./storage.js').StorageAdapter, app?: any}} opts
   */
  constructor({ storage, app = null }) {
    this.storage = storage;
    this.app = app;
    this.lastSavedTick = -1;
    /** @type {Array<() => void>} */
    this.cleanups = [];
  }

  /**
   * Saves the current controller state unless `tick` has not changed since the
   * last save (design §20). Starts synchronously inside lifecycle handlers.
   * @param {any} controller
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<boolean>} true if a write was issued
   */
  save(controller, { force = false } = {}) {
    const tick = controller.engine.tick;
    if (!force && tick === this.lastSavedTick) return Promise.resolve(false);
    this.lastSavedTick = tick;
    const record = buildSaveRecord(controller);
    return this.storage.set(SAVE_KEY, JSON.stringify(record)).then(() => true);
  }

  /** Deletes the saved match record (called at full time or discard). */
  clear() {
    this.lastSavedTick = -1;
    return this.storage.remove(SAVE_KEY);
  }

  /** @returns {Promise<any | null>} */
  async loadRaw() {
    const raw = await this.storage.get(SAVE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Verifies and resumes a saved match record by re-simulating via
   * `MatchEngine.replay`. On any mismatch, discards the record and returns a
   * typed reason code.
   * @param {any} [record]
   * @param {{onProgress?: (pct: number) => void}} [opts]
   * @returns {Promise<{ok: true, engine: MatchEngine, events: any[], record: any, playbackState: string, mode: string} | {ok: false, reason: 'NO_SAVE' | 'SCHEMA_MISMATCH' | 'ENGINE_MISMATCH' | 'CONFIG_HASH_MISMATCH' | 'STATE_HASH_MISMATCH'}>}
   */
  async resume(record, { onProgress } = {}) {
    const rec = record ?? (await this.loadRaw());
    if (!rec) return { ok: false, reason: 'NO_SAVE' };
    if (rec.schemaVersion !== SCHEMA_VERSION) {
      await this.clear();
      return { ok: false, reason: 'SCHEMA_MISMATCH' };
    }
    if (rec.engineVersion !== ENGINE_VERSION) {
      await this.clear();
      return { ok: false, reason: 'ENGINE_MISMATCH' };
    }
    const computedHash = await sha256Hex(canonicalJson(rec.config));
    if (computedHash !== rec.configHash) {
      await this.clear();
      return { ok: false, reason: 'CONFIG_HASH_MISMATCH' };
    }

    onProgress?.(0);
    const { engine, events } = MatchEngine.replay(rec.input, rec.config, rec.commandLog ?? [], rec.tick);
    onProgress?.(1);

    if (engine.hash() !== rec.stateHash) {
      await this.clear();
      return { ok: false, reason: 'STATE_HASH_MISMATCH' };
    }

    // A saved highlight pause resumes as PAUSED (design §20).
    const playbackState = rec.playbackState === 'PAUSED_HIGHLIGHT' ? 'PAUSED' : (rec.playbackState ?? 'PAUSED');
    return { ok: true, engine, events, record: rec, playbackState, mode: rec.mode ?? 'full' };
  }

  /**
   * Attaches browser `visibilitychange` and `@capacitor/app` `pause` /
   * `backButton` listeners (design §20).
   * @param {{getController: () => any, onBackButton?: () => void}} hooks
   */
  attachLifecycle({ getController, onBackButton }) {
    if (typeof document !== 'undefined') {
      const onVis = () => {
        if (document.visibilityState === 'hidden') {
          const ctrl = getController();
          if (ctrl && ctrl.playbackState !== 'FULL_TIME') {
            ctrl.pause();
            void this.save(ctrl);
          }
        }
      };
      document.addEventListener('visibilitychange', onVis);
      this.cleanups.push(() => document.removeEventListener('visibilitychange', onVis));
    }
    if (this.app?.addListener) {
      const pausePromise = this.app.addListener('pause', () => {
        const ctrl = getController();
        if (ctrl && ctrl.playbackState !== 'FULL_TIME') {
          ctrl.pause();
          void this.save(ctrl);
        }
      });
      this.cleanups.push(() => {
        void Promise.resolve(pausePromise).then((h) => h?.remove?.());
      });
      if (onBackButton) {
        const backPromise = this.app.addListener('backButton', onBackButton);
        this.cleanups.push(() => {
          void Promise.resolve(backPromise).then((h) => h?.remove?.());
        });
      }
    }
  }

  detachLifecycle() {
    for (const fn of this.cleanups) fn();
    this.cleanups.length = 0;
  }
}
