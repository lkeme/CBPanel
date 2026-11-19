import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_START_URL, START_URL_PRESETS } from "../../shared/profile";
import { buildStartUrlOptions, planStartUrlKeyPress } from "./startUrlPresets";

const ALL_PRESET_IDS = START_URL_PRESETS.map((preset) => preset.id);
const LAST_PRESET_INDEX = START_URL_PRESETS.length - 1;

function visibleIds(options: { showAllPresets?: boolean; typedQuery?: string | null; value: string }): string[] {
  return buildStartUrlOptions({
    showAllPresets: options.showAllPresets ?? false,
    typedQuery: options.typedQuery ?? null,
    value: options.value,
  }).presets.map((preset) => preset.id);
}

function keyPlan(press: {
  activeIndex?: number;
  composing?: boolean;
  key: string;
  open?: boolean;
  showAllPresets?: boolean;
  visibleCount?: number;
}) {
  return planStartUrlKeyPress({
    activeIndex: press.activeIndex ?? -1,
    composing: press.composing ?? false,
    key: press.key,
    open: press.open ?? true,
    showAllPresets: press.showAllPresets ?? false,
    visibleCount: press.visibleCount ?? START_URL_PRESETS.length,
  });
}

test("focusing the input after a preset was picked still offers every preset", () => {
  // The user clicked BrowserLeaks Canvas, then clicked back into the box. Nothing was typed, so nothing
  // may narrow the list — filtering by the selected URL left it showing that one row, which reads as
  // "the other presets are gone".
  assert.deepEqual(visibleIds({ typedQuery: null, value: "https://browserleaks.com/canvas" }), ALL_PRESET_IDS);
  assert.deepEqual(visibleIds({ typedQuery: null, value: DEFAULT_START_URL }), ALL_PRESET_IDS);
});

test("a typed query still narrows the list, by label or by URL", () => {
  assert.deepEqual(visibleIds({ typedQuery: "creep", value: "creep" }), ["creepjs"]);
  assert.deepEqual(visibleIds({ typedQuery: "browserleaks.com", value: "browserleaks.com" }), [
    "browserleaks-canvas",
    "browserleaks-webrtc",
  ]);
  assert.deepEqual(visibleIds({ typedQuery: "blank page", value: "blank page" }), ["blank"]);
});

test("a query is only honoured for the value it produced, so a draft reload drops it", () => {
  // `typedQuery` outlives the keystroke that set it; the value moving on without it means the change
  // came from somewhere else (preset click, draft reload), and that must not keep filtering.
  assert.deepEqual(visibleIds({ typedQuery: "creep", value: "about:blank" }), ALL_PRESET_IDS);
  assert.deepEqual(visibleIds({ typedQuery: "creep", value: "creepj" }), ALL_PRESET_IDS);
});

test("the arrow button shows every preset even while the typed text would filter them", () => {
  assert.deepEqual(visibleIds({ showAllPresets: true, typedQuery: "creep", value: "creep" }), ALL_PRESET_IDS);
  assert.deepEqual(visibleIds({ showAllPresets: true, typedQuery: "no-such-preset", value: "no-such-preset" }), ALL_PRESET_IDS);
});

test("matching is case-folded and ignores surrounding blanks", () => {
  assert.deepEqual(visibleIds({ typedQuery: "CREEPJS", value: "CREEPJS" }), ["creepjs"]);
  assert.deepEqual(visibleIds({ typedQuery: "  about:blank  ", value: "  about:blank  " }), ["blank"]);
  assert.equal(buildStartUrlOptions({ showAllPresets: false, typedQuery: null, value: "  about:blank  " }).selectedUrl, "about:blank");
});

test("an empty value filters nothing and claims no custom URL", () => {
  const options = buildStartUrlOptions({ showAllPresets: false, typedQuery: "", value: "" });

  assert.deepEqual(
    options.presets.map((preset) => preset.id),
    ALL_PRESET_IDS,
  );
  assert.equal(options.selectedUrl, "");
  assert.equal(options.showCustomHint, false);
});

test("the custom hint marks a URL that is no preset, and stays away from the presets' own URLs", () => {
  const custom = buildStartUrlOptions({ showAllPresets: false, typedQuery: null, value: "https://mail.example.com" });
  const preset = buildStartUrlOptions({ showAllPresets: false, typedQuery: null, value: "about:blank" });

  // A real URL is never one of the rows on screen, so the hint stands beside them.
  assert.equal(custom.presets.length, START_URL_PRESETS.length);
  assert.equal(custom.showCustomHint, true);
  assert.equal(preset.showCustomHint, false);
});

test("a half-typed word gets no custom hint while rows still match it", () => {
  const matching = buildStartUrlOptions({ showAllPresets: false, typedQuery: "creep", value: "creep" });
  const unmatched = buildStartUrlOptions({ showAllPresets: false, typedQuery: "zzz", value: "zzz" });

  assert.equal(matching.showCustomHint, false);
  assert.equal(unmatched.presets.length, 0);
  assert.equal(unmatched.showCustomHint, true);
});

