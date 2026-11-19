import assert from "node:assert/strict";
import test from "node:test";

import { countWrapperGesture, WRAPPER_GESTURE_CLICKS } from "./coreWrapperGesture";

test("a single click never completes the gesture", () => {
  assert.deepEqual(countWrapperGesture(0), { clicks: 1, fired: false });
});

test("the gesture fires exactly on the last click of the sequence, and resets", () => {
  let state = { clicks: 0, fired: false };
  for (let index = 1; index < WRAPPER_GESTURE_CLICKS; index += 1) {
    state = countWrapperGesture(state.clicks);
    assert.equal(state.fired, false, `click ${index} must not fire`);
  }
  state = countWrapperGesture(state.clicks);
  assert.deepEqual(state, { clicks: 0, fired: true });
  // The next sequence starts from zero, so an accidental extra click cannot carry over.
  assert.deepEqual(countWrapperGesture(state.clicks), { clicks: 1, fired: false });
});
