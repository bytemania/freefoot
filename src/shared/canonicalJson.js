/**
 * Canonical JSON and SHA-256 helpers shared by Node scripts and the browser.
 * The browser's config-hash check must produce the same bytes as the build.
 */

/**
 * Stringifies `value` with object keys sorted recursively (by UTF-16 code
 * unit order, no locale). Like `JSON.stringify`, `undefined` object members
 * are skipped and `undefined` array items become `null`. Non-finite numbers,
 * bigints, functions and symbols are rejected.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return stringify(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringify(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? 'null' : stringify(item))).join(',')}]`;
      }
      const record = /** @type {Record<string, unknown>} */ (value);
      const parts = [];
      for (const key of Object.keys(record).sort()) {
        if (record[key] === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${stringify(record[key])}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
  }
}

/**
 * SHA-256 of the UTF-8 bytes of `text`, as lowercase hex. Uses `node:crypto`
 * in Node and `crypto.subtle` in the browser, so it is async in both.
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function sha256Hex(text) {
  if (typeof process !== 'undefined' && process.versions?.node) {
    // A variable specifier keeps bundlers from trying to resolve a Node builtin.
    const specifier = 'node:crypto';
    const { createHash } = await import(/* @vite-ignore */ specifier);
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
