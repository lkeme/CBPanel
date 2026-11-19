/**
 * The wrapper label is the only switch between the two channels, and it is hidden on purpose: no
 * tooltip, no hover, no button role. A single click must therefore never move the running channel —
 * the whole sequence is the guard, for unlocking as much as for switching.
 *
 * The counter is passed in and returned rather than kept here so the click path stays a plain
 * function of its state, and so a click that does not reach the threshold cannot have moved anything.
 */
export const WRAPPER_GESTURE_CLICKS = 7;

/** Returns the new count and whether this click completed a sequence. */
export function countWrapperGesture(current: number): { clicks: number; fired: boolean } {
  const clicks = current + 1;
  return clicks >= WRAPPER_GESTURE_CLICKS
    ? { clicks: 0, fired: true }
    : { clicks, fired: false };
}
