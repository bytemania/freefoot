/**
 * The seed of the match the app plays: a fresh random one each time, unless the page URL names one with
 * `?seed=<n>` (an integer 0 to 4294967295), so a match can be replayed exactly, e.g. by the end-to-end tests.
 * Not to be confused with the `#seed=` debug viewer route.
 */

/** Largest seed accepted (the engine keeps seeds as unsigned 32-bit integers). */
export const MAX_SEED = 0xffffffff;

/**
 * @param {string} search the URL query string (`location.search`), e.g. `?seed=1234`
 * @param {() => number} random a fresh random seed, for when the URL names none (or an invalid one)
 * @returns {number}
 */
export function matchSeedFrom(search, random) {
  const raw = new URLSearchParams(search).get('seed');
  if (raw !== null && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    if (Number.isSafeInteger(n) && n <= MAX_SEED) return n;
  }
  return random();
}
