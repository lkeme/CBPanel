export type AppVersionInfo = {
  /** The packaged CloakBrowser wrapper version. */
  wrapper?: string;
  /** CBPanel's own version. */
  app?: string;
};

export const APP_BRAND = "CBPanel";

/**
 * The About page footer. The start year is the year the project was published, which LICENSE
 * records; the closing year is resolved at render time so a build made later does not keep
 * claiming the first one.
 */
export const APP_COPYRIGHT_START_YEAR = 2026;
export const APP_COPYRIGHT_HOLDER = "Lkeme";

/**
 * Combine two version reports, preferring whichever side knows each half. The desktop bridge
 * answers before the sidecar, and a packaged sidecar may predate a field, so neither source is
 * complete on its own.
 */
export function resolveAppVersions(primary: AppVersionInfo | undefined, fallback: AppVersionInfo | undefined): AppVersionInfo {
  return {
    wrapper: primary?.wrapper ?? fallback?.wrapper,
    app: primary?.app ?? fallback?.app,
  };
}

/**
 * `app | wrapper`, or just the half that is known; empty when neither is. The product title puts
 * CBPanel's own version first so the wrapper stays the trailing, interchangeable half.
 */
export function formatAppVersionLabel(versions: AppVersionInfo | undefined): string {
  return [versions?.app, versions?.wrapper].filter(Boolean).join(" | ");
}

/** `CBPanel 1.0.10` — the brand with the app version, leaving the wrapper for its own slot. */
export function formatAppBrandLabel(versions: AppVersionInfo | undefined): string {
  return versions?.app ? `${APP_BRAND} ${versions.app}` : APP_BRAND;
}

/**
 * `CBPanel 1.0.10 | 0.7.0` — the full document and window title. Without a known app version the
 * brand stands alone rather than borrowing the wrapper's number, which would read as CBPanel's own.
 */
export function formatAppTitle(versions: AppVersionInfo | undefined): string {
  const wrapper = versions?.wrapper;
  if (!versions?.app) return wrapper ? `${APP_BRAND} | ${wrapper}` : APP_BRAND;
  return wrapper ? `${APP_BRAND} ${versions.app} | ${wrapper}` : `${APP_BRAND} ${versions.app}`;
}
