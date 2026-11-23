/**
 * Minimal DOM stand-in for view tests: elements keep textContent, innerHTML,
 * attributes and classes; `querySelector('#id')` returns one element per id.
 */
export function fakeElement() {
  const classes = new Set();
  /** @type {Record<string, string>} */
  const attrs = {};
  return {
    textContent: '',
    innerHTML: '',
    disabled: false,
    attrs,
    classList: {
      toggle: (/** @type {string} */ c, /** @type {boolean} */ on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (/** @type {string} */ c) => classes.has(c),
      add: (/** @type {string} */ c) => classes.add(c),
      remove: (/** @type {string} */ c) => classes.delete(c),
    },
    setAttribute: (/** @type {string} */ k, /** @type {string} */ v) => {
      attrs[k] = v;
    },
    getAttribute: (/** @type {string} */ k) => attrs[k] ?? null,
  };
}

/** A root whose querySelector creates elements on demand. */
export function fakeRoot() {
  /** @type {Map<string, ReturnType<typeof fakeElement>>} */
  const els = new Map();
  const root = /** @type {any} */ (fakeElement());
  root.querySelector = (/** @type {string} */ sel) => {
    if (!els.has(sel)) els.set(sel, fakeElement());
    return els.get(sel);
  };
  root.querySelectorAll = () => [];
  root.addEventListener = () => {};
  return root;
}
