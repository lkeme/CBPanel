import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { type BrowserProfile, defaultProfile } from "../../src/shared/profile";
import {
  applyPlaywrightInitScripts,
  initScriptsForProfile,
} from "./sessionService";

// Both markers come from the scripts' own bodies: the watermark node id and the interface the voices
// script hooks. They are page-visible surface, so asserting on them also pins "the feature is off"
// to "the script is absent", not "the script is empty".
const WATERMARK_MARKER = "cbpanel-watermark";
const VOICES_MARKER = "SpeechSynthesis";

function profileWith(
  runtime: Partial<BrowserProfile["runtime"]>,
  fingerprint: Partial<BrowserProfile["fingerprint"]> = {},
): BrowserProfile {
  const base = defaultProfile();
  return { ...base, runtime: { ...base.runtime, ...runtime }, fingerprint: { ...base.fingerprint, ...fingerprint } };
}

test("the injected scripts keep the watermark first and the voices shaping second", () => {
  const scripts = initScriptsForProfile(profileWith({ watermark: "banner", voices: true }));

  assert.equal(scripts.length, 2);
  // Order matters: the generated launch snippet mirrors these calls one for one.
  assert.ok(scripts[0].includes(WATERMARK_MARKER), "the watermark must be the first script");
  assert.equal(scripts[0].includes(VOICES_MARKER), false);
  assert.ok(scripts[1].includes(VOICES_MARKER), "the voices shaping must be the second script");
  assert.equal(scripts[1].includes(WATERMARK_MARKER), false);
});

test("a disabled feature yields no script at all, and both disabled yields none", () => {
  const voicesOnly = initScriptsForProfile(profileWith({ watermark: "off", voices: true }));
  assert.equal(voicesOnly.length, 1);
  assert.ok(voicesOnly[0].includes(VOICES_MARKER));
  assert.equal(voicesOnly[0].includes(WATERMARK_MARKER), false);

  const watermarkOnly = initScriptsForProfile(profileWith({ watermark: "enhanced", voices: false }));
  assert.equal(watermarkOnly.length, 1);
  assert.ok(watermarkOnly[0].includes(WATERMARK_MARKER));
  assert.equal(watermarkOnly[0].includes(VOICES_MARKER), false);

  assert.deepEqual(initScriptsForProfile(profileWith({ watermark: "off", voices: false })), []);
});

test("the fingerprint seed reaches the voices script", () => {
  const first = initScriptsForProfile(profileWith({ watermark: "off", voices: true }, { seed: "seed-one" }));
  const second = initScriptsForProfile(profileWith({ watermark: "off", voices: true }, { seed: "seed-two" }));

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0], second[0]);
});

test("a profile whose voices field is missing still gets the shaping", () => {
  // Normalization is mergeProfile's job; if a missing value ever reaches the launcher, the builder's
  // own default is on, because leaving the host list alone is the anti-leak gap.
  const scripts = initScriptsForProfile(
    profileWith({ watermark: "off", voices: undefined as unknown as boolean }),
  );

  assert.equal(scripts.length, 1);
  assert.ok(scripts[0].includes(VOICES_MARKER));
});

// The context surface the extracted appliers use, taken from the applier itself so the fakes cannot
// drift from the production signature. Playwright resolves `addInitScript` to a disposal handle; the
// appliers drop it, and the fake still implements the full contract.
type PlaywrightInitScriptContext = Parameters<typeof applyPlaywrightInitScripts>[0];
type PlaywrightInitScriptDisposable = Awaited<ReturnType<PlaywrightInitScriptContext["addInitScript"]>>;

function disposable(): PlaywrightInitScriptDisposable {
  return {
    dispose: async () => undefined,
    [Symbol.asyncDispose]: async () => undefined,
  };
}

test("Playwright injection installs exactly the profile's scripts, in order", async () => {
  const profile = profileWith({ watermark: "banner", voices: true });
  const installed: string[] = [];
  const context: PlaywrightInitScriptContext = {
    addInitScript: async (script: string) => {
      installed.push(script);
      return disposable();
    },
  };

  await applyPlaywrightInitScripts(context, profile);

  assert.deepEqual(installed, initScriptsForProfile(profile));
  assert.equal(installed.length, 2);
});

test("Playwright injection leaves the API untouched when both features are off", async () => {
  let calls = 0;
  const context: PlaywrightInitScriptContext = {
    addInitScript: async () => {
      calls += 1;
      return disposable();
    },
  };

  await applyPlaywrightInitScripts(context, profileWith({ watermark: "off", voices: false }));

  assert.equal(calls, 0);
});

test("the launcher still calls the extracted injection unit", () => {
  const source = fs.readFileSync(new URL("./sessionService.ts", import.meta.url), "utf8");

  assert.equal(
    source.match(/await applyPlaywrightInitScripts\(context, profile\);/g)?.length,
    1,
    "the launcher must await applyPlaywrightInitScripts(context, profile)",
  );
  assert.equal(
    source.includes("applyPuppeteerInitScripts"),
    false,
    "no Puppeteer init-script path may remain",
  );
});
