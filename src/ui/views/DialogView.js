/**
 * Modal dialogs (design §14, §20, item 68a):
 * Resume match, Leave match, Half-time, Full-time result, Discard reason, and
 * the selectable `<textarea>` copy fallback (bench JSON).
 */
import { View } from './View.js';

const PARTIAL = `
<div class="dialog-backdrop is-hidden" role="dialog" aria-modal="true">
  <div class="dialog-card">
    <h3 class="dialog-title" id="dlg-title"></h3>
    <div class="dialog-body" id="dlg-body"></div>
    <div class="dialog-actions" id="dlg-actions"></div>
  </div>
</div>
`;

export class DialogView extends View {
  constructor() {
    super(PARTIAL);
  }

  /**
   * Shows a modal dialog with arbitrary title, body HTML/text, and buttons.
   * @param {{title: string, bodyHtml: string, actions: Array<{label: string, primary?: boolean, onClick: () => void}>}} opts
   */
  show({ title, bodyHtml, actions }) {
    if (!this.root) return;
    const backdrop = this.root.querySelector('.dialog-backdrop');
    const titleEl = this.root.querySelector('#dlg-title');
    const bodyEl = this.root.querySelector('#dlg-body');
    const actionsEl = this.root.querySelector('#dlg-actions');
    if (!backdrop || !titleEl || !bodyEl || !actionsEl) return;

    titleEl.textContent = title;
    bodyEl.innerHTML = bodyHtml;
    actionsEl.innerHTML = '';
    for (const act of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = act.primary ? 'btn btn-primary' : 'btn';
      btn.textContent = act.label;
      btn.addEventListener('click', () => {
        this.hide();
        act.onClick();
      });
      actionsEl.appendChild(btn);
    }
    backdrop.classList.remove('is-hidden');
  }

  /**
   * Shows the selectable `<textarea>` fallback when clipboard copy fails (item 70a).
   * @param {string} title
   * @param {string} jsonText
   * @param {string} closeLabel
   */
  showCopyFallback(title, jsonText, closeLabel = 'Close') {
    const escaped = jsonText.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    this.show({
      title,
      bodyHtml: `<textarea class="repro-textarea" readonly rows="10">${escaped}</textarea>`,
      actions: [{ label: closeLabel, primary: true, onClick: () => {} }],
    });
    const ta = /** @type {HTMLTextAreaElement | null} */ (this.root?.querySelector('.repro-textarea'));
    ta?.select();
  }

  hide() {
    this.root?.querySelector('.dialog-backdrop')?.classList.add('is-hidden');
  }
}
