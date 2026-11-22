/**
 * FNV-1a 32-bit over the canonical tagged byte encoding of a plain value
 * (design §4, item 38). Tags: 0 null, 1 false, 2 true, 3 number (float64
 * little-endian, -0 written as +0), 4 string (uint32 length of the UTF-8
 * bytes, then the bytes), 5 array (uint32 length, items), 6 object (uint32
 * key count, then key string and value pairs in key order).
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const view = new DataView(new ArrayBuffer(8));
const view8 = new Uint8Array(view.buffer);

let h = FNV_OFFSET;

/** @param {number} byte */
function put(byte) {
  h = Math.imul(h ^ byte, FNV_PRIME) >>> 0;
}

/** @param {number} n */
function putUint32(n) {
  put(n & 0xff);
  put((n >>> 8) & 0xff);
  put((n >>> 16) & 0xff);
  put((n >>> 24) & 0xff);
}

/** @param {number} cp */
function utf8Length(cp) {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** @param {string} s */
function putString(s) {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo < 0xe000) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    bytes += utf8Length(cp);
  }
  putUint32(bytes);
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo < 0xe000) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) {
      put(cp);
    } else if (cp < 0x800) {
      put(0xc0 | (cp >> 6));
      put(0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      put(0xe0 | (cp >> 12));
      put(0x80 | ((cp >> 6) & 0x3f));
      put(0x80 | (cp & 0x3f));
    } else {
      put(0xf0 | (cp >> 18));
      put(0x80 | ((cp >> 12) & 0x3f));
      put(0x80 | ((cp >> 6) & 0x3f));
      put(0x80 | (cp & 0x3f));
    }
  }
}

/**
 * @param {unknown} v
 * @param {string} path for error messages
 */
function walk(v, path) {
  if (v === null) {
    put(0);
  } else if (v === false) {
    put(1);
  } else if (v === true) {
    put(2);
  } else if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`hash: non-finite number at ${path}`);
    put(3);
    view.setFloat64(0, v === 0 ? 0 : v, true);
    for (let i = 0; i < 8; i++) put(view8[i]);
  } else if (typeof v === 'string') {
    put(4);
    putString(v);
  } else if (Array.isArray(v)) {
    put(5);
    putUint32(v.length);
    for (let i = 0; i < v.length; i++) walk(v[i], `${path}[${i}]`);
  } else if (typeof v === 'object' && v !== undefined) {
    const record = /** @type {Record<string, unknown>} */ (v);
    const keys = Object.keys(record);
    put(6);
    putUint32(keys.length);
    for (let i = 0; i < keys.length; i++) {
      put(4);
      putString(keys[i]);
      walk(record[keys[i]], `${path}.${keys[i]}`);
    }
  } else {
    throw new Error(`hash: unsupported value at ${path}`);
  }
}

/**
 * FNV-1a hash of the canonical encoding of `value`.
 * @param {unknown} value plain JSON-like data (no undefined, NaN or Infinity)
 * @returns {number} uint32
 */
export function hashValue(value) {
  h = FNV_OFFSET;
  walk(value, '$');
  return h >>> 0;
}

/**
 * Hash as 8 lowercase hex digits.
 * @param {unknown} value
 * @returns {string}
 */
export function hashHex(value) {
  return hashValue(value).toString(16).padStart(8, '0');
}
