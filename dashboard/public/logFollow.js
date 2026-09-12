/**
 * Sticky-bottom log follow for polling refresh.
 * Stickiness is tracked by scroll events (not by reading position right
 * before text replace), so a failed first pin does not permanently unpin.
 */

/**
 * @param {{ scrollTop: number, scrollHeight: number, clientHeight: number }} el
 * @param {number} [thresholdPx]
 */
export function isScrolledToBottom(el, thresholdPx = 24) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
}

/**
 * @param {{ thresholdPx?: number }} [options]
 */
export function createLogFollowState(options = {}) {
  const thresholdPx = options.thresholdPx ?? 24;
  let stickToBottom = true;
  let ignoreScroll = false;

  return {
    get stickToBottom() {
      return stickToBottom;
    },

    forceStick() {
      stickToBottom = true;
    },

    /**
     * @param {{ scrollTop: number, scrollHeight: number, clientHeight: number }} el
     */
    onScroll(el) {
      if (ignoreScroll) return;
      stickToBottom = isScrolledToBottom(el, thresholdPx);
    },

    /**
     * Replace log text and pin to bottom when sticky.
     * @param {{ textContent: string, scrollTop: number, scrollHeight: number }} el
     * @param {string} text
     * @param {{
     *   forceBottom?: boolean,
     *   afterLayout?: (fn: () => void) => void
     * }} [opts]
     * @returns {boolean} whether a bottom pin was scheduled
     */
    setText(el, text, opts = {}) {
      if (opts.forceBottom) stickToBottom = true;
      const shouldStick = stickToBottom;

      // textContent 代入で scroll が同期発火しても sticky を落とさない
      ignoreScroll = shouldStick;
      el.textContent = text;
      if (!shouldStick) {
        ignoreScroll = false;
        return false;
      }

      const afterLayout =
        opts.afterLayout ||
        ((fn) => {
          fn();
        });

      const pin = () => {
        el.scrollTop = el.scrollHeight;
      };
      pin();
      afterLayout(() => {
        pin();
        afterLayout(() => {
          pin();
          ignoreScroll = false;
        });
      });
      return true;
    }
  };
}
