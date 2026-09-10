/**
 * Shaping of `speechSynthesis.getVoices()`.
 *
 * CloakBrowser's native patches do not cover the voices enumeration: measured on one host, two very
 * different `--fingerprint` seeds return a byte-identical list (22 voices, `Microsoft David`/`Mark`/
 * `Zira` on Windows). That is both a cross-environment correlation signal and a platform mismatch for
 * a profile that declares macOS or Linux. CBPanel cannot change the C++/TTS layer, so it shapes the
 * list from the page instead.
 *
 * The shaping is subtractive only. The browser's real synthesiser cannot be changed, so an invented
 * voice would be caught the first time a page speaks; every entry the page sees after this runs is
 * one the host really reports.
 */

/** The voice fields the subset algorithm reads. Structural, so it also types the in-page copy. */
export interface VoiceLike {
  voiceURI?: string;
  name?: string;
  lang?: string;
  default?: boolean;
}

/**
 * FNV-1a over a string. `buildVoicesScript` embeds these functions into the page through `toString()`,
 * so every body below must stay self-contained: no references to module scope, no syntax a compiler
 * would rewrite into a helper call.
 */
function hashVoicesText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash ^ value.charCodeAt(index)) >>> 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A voice's stable identity. The array index is deliberately absent: the host may reorder its list,
 * and an index-keyed score would then reshuffle which voices survive between two calls. Newlines
 * cannot appear in a voice field, so two different voices cannot join to one identity.
 */
function voiceIdentity(voice: VoiceLike): string {
  return `${voice.voiceURI ?? ""}\n${voice.name ?? ""}\n${voice.lang ?? ""}`;
}

/**
 * The subset algorithm itself. `selectStableVoices` runs this function, and `buildVoicesScript`
 * embeds its source text into the page, so the panel and the page can never disagree about the
 * result.
 *
 * Keep-only by construction: the returned array holds input entries and nothing else. Very short
 * lists pass through untouched, the engine default and the voices whose `lang` matches exactly are
 * always kept, and the rest are ranked by `hash(seed, identity)` down to a seeded 70-85% of the host
 * list.
 */
function selectVoicesCore(voices: readonly VoiceLike[], seed: number, language: string): VoiceLike[] {
  const total = voices.length;
  if (total <= 3) return voices.slice();

  const target = language.trim().toLowerCase();
  const selected = new Array<boolean>(total).fill(false);
  const scores = new Array<number>(total).fill(0);
  let mandatory = 0;
  for (let index = 0; index < total; index += 1) {
    const voice = voices[index];
    const matchesLanguage = target.length > 0 && (voice.lang ?? "").trim().toLowerCase() === target;
    if (voice.default === true || matchesLanguage) {
      selected[index] = true;
      mandatory += 1;
    }
    scores[index] = hashVoicesText(`${seed}\n${voiceIdentity(voice)}`);
  }

  // The ratio floats with the seed, so two environments do not keep the same fraction of the list.
  const ratio = 70 + (hashVoicesText(`ratio:${seed}`) % 16);
  let keepCount = Math.max(mandatory, Math.round((total * ratio) / 100));
  // Never cut a list this long below two entries: an almost empty voice list is its own anomaly.
  if (keepCount < 2) keepCount = Math.min(2, total);

  if (keepCount > mandatory) {
    const ranked: number[] = [];
    for (let index = 0; index < total; index += 1) {
      if (!selected[index]) ranked.push(index);
    }
    ranked.sort((left, right) => scores[right] - scores[left] || left - right);
    for (let index = 0; index < ranked.length && keepCount > mandatory; index += 1) {
      selected[ranked[index]] = true;
      keepCount -= 1;
    }
  }

  // Host order, not score order: a re-sorted voice list is itself a fingerprint.
  const result: VoiceLike[] = [];
  for (let index = 0; index < total; index += 1) {
    if (selected[index]) result.push(voices[index]);
  }
  return result;
}

/**
 * A stable subset of the host's voice list. Keep-only: every returned entry comes from the input,
 * because the browser's real synthesiser cannot be changed and an invented voice would be caught the
 * first time a page speaks.
 */
export function selectStableVoices<T extends VoiceLike>(
  voices: readonly T[],
  seed: number,
  language: string,
): T[] {
  // Sound by construction: selectVoicesCore only ever returns entries it was given.
  return selectVoicesCore(voices, seed, language) as T[];
}

/**
 * The instance seed: the profile's fingerprint seed when set, else a stable digest of its id — an
 * environment without an explicit seed still gets the same list every launch. The prefixes keep a
 * profile whose id happens to equal another profile's fingerprint seed from colliding with it.
 */
export function voicesSeed(seed: string, profileId: string): number {
  const trimmed = seed.trim();
  return hashVoicesText(trimmed ? `seed:${trimmed}` : `profile:${profileId}`);
}

/**
 * Embeds a function as a declaration. `var <name> = <source>` rather than the bare source: a minifier
 * may rewrite the declaration into an expression, and the body keeps calling the helpers under their
 * minified names — so the name has to come from the function itself, not from a string in this file.
 *
 * The source is inserted verbatim and never re-indented: a printer may emit a template literal with a
 * raw newline in it, and padding such a line would silently change the string the page computes.
 */
function embedFunctionSource(fn: (...args: never[]) => unknown): string {
  const source = fn.toString();
  return fn.name ? `var ${fn.name} = ${source};` : source;
}

