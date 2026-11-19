import { START_URL_PRESETS, type StartUrlPreset } from "../../shared/profile";
import { nextChoiceIndex } from "../ui/choice-list";

/** What the start-URL dropdown puts on screen for a given input value and filter state. */
export type StartUrlOptions = {
  /** The rows to render, in list order. `activeIndex` indexes into exactly this array. */
  presets: StartUrlPreset[];
  /** `value` without surrounding blanks — what "the currently selected preset" is compared against. */
  selectedUrl: string;
  /** Whether the "custom URL" hint belongs under the rows. */
  showCustomHint: boolean;
};

/**
 * Decides which presets the dropdown shows.
 *
 * Only text the user actually typed narrows the list, which is why `typedQuery` is a separate input
 * instead of being read off `value`: it is stored with the value it produced, so a preset click or an
 * outside change (draft reload) drops the filter. Filtering by the URL that is already selected left
 * the list showing that single entry, which reads as "the presets are gone".
 *
 * `showAllPresets` is the arrow button's override — it shows every preset no matter what is typed.
 */
export function buildStartUrlOptions({
  showAllPresets,
  typedQuery,
  value,
}: {
  showAllPresets: boolean;
  typedQuery: string | null;
  value: string;
}): StartUrlOptions {
  const selectedUrl = value.trim();
  const presetQuery = typedQuery === value ? selectedUrl.toLowerCase() : "";
  const presets = showAllPresets
    ? START_URL_PRESETS
    : START_URL_PRESETS.filter(
        (preset) => !presetQuery || preset.label.toLowerCase().includes(presetQuery) || preset.url.toLowerCase().includes(presetQuery),
      );
  const isCustomUrl = Boolean(selectedUrl) && !START_URL_PRESETS.some((preset) => preset.url === selectedUrl);
  // A half-typed word gets no hint while rows still match it — the rows are the better answer. Once a
  // real URL is in the box the hint stands even beside matching rows, because none of them is it.
  const showCustomHint = isCustomUrl && (presets.length === 0 || /^https?:\/\//i.test(selectedUrl));
  return { presets, selectedUrl, showCustomHint };
}

/** Whether the keydown handler must swallow the keystroke, independent of what it does with state. */
type KeyStrokeGuards = {
  preventDefault: boolean;
  stopPropagation: boolean;
};

/**
 * What the combobox does with a keystroke.
 *
 * - `none`: leave every piece of state alone.
 * - `move`: open the list, expand it to every preset, and highlight `activeIndex`.
 * - `commit`: write the preset at `activeIndex` and close.
 * - `close`: close without writing.
 */
export type StartUrlKeyPlan = KeyStrokeGuards &
  ({ action: "none" } | { action: "move"; activeIndex: number } | { action: "commit"; activeIndex: number } | { action: "close" });

/**
 * Decides what a keystroke on the start-URL input means.
 *
 * `visibleCount` is the length of `buildStartUrlOptions().presets`, i.e. what is on screen right now,
 * so an `activeIndex` the filtered list no longer reaches cannot be committed.
 */
export function planStartUrlKeyPress({
  activeIndex,
  composing,
  key,
  open,
  showAllPresets,
  visibleCount,
}: {
  activeIndex: number;
  composing: boolean;
  key: string;
  open: boolean;
  showAllPresets: boolean;
  visibleCount: number;
}): StartUrlKeyPlan {
  // Mid-composition the keystroke belongs to the IME candidate window: Enter picks a candidate and the
  // arrows walk the candidates, so the list must not react to either.
  if (composing) return { action: "none", preventDefault: false, stopPropagation: false };
  if (key === "ArrowDown" || key === "ArrowUp") {
    // Both arrows expand the list before moving, so they wrap around the full preset list rather than
    // the filtered one; once `showAllPresets` is set the visible list already is that full list.
    const reachableCount = showAllPresets ? visibleCount : START_URL_PRESETS.length;
    const direction = key === "ArrowDown" ? 1 : -1;
    return {
      action: "move",
      activeIndex: nextChoiceIndex(activeIndex, reachableCount, direction),
      preventDefault: true,
      stopPropagation: false,
    };
  }
  if (key === "Enter") {
    // Swallowed in both branches, so the combobox owns Enter whenever it has focus rather than only
    // when an option is highlighted. Nothing today submits on it — the editor lives in a Drawer (a
    // <section>), and the repo's only <form> is DialogShell — so this is the guard, not a fix for an
    // observed submit: it keeps a future enclosing form, or any ancestor Enter handler, from acting on
    // a keystroke that belongs to the open list.
    const highlighted = activeIndex >= 0 && activeIndex < visibleCount;
    return highlighted
      ? { action: "commit", activeIndex, preventDefault: true, stopPropagation: false }
      : { action: "close", preventDefault: true, stopPropagation: false };
  }
  // Escape is only the combobox's while the list is open; closed, it belongs to the enclosing Drawer,
  // so it is neither swallowed nor acted on. `preventDefault` stays off either way — cancelling the
  // key's default is not what keeps the Drawer open, stopping the bubble is.
  if (key === "Escape" && open) return { action: "close", preventDefault: false, stopPropagation: true };
  return { action: "none", preventDefault: false, stopPropagation: false };
}
