/**
 * Bottom-sheet / collapsible drawer helper (design item 62).
 */
export class Drawer {
  /**
   * @param {HTMLElement} el
   */
  constructor(el) {
    this.el = el;
    this.openState = false;
  }

  open() {
    this.openState = true;
    this.el.classList.add('is-open');
    this.el.setAttribute('aria-hidden', 'false');
  }

  close() {
    this.openState = false;
    this.el.classList.remove('is-open');
    this.el.setAttribute('aria-hidden', 'true');
  }

  toggle() {
    if (this.openState) this.close();
    else this.open();
  }
}
