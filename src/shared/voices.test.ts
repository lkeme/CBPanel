import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { buildVoicesScript, selectStableVoices, voicesSeed, type VoiceLike } from "./voices";
import { defaultProfile, mergeProfile, normalizeProfile, type BrowserProfile } from "./profile";

type TestVoice = VoiceLike & { voiceURI: string; name: string; lang: string };

// A Windows host list with the shape the runtime probes recorded: 22 entries, one engine default,
// several zh-CN voices and no macOS/Linux-only entries.
const HOST_VOICES: TestVoice[] = (
  [
    ["Microsoft David - English (United States)", "en-US", true],
    ["Microsoft Mark - English (United States)", "en-US"],
    ["Microsoft Zira - English (United States)", "en-US"],
    ["Microsoft Hazel - English (Great Britain)", "en-GB"],
    ["Microsoft Heera - English (India)", "en-IN"],
    ["Microsoft Huihui - Chinese (Simplified, PRC)", "zh-CN"],
    ["Google 普通话（中国大陆）", "zh-CN"],
    ["Microsoft Yaoyao - Chinese (Simplified, PRC)", "zh-CN"],
    ["Microsoft Kangkang - Chinese (Simplified, PRC)", "zh-CN"],
    ["Microsoft Tracy - Chinese (Traditional, Hong Kong S.A.R.)", "zh-HK"],
    ["Microsoft Hanhan - Chinese (Traditional, Taiwan)", "zh-TW"],
    ["Microsoft Ayumi - Japanese (Japan)", "ja-JP"],
    ["Microsoft Haruka - Japanese (Japan)", "ja-JP"],
    ["Microsoft Ichiro - Japanese (Japan)", "ja-JP"],
    ["Microsoft Yuna - Korean (Korea)", "ko-KR"],
    ["Microsoft Julie - French (France)", "fr-FR"],
    ["Microsoft Hortense - French (France)", "fr-FR"],
    ["Microsoft Katja - German (Germany)", "de-DE"],
    ["Microsoft Hedda - German (Germany)", "de-DE"],
    ["Microsoft Sabina - Spanish (Mexico)", "es-MX"],
    ["Microsoft Helena - Spanish (Spain)", "es-ES"],
    ["Microsoft Maria - Portuguese (Brazil)", "pt-BR"],
  ] as Array<[string, string] | [string, string, boolean]>
).map(([name, lang, isDefault]) => ({
  voiceURI: `urn:moz-tts:${name}`,
  name,
  lang,
  ...(isDefault ? { default: true } : {}),
}));

// Array.from, not map: the in-page array belongs to the sandbox realm and mapping it would keep that
// realm's Array prototype, which deepStrictEqual then rejects as a different type.
function names(voices: readonly VoiceLike[]): string[] {
  return Array.from(voices, (voice) => voice.name ?? "");
}

test("shaping only ever removes voices, never invents one", () => {
  for (const seed of [0, 1, 42069, 4294967295]) {
    for (const language of ["", "zh-CN", "en-US", "de-DE"]) {
      const kept = selectStableVoices(HOST_VOICES, seed, language);
      const label = `seed=${seed} language=${language}`;

      assert.ok(kept.length <= HOST_VOICES.length, `${label} must not grow the list`);
      const host = new Set(HOST_VOICES);
      for (const voice of kept) {
        // Reference equality: a kept entry is one of the host's own objects, not a copy or a lookalike.
        assert.ok(host.has(voice), `${label} kept ${voice.name}, which the host does not report`);
      }
      assert.equal(new Set(kept).size, kept.length, `${label} must not repeat a voice`);
      assert.ok(kept.length >= 2, `${label} must stay usable`);
    }
  }
});

test("the same seed and language always shape the same list", () => {
  assert.deepEqual(
    names(selectStableVoices(HOST_VOICES, 4242, "zh-CN")),
    names(selectStableVoices(HOST_VOICES, 4242, "zh-CN")),
  );
});

test("different seeds shape different lists", () => {
  const shaped = (seed: number) => names(selectStableVoices(HOST_VOICES, seed, "")).join("|");

  assert.notEqual(shaped(7), shaped(99));
  const distinct = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(shaped));
  assert.ok(distinct.size >= 6, `expected several distinct lists, got ${distinct.size}`);
});

test("voices matching the requested language are mandatory keeps", () => {
  const zhVoices = HOST_VOICES.filter((voice) => voice.lang === "zh-CN");
  for (const seed of [0, 3, 4242, 4294967295]) {
    const kept = selectStableVoices(HOST_VOICES, seed, "zh-CN");
    for (const voice of zhVoices) {
      assert.ok(kept.includes(voice), `seed=${seed} dropped ${voice.name}`);
    }
  }
  // The comparison is case-insensitive on both sides.
  assert.ok(names(selectStableVoices(HOST_VOICES, 17, "ZH-cn")).includes(zhVoices[0].name));
});

