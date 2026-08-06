import assert from "node:assert/strict";
import test from "node:test";

import type { NetworkCheckResult } from "./entities";
import type { LaunchGeoUnresolvedReason } from "./launchGeoip";
import { buildNetworkCheckSuccessParts, launchGeoSummaryText, networkCheckSummaryText } from "./networkCheckDisplay";
import { formatRegionLabel } from "./regionDisplay";

test("formatRegionLabel preserves non-ISO location strings", () => {
  assert.equal(formatRegionLabel("Singapore / Singapore", "zh-CN"), "Singapore / Singapore");
});

test("buildNetworkCheckSuccessParts keeps ip region colo latency order and supports flags", () => {
  const check = {
    checkedAt: "2026-07-03T00:00:00.000Z",
    ok: true,
    ip: "203.0.113.42",
    latencyMs: 88,
    trace: {
      providerId: "cloudflare-www",
      providerName: "Cloudflare",
      providerUrl: "https://www.cloudflare.com/cdn-cgi/trace",
      loc: "SG",
      colo: "SIN",
    },
  } satisfies NetworkCheckResult;

  assert.deepEqual(buildNetworkCheckSuccessParts(check, { includeFlag: true, locale: "zh-CN" }), [
    "203.0.113.42",
    "🇸🇬 新加坡 (SG)",
    "SIN",
    "88ms",
  ]);
});

test("networkCheckSummaryText prefers localized country codes over raw country names and omits timezone", () => {
  const check = {
    checkedAt: "2026-07-03T00:00:00.000Z",
    ok: true,
    ip: "203.0.113.42",
    geo: {
      countryCode: "JP",
      countryName: "Japan",
      timezone: "Asia/Tokyo",
      locale: "ja-JP",
    },
  } satisfies NetworkCheckResult;

  assert.equal(
    networkCheckSummaryText(check, { includeFlag: true, includeLatency: false, locale: "zh-CN" }),
    "203.0.113.42 · 🇯🇵 日本 (JP)",
  );
  assert.equal(
    networkCheckSummaryText(check, { includeFlag: false, includeLatency: false, locale: "zh-CN", separator: " / " }),
    "203.0.113.42 / 日本 (JP)",
  );
});

test("networkCheckSummaryText can prefix failure summaries with emoji", () => {
  const check = {
    checkedAt: "2026-07-03T00:00:00.000Z",
    ok: false,
    error: "代理出口检测失败",
  } satisfies NetworkCheckResult;

  assert.equal(
    networkCheckSummaryText(check, { failedText: "检测失败", failurePrefix: "❌" }),
    "❌ 代理出口检测失败",
  );
});

const LAUNCH_GEO_OPTIONS = {
  emptyText: "未解析",
  failedText: "解析失败",
  labels: { exitIp: "出口 IP", timezone: "时区", locale: "语言" },
  reasonText: (reason: LaunchGeoUnresolvedReason) => `reason:${reason}`,
};

// Three labelled values, not a region and a latency: the operator is checking that a launch will inject a
// timezone and locale matching the exit, so each has to be readable on its own.
test("launchGeoSummaryText labels the exit IP, timezone and locale", () => {
  const check = {
    checkedAt: "2026-08-06T00:00:00.000Z",
    ok: true,
    ip: "203.0.113.42",
    geo: { countryCode: "JP", timezone: "Asia/Tokyo", locale: "ja-JP" },
    source: "launch-geoip",
  } satisfies NetworkCheckResult;

  assert.equal(
    launchGeoSummaryText(check, LAUNCH_GEO_OPTIONS),
    "出口 IP: 203.0.113.42 · 时区: Asia/Tokyo · 语言: ja-JP",
  );
});

// The exit IP resolved and the database did not answer. Dropping the IP for the reason would throw away
// the half that did work — and behind a proxy that half is what WebRTC uses.
test("launchGeoSummaryText keeps the exit IP alongside the unresolved reason", () => {
  const check = {
    checkedAt: "2026-08-06T00:00:00.000Z",
    ok: true,
    ip: "198.51.100.7",
    source: "launch-geoip",
    geoUnresolvedReason: "geoip-db-missing",
  } satisfies NetworkCheckResult;

  assert.equal(
    launchGeoSummaryText(check, LAUNCH_GEO_OPTIONS),
    "出口 IP: 198.51.100.7 · reason:geoip-db-missing",
  );
});

test("launchGeoSummaryText omits the values that did not resolve", () => {
  const check = {
    checkedAt: "2026-08-06T00:00:00.000Z",
    ok: true,
    ip: "198.51.100.7",
    geo: { timezone: "Europe/Berlin" },
    source: "launch-geoip",
  } satisfies NetworkCheckResult;

  assert.equal(launchGeoSummaryText(check, LAUNCH_GEO_OPTIONS), "出口 IP: 198.51.100.7 · 时区: Europe/Berlin");
});

test("launchGeoSummaryText reports a failed resolution and an absent one differently", () => {
  assert.equal(launchGeoSummaryText(undefined, LAUNCH_GEO_OPTIONS), "未解析");
  assert.equal(
    launchGeoSummaryText(
      { checkedAt: "2026-08-06T00:00:00.000Z", ok: false, error: "代理连接已关闭" } satisfies NetworkCheckResult,
      LAUNCH_GEO_OPTIONS,
    ),
    "代理连接已关闭",
  );
  assert.equal(
    launchGeoSummaryText(
      { checkedAt: "2026-08-06T00:00:00.000Z", ok: false } satisfies NetworkCheckResult,
      LAUNCH_GEO_OPTIONS,
    ),
    "解析失败",
  );
});
