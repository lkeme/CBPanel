import React from "react";
import { HelpCircle, X } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { Switch } from "./switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

export function Drawer({
  title,
  close,
  children,
  actions,
  contentClassName,
  subtitle,
  t,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
  contentClassName?: string;
  subtitle?: string;
  t: (key: TranslationKey) => string;
}) {
  return (
    <div className="drawer-layer" role="dialog" aria-modal="true">
      <button className="drawer-scrim" aria-label={t("actions.close")} onClick={close} type="button" />
      <section className="drawer-panel">
        <header className="drawer-header">
          <div className="drawer-title-block">
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions}
          <button className="icon-button" title={t("actions.close")} onClick={close} type="button">
            <X size={18} />
          </button>
        </header>
        <div className={contentClassName ?? "drawer-scroll"}>{children}</div>
      </section>
    </div>
  );
}

export function FormSection({
  children,
  description,
  title,
}: {
  children: React.ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="form-section wide">
      <header className="form-section-header">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </header>
      <div className="form-grid two compact-section">{children}</div>
    </section>
  );
}

export function Field({
  children,
  error,
  help,
  label,
  wide = false,
}: {
  children: React.ReactNode;
  error?: string;
  help?: string;
  label: string;
  wide?: boolean;
}) {
  const labelId = React.useId();
  const generatedControlId = React.useId();
  const labelledControl = labelSingleNativeControl(children, labelId, generatedControlId);
  const labelContent = labelledControl.controlId
    ? <label htmlFor={labelledControl.controlId} id={labelId}>{label}</label>
    : <span id={labelId}>{label}</span>;
  const labelNode = (
    <span className="field-label">
      {labelContent}
      {help && <InfoTip text={help} />}
    </span>
  );
  const rootClassName = `field ${wide ? "wide" : ""}`;

  return (
    <div aria-labelledby={labelId} className={rootClassName} role="group">
      {labelNode}
      {labelledControl.children}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

export function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <input min={min} max={max} type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </Field>
  );
}

export function OptionControl({
  children,
  help,
  label,
  wide = false,
}: {
  children: React.ReactNode;
  help?: string;
  label: string;
  wide?: boolean;
}) {
  return (
    <div className={`option-control ${wide ? "wide" : ""}`}>
      <span>
        {label}
        {help && <InfoTip text={help} />}
      </span>
      <div className="option-control-value">{children}</div>
    </div>
  );
}

export function ToggleField({
  label,
  checked,
  disabled = false,
  help,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  help?: string;
  onChange: (checked: boolean) => void;
}) {
  const labelId = React.useId();

  return (
    <div className={`toggle-field ${disabled ? "disabled" : ""}`}>
      <span id={labelId}>
        {label}
        {help && <InfoTip text={help} />}
      </span>
      <Switch aria-labelledby={labelId} checked={checked} className="toggle-switch" disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

export function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button className="info-tip" aria-label={text} onClick={(event) => event.preventDefault()} type="button">
          <HelpCircle size={14} aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className={option.value === value ? "active" : ""}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function labelSingleNativeControl(
  children: React.ReactNode,
  labelId: string,
  generatedControlId: string,
): { children: React.ReactNode; controlId?: string } {
  if (!React.isValidElement(children) || typeof children.type !== "string") return { children };
  if (!["input", "select", "textarea"].includes(children.type)) return { children };
  const child = children as React.ReactElement<Record<string, unknown>, string>;
  const props = child.props as {
    "aria-label"?: string;
    "aria-labelledby"?: string;
    id?: unknown;
  };
  const existingId = typeof props.id === "string" ? props.id.trim() : "";
  const controlId = existingId || generatedControlId;
  const labelledProps: Record<string, string> = {};
  if (!existingId) labelledProps.id = controlId;
  if (!props["aria-label"] && !props["aria-labelledby"]) labelledProps["aria-labelledby"] = labelId;
  return {
    children: Object.keys(labelledProps).length > 0 ? React.cloneElement(child, labelledProps) : children,
    controlId,
  };
}