test("an empty language keeps no language preference", () => {
  const zhVoices = HOST_VOICES.filter((voice) => voice.lang === "zh-CN");
  const droppedSomewhere = Array.from({ length: 50 }, (_, seed) => seed).some((seed) => {
    const kept = selectStableVoices(HOST_VOICES, seed, "");
    return zhVoices.some((voice) => !kept.includes(voice));
  });
  assert.ok(droppedSomewhere, "with no locale the shaping must be free to drop foreign-language voices");
});

test("the engine default voice is always kept", () => {
  for (const seed of [0, 5, 4242, 4294967290]) {
    assert.ok(selectStableVoices(HOST_VOICES, seed, "").includes(HOST_VOICES[0]), `seed=${seed}`);
  }
});

test("lists of three voices or fewer pass through unchanged", () => {
  for (let size = 0; size <= 3; size += 1) {
    const voices = HOST_VOICES.slice(0, size);
    assert.deepEqual(selectStableVoices(voices, 999, "zh-CN"), voices);
  }
});

test("retention stays inside the seeded 70-85% band", () => {
  for (const seed of [0, 5, 424242, 4294967294]) {
    const kept = selectStableVoices(HOST_VOICES, seed, "");
    assert.ok(
      kept.length >= Math.floor((HOST_VOICES.length * 70) / 100),
      `seed=${seed} kept only ${kept.length}`,
    );
    assert.ok(
      kept.length <= Math.ceil((HOST_VOICES.length * 85) / 100),
      `seed=${seed} kept ${kept.length} of ${HOST_VOICES.length}`,
    );
  }
});

test("voicesSeed derives a stable instance seed, fingerprint seed first", () => {
  assert.equal(voicesSeed("", "profile-a"), voicesSeed("", "profile-a"));
  assert.notEqual(voicesSeed("", "profile-a"), voicesSeed("", "profile-b"));
  assert.equal(voicesSeed("42069", "profile-a"), voicesSeed("42069", "profile-b"));
  assert.equal(voicesSeed("  42069  ", "profile-a"), voicesSeed("42069", "profile-b"));
  assert.equal(voicesSeed("   ", "profile-a"), voicesSeed("", "profile-a"));
  // A profile whose id equals another profile's fingerprint seed must not share its list.
  assert.notEqual(voicesSeed("", "42069"), voicesSeed("42069", "profile-a"));
});

test("two profiles without an explicit seed still end up with different lists", () => {
  const shaped = (profileId: string) =>
    names(selectStableVoices(HOST_VOICES, voicesSeed("", profileId), "")).join("|");

  assert.notEqual(shaped("profile-a"), shaped("profile-b"));
});

test("voices shaping is off only when the profile turns it off", () => {
  assert.equal(buildVoicesScript(42069, "zh-CN", false), "");
  assert.equal(buildVoicesScript(42069, "zh-CN", false).includes("getVoices"), false);
  assert.notEqual(buildVoicesScript(42069, "zh-CN", true), "");
});

// The script is a serialized copy of the module's own algorithm, so these run it inside a minimal
// page realm and compare it to what selectStableVoices computes; a drift between the two fails here.

type VoicesPage = {
  voices: () => TestVoice[];
  evaluate: <Value>(source: string) => Value;
};

function createVoicesPage(hostVoices: TestVoice[]): VoicesPage {
  const sandbox: Record<string, unknown> = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(
    `function SpeechSynthesis() {}
     var HOST_VOICES = ${JSON.stringify(hostVoices)};
     Object.defineProperty(SpeechSynthesis.prototype, "getVoices", {
       value: function getVoices() { return HOST_VOICES; },
       writable: true,
       enumerable: false,
       configurable: true
     });
     window.SpeechSynthesis = SpeechSynthesis;`,
    sandbox,
  );
  return {
    voices: () => vm.runInContext("new SpeechSynthesis().getVoices()", sandbox) as TestVoice[],
    evaluate: <Value>(source: string) => vm.runInContext(source, sandbox) as Value,
  };
}

function runVoicesScript(script: string, hostVoices: TestVoice[] = HOST_VOICES): VoicesPage {
  const page = createVoicesPage(hostVoices);
  page.evaluate(script);
  return page;
}

test("the running script returns exactly the subset the module computes", () => {
  const seed = voicesSeed("42069", "profile-a");
  const page = runVoicesScript(buildVoicesScript(seed, "zh-CN"));

  assert.deepEqual(names(page.voices()), names(selectStableVoices(HOST_VOICES, seed, "zh-CN")));
  // The screenshot the panel shows and the page's own answer come from one implementation.
  assert.deepEqual(
    names(runVoicesScript(buildVoicesScript(7, "")).voices()),
    names(selectStableVoices(HOST_VOICES, 7, "")),
  );
});

