import assert from "node:assert/strict";
import test from "node:test";

import { downloadProgressDetail, formatBytes, formatBytesPerSecond } from "./downloadProgress";

test("byte sizes use the unit a transfer is read in, with one decimal below a hundred", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(-5), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(180 * 1024 * 1024), "180 MB");
  assert.equal(formatBytes(1024 * 1024 * 1024 * 2), "2 GB");
});

test("a rate only prints when one was actually measured", () => {
  assert.equal(formatBytesPerSecond(undefined), undefined);
  assert.equal(formatBytesPerSecond(0), undefined);
  assert.equal(formatBytesPerSecond(Number.NaN), undefined);
  assert.equal(formatBytesPerSecond(1024 * 1024 * 12.34), "12.3 MB/s");});

// Every field is optional because a real download may know any combination of them; the detail line must
// never invent a zero for a number it was not given.
test("the detail line prints only the fields the transfer reported", () => {
  assert.equal(downloadProgressDetail({}), "");
  assert.equal(downloadProgressDetail({ receivedBytes: 1024 }), "1 KB");
  assert.equal(downloadProgressDetail({ receivedBytes: 1024, totalBytes: 4096 }), "1 KB / 4 KB");
  assert.equal(downloadProgressDetail({ totalBytes: 4096 }), "");
  assert.equal(downloadProgressDetail({ receivedBytes: 1024, bytesPerSecond: 2048 }), "1 KB · 2 KB/s");
  assert.equal(
    downloadProgressDetail({ receivedBytes: 45 * 1024 * 1024, totalBytes: 180 * 1024 * 1024, bytesPerSecond: 12 * 1024 * 1024 }),
    "45 MB / 180 MB · 12 MB/s",
  );
});
