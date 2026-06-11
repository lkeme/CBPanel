import { useEffect, useState } from "react";
import { FilePlus2 } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { isManagedCloakBrowserEnvKey, normalizeCloakBrowserEnvKey } from "../../shared/settings";
import {
  ChoiceList,
  ChoiceOption,
  closeOnFocusLeave,
  isComposingInput,
  nextChoiceIndex,
} from "../ui/choice-list";

export function EnvKeyCombobox({
  disabled = false,
  onChange,
  options,
  t,
  value,
}: {
  disabled?: boolean;
  onChange: (value: string) => void;
  options: readonly string[];
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(value);
  const [activeIndex, setActiveIndex] = useState(-1);
  useEffect(() => setInput(value), [value]);
  const normalizedInput = normalizeCloakBrowserEnvKey(input);
  const normalizedValue = normalizeCloakBrowserEnvKey(value) ?? value;
  const filteredOptions = options.filter((option) => option.toLowerCase().includes(input.trim().toLowerCase()));
  const canUseCustom = Boolean(input.trim() && normalizedInput && !isManagedCloakBrowserEnvKey(normalizedInput));
  const itemCount = filteredOptions.length + (canUseCustom && normalizedInput && !filteredOptions.includes(normalizedInput) ? 1 : 0);

  useEffect(() => {
    setActiveIndex((current) => {
      if (!open || itemCount <= 0 || current < 0) return -1;
      return Math.min(current, itemCount - 1);
    });
  }, [itemCount, open]);

  function commit(nextValue: string | undefined) {
    const normalized = normalizeCloakBrowserEnvKey(nextValue);
    if (!normalized || isManagedCloakBrowserEnvKey(normalized)) return;
    onChange(normalized);
    setInput(normalized);
    setActiveIndex(-1);
    setOpen(false);
  }

  function commitActive() {
    if (activeIndex >= 0 && activeIndex < filteredOptions.length) {
      commit(filteredOptions[activeIndex]);
      return;
    }
    commit(input);
  }

  return (
    <div
      className={`env-key-combobox ${open ? "open" : ""} ${disabled ? "disabled" : ""}`}
      onBlur={(event) => closeOnFocusLeave(event, () => {
        if (canUseCustom) commit(input);
        setActiveIndex(-1);
        setOpen(false);
      })}
    >
      <input
        className="mono-cell"
        disabled={disabled}
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
          setActiveIndex(-1);
          setOpen(true);
        }}
        onFocus={() => {
          setActiveIndex(-1);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (isComposingInput(event)) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            setOpen(true);
            setActiveIndex((current) => nextChoiceIndex(current, itemCount, direction));
          }
          if (event.key === "Escape") {
            setActiveIndex(-1);
            setOpen(false);
          }
          if (event.key === "Enter") {
            event.preventDefault();
            commitActive();
          }
        }}
        placeholder={t("browserCore.envKeyPlaceholder")}
      />
      <button
        aria-label={t("browserCore.envKeyOptions")}
        className="env-key-combobox-trigger"
        disabled={disabled}
        onClick={() => {
          setActiveIndex(filteredOptions.findIndex((option) => option === normalizedValue));
          setOpen((current) => !current);
        }}
        type="button"
      >
        <ChevronDownIcon />
      </button>
      {open && !disabled && (
        <ChoiceList className="env-key-combobox-list">
          {filteredOptions.map((option) => (
            <ChoiceOption
              active={activeIndex === filteredOptions.indexOf(option) || (activeIndex < 0 && option === normalizedValue)}
              keepFocus
              key={option}
              onClick={() => {
                commit(option);
              }}
              onMouseEnter={() => setActiveIndex(filteredOptions.indexOf(option))}
            >
              <span className="mono-cell">{option}</span>
              <small>{t(`browserCore.envSuggestion.${option}` as TranslationKey)}</small>
            </ChoiceOption>
          ))}
          {canUseCustom && normalizedInput && !filteredOptions.includes(normalizedInput) && (
            <ChoiceOption
              active={activeIndex === filteredOptions.length}
              className="create"
              keepFocus
              onClick={() => {
                commit(input);
              }}
              onMouseEnter={() => setActiveIndex(filteredOptions.length)}
            >
              <FilePlus2 size={15} aria-hidden="true" />
              <span className="mono-cell">{normalizedInput}</span>
            </ChoiceOption>
          )}
        </ChoiceList>
      )}
    </div>
  );
}

function ChevronDownIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" focusable="false">
      <path d="M4.25 6.25 8 10l3.75-3.75" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}
