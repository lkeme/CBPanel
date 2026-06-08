import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import type { TranslationKey } from "../../i18n";

export function PasswordInput({
  disabled = false,
  onChange,
  t,
  value,
}: {
  disabled?: boolean;
  onChange: (value: string) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  value: string;
}) {
  const [visible, setVisible] = useState(false);
  const label = t(visible ? "actions.hidePassword" : "actions.showPassword");

  return (
    <div className="password-input">
      <input
        autoComplete="new-password"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        type={visible ? "text" : "password"}
        value={value}
      />
      <button
        aria-label={label}
        className="password-input-toggle"
        disabled={disabled}
        onClick={() => setVisible((nextVisible) => !nextVisible)}
        onMouseDown={(event) => event.preventDefault()}
        title={label}
        type="button"
      >
        {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
      </button>
    </div>
  );
}
