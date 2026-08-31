import fs from "node:fs/promises";
import { Reader } from "mmdb-lib";
import type { CityResponse } from "mmdb-lib";

import { localeForCountryCode } from "../../src/shared/launchGeoip";

// What a `geoip: true` launch would derive for one exit IP. Mirrors the tail of upstream's
// `maybeResolveGeoip` (cloakbrowser 0.5.10 `js/src/geoip.ts`): read the GeoLite2 city record, take
// `location.time_zone` as the timezone, map `country.iso_code` through COUNTRY_LOCALE_MAP, and fail
// the launch if either required value cannot be resolved.
export type LaunchGeoDbLookup = {
  timezone: string;
  locale: string;
  countryCode?: string;
};

/** Resolves one IP against an already-loaded database. Split out so tests cover every branch without shipping a GeoLite2 fixture. */
export type LaunchGeoDbReader = (buffer: Buffer, ip: string) => CityResponse | null;

// Deliberately does not download the database. Upstream's `ensureGeoipDb()` fetches ~70MB on first
// use, which is right for a launch the operator asked for and wrong for a "what would this proxy
// give me" question — so a missing database is reported, not silently repaired. The file is populated
// by the first `geoip: true` launch, whose download already routes through the configured GitHub
// mirror (see githubMirrorFetch).
//
// CloakBrowser 0.5.10 deliberately made every failure fatal. A partial exit-IP answer is not a valid
// preview of a launch any more: the launch aborts when the database, timezone, or locale is missing.
export async function readLaunchGeoFromDb(
  dbPath: string | undefined,
  ip: string,
  read: LaunchGeoDbReader = readCityRecord,
): Promise<LaunchGeoDbLookup> {
  if (!dbPath) throw geoipResolutionError("GeoIP resolution failed: GeoIP database is unavailable");

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(dbPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw geoipResolutionError("GeoIP resolution failed: GeoIP database is unavailable", error);
    }
    throw geoipLookupError(ip, error);
  }

  let record: CityResponse | null;
  try {
    record = read(buffer, ip);
  } catch (error) {
    throw geoipLookupError(ip, error);
  }

  if (!record) throw geoipResolutionError(`GeoIP lookup failed for ${ip}: address is not in the database`);

  return launchGeoFromCityRecord(record);
}

export function launchGeoFromCityRecord(record: CityResponse): LaunchGeoDbLookup {
  const countryCode = record.country?.iso_code ?? undefined;
  const timezone = record.location?.time_zone ?? undefined;
  const locale = localeForCountryCode(countryCode);
  if (!timezone || !locale) {
    const missing = [timezone ? undefined : "timezone", locale ? undefined : "locale"]
      .filter((value): value is string => Boolean(value));
    throw geoipResolutionError(`GeoIP resolution failed: could not determine ${missing.join(" and ")}`);
  }
  return {
    timezone,
    locale,
    countryCode,
  };
}

function readCityRecord(buffer: Buffer, ip: string): CityResponse | null {
  return new Reader<CityResponse>(buffer).get(ip);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

function geoipLookupError(ip: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return geoipResolutionError(`GeoIP lookup failed for ${ip}: ${detail}`, error);
}

function geoipResolutionError(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    status: 502,
    code: "GEOIP_RESOLUTION_FAILED",
  });
}
