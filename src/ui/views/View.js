/**
 * Base UI view (design §15, item 62). Every view implements
 * `mount(rootEl)`, `update(frame)` and `destroy()`.
 */
export class View {
  /**
   * @param {string} partialHtml raw HTML string imported with `?raw`
   */
  constructor(partialHtml = '') {
    this.partialHtml = partialHtml;
    /** @type {HTMLElement | null} */
    this.root = null;
  }

  /**
   * @param {HTMLElement} rootEl
   */
  mount(rootEl) {
    this.root = rootEl;
    if (this.partialHtml) {
      this.root.innerHTML = this.partialHtml;
    }
  }

  /**
   * @param {any} _frame
   */
  // eslint-disable-next-line no-unused-vars
  update(_frame) {}

  destroy() {
    if (this.root) {
      this.root.innerHTML = '';
      this.root = null;
    }
  }
}
