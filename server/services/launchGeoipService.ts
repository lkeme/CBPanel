import fs from "node:fs/promises";
import { Reader } from "mmdb-lib";
import type { CityResponse } from "mmdb-lib";

import { localeForCountryCode, type LaunchGeoUnresolvedReason } from "../../src/shared/launchGeoip";

// What a `geoip: true` launch would derive for one exit IP. Mirrors the tail of upstream's
// `resolveProxyGeo` (cloakbrowser 0.5.5 `js/src/geoip.ts`): read the GeoLite2 city record, take
// `location.time_zone` as the timezone and map `country.iso_code` through COUNTRY_LOCALE_MAP.
export type LaunchGeoDbLookup = {
  timezone?: string;
  locale?: string;
  countryCode?: string;
  /** Why the timezone/locale are absent. Never set when the record was found — a record that simply carries no `time_zone` leaves the field empty without claiming a failure. */
  reason?: LaunchGeoUnresolvedReason;
};

/** Resolves one IP against an already-loaded database. Split out so tests cover every branch without shipping a GeoLite2 fixture. */
export type LaunchGeoDbReader = (buffer: Buffer, ip: string) => CityResponse | null;

// Deliberately does not download the database. Upstream's `ensureGeoipDb()` fetches ~70MB on first
// use, which is right for a launch the operator asked for and wrong for a "what would this proxy
// give me" question — so a missing database is reported, not silently repaired. The file is populated
// by the first `geoip: true` launch, whose download already routes through the configured GitHub
// mirror (see githubMirrorFetch).
//
// Never throws, matching upstream: a GeoIP hiccup must not take down the exit-IP answer, which is
// useful on its own and is resolved before this is ever called.
export async function readLaunchGeoFromDb(
  dbPath: string | undefined,
  ip: string,
  read: LaunchGeoDbReader = readCityRecord,
): Promise<LaunchGeoDbLookup> {
  if (!dbPath) return { reason: "geoip-db-missing" };

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(dbPath);
  } catch (error) {
    // A database that is not there yet and one that is there but unreadable lead to different fixes —
    // launch once with geoip on, versus clear the cache — so they stay distinguishable.
    return { reason: isMissingFileError(error) ? "geoip-db-missing" : "geoip-db-unreadable" };
  }

  let record: CityResponse | null;
  try {
    record = read(buffer, ip);
  } catch {
    // A truncated or corrupt download parses as garbage rather than failing to open.
    return { reason: "geoip-db-unreadable" };
  }

  // The database resolved fine, this exit is just not in it. Retrying changes nothing, which is why
  // this is not folded into "unreadable".
  if (!record) return { reason: "ip-not-in-db" };

  return launchGeoFromCityRecord(record);
}

// A record with neither field is not an error: upstream returns null timezone and locale and lets the
// launch proceed without them, so the panel reports the same nothing rather than inventing a fallback.
export function launchGeoFromCityRecord(record: CityResponse): LaunchGeoDbLookup {
  const countryCode = record.country?.iso_code ?? undefined;
  return {
    timezone: record.location?.time_zone ?? undefined,
    locale: localeForCountryCode(countryCode),
    countryCode,
  };
}

function readCityRecord(buffer: Buffer, ip: string): CityResponse | null {
  return new Reader<CityResponse>(buffer).get(ip);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}