test("the replaced method still reports itself as native", () => {
  const page = runVoicesScript(buildVoicesScript(7, ""));
  page.evaluate("function untouched(a) { return a; }");

  assert.equal(
    page.evaluate("Function.prototype.toString.call(new SpeechSynthesis().getVoices)"),
    "function getVoices() { [native code] }",
  );
  assert.equal(
    page.evaluate("new SpeechSynthesis().getVoices.toString()"),
    "function getVoices() { [native code] }",
  );
  // The proxy itself must report as native too, or the proxy's own fingerprint betrays the masking.
  assert.equal(
    page.evaluate("Function.prototype.toString.call(Function.prototype.toString)"),
    "function toString() { [native code] }",
  );
  assert.equal(page.evaluate("Function.prototype.toString.length"), 0);
  assert.equal(page.evaluate("Function.prototype.toString.name"), "toString");
  assert.equal(page.evaluate("new SpeechSynthesis().getVoices.length"), 0);
  assert.equal(page.evaluate("new SpeechSynthesis().getVoices.name"), "getVoices");
});

test("every other function keeps its real source and behavior", () => {
  const page = runVoicesScript(buildVoicesScript(7, ""));

  assert.equal(
    page.evaluate("function untouched(a) { return a; } Function.prototype.toString.call(untouched)"),
    "function untouched(a) { return a; }",
  );
  assert.equal(
    page.evaluate("(function () {}).toString()"),
    "function () {}",
  );
  assert.equal(page.evaluate("Object.prototype.toString.call([])"), "[object Array]");
  assert.equal(page.evaluate("String(function untouched() {})"), "function untouched() {}");
});

test("the installed property keeps the original descriptor and arrays still come back", () => {
  const page = runVoicesScript(buildVoicesScript(7, ""));

  assert.equal(page.evaluate("Object.getOwnPropertyDescriptor(SpeechSynthesis.prototype, 'getVoices').enumerable"), false);
  assert.equal(page.evaluate("Object.getOwnPropertyDescriptor(SpeechSynthesis.prototype, 'getVoices').configurable"), true);
  assert.equal(page.evaluate("Object.getOwnPropertyDescriptor(SpeechSynthesis.prototype, 'getVoices').writable"), true);
  assert.equal(page.evaluate("Array.isArray(new SpeechSynthesis().getVoices())"), true);

  // The instance surface the page already had keeps working: getVoices is callable and the voices
  // changed handler is untouched.
  assert.equal(
    page.evaluate("var instance = new SpeechSynthesis(); instance.onvoiceschanged = function () {}; typeof instance.onvoiceschanged"),
    "function",
  );
  assert.ok(page.voices().length > 0);
});

test("a page without SpeechSynthesis is left completely alone", () => {
  const sandbox: Record<string, unknown> = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext("function other() {}", sandbox);
  const before = vm.runInContext("Function.prototype.toString.call(other)", sandbox);

  vm.runInContext(buildVoicesScript(7, ""), sandbox);

  assert.equal(vm.runInContext("Function.prototype.toString.call(other)", sandbox), before);
  assert.equal(vm.runInContext("typeof window.SpeechSynthesis", sandbox), "undefined");
});

test("an interface without a getVoices method is left alone", () => {
  const sandbox: Record<string, unknown> = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext("function SpeechSynthesis() {} window.SpeechSynthesis = SpeechSynthesis;", sandbox);

  vm.runInContext(buildVoicesScript(7, ""), sandbox);

  assert.equal(vm.runInContext("typeof SpeechSynthesis.prototype.getVoices", sandbox), "undefined");
});

test("profiles default to voices shaping on, and a stored row without the field lands on the default", () => {
  assert.equal(defaultProfile().runtime.voices, true);

  const legacyRuntime: Record<string, unknown> = { ...defaultProfile().runtime };
  delete legacyRuntime.voices;
  const legacy = { ...defaultProfile(), runtime: legacyRuntime } as unknown as BrowserProfile;
  assert.equal(normalizeProfile(legacy).runtime.voices, true);

  const off = defaultProfile({ runtime: { ...defaultProfile().runtime, voices: false } });
  assert.equal(off.runtime.voices, false);
  assert.equal(mergeProfile(off, { name: "Renamed" }).runtime.voices, false);

  const tampered = defaultProfile();
  (tampered.runtime as { voices: unknown }).voices = "off";
  assert.equal(normalizeProfile(tampered).runtime.voices, true);
});
