import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";

import { START_URL_PRESETS } from "../../shared/profile";
import {
  ChoiceEmpty,
  ChoiceList,
  ChoiceOption,
  clampChoiceIndex,
  closeOnFocusLeave,
  isComposingInput,
} from "../ui/choice-list";
import { buildStartUrlOptions, planStartUrlKeyPress } from "./startUrlPresets";

export function StartUrlCombobox({
  customLabel,
  onChange,
  placeholder,
  presetLabel,
  value,
}: {
  customLabel: string;
  onChange: (value: string) => void;
  placeholder: string;
  presetLabel: string;
  value: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [showAllPresets, setShowAllPresets] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  // Holds the text the user typed together with the value it produced, which is what lets
  // `buildStartUrlOptions` tell typing apart from a preset click or a draft reload.
  const [typedQuery, setTypedQuery] = useState<string | null>(null);
  const { presets: visiblePresets, selectedUrl, showCustomHint } = buildStartUrlOptions({ showAllPresets, typedQuery, value });

  function close() {
    setOpen(false);
    setShowAllPresets(false);
    setActiveIndex(-1);
  }

  function openPresets(showAll: boolean) {
    const nextPresets = showAll ? START_URL_PRESETS : visiblePresets;
    setShowAllPresets(showAll);
    setOpen(true);
    const selectedIndex = nextPresets.findIndex((preset) => preset.url === selectedUrl);
    setActiveIndex(clampChoiceIndex(selectedIndex, nextPresets.length));
  }

  function commitPreset(index: number) {
    const preset = visiblePresets[index];
    if (preset) onChange(preset.url);
    close();
  }

  return (
    <div
      className={`start-url-combobox ${open ? "open" : ""}`}
      onBlur={(event) => closeOnFocusLeave(event, close)}
    >
      <div className="start-url-combobox-control">
        <input
          aria-autocomplete="list"
          aria-controls={open ? listId : undefined}
          aria-expanded={open}
          aria-haspopup="listbox"
          role="combobox"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setTypedQuery(event.target.value);
            setShowAllPresets(false);
            setActiveIndex(-1);
            setOpen(true);
          }}
          onFocus={() => {
            setTypedQuery(null);
            setShowAllPresets(false);
            setActiveIndex(-1);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            const plan = planStartUrlKeyPress({
              activeIndex,
              composing: isComposingInput(event),
              key: event.key,
              open,
              showAllPresets,
              visibleCount: visiblePresets.length,
            });
            if (plan.preventDefault) event.preventDefault();
            if (plan.stopPropagation) event.stopPropagation();
            if (plan.action === "move") {
              setShowAllPresets(true);
              setOpen(true);
              // A direct value, not the updater form this replaced: the plan already resolved the target
              // index, and the `activeIndex` it read is current here — keydown is a discrete event, so React
              // flushes it on SyncLane in a microtask and no repeat key or IME commit arrives with one still
              // queued. Not strict equivalence, though: the `onMouseEnter` below writes on
              // InputContinuousLane through a MessageChannel task, so a keystroke racing a hover moves from
              // the rendered index instead of the hovered one — one row of highlight, corrected by the next
              // arrow key. Closing that would mean carrying `direction` and `reachableCount` on the plan and
              // rewriting six whole-object assertions, which is not what one row of highlight costs.
              setActiveIndex(plan.activeIndex);
            }
            if (plan.action === "commit") commitPreset(plan.activeIndex);
            if (plan.action === "close") close();
          }}
          placeholder={placeholder}
        />
        <button
          aria-label={presetLabel}
          title={presetLabel}
          onClick={() => {
            const nextOpen = !open || !showAllPresets;
            if (nextOpen) openPresets(true);
            else close();
          }}
          type="button"
        >
          <ChevronDown size={16} strokeWidth={1.9} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <ChoiceList className="start-url-combobox-list" id={listId}>
          {visiblePresets.map((preset) => (
            <ChoiceOption
              active={activeIndex === visiblePresets.indexOf(preset) || (activeIndex < 0 && preset.url === selectedUrl)}
              key={preset.id}
              onClick={() => {
                onChange(preset.url);
                close();
              }}
              onMouseEnter={() => setActiveIndex(visiblePresets.indexOf(preset))}
            >
              <strong>{preset.label}</strong>
              <small>{preset.url}</small>
            </ChoiceOption>
          ))}
          {showCustomHint && <ChoiceEmpty className="start-url-combobox-empty">{customLabel}</ChoiceEmpty>}
        </ChoiceList>
      )}
    </div>
  );
}
