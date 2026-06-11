import { useEffect, useMemo, useState } from "react";
import { FilePlus2, X } from "lucide-react";

import {
  ChoiceEmpty,
  ChoiceList,
  ChoiceOption,
  closeOnFocusLeave,
  isComposingInput,
  nextChoiceIndex,
} from "./choice-list";

export function CreatableCombobox({
  createLabel,
  disabled = false,
  emptyLabel,
  onChange,
  options,
  placeholder,
  value,
}: {
  createLabel: string;
  disabled?: boolean;
  emptyLabel: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder: string;
  value: string;
}) {
  const [input, setInput] = useState(value);
  const [open, setOpen] = useState(false);
  const cleanInput = input.trim();
  const lowerInput = cleanInput.toLowerCase();
  const filteredOptions = useMemo(
    () => options.filter((option) => !lowerInput || option.toLowerCase().includes(lowerInput)),
    [lowerInput, options],
  );
  const canCreate = Boolean(cleanInput) && !options.some((option) => option.toLowerCase() === lowerInput);
  const itemCount = filteredOptions.length + (canCreate ? 1 : 0);
  const selectedOptionIndex = filteredOptions.findIndex((option) => option === value);
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    setInput(value);
  }, [value]);

  useEffect(() => {
    setActiveIndex((current) => normalizeOptionalActiveIndex(current, itemCount, open));
  }, [itemCount, open]);

  function commit(nextValue: string) {
    const cleanValue = nextValue.trim();
    if (!cleanValue) return;
    onChange(cleanValue);
    setInput(cleanValue);
    setActiveIndex(-1);
    setOpen(false);
  }

  function commitActive() {
    if (activeIndex >= 0 && activeIndex < filteredOptions.length) {
      commit(filteredOptions[activeIndex]);
      return;
    }
    if (canCreate && activeIndex === filteredOptions.length) {
      commit(input);
      return;
    }
    commit(input);
  }

  return (
    <div
      className={`combo-input ${open ? "open" : ""}`}
      onBlur={(event) => closeOnFocusLeave(event, () => setOpen(false))}
    >
      <div className="combo-control">
        <input
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
            if (event.key === "Enter") {
              event.preventDefault();
              commitActive();
            }
            if (event.key === "Escape") {
              setActiveIndex(-1);
              setOpen(false);
            }
          }}
          placeholder={placeholder}
        />
        <button
          disabled={disabled}
          aria-label={placeholder}
          onClick={() => {
            setActiveIndex(selectedOptionIndex);
            setOpen((current) => !current);
          }}
          type="button"
        >
          <ChevronDownIcon />
        </button>
      </div>
      {open && !disabled && (
        <ChoiceList className="combo-list">
          {filteredOptions.map((option) => (
            <ChoiceOption
              active={activeIndex === filteredOptions.indexOf(option) || (activeIndex < 0 && option === value)}
              keepFocus
              key={option}
              onClick={() => commit(option)}
              onMouseEnter={() => setActiveIndex(filteredOptions.indexOf(option))}
            >
              <span>{option}</span>
            </ChoiceOption>
          ))}
          {canCreate && (
            <ChoiceOption
              active={activeIndex === filteredOptions.length}
              className="create"
              keepFocus
              onClick={() => commit(input)}
              onMouseEnter={() => setActiveIndex(filteredOptions.length)}
            >
              <FilePlus2 size={15} aria-hidden="true" />
              <span>{createLabel.replace("{name}", cleanInput)}</span>
            </ChoiceOption>
          )}
          {filteredOptions.length === 0 && !canCreate && <ChoiceEmpty className="combo-empty">{emptyLabel}</ChoiceEmpty>}
        </ChoiceList>
      )}
    </div>
  );
}

export function CreatableTagInput({
  createLabel,
  disabled = false,
  emptyLabel,
  onAdd,
  onRemove,
  options,
  placeholder,
  value,
}: {
  createLabel: string;
  disabled?: boolean;
  emptyLabel: string;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  options: string[];
  placeholder: string;
  value: string[];
}) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => new Set(value.map((tag) => tag.trim()).filter(Boolean)), [value]);
  const cleanInput = input.trim();
  const lowerInput = cleanInput.toLowerCase();
  const filteredOptions = useMemo(
    () => options.filter((option) => !selected.has(option) && (!lowerInput || option.toLowerCase().includes(lowerInput))),
    [lowerInput, options, selected],
  );
  const canCreate = Boolean(cleanInput) && ![...selected, ...options].some((option) => option.toLowerCase() === lowerInput);
  const itemCount = filteredOptions.length + (canCreate ? 1 : 0);
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    setActiveIndex((current) => normalizeOptionalActiveIndex(current, itemCount, open));
  }, [itemCount, open]);

  function commit(tag: string) {
    const cleanTag = tag.trim();
    if (!cleanTag) return;
    onAdd(cleanTag);
    setInput("");
    setActiveIndex(-1);
    setOpen(false);
  }

  function commitActive() {
    if (activeIndex >= 0 && activeIndex < filteredOptions.length) {
      commit(filteredOptions[activeIndex]);
      return;
    }
    if (canCreate && activeIndex === filteredOptions.length) {
      commit(input);
      return;
    }
    commit(input);
  }

  return (
    <div
      className={`tag-combobox ${open ? "open" : ""} ${disabled ? "disabled" : ""}`}
      onBlur={(event) => closeOnFocusLeave(event, () => setOpen(false))}
    >
      <div className="tag-combobox-control" onClick={() => !disabled && setOpen(true)}>
        {value.map((tag) => (
          <span className="tag selected-tag" key={tag}>
            {tag}
            <button disabled={disabled} aria-label={tag} onClick={() => onRemove(tag)} type="button">
              <X size={13} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
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
            if (event.key === "Enter") {
              event.preventDefault();
              commitActive();
            }
            if (event.key === "Backspace" && !input && value.length > 0) onRemove(value[value.length - 1]);
            if (event.key === "Escape") {
              setActiveIndex(-1);
              setOpen(false);
            }
          }}
          placeholder={value.length === 0 ? placeholder : ""}
        />
      </div>
      {open && !disabled && (
        <ChoiceList className="combo-list">
          {filteredOptions.map((option) => (
            <ChoiceOption
              active={activeIndex === filteredOptions.indexOf(option)}
              keepFocus
              key={option}
              onClick={() => commit(option)}
              onMouseEnter={() => setActiveIndex(filteredOptions.indexOf(option))}
            >
              <span>{option}</span>
            </ChoiceOption>
          ))}
          {canCreate && (
            <ChoiceOption
              active={activeIndex === filteredOptions.length}
              className="create"
              keepFocus
              onClick={() => commit(input)}
              onMouseEnter={() => setActiveIndex(filteredOptions.length)}
            >
              <FilePlus2 size={15} aria-hidden="true" />
              <span>{createLabel.replace("{name}", cleanInput)}</span>
            </ChoiceOption>
          )}
          {filteredOptions.length === 0 && !canCreate && <ChoiceEmpty className="combo-empty">{emptyLabel}</ChoiceEmpty>}
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

function normalizeOptionalActiveIndex(currentIndex: number, itemCount: number, open: boolean) {
  if (!open || itemCount <= 0 || currentIndex < 0) return -1;
  return Math.min(currentIndex, itemCount - 1);
}
