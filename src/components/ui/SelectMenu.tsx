import { useState } from "react";

import { ChoiceList, ChoiceOption, clampChoiceIndex, closeOnFocusLeave, nextChoiceIndex } from "./choice-list";

export function SelectMenu<T extends string>({
  disabled = false,
  onChange,
  options,
  placeholder,
  value,
}: {
  disabled?: boolean;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string; meta?: string }>;
  placeholder: string;
  value: T;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const label = selected?.label ?? placeholder;
  const meta = selected?.meta;

  function openAt(index: number) {
    setActiveIndex(clampChoiceIndex(index, options.length));
    setOpen(true);
  }

  function commit(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  }

  return (
    <div
      className={`select-menu ${open ? "open" : ""} ${disabled ? "disabled" : ""}`}
      onBlur={(event) => closeOnFocusLeave(event, () => setOpen(false))}
    >
      <button
        aria-expanded={open}
        className="select-menu-trigger"
        disabled={disabled}
        onClick={() => {
          if (!open) openAt(selectedIndex);
          else setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            if (open) {
              setActiveIndex((current) => nextChoiceIndex(current, options.length, direction));
            } else {
              setActiveIndex(nextChoiceIndex(selectedIndex, options.length, direction));
              setOpen(true);
            }
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!open) openAt(selectedIndex);
            else commit(activeIndex);
          }
          if (event.key === "Escape") setOpen(false);
        }}
        type="button"
      >
        <span className={`select-menu-value ${meta ? "has-meta" : ""}`}>
          <strong>{label}</strong>
          {meta && <small>{meta}</small>}
        </span>
        <ChevronDownIcon />
      </button>
      {open && (
        <ChoiceList className="select-menu-list">
          {options.map((option) => (
            <ChoiceOption
              active={options[activeIndex]?.value === option.value || (!options[activeIndex] && option.value === value)}
              key={option.value}
              onMouseEnter={() => setActiveIndex(options.findIndex((candidate) => candidate.value === option.value))}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {option.meta && <small>{option.meta}</small>}
            </ChoiceOption>
          ))}
        </ChoiceList>
      )}
    </div>
  );
}

export function ChevronDownIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  );
}
