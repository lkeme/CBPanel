import assert from "node:assert/strict";
import test from "node:test";

import { formatArchitecture, formatCopyrightYears, formatOperatingSystem } from "./aboutInfo";

test("the architecture is reported in the machine's own naming, not Node's abbreviation", () => {
  assert.equal(formatArchitecture("x64"), "x86_64");
  assert.equal(formatArchitecture("ia32"), "x86");
  assert.equal(formatArchitecture("arm64"), "arm64");
  // An architecture this table does not know is printed as-is rather than dropped or guessed.
  assert.equal(formatArchitecture("mips"), "mips");
  assert.equal(formatArchitecture(undefined), "-");
  assert.equal(formatArchitecture("  "), "-");
});

test("the operating system pairs its name with the release it names", () => {
  assert.equal(
    formatOperatingSystem({ os: "Windows_NT", arch: "x64", node: "v26.0.0", osName: "Windows 11 Enterprise", osVersion: "10.0.26300" }),
    "Windows 11 Enterprise (10.0.26300)",
  );
  // A payload from before osName/osVersion existed still names something.
  assert.equal(formatOperatingSystem({ os: "Windows_NT", arch: "x64", node: "v26.0.0" }), "Windows_NT");
  // A name that already carries the version is not repeated in parentheses.
  assert.equal(
    formatOperatingSystem({ os: "Linux", arch: "x64", node: "v26.0.0", osName: "Ubuntu 24.04 LTS", osVersion: "Ubuntu 24.04 LTS" }),
    "Ubuntu 24.04 LTS",
  );
  assert.equal(formatOperatingSystem(undefined), "-");
});

test("the copyright collapses to one year until the year rolls over", () => {
  assert.equal(formatCopyrightYears(2026, new Date("2026-06-01T00:00:00Z")), "2026");
  assert.equal(formatCopyrightYears(2026, new Date("2027-01-01T00:00:00Z")), "2026-2027");
  // A clock behind the release year still prints a single, valid year rather than a backwards range.
  assert.equal(formatCopyrightYears(2026, new Date("2025-12-31T00:00:00Z")), "2026");
});