test("Enter with nothing highlighted still swallows the keystroke", () => {
  // The combobox owns Enter whenever it has focus, not only when an option is highlighted, so a future
  // enclosing form or ancestor Enter handler cannot act on a keystroke that belongs to the open list.
  assert.deepEqual(keyPlan({ activeIndex: -1, key: "Enter" }), { action: "close", preventDefault: true, stopPropagation: false });
  assert.deepEqual(keyPlan({ activeIndex: -1, key: "Enter", open: false }), {
    action: "close",
    preventDefault: true,
    stopPropagation: false,
  });
});

test("Enter on a highlighted option commits that option", () => {
  assert.deepEqual(keyPlan({ activeIndex: 0, key: "Enter" }), {
    action: "commit",
    activeIndex: 0,
    preventDefault: true,
    stopPropagation: false,
  });
  assert.deepEqual(keyPlan({ activeIndex: LAST_PRESET_INDEX, key: "Enter" }), {
    action: "commit",
    activeIndex: LAST_PRESET_INDEX,
    preventDefault: true,
    stopPropagation: false,
  });
});

test("Enter on an index the filtered list no longer reaches closes instead of committing", () => {
  assert.deepEqual(keyPlan({ activeIndex: 3, key: "Enter", visibleCount: 1 }), {
    action: "close",
    preventDefault: true,
    stopPropagation: false,
  });
  assert.deepEqual(keyPlan({ activeIndex: 0, key: "Enter", visibleCount: 0 }), {
    action: "close",
    preventDefault: true,
    stopPropagation: false,
  });
});

test("the arrows open the list on the selected end and wrap around it", () => {
  assert.deepEqual(keyPlan({ activeIndex: -1, key: "ArrowDown" }), {
    action: "move",
    activeIndex: 0,
    preventDefault: true,
    stopPropagation: false,
  });
  assert.deepEqual(keyPlan({ activeIndex: -1, key: "ArrowUp" }), {
    action: "move",
    activeIndex: LAST_PRESET_INDEX,
    preventDefault: true,
    stopPropagation: false,
  });
  assert.deepEqual(keyPlan({ activeIndex: LAST_PRESET_INDEX, key: "ArrowDown", showAllPresets: true }), {
    action: "move",
    activeIndex: 0,
    preventDefault: true,
    stopPropagation: false,
  });
  assert.deepEqual(keyPlan({ activeIndex: 0, key: "ArrowUp", showAllPresets: true }), {
    action: "move",
    activeIndex: LAST_PRESET_INDEX,
    preventDefault: true,
    stopPropagation: false,
  });
});

test("the arrows walk the expanded list, not the one the typed text filtered down to", () => {
  // The branch expands the list on the way through, so the index it lands on has to address the full
  // list — clamping to the filtered length would strand the highlight on row 0.
  const downFromLast = keyPlan({ activeIndex: LAST_PRESET_INDEX, key: "ArrowDown", showAllPresets: false, visibleCount: 1 });
  const upFromFirst = keyPlan({ activeIndex: 0, key: "ArrowUp", showAllPresets: false, visibleCount: 1 });

  assert.deepEqual(downFromLast, { action: "move", activeIndex: 0, preventDefault: true, stopPropagation: false });
  assert.deepEqual(upFromFirst, { action: "move", activeIndex: LAST_PRESET_INDEX, preventDefault: true, stopPropagation: false });
});

test("Escape closes the list without letting the enclosing Drawer see the key", () => {
  assert.deepEqual(keyPlan({ key: "Escape", open: true }), { action: "close", preventDefault: false, stopPropagation: true });
  assert.deepEqual(keyPlan({ activeIndex: 2, key: "Escape", open: true }), {
    action: "close",
    preventDefault: false,
    stopPropagation: true,
  });
});

test("Escape on a closed list belongs to the Drawer, so it is neither swallowed nor acted on", () => {
  assert.deepEqual(keyPlan({ key: "Escape", open: false }), { action: "none", preventDefault: false, stopPropagation: false });
});

test("an IME composing a candidate keeps every key away from the list", () => {
  // Enter picks a candidate and the arrows walk them, so acting here would commit a preset the user was
  // never offered and swallow the keystroke the IME needs.
  for (const key of ["Enter", "ArrowDown", "ArrowUp", "Escape"]) {
    assert.deepEqual(keyPlan({ activeIndex: 2, composing: true, key, open: true }), {
      action: "none",
      preventDefault: false,
      stopPropagation: false,
    });
  }
});

test("typing keys and Tab pass straight through, so focus and text entry still work", () => {
  for (const key of ["a", "1", "/", "Tab", "Backspace", "Home"]) {
    assert.deepEqual(keyPlan({ activeIndex: 2, key, open: true }), {
      action: "none",
      preventDefault: false,
      stopPropagation: false,
    });
  }
});
