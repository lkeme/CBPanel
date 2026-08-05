import { Copy } from "lucide-react";

import type { TranslationKey } from "../../i18n";

export function CopyButton({
  t,
  value,
}: {
  t: (key: TranslationKey) => string;
  value: string;
}) {
  return (
    <button
      className="icon-button compact"
      aria-label={t("actions.copy")}
      title={t("actions.copy")}
      onClick={() => void navigator.clipboard.writeText(value)}
      type="button"
    >
      <Copy size={15} aria-hidden="true" />
    </button>
  );
}