function voicesAlgorithmSource(): string {
  return [hashVoicesText, voiceIdentity, selectVoicesCore].map(embedFunctionSource).join("\n\n");
}

/**
 * Builds the init script that replaces `SpeechSynthesis.prototype.getVoices` with the shaped subset.
 * Returns "" when the profile turns shaping off; callers must then skip the injection API entirely,
 * because even an empty init script would add an observable surface.
 *
 * The script embeds the very functions `selectStableVoices` runs (through `toString()`), installs the
 * replacement with the original property descriptor, and proxies `Function.prototype.toString` so the
 * replaced method reports itself as native while every other function keeps its real source. Both
 * modifications are installed as one unit and rolled back with the captured descriptors when either
 * fails, so a partial install leaves no trace. It bails out when the page has no `SpeechSynthesis`,
 * and swallows every failure: shaping must never break the page it runs in.
 *
 * Not idempotent, deliberately without a guard: injected twice it shapes the already-shaped list again
 * and the retention keeps shrinking. That is unreachable on the shipped launcher paths — each document
 * gets the script exactly once — and a page-visible marker would add the very kind of tell this feature
 * exists to remove, so the trade is rejected.
 */
export function buildVoicesScript(seed: number, language: string, enabled = true): string {
  if (!enabled) return "";
  const seedLiteral = String(Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0);
  const languageLiteral = JSON.stringify(language.trim());
  // Interpolated, never spelled out: a minified bundle renames the function, and the embedded copy
  // above is declared under its renamed name.
  const coreCall = `${selectVoicesCore.name}(voices, SEED, LANGUAGE)`;

  return `(function () {
  try {
    var synthesis = window.SpeechSynthesis;
    if (typeof synthesis !== "function" || !synthesis.prototype) return;
    var prototype = synthesis.prototype;
    var originalGetVoices = prototype.getVoices;
    if (typeof originalGetVoices !== "function") return;

${voicesAlgorithmSource()}

    var SEED = ${seedLiteral};
    var LANGUAGE = ${languageLiteral};
    // Taken from an object-literal method shorthand, not written as a function expression: a method
    // definition is not a constructor and has no own "prototype" property, exactly like a native WebIDL
    // operation. A function expression would be constructible and expose ["length","name","prototype"] —
    // a one-line tell that every shaping-enabled environment would share.
    var hookedGetVoices = {
      getVoices() {
        var voices = originalGetVoices.call(this);
        try {
          return ${coreCall};
        } catch (error) {
          return voices;
        }
      }
    }.getVoices;

    // The page must not be able to tell the method was replaced: register the hooked method's native
    // text, proxy the real Function.prototype.toString so every unregistered call still forwards to it,
    // and register the proxy itself so it reports as native too.
    var descriptor = Object.getOwnPropertyDescriptor(prototype, "getVoices");
    var originalToString = Function.prototype.toString;
    var toStringDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
    var fakeToStrings = new WeakMap();
    var hookedToString = new Proxy(originalToString, {
      apply: function (target, receiver, args) {
        if (fakeToStrings.has(receiver)) return fakeToStrings.get(receiver);
        return Reflect.apply(target, receiver, args);
      }
    });
    fakeToStrings.set(hookedGetVoices, "function getVoices() { [native code] }");
    fakeToStrings.set(hookedToString, originalToString.call(originalToString));

    // The two global modifications are installed as one unit and rolled back together: an install that
    // stops halfway would leave the realm with the hook but no masking (or the masking proxy over every
    // function with nothing to hide), and either half is a one-line tell. Restoring puts back the very
    // values and attributes captured before installing, so a failed install changes nothing.
    var installed = false;
    try {
      Object.defineProperty(prototype, "getVoices", {
        value: hookedGetVoices,
        writable: descriptor ? descriptor.writable === true : true,
        enumerable: descriptor ? descriptor.enumerable === true : false,
        configurable: descriptor ? descriptor.configurable === true : true
      });
      Object.defineProperty(Function.prototype, "toString", {
        value: hookedToString,
        writable: toStringDescriptor ? toStringDescriptor.writable === true : true,
        enumerable: toStringDescriptor ? toStringDescriptor.enumerable === true : false,
        configurable: toStringDescriptor ? toStringDescriptor.configurable === true : true
      });
      installed = true;
    } finally {
      if (!installed) {
        // Restoring can fail too (a frozen or non-configurable property); shaping must never break the
        // page, so each attempt is independent and swallowed.
        try {
          Object.defineProperty(Function.prototype, "toString", {
            value: originalToString,
            writable: toStringDescriptor ? toStringDescriptor.writable === true : true,
            enumerable: toStringDescriptor ? toStringDescriptor.enumerable === true : false,
            configurable: toStringDescriptor ? toStringDescriptor.configurable === true : true
          });
        } catch (error) {}
        try {
          if (descriptor) {
            Object.defineProperty(prototype, "getVoices", {
              value: originalGetVoices,
              writable: descriptor.writable === true,
              enumerable: descriptor.enumerable === true,
              configurable: descriptor.configurable === true
            });
          } else {
            // The interface used to inherit getVoices and the failed install made it own; removing the
            // own property restores that shape instead of leaving a page-visible leftover.
            delete prototype.getVoices;
          }
        } catch (error) {}
      }
    }
  } catch (error) {
    /* Voices shaping must never break the page it is injected into. */
  }
})();`;
}
