import { brotliCompressSync, gzipSync } from "node:zlib";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const distAssetsDir = path.resolve("dist/assets");
const baselinePath = path.resolve("scripts/baselines/frontend-bundle-baseline.json");

const args = new Set(process.argv.slice(2));
const update = args.has("--update");
const failOnChange = !update;
const defaultLimits = {
  perChunkBytes: 32 * 1024,
  roleBytes: 48 * 1024,
  entryBytes: 24 * 1024,
  entryGzipBytes: 8 * 1024,
  vendorRoleBytes: 96 * 1024,
};

function kb(bytes) {
  return Math.round((bytes / 1024) * 10) / 10;
}

function classifyChunk(fileName) {
  if (/^index-.*\.js$/.test(fileName)) return "entry";
  if (/vendor-.*\.js$/.test(fileName)) return "vendor";
  if (/ProfileEditorDrawer-.*\.js$/.test(fileName)) return "profile-editor";
  if (/RegistryModuleView-.*\.js$/.test(fileName)) return "registry-view";
  if (/RegistryDialogs-.*\.js$/.test(fileName)) return "registry-dialogs";
  if (/SettingsDrawer-.*\.js$/.test(fileName)) return "settings";
  if (/BrowserCoreImportDialog-.*\.js$/.test(fileName)) return "browser-core-import";
  if (/ColumnSettingsDrawer-.*\.js$/.test(fileName)) return "column-settings";
  return "other";
}

async function collectChunks() {
  let entries;
  try {
    entries = await readdir(distAssetsDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read ${distAssetsDir}. Run npm run build first. ${error instanceof Error ? error.message : String(error)}`);
  }

  const chunks = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const filePath = path.join(distAssetsDir, entry.name);
    const content = await readFile(filePath);
    chunks.push({
      file: entry.name,
      role: classifyChunk(entry.name),
      bytes: content.byteLength,
      gzipBytes: gzipSync(content).byteLength,
      brotliBytes: brotliCompressSync(content).byteLength,
    });
  }

  chunks.sort((left, right) => right.bytes - left.bytes || left.file.localeCompare(right.file));
  return chunks;
}

function summarize(chunks) {
  const byRole = new Map();
  for (const chunk of chunks) {
    const current = byRole.get(chunk.role) ?? {
      role: chunk.role,
      files: 0,
      bytes: 0,
      gzipBytes: 0,
      brotliBytes: 0,
    };
    current.files += 1;
    current.bytes += chunk.bytes;
    current.gzipBytes += chunk.gzipBytes;
    current.brotliBytes += chunk.brotliBytes;
    byRole.set(chunk.role, current);
  }
  return [...byRole.values()].sort((left, right) => right.bytes - left.bytes || left.role.localeCompare(right.role));
}

function report(baseline) {
  const rows = baseline.summary.map((item) => ({
    role: item.role,
    files: item.files,
    rawKB: kb(item.bytes),
    gzipKB: kb(item.gzipBytes),
    brotliKB: kb(item.brotliBytes),
  }));
  console.table(rows);
  const largest = baseline.chunks.slice(0, 10).map((chunk) => ({
    role: chunk.role,
    file: chunk.file,
    rawKB: kb(chunk.bytes),
    gzipKB: kb(chunk.gzipBytes),
    brotliKB: kb(chunk.brotliBytes),
  }));
  console.table(largest);
}

async function readExistingBaseline() {
  try {
    return JSON.parse(await readFile(baselinePath, "utf8"));
  } catch (error) {
    if (update) return null;
    throw new Error(`Cannot read ${path.relative(process.cwd(), baselinePath)}. Run npm run bundle:baseline:update after npm run build. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function byKey(items, key) {
  return new Map(items.map((item) => [item[key], item]));
}

function compareAgainstBaseline(current, previous) {
  if (!previous) return [];
  const limits = { ...defaultLimits, ...(previous.limits ?? {}) };
  const failures = [];
  const previousChunks = byKey(previous.chunks ?? [], "file");
  const previousSummary = byKey(previous.summary ?? [], "role");

  for (const chunk of current.chunks) {
    const old = previousChunks.get(chunk.file);
    if (!old) continue;
    const rawGrowth = chunk.bytes - old.bytes;
    if (rawGrowth > limits.perChunkBytes) {
      failures.push(`${chunk.file} grew by ${kb(rawGrowth)} KB raw; limit is ${kb(limits.perChunkBytes)} KB`);
    }
    if (chunk.role === "entry") {
      const gzipGrowth = chunk.gzipBytes - old.gzipBytes;
      if (rawGrowth > limits.entryBytes) {
        failures.push(`entry chunk ${chunk.file} grew by ${kb(rawGrowth)} KB raw; limit is ${kb(limits.entryBytes)} KB`);
      }
      if (gzipGrowth > limits.entryGzipBytes) {
        failures.push(`entry chunk ${chunk.file} grew by ${kb(gzipGrowth)} KB gzip; limit is ${kb(limits.entryGzipBytes)} KB`);
      }
    }
  }

  for (const summary of current.summary) {
    const old = previousSummary.get(summary.role);
    if (!old) continue;
    const limit = summary.role === "vendor"
      ? limits.vendorRoleBytes
      : summary.role === "entry"
        ? limits.entryBytes
        : limits.roleBytes;
    const rawGrowth = summary.bytes - old.bytes;
    if (rawGrowth > limit) {
      failures.push(`${summary.role} role grew by ${kb(rawGrowth)} KB raw; limit is ${kb(limit)} KB`);
    }
    if (summary.role === "entry") {
      const gzipGrowth = summary.gzipBytes - old.gzipBytes;
      if (gzipGrowth > limits.entryGzipBytes) {
        failures.push(`entry role grew by ${kb(gzipGrowth)} KB gzip; limit is ${kb(limits.entryGzipBytes)} KB`);
      }
    }
  }

  return failures;
}

const chunks = await collectChunks();
const previousBaseline = await readExistingBaseline();
const baseline = {
  generatedAt: new Date().toISOString(),
  tool: "scripts/check-bundle-baseline.mjs",
  limits: previousBaseline?.limits ?? defaultLimits,
  chunks,
  summary: summarize(chunks),
};

report(baseline);

const failures = compareAgainstBaseline(baseline, previousBaseline);

if (update) {
  const temporaryBaselinePath = `${baselinePath}.tmp`;
  await writeFile(temporaryBaselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  await rename(temporaryBaselinePath, baselinePath);
  console.log(`Updated ${path.relative(process.cwd(), baselinePath)}`);
} else if (failOnChange && failures.length > 0) {
  console.error("Bundle baseline check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("Run npm run bundle:baseline:update only after reviewing intentional chunk-boundary changes.");
  process.exitCode = 1;
} else {
  console.log("Bundle baseline check passed. Run npm run bundle:baseline:update after an intentional bundle-boundary change.");
}
