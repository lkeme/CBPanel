import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FilePlus2 } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { isManagedCloakBrowserEnvKey, isPanelSettingCloakBrowserEnvKey, normalizeCloakBrowserEnvKey } from "../../shared/settings";
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
  const [dropUp, setDropUp] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const shortKey = (key: string) => key.replace(/^CLOAKBROWSER_/, "");
  const [input, setInput] = useState(() => shortKey(value));
  const [activeIndex, setActiveIndex] = useState(-1);
  useEffect(() => setInput(shortKey(value)), [value]);
  const normalizedInput = normalizeCloakBrowserEnvKey(input);
  const normalizedValue = normalizeCloakBrowserEnvKey(value) ?? value;
  const filteredOptions = options.filter((option) => option.toLowerCase().includes(input.trim().toLowerCase()));
  const canUseCustom = Boolean(input.trim() && normalizedInput && !isManagedCloakBrowserEnvKey(normalizedInput) && !isPanelSettingCloakBrowserEnvKey(normalizedInput));
  const itemCount = filteredOptions.length + (canUseCustom && normalizedInput && !filteredOptions.includes(normalizedInput) ? 1 : 0);

  useEffect(() => {
    setActiveIndex((current) => {
      if (!open || itemCount <= 0 || current < 0) return -1;
      return Math.min(current, itemCount - 1);
    });
  }, [itemCount, open]);

  useLayoutEffect(() => {
    if (!open) {
      setDropUp(false);
      return;
    }
    let frame = 0;
    const updatePlacement = () => {
      const container = containerRef.current;
      const list = container?.querySelector<HTMLElement>(".env-key-combobox-list");
      if (!container || !list) return;
      const box = container.getBoundingClientRect();
      const listHeight = Math.min(260, list.scrollHeight);
      const spaceBelow = window.innerHeight - box.bottom;
      const spaceAbove = box.top;
      setDropUp(spaceBelow < listHeight + 8 && spaceAbove > spaceBelow);
    };
    frame = window.requestAnimationFrame(updatePlacement);
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [itemCount, open]);

  function commit(nextValue: string | undefined) {
    const normalized = normalizeCloakBrowserEnvKey(nextValue);
    if (!normalized || isManagedCloakBrowserEnvKey(normalized) || isPanelSettingCloakBrowserEnvKey(normalized)) return;
    onChange(normalized);
    setInput(shortKey(normalized));
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
      className={`env-key-combobox ${open ? "open" : ""} ${dropUp ? "drop-up" : ""} ${disabled ? "disabled" : ""}`}
      ref={containerRef}
      onBlur={(event) => closeOnFocusLeave(event, () => {
        if (canUseCustom) commit(input);
        setActiveIndex(-1);
        setOpen(false);
      })}
    >
      <input
        className="mono-cell"
        aria-label={t("browserCore.envKeyOptions")}
        title={normalizedValue || undefined}
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
          if (event.key === "Escape" && open) {
            // Swallow it while the list is open so an enclosing Drawer stays put.
            event.stopPropagation();
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
              <span className="mono-cell" title={option}>{shortKey(option)}</span>
              {t(`browserCore.envSuggestion.${option}` as TranslationKey) !== `browserCore.envSuggestion.${option}` && <small>{t(`browserCore.envSuggestion.${option}` as TranslationKey)}</small>}
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
              <span className="mono-cell" title={normalizedInput}>{shortKey(normalizedInput)}</span>
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
