import { useEffect, useState } from "react";
import { FilePlus2 } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { isManagedCloakBrowserEnvKey, normalizeCloakBrowserEnvKey } from "../../shared/settings";
import { ChoiceList, ChoiceOption, closeOnFocusLeave } from "../ui/choice-list";

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
  useEffect(() => setInput(value), [value]);
  const normalizedInput = normalizeCloakBrowserEnvKey(input);
  const normalizedValue = normalizeCloakBrowserEnvKey(value) ?? value;
  const filteredOptions = options.filter((option) => option.toLowerCase().includes(input.trim().toLowerCase()));
  const canUseCustom = Boolean(input.trim() && normalizedInput && !isManagedCloakBrowserEnvKey(normalizedInput));

  function commit(nextValue: string | undefined) {
    const normalized = normalizeCloakBrowserEnvKey(nextValue);
    if (!normalized || isManagedCloakBrowserEnvKey(normalized)) return;
    onChange(normalized);
    setInput(normalized);
    setOpen(false);
  }

  return (
    <div
      className={`env-key-combobox ${open ? "open" : ""} ${disabled ? "disabled" : ""}`}
      onBlur={(event) => closeOnFocusLeave(event, () => {
        if (canUseCustom) commit(input);
        setOpen(false);
      })}
    >
      <input
        className="mono-cell"
        disabled={disabled}
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
          if (event.key === "Enter") {
            event.preventDefault();
            commit(input);
          }
        }}
        placeholder={t("browserCore.envKeyPlaceholder")}
      />
      <button
        aria-label={t("browserCore.envKeyOptions")}
        className="env-key-combobox-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <ChevronDownIcon />
      </button>
      {open && !disabled && (
        <ChoiceList className="env-key-combobox-list">
          {filteredOptions.map((option) => (
            <ChoiceOption
              active={option === normalizedValue}
              keepFocus
              key={option}
              onClick={() => {
                commit(option);
              }}
            >
              <span className="mono-cell">{option}</span>
              <small>{t(`browserCore.envSuggestion.${option}` as TranslationKey)}</small>
            </ChoiceOption>
          ))}
          {canUseCustom && normalizedInput && !filteredOptions.includes(normalizedInput) && (
            <ChoiceOption
              className="create"
              keepFocus
              onClick={() => {
                commit(input);
              }}
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
