import type { ProxyEntity } from "../../shared/entities";
import { maskProxyUrlForDisplay } from "../../shared/profile";

export function maskManagedProxyForDisplay(
  proxy: Pick<ProxyEntity, "scheme" | "host" | "port" | "username" | "password"> | undefined,
  fallback = "-",
): string {
  if (!proxy) return fallback;
  const auth = proxy.username ? `${encodeURIComponent(proxy.username)}${proxy.password ? ":***" : ""}@` : "";
  const url = proxy.host && proxy.port ? `${proxy.scheme}://${auth}${proxy.host}:${proxy.port}` : "";
  return maskProxyUrlForDisplay(url || fallback);
}
