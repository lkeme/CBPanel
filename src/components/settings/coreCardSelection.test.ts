import assert from "node:assert/strict";
import test from "node:test";

import { resolveCoreCard } from "./coreCardSelection";

test("a stored card survives a reopen without following the running channel", () => {
  assert.equal(resolveCoreCard("official", { unlocked: true, activeChannel: "official" }), "official");
  assert.equal(resolveCoreCard("private", { unlocked: true, activeChannel: "official" }), "private");
  assert.equal(resolveCoreCard("private", { unlocked: true, activeChannel: "private" }), "private");
});

// The stored choice is a view preference, so it can never reveal the private card before the card has
// been unlocked; the running channel is the only card the panel may show then.
test("a stored private card cannot unlock anything", () => {
  assert.equal(resolveCoreCard("private", { unlocked: false, activeChannel: "official" }), "official");
  assert.equal(resolveCoreCard("private", { unlocked: false, activeChannel: "private" }), "private");
});

test("no stored choice, or one that is not a channel, falls back to the running channel", () => {
  for (const stored of [undefined, null, "", "third-party", 1, {}]) {
    assert.equal(resolveCoreCard(stored, { unlocked: true, activeChannel: "official" }), "official", String(stored));
    assert.equal(resolveCoreCard(stored, { unlocked: true, activeChannel: "private" }), "private", String(stored));
  }
});
