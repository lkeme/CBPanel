import type { ExtensionEntity } from "../../src/shared/entities";

export type ExtensionPermissionDeclaration = Pick<
  ExtensionEntity,
  "permissions" | "hostPermissions" | "optionalPermissions" | "optionalHostPermissions"
>;

/**
 * Permission declarations are category-sensitive. A permission that used to be
 * optional does not authorize promoting it to required, while a required value
 * moving to optional is a reduction. New optional declarations keep the
 * existing CBPanel policy of requiring explicit review.
 */
export function extensionPermissionIncreases(
  previous: ExtensionPermissionDeclaration,
  next: ExtensionPermissionDeclaration,
): string[] {
  const previousRequired = new Set(previous.permissions);
  const previousRequiredHosts = new Set(previous.hostPermissions);
  const previousAnyPermissions = new Set([
    ...previous.permissions,
    ...(previous.optionalPermissions ?? []),
  ]);
  const previousAnyHosts = new Set([
    ...previous.hostPermissions,
    ...(previous.optionalHostPermissions ?? []),
  ]);
  return [...new Set([
    ...next.permissions.filter((permission) => !previousRequired.has(permission)),
    ...next.hostPermissions.filter((permission) => !previousRequiredHosts.has(permission)),
    ...(next.optionalPermissions ?? []).filter((permission) => !previousAnyPermissions.has(permission)),
    ...(next.optionalHostPermissions ?? []).filter((permission) => !previousAnyHosts.has(permission)),
  ])].sort();
}
