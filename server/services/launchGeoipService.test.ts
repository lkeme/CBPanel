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

test("an unset database path fails the launch GeoIP resolution", async () => {
  await assert.rejects(
    readLaunchGeoFromDb(undefined, "1.1.1.1"),
    (error) => {
      assert.equal((error as { code?: string }).code, "GEOIP_RESOLUTION_FAILED");
      assert.match((error as Error).message, /database is unavailable/);
      return true;
    },
  );
});

test("a database path that does not exist fails the launch GeoIP resolution", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cbp-launch-geoip-"));
  await assert.rejects(readLaunchGeoFromDb(path.join(dir, "absent.mmdb"), "1.1.1.1"), /database is unavailable/);
});

// A truncated download opens fine and fails while parsing, so the guard cannot be a file-exists check.
test("a database the reader cannot parse fails the launch GeoIP resolution", async () => {
  const dbPath = await tempDbPath("not an mmdb");
  await assert.rejects(readLaunchGeoFromDb(dbPath, "1.1.1.1"), /GeoIP lookup failed for 1\.1\.1\.1/);
});

test("an IP the database does not cover fails the launch GeoIP resolution", async () => {
  const dbPath = await tempDbPath("stub");
  await assert.rejects(readLaunchGeoFromDb(dbPath, "10.0.0.1", () => null), /address is not in the database/);
});

test("a resolved record yields the timezone and the locale upstream would inject", async () => {
  const dbPath = await tempDbPath("stub");
  const result = await readLaunchGeoFromDb(dbPath, "203.0.113.7", () =>
    cityRecord({ country: { iso_code: "JP" }, location: { time_zone: "Asia/Tokyo" } } as Partial<CityResponse>),
  );
  assert.deepEqual(result, { timezone: "Asia/Tokyo", locale: "ja-JP", countryCode: "JP" });
});

test("a record missing timezone and country fails the launch GeoIP resolution", () => {
  assert.throws(() => launchGeoFromCityRecord(cityRecord({})), /could not determine timezone and locale/);
});

test("a record missing either timezone or locale fails the launch GeoIP resolution", () => {
  assert.throws(
    () => launchGeoFromCityRecord(cityRecord({ location: { time_zone: "Europe/Berlin" } } as Partial<CityResponse>)),
    /could not determine locale/,
  );
  assert.throws(
    () => launchGeoFromCityRecord(cityRecord({ country: { iso_code: "DE" } } as Partial<CityResponse>)),
    /could not determine timezone/,
  );
});

test("a country outside the locale table fails the launch GeoIP resolution", () => {
  assert.throws(
    () => launchGeoFromCityRecord(
      cityRecord({ country: { iso_code: "ZZ" }, location: { time_zone: "Etc/UTC" } } as Partial<CityResponse>),
    ),
    /could not determine locale/,
  );
});
