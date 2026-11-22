/**
 * Cross-platform clipboard copy helper (design item 70a).
 * Uses `@capacitor/clipboard` on native, `navigator.clipboard.writeText` on
 * web, and invokes `onFallback(text)` (DialogView `<textarea>`) on any failure.
 */

/**
 * @param {string} text
 * @param {{onFallback?: (text: string) => void}} [opts]
 * @returns {Promise<boolean>} true if copied directly, false if fell back
 */
export async function copyText(text, { onFallback } = {}) {
  try {
    const { Clipboard } = await import('@capacitor/clipboard');
    await Clipboard.write({ string: text });
    return true;
  } catch {
    // Fall through to Web Clipboard API
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to selectable textarea fallback
  }
  onFallback?.(text);
  return false;
}
