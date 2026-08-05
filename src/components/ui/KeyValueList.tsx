import type React from "react";

import type { TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { CopyButton } from "./CopyButton";

export type KeyValueItem = {
  copyValue?: string;
  label: React.ReactNode;
  mono?: boolean;
  title?: string;
  value: React.ReactNode;
};

export function KeyValueList({
  className,
  items,
  t,
}: {
  className?: string;
  items: KeyValueItem[];
  t?: (key: TranslationKey) => string;
}) {
  return (
    <dl className={cn("kv-list", className)}>
      {items.map((item, index) => (
        <div key={typeof item.label === "string" ? item.label : index}>
          <dt>{item.label}</dt>
          <dd>
            {item.copyValue !== undefined ? (
              <CopyableValueRow
                copyValue={item.copyValue}
                t={t}
                value={typeof item.value === "string" ? item.value : item.copyValue}
              />
            ) : typeof item.value === "string" || typeof item.value === "number" ? (
              <span className={item.mono ? "mono-cell" : undefined} title={item.title}>
                {item.value}
              </span>
            ) : (
              item.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function CopyableValueRow({
  className,
  copyValue,
  empty = "-",
  suffix,
  t,
  value,
}: {
  className?: string;
  copyValue?: string | null;
  empty?: string;
  suffix?: React.ReactNode;
  t?: (key: TranslationKey) => string;
  value?: string | null;
}) {
  const text = value?.trim() || empty;
  const copyText = copyValue === undefined ? value?.trim() : copyValue?.trim();
  const canCopy = Boolean(copyText && t);
  return (
    <span className={cn("browser-core-detail-value", canCopy && "copyable", suffix && "has-suffix", !value?.trim() && "empty", className)}>
      <span className="mono-cell" title={text}>
        {text}
      </span>
      {suffix && <span className="browser-core-detail-suffix">{suffix}</span>}
      {canCopy && t && copyText && <CopyButton value={copyText} t={t} />}
    </span>
  );
}
