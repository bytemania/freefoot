/**
 * Storage adapters (design item 54a).
 * Keeps `@capacitor/preferences` out of Node runtime tests while providing a
 * uniform async `{get, set, remove}` interface.
 */

/**
 * @typedef {{
 *   get: (key: string) => Promise<string | null>,
 *   set: (key: string, value: string) => Promise<void>,
 *   remove: (key: string) => Promise<void>,
 * }} StorageAdapter
 */

/**
 * In-memory storage for Node unit tests.
 * @returns {StorageAdapter}
 */
export function memoryStorage() {
  /** @type {Map<string, string>} */
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? /** @type {string} */ (map.get(key)) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
  };
}

/**
 * Browser / Capacitor storage adapter. Uses `@capacitor/preferences` when
 * available, falling back cleanly to `localStorage`.
 * @returns {StorageAdapter}
 */
export function capacitorStorage() {
  return {
    async get(key) {
      try {
        const { Preferences } = await import('@capacitor/preferences');
        const res = await Preferences.get({ key });
        return res.value ?? null;
      } catch {
        try {
          return window.localStorage.getItem(key);
        } catch {
          return null;
        }
      }
    },
    async set(key, value) {
      try {
        const { Preferences } = await import('@capacitor/preferences');
        await Preferences.set({ key, value });
      } catch {
        try {
          window.localStorage.setItem(key, value);
        } catch {
          // ignore quota/private mode errors
        }
      }
    },
    async remove(key) {
      try {
        const { Preferences } = await import('@capacitor/preferences');
        await Preferences.remove({ key });
      } catch {
        try {
          window.localStorage.removeItem(key);
        } catch {
          // ignore
        }
      }
    },
  };
}
