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
  nextChoiceIndex,
} from "../ui/choice-list";

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
  const selectedUrl = value.trim();
  const presetQuery = selectedUrl.toLowerCase();
  const visiblePresets = showAllPresets
    ? START_URL_PRESETS
    : START_URL_PRESETS.filter(
        (preset) => !presetQuery || preset.label.toLowerCase().includes(presetQuery) || preset.url.toLowerCase().includes(presetQuery),
      );
  const isCustomUrl = Boolean(selectedUrl) && !START_URL_PRESETS.some((preset) => preset.url === selectedUrl);
  const showCustomHint = isCustomUrl && (visiblePresets.length === 0 || /^https?:\/\//i.test(selectedUrl));

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

  function commitActive() {
    const preset = visiblePresets[activeIndex];
    if (!preset) {
      close();
      return;
    }
    onChange(preset.url);
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
            setShowAllPresets(false);
            setActiveIndex(-1);
            setOpen(true);
          }}
          onFocus={() => {
            setShowAllPresets(false);
            setActiveIndex(-1);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (isComposingInput(event)) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              const keyboardPresets = showAllPresets ? visiblePresets : START_URL_PRESETS;
              setShowAllPresets(true);
              setOpen(true);
              setActiveIndex((current) => nextChoiceIndex(current, keyboardPresets.length, direction));
            }
            if (event.key === "Enter") {
              if (activeIndex >= 0) {
                event.preventDefault();
                commitActive();
              } else {
                close();
              }
            }
            if (event.key === "Escape") close();
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
