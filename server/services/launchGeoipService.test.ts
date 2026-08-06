import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CityResponse } from "mmdb-lib";

import { launchGeoFromCityRecord, readLaunchGeoFromDb } from "./launchGeoipService";

async function tempDbPath(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cbp-launch-geoip-"));
  const dbPath = path.join(dir, "GeoLite2-City.mmdb");
  await fs.writeFile(dbPath, contents, "utf8");
  return dbPath;
}

function cityRecord(patch: Partial<CityResponse>): CityResponse {
  return patch as CityResponse;
}

// A missing database is the state a fresh install is in — nothing has run `geoip: true` yet. It has to
// be distinguishable from a corrupt one because the fixes differ, and it must never be reported as a
// hard failure: the caller still has a real exit IP to show.
test("an unset database path reports geoip-db-missing", async () => {
  assert.deepEqual(await readLaunchGeoFromDb(undefined, "1.1.1.1"), { reason: "geoip-db-missing" });
});

test("a database path that does not exist reports geoip-db-missing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cbp-launch-geoip-"));
  const result = await readLaunchGeoFromDb(path.join(dir, "absent.mmdb"), "1.1.1.1");
  assert.deepEqual(result, { reason: "geoip-db-missing" });
});

// A truncated download opens fine and fails while parsing, so the guard cannot be a file-exists check.
test("a database the reader cannot parse reports geoip-db-unreadable", async () => {
  const dbPath = await tempDbPath("not an mmdb");
  const result = await readLaunchGeoFromDb(dbPath, "1.1.1.1");
  assert.deepEqual(result, { reason: "geoip-db-unreadable" });
});

// Distinct from "unreadable" on purpose: the database is fine, this exit is simply not in it, and
// retrying will not change that.
test("an IP the database does not cover reports ip-not-in-db", async () => {
  const dbPath = await tempDbPath("stub");
  const result = await readLaunchGeoFromDb(dbPath, "10.0.0.1", () => null);
  assert.deepEqual(result, { reason: "ip-not-in-db" });
});

test("a resolved record yields the timezone and the locale upstream would inject", async () => {
  const dbPath = await tempDbPath("stub");
  const result = await readLaunchGeoFromDb(dbPath, "203.0.113.7", () =>
    cityRecord({ country: { iso_code: "JP" }, location: { time_zone: "Asia/Tokyo" } } as Partial<CityResponse>),
  );
  assert.deepEqual(result, { timezone: "Asia/Tokyo", locale: "ja-JP", countryCode: "JP" });
});

// Upstream returns nulls and lets the launch continue; the panel reports the same nothing rather than
// claiming a failure the browser will not experience.
test("a record missing timezone and country is not treated as a failure", () => {
  assert.deepEqual(launchGeoFromCityRecord(cityRecord({})), {
    timezone: undefined,
    locale: undefined,
    countryCode: undefined,
  });
});

// The two fields come from different parts of the record, so one being absent must not blank the other.
test("timezone and locale resolve independently of each other", () => {
  assert.deepEqual(
    launchGeoFromCityRecord(cityRecord({ location: { time_zone: "Europe/Berlin" } } as Partial<CityResponse>)),
    { timezone: "Europe/Berlin", locale: undefined, countryCode: undefined },
  );
  assert.deepEqual(
    launchGeoFromCityRecord(cityRecord({ country: { iso_code: "DE" } } as Partial<CityResponse>)),
    { timezone: undefined, locale: "de-DE", countryCode: "DE" },
  );
});

// An exit in a country outside upstream's table keeps its timezone — the locale is what is uncovered,
// and dropping the timezone with it would lose a value the launch does apply.
test("a country outside the table keeps the timezone and leaves the locale unset", () => {
  assert.deepEqual(
    launchGeoFromCityRecord(
      cityRecord({ country: { iso_code: "ZZ" }, location: { time_zone: "Etc/UTC" } } as Partial<CityResponse>),
    ),
    { timezone: "Etc/UTC", locale: undefined, countryCode: "ZZ" },
  );
});
