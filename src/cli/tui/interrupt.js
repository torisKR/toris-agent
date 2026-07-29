/**
 * What ctrl-c means, as a pure state machine.
 *
 * A coding agent has three plausible reactions to an interrupt and picking the
 * wrong one is infuriating: killing the process mid-answer loses the
 * transcript, while ignoring it strands the operator inside a runaway turn.
 * The rule here is the one every modern REPL converged on — interrupt the work
 * in front of you first, and only quit when there is nothing left to interrupt
 * and the operator insists twice.
 */

/** Two presses further apart than this are treated as unrelated. */
export const DOUBLE_PRESS_WINDOW_MS = 2000;

/**
 * @typedef {'cancel'|'clear'|'confirm'|'exit'} InterruptAction
 */

/**
 * @param {{windowMs?:number, now?:() => number}} [options]
 * @returns {{press: (state:{isGenerating?:boolean, hasInput?:boolean}) => InterruptAction}}
 */
export function createInterruptPolicy({ windowMs = DOUBLE_PRESS_WINDOW_MS, now = Date.now } = {}) {
  let lastBarePressAt = null;

  return {
    /**
     * Decide what this press should do.
     * @param {{isGenerating?:boolean, hasInput?:boolean}} state
     * @returns {InterruptAction}
     */
    press({ isGenerating = false, hasInput = false } = {}) {
      // Interrupting work or a half-typed line is never a request to quit, so
      // it also cannot count as the first half of a double press.
      if (isGenerating) {
        lastBarePressAt = null;
        return 'cancel';
      }
      if (hasInput) {
        lastBarePressAt = null;
        return 'clear';
      }

      const at = now();
      const isRepeat = lastBarePressAt !== null && at - lastBarePressAt <= windowMs;
      lastBarePressAt = isRepeat ? null : at;
      return isRepeat ? 'exit' : 'confirm';
    },
  };
}
