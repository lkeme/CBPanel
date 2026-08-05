import { maskManagedProxyForDisplay } from "../profiles/proxyDisplay";
import type { ProxyEntity, TrashEnvironment } from "../../shared/entities";
import type { ModuleStat } from "./registryStats";

/** Name and description are all a group or tag row prints, so that is all we search. */
export function statHaystack(stat: ModuleStat): string {
  return [stat.name, stat.description].filter(Boolean).join(" ");
}

/**
 * Proxy rows print a masked address, so the haystack is built from that same string:
 * whatever is on screen is searchable, and the password can never be matched.
 */
export function proxyHaystack(stat: ModuleStat, proxy?: ProxyEntity): string {
  if (!proxy) return statHaystack(stat);
  const address = `${proxy.scheme}://${proxy.host}:${proxy.port}`;
  return [stat.name, stat.description, maskManagedProxyForDisplay(proxy, address), address, proxy.notes]
    .filter(Boolean)
    .join(" ");
}

/**
 * Takes the already-formatted timestamp rather than formatting again, so the row and the
 * haystack cannot disagree about how a deletion time reads. Field order mirrors the row so a
 * query that spans two adjacent visible fields still matches.
 */
export function trashHaystack(entry: TrashEnvironment, deletedAtLabel: string): string {
  return [entry.environment.name, deletedAtLabel, entry.deleteReason].filter(Boolean).join(" ");
}

/** True when the trimmed query is a substring of the haystack; both sides are case-folded. */
export function matchesQuery(haystack: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle ? haystack.toLowerCase().includes(needle) : true;
}
