import { useState } from "react";

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
  const label = selected?.label ?? placeholder;
  const meta = selected?.meta;

  return (
    <div
      className={`select-menu ${open ? "open" : ""} ${disabled ? "disabled" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        aria-expanded={open}
        className="select-menu-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className={`select-menu-value ${meta ? "has-meta" : ""}`}>
          <strong>{label}</strong>
          {meta && <small>{meta}</small>}
        </span>
        <ChevronDownIcon />
      </button>
      {open && (
        <div className="select-menu-list" role="listbox">
          {options.map((option) => (
            <button
              className={option.value === value ? "active" : ""}
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              role="option"
              type="button"
              aria-selected={option.value === value}
            >
              <span>{option.label}</span>
              {option.meta && <small>{option.meta}</small>}
            </button>
          ))}
        </div>
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
