/**
 * Locale state & UI string lookup (design §16, item 57).
 * Defaults to `pt-PT`, supports `en-GB`, notifies change listeners, and
 * persists the last choice via the injected storage adapter.
 */

const STORAGE_KEY = 'freefoot.locale.v1';

export class LocaleManager {
  /**
   * @param {{uiStrings: Record<string, any>, storage?: {get: (k: string) => Promise<string | null>, set: (k: string, v: string) => Promise<void>}, initial?: 'pt-PT' | 'en-GB'}} opts
   */
  constructor({ uiStrings, storage, initial = 'pt-PT' }) {
    this.uiStrings = uiStrings;
    this.storage = storage ?? null;
    /** @type {'pt-PT' | 'en-GB'} */
    this.locale = initial;
    /** @type {Set<(loc: 'pt-PT' | 'en-GB') => void>} */
    this.listeners = new Set();
  }

  async init() {
    if (!this.storage) return this.locale;
    const saved = await this.storage.get(STORAGE_KEY);
    if (saved === 'pt-PT' || saved === 'en-GB') {
      this.locale = saved;
    }
    return this.locale;
  }

  /** @returns {'pt-PT' | 'en-GB'} */
  getLocale() {
    return this.locale;
  }

  /** @param {'pt-PT' | 'en-GB'} next */
  setLocale(next) {
    if (next !== 'pt-PT' && next !== 'en-GB') return;
    if (next === this.locale) return;
    this.locale = next;
    void this.storage?.set(STORAGE_KEY, next);
    for (const fn of this.listeners) fn(next);
  }

  toggle() {
    this.setLocale(this.locale === 'pt-PT' ? 'en-GB' : 'pt-PT');
  }

  /**
   * @param {(loc: 'pt-PT' | 'en-GB') => void} fn
   * @returns {() => void} unsubscribe
   */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Looks up a dotted UI string key like `buttons.play` or `errors.NO_SUBS_LEFT`.
   * @param {string} key
   * @param {Record<string, string | number>} [vars]
   * @returns {string}
   */
  t(key, vars) {
    const [group, name] = key.split('.');
    let raw = this.uiStrings[this.locale]?.[group]?.[name] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        raw = raw.replaceAll(`{${k}}`, String(v));
      }
    }
    return raw;
  }
}
