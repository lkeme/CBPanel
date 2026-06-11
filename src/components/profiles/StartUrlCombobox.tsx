import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";

import { START_URL_PRESETS } from "../../shared/profile";

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
  }

  return (
    <div
      className={`start-url-combobox ${open ? "open" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
      }}
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
            setOpen(true);
          }}
          onFocus={() => {
            setShowAllPresets(false);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              setShowAllPresets(true);
              setOpen(true);
            }
            if (event.key === "Escape" || event.key === "Enter") close();
          }}
          placeholder={placeholder}
        />
        <button
          aria-label={presetLabel}
          title={presetLabel}
          onClick={() => {
            const nextOpen = !open || !showAllPresets;
            setShowAllPresets(nextOpen);
            setOpen(nextOpen);
          }}
          type="button"
        >
          <ChevronDown size={16} strokeWidth={1.9} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div className="start-url-combobox-list" id={listId} role="listbox">
          {visiblePresets.map((preset) => (
            <button
              aria-selected={preset.url === selectedUrl}
              className={preset.url === selectedUrl ? "active" : ""}
              key={preset.id}
              onClick={() => {
                onChange(preset.url);
                close();
              }}
              role="option"
              type="button"
            >
              <strong>{preset.label}</strong>
              <small>{preset.url}</small>
            </button>
          ))}
          {showCustomHint && <span className="start-url-combobox-empty">{customLabel}</span>}
        </div>
      )}
    </div>
  );
}
