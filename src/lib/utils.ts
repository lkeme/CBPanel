import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatTime(value: string, style: "short" | "dateTime" = "short"): string {
  if (style === "dateTime") {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
  }
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * `extension-<uuid>`: the prefix is constant, so the first bytes of the uuid are what tells two
 * records apart. Same helper for the list chip and the import-conflict dialog — the two must print
 * the same discriminator or the dialog cannot be matched against the row it is talking about.
 */
export function shortExtensionId(id: string): string {
  return id.replace(/^extension-/, "").slice(0, 8);
}
