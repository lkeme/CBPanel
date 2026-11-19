import { useSyncExternalStore } from "react";

import type { ThemeMode } from "../shared/settings";

const colorSchemeQuery = "(prefers-color-scheme: dark)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(colorSchemeQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function systemIsDark() {
  return window.matchMedia(colorSchemeQuery).matches;
}

export function useResolvedTheme(mode: ThemeMode): "light" | "dark" {
  const dark = useSyncExternalStore(subscribe, systemIsDark, () => false);
  return mode === "system" ? (dark ? "dark" : "light") : mode;
}
