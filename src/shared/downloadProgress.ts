const KIB = 1024;

/**
 * A byte count the way a download reports it: whole units with one decimal, which is the precision a
 * transfer rate needs and a size does not, and the trailing `.0` is dropped so a round number reads as
 * one. Values below a kibibyte stay in bytes so the first moments of a download do not read as "0.0 KB".
 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < KIB) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / KIB;
  let unit = 0;
  while (scaled >= KIB && unit < units.length - 1) {
    scaled /= KIB;
    unit += 1;
  }
  const digits = scaled >= 100 ? 0 : 1;
  return `${Number(scaled.toFixed(digits))} ${units[unit]}`;
}

/** The same scale with the rate suffix; no rate is not a zero rate, so it prints nothing. */
export function formatBytesPerSecond(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return `${formatBytes(value)}/s`;
}

/**
 * "45.2 / 180 MB · 12.3 MB/s" — the fields a download actually knows, and only those. An unknown total
 * drops the second half of the size; an unknown rate drops the rate. An empty string means there is
 * nothing to say, which is different from "0 B/s".
 */
export function downloadProgressDetail(input: {
  receivedBytes?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
}): string {
  const rate = formatBytesPerSecond(input.bytesPerSecond);
  const received = typeof input.receivedBytes === "number" && input.receivedBytes > 0 ? formatBytes(input.receivedBytes) : undefined;
  const total = typeof input.totalBytes === "number" && input.totalBytes > 0 ? formatBytes(input.totalBytes) : undefined;
  const size = received && total ? `${received} / ${total}` : received;
  return [size, rate].filter(Boolean).join(" · ");
}
