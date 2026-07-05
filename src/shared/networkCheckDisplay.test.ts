import assert from "node:assert/strict";
import test from "node:test";

import type { NetworkCheckResult } from "./entities";
import { buildNetworkCheckSuccessParts, networkCheckSummaryText } from "./networkCheckDisplay";
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
