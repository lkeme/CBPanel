import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, Zip, ZipDeflate, zipSync, type Zippable } from "fflate";
import {
  analyzeAndStageBoundedZip,
  ExtensionArchiveAnalysisError,
  fingerprintStagedExtensionTree,
  type ExtensionArchiveErrorCode,
} from "./boundedZipAnalyzer";

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;

test("bounded analyzer validates before streaming a byte/file-range ZIP into staging", async (t) => {
  const directory = await temporaryDirectory(t);
  const zip = extensionZip({
    "nested/": [new Uint8Array(), { level: 6 }],
    "nested/content.js": strToU8("console.log('bounded')"),
    "nested/manifest.json": manifestBytes(),
  });
  const wrapped = Buffer.concat([Buffer.from("verified-crx-prefix"), Buffer.from(zip), Buffer.from("ignored-tail")]);
  const archivePath = path.join(directory, "package.crx");
  await fs.writeFile(archivePath, wrapped);
  const outputDir = path.join(directory, "stage");

  const result = await analyzeAndStageBoundedZip({
    archivePath,
    archiveOffset: Buffer.byteLength("verified-crx-prefix"),
    archiveLength: zip.byteLength,
    outputDir,
  });

  assert.equal(result.archiveBytes, zip.byteLength);
  assert.equal(result.entryCount, 3);
  assert.equal(result.filesystemNodeCount, 3);
  assert.equal(result.fileCount, 2);
  assert.equal(result.stagedFileCount, 2);
  assert.equal(result.stagedRoot, path.join(outputDir, "nested"));
  assert.equal(result.manifestRelativePath, "nested/manifest.json");
  assert.match(result.treeSha256, /^[0-9a-f]{64}$/);
  assert.equal(await fs.readFile(path.join(result.stagedRoot, "content.js"), "utf8"), "console.log('bounded')");

  const repeated = await fingerprintStagedExtensionTree(result.stagedRoot);
  assert.equal(repeated.sha256, result.treeSha256);
  await fs.writeFile(path.join(result.stagedRoot, "content.js"), "changed");
  const contentChanged = await fingerprintStagedExtensionTree(result.stagedRoot);
  assert.notEqual(contentChanged.sha256, result.treeSha256);
  await fs.mkdir(path.join(result.stagedRoot, "empty-directory"));
  const directoryChanged = await fingerprintStagedExtensionTree(result.stagedRoot);
  assert.notEqual(directoryChanged.sha256, contentChanged.sha256, "empty directories belong to staged-tree evidence");
  assert.equal(directoryChanged.filesystemNodeCount, contentChanged.filesystemNodeCount + 1);
});

test("bounded analyzer rejects unsafe cross-platform entry paths before creating staging", async (t) => {
  const directory = await temporaryDirectory(t);
  const unsafePaths = [
    "../escaped.txt",
    "/absolute.txt",
    "C:/drive.txt",
    "//server/share.txt",
    "folder\\backslash.txt",
    "folder/file.txt:stream",
    "CON.txt",
    "folder/trailing.",
    "folder/trailing ",
    "folder//empty.txt",
  ];

  for (const [index, unsafePath] of unsafePaths.entries()) {
    const outputDir = path.join(directory, `stage-${index}`);
    await expectArchiveCode(
      analyzeAndStageBoundedZip({
        zipBytes: extensionZip({
          "manifest.json": manifestBytes(),
          [unsafePath]: strToU8("unsafe"),
        }),
        outputDir,
      }),
      "EXTENSION_ARCHIVE_PATH_UNSAFE",
    );
    assert.equal(await exists(outputDir), false);
  }
  assert.equal(await exists(path.join(directory, "escaped.txt")), false);
});

test("bounded analyzer rejects normalized, case-insensitive, and file/directory collisions", async (t) => {
  const directory = await temporaryDirectory(t);
  const cases: Zippable[] = [
    {
      "manifest.json": manifestBytes(),
      "Icon.png": strToU8("one"),
      "icon.png": strToU8("two"),
    },
    {
      "manifest.json": manifestBytes(),
      "é.txt": strToU8("one"),
      "e\u0301.txt": strToU8("two"),
    },
    {
      "manifest.json": manifestBytes(),
      collision: strToU8("file"),
      "collision/child.txt": strToU8("child"),
    },
  ];

  for (const [index, entries] of cases.entries()) {
    await expectArchiveCode(
      analyzeAndStageBoundedZip({
        zipBytes: extensionZip(entries),
        outputDir: path.join(directory, `collision-${index}`),
      }),
      "EXTENSION_ARCHIVE_PATH_COLLISION",
    );
  }
});

test("bounded analyzer rejects symlink, special, reparse, and shared-offset link entries", async (t) => {
  const directory = await temporaryDirectory(t);
  const unsafeAttributes = [
    { os: 3, attrs: (0o120777 << 16) >>> 0 },
    { os: 3, attrs: (0o010644 << 16) >>> 0 },
    { os: 0, attrs: 0x400 },
  ];
  for (const [index, attributes] of unsafeAttributes.entries()) {
    await expectArchiveCode(
      analyzeAndStageBoundedZip({
        zipBytes: extensionZip({
          "manifest.json": manifestBytes(),
          unsafe: [strToU8("target"), attributes],
        }),
        outputDir: path.join(directory, `node-${index}`),
      }),
      "EXTENSION_ARCHIVE_LINK_FORBIDDEN",
    );
  }

  const sharedOffset = Buffer.from(extensionZip({
    "manifest.json": manifestBytes(),
    "other.txt": strToU8("other"),
  }));
  const centralHeaders = signatureOffsets(sharedOffset, CENTRAL_HEADER_SIGNATURE);
  assert.equal(centralHeaders.length, 2);
  sharedOffset.writeUInt32LE(0, centralHeaders[1]! + 42);
  await expectArchiveCode(
    analyzeAndStageBoundedZip({ zipBytes: sharedOffset, outputDir: path.join(directory, "shared") }),
    "EXTENSION_ARCHIVE_LINK_FORBIDDEN",
  );
});

test("bounded analyzer rejects encrypted, unsupported, corrupt, and truncated ZIP records", async (t) => {
  const directory = await temporaryDirectory(t);

  const encrypted = Buffer.from(extensionZip({ "manifest.json": manifestBytes() }));
  patchEveryHeader(encrypted, { localOffset: 6, centralOffset: 8, value: 1, width: 2 });
  await expectArchiveCode(
    analyzeAndStageBoundedZip({ zipBytes: encrypted, outputDir: path.join(directory, "encrypted") }),
    "EXTENSION_ARCHIVE_ENCRYPTED",
  );

  const unsupported = Buffer.from(extensionZip({ "manifest.json": manifestBytes() }));
  patchEveryHeader(unsupported, { localOffset: 8, centralOffset: 10, value: 99, width: 2 });
  await expectArchiveCode(
    analyzeAndStageBoundedZip({ zipBytes: unsupported, outputDir: path.join(directory, "unsupported") }),
    "EXTENSION_ARCHIVE_UNSUPPORTED",
  );

  const badCrc = Buffer.from(extensionZip({ "manifest.json": manifestBytes() }));
  const local = signatureOffsets(badCrc, LOCAL_HEADER_SIGNATURE)[0]!;
  const central = signatureOffsets(badCrc, CENTRAL_HEADER_SIGNATURE)[0]!;
  const wrongCrc = (badCrc.readUInt32LE(local + 14) ^ 0xffffffff) >>> 0;
  badCrc.writeUInt32LE(wrongCrc, local + 14);
  badCrc.writeUInt32LE(wrongCrc, central + 16);
  const corruptStage = path.join(directory, "corrupt");
  await expectArchiveCode(
    analyzeAndStageBoundedZip({ zipBytes: badCrc, outputDir: corruptStage }),
    "EXTENSION_ARCHIVE_INVALID",
  );
  assert.equal(await exists(corruptStage), false);

  const valid = extensionZip({ "manifest.json": manifestBytes() });
  await expectArchiveCode(
    analyzeAndStageBoundedZip({
      zipBytes: valid.subarray(0, valid.byteLength - 5),
      outputDir: path.join(directory, "truncated"),
    }),
    "EXTENSION_ARCHIVE_INVALID",
  );

  const zip64Sentinel = Buffer.from(valid);
  const zip64Eocd = signatureOffsets(zip64Sentinel, 0x06054b50).at(-1)!;
  zip64Sentinel.writeUInt16LE(0xffff, zip64Eocd + 8);
  zip64Sentinel.writeUInt16LE(0xffff, zip64Eocd + 10);
  await expectArchiveCode(
    analyzeAndStageBoundedZip({ zipBytes: zip64Sentinel, outputDir: path.join(directory, "zip64-sentinel") }),
    "EXTENSION_ARCHIVE_UNSUPPORTED",
  );

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  const zip64Locator = Buffer.concat([
    Buffer.from(valid).subarray(0, zip64Eocd),
    locator,
    Buffer.from(valid).subarray(zip64Eocd),
  ]);
  await expectArchiveCode(
    analyzeAndStageBoundedZip({ zipBytes: zip64Locator, outputDir: path.join(directory, "zip64-locator") }),
    "EXTENSION_ARCHIVE_UNSUPPORTED",
  );

  const unicodeExtra = unicodePathExtra("manifest.json", "manifest.json");
  const unicodeMismatch = Buffer.from(zipSync({
    "manifest.json": [manifestBytes(), { extra: { 0x7075: unicodeExtra } }],
  }));
  const unicodeLocal = signatureOffsets(unicodeMismatch, LOCAL_HEADER_SIGNATURE)[0]!;
  const unicodeLocalNameLength = unicodeMismatch.readUInt16LE(unicodeLocal + 26);
  const unicodeLocalExtra = unicodeLocal + 30 + unicodeLocalNameLength;
  unicodeMismatch[unicodeLocalExtra + 4 + 5] = "x".charCodeAt(0);
  await expectArchiveCode(
    analyzeAndStageBoundedZip({ zipBytes: unicodeMismatch, outputDir: path.join(directory, "unicode-mismatch") }),
    "EXTENSION_ARCHIVE_INVALID",
  );
});

test("bounded analyzer applies every configured count, byte, ratio, path, depth, and disk limit", async (t) => {
  const directory = await temporaryDirectory(t);
  const scenarios: Array<{
    name: string;
    bytes: Uint8Array;
    limits: Parameters<typeof analyzeAndStageBoundedZip>[0]["limits"];
  }> = [
    {
      name: "archive-bytes-before-snapshot",
      bytes: extensionZip({ "manifest.json": manifestBytes() }),
      limits: { maxArchiveBytes: 16 },
    },
    {
      name: "entries",
      bytes: extensionZip({ "manifest.json": manifestBytes(), "a.txt": strToU8("a") }),
      limits: { maxEntries: 1 },
    },
    {
      name: "filesystem-nodes",
      bytes: extensionZip({ "manifest.json": manifestBytes(), "a/b/c.txt": strToU8("x") }),
      limits: { maxFilesystemNodes: 3 },
    },
    {
      name: "filesystem-prefix-bytes",
      bytes: extensionZip({ "manifest.json": manifestBytes(), "long-prefix/child.txt": strToU8("x") }),
      limits: { maxFilesystemPathBytes: 16 },
    },
    {
      name: "per-file",
      bytes: extensionZip({ "manifest.json": manifestBytes() }),
      limits: { maxFileExpandedBytes: 10 },
    },
    {
      name: "expanded-total",
      bytes: extensionZip({ "manifest.json": manifestBytes() }),
      limits: { maxTotalExpandedBytes: 10 },
    },
    {
      name: "ratio",
      bytes: extensionZip({ "manifest.json": manifestBytes(), "zeros.bin": new Uint8Array(100_000) }),
      limits: { maxCompressionRatio: 2 },
    },
    {
      name: "path-bytes",
      bytes: extensionZip({ "manifest.json": manifestBytes(), "long-name.txt": strToU8("x") }),
      limits: { maxPathBytes: 8 },
    },
    {
      name: "path-depth",
      bytes: extensionZip({ "manifest.json": manifestBytes(), "a/b/c.txt": strToU8("x") }),
      limits: { maxPathDepth: 2 },
    },
    {
      name: "manifest-depth",
      bytes: extensionZip({ "a/b/manifest.json": manifestBytes() }),
      limits: { maxManifestSearchDepth: 1 },
    },
    {
      name: "manifest-bytes",
      bytes: extensionZip({ "manifest.json": manifestBytes() }),
      limits: { maxManifestBytes: 10 },
    },
    {
      name: "locale-messages-bytes",
      bytes: extensionZip({
        "manifest.json": manifestBytes({ name: "__MSG_name__", default_locale: "en" }),
        "_locales/en/messages.json": strToU8("x".repeat(100)),
      }),
      limits: { maxLocaleMessagesBytes: 10 },
    },
    {
      name: "temp-disk",
      bytes: extensionZip({ "manifest.json": manifestBytes() }),
      limits: { maxTemporaryDiskBytes: 100 },
    },
  ];

  for (const scenario of scenarios) {
    await expectArchiveCode(
      analyzeAndStageBoundedZip({
        zipBytes: scenario.bytes,
        outputDir: path.join(directory, scenario.name),
        limits: scenario.limits,
      }),
      "EXTENSION_ARCHIVE_LIMIT_EXCEEDED",
    );
  }
});

test("bounded analyzer requires one exact unambiguous Manifest and preserves caller-owned nonempty stages", async (t) => {
  const directory = await temporaryDirectory(t);
  await expectArchiveCode(
    analyzeAndStageBoundedZip({
      zipBytes: extensionZip({ "readme.txt": strToU8("none") }),
      outputDir: path.join(directory, "missing"),
    }),
    "EXTENSION_ARCHIVE_MANIFEST_MISSING",
  );
  await expectArchiveCode(
    analyzeAndStageBoundedZip({
      zipBytes: extensionZip({
        "manifest.json": manifestBytes(),
        "nested/manifest.json": manifestBytes(),
      }),
      outputDir: path.join(directory, "ambiguous"),
    }),
    "EXTENSION_ARCHIVE_MANIFEST_AMBIGUOUS",
  );
  await expectArchiveCode(
    analyzeAndStageBoundedZip({
      zipBytes: extensionZip({ "Manifest.json": manifestBytes() }),
      outputDir: path.join(directory, "wrong-case"),
    }),
    "EXTENSION_ARCHIVE_MANIFEST_MISSING",
  );

  const nonemptyStage = path.join(directory, "caller-stage");
  await fs.mkdir(nonemptyStage);
  await fs.writeFile(path.join(nonemptyStage, "owned.txt"), "keep");
  await expectArchiveCode(
    analyzeAndStageBoundedZip({
      zipBytes: extensionZip({ "manifest.json": manifestBytes() }),
      outputDir: nonemptyStage,
    }),
    "EXTENSION_ARCHIVE_STAGE_INVALID",
  );
  assert.equal(await fs.readFile(path.join(nonemptyStage, "owned.txt"), "utf8"), "keep");
});

test("bounded analyzer honors cancellation before taking staging ownership", async (t) => {
  const directory = await temporaryDirectory(t);
  const controller = new AbortController();
  controller.abort();
  const outputDir = path.join(directory, "cancelled");
  await expectArchiveCode(
    analyzeAndStageBoundedZip({
      zipBytes: extensionZip({ "manifest.json": manifestBytes() }),
      outputDir,
      signal: controller.signal,
    }),
    "ACQUISITION_CANCELLED",
  );
  assert.equal(await exists(outputDir), false);
});

test("bounded analyzer snapshots caller-owned bytes before asynchronous analysis", async (t) => {
  const directory = await temporaryDirectory(t);
  const bytes = extensionZip({ "manifest.json": manifestBytes() });
  const pending = analyzeAndStageBoundedZip({
    zipBytes: bytes,
    outputDir: path.join(directory, "snapshot"),
  });
  bytes.fill(0);
  const result = await pending;
  assert.equal(result.fileCount, 1);
  assert.match(result.treeSha256, /^[0-9a-f]{64}$/);
});

test("bounded analyzer reclaims its stage when cancellation occurs during streamed extraction", async (t) => {
  const directory = await temporaryDirectory(t);
  const bytes = extensionZip({
    "manifest.json": manifestBytes(),
    "large.bin": [new Uint8Array(512 * 1024), { level: 0 }],
  });
  let reads = 0;
  const signal = {
    get aborted() {
      reads += 1;
      return reads >= 6;
    },
  } as AbortSignal;
  const outputDir = path.join(directory, "midstream-cancel");
  await expectArchiveCode(
    analyzeAndStageBoundedZip({ zipBytes: bytes, outputDir, signal }),
    "ACQUISITION_CANCELLED",
  );
  assert.ok(reads >= 6);
  assert.equal(await exists(outputDir), false);
});

test("bounded analyzer accepts signed and signatureless descriptors, including signature-valued CRC", async (t) => {
  const directory = await temporaryDirectory(t);
  const ambiguousCrcBytes = Uint8Array.of(0xac, 0x0a, 0x7a, 0xd5);
  const signed = await streamingZip([
    ["manifest.json", manifestBytes()],
    ["ambiguous.bin", ambiguousCrcBytes],
  ]);
  const signedResult = await analyzeAndStageBoundedZip({
    zipBytes: signed,
    outputDir: path.join(directory, "signed-descriptor"),
  });
  assert.equal(signedResult.fileCount, 2);

  const signatureless = removeLastDescriptorSignature(signed);
  const signaturelessResult = await analyzeAndStageBoundedZip({
    zipBytes: signatureless,
    outputDir: path.join(directory, "signatureless-descriptor"),
  });
  assert.equal(signaturelessResult.fileCount, 2);
  assert.deepEqual(
    await fs.readFile(path.join(signaturelessResult.stagedRoot, "ambiguous.bin")),
    Buffer.from(ambiguousCrcBytes),
  );
});

test("staged fingerprint rejects hard-linked files", async (t) => {
  const directory = await temporaryDirectory(t);
  const root = path.join(directory, "hardlink-tree");
  await fs.mkdir(root);
  const original = path.join(root, "original.txt");
  await fs.writeFile(original, "same inode");
  await fs.link(original, path.join(root, "linked.txt"));
  await expectArchiveCode(
    fingerprintStagedExtensionTree(root),
    "EXTENSION_ARCHIVE_LINK_FORBIDDEN",
  );
});

function extensionZip(entries: Zippable): Uint8Array {
  return zipSync(entries, { level: 6 });
}

function manifestBytes(overrides: Record<string, unknown> = {}): Uint8Array {
  return strToU8(JSON.stringify({
    name: "Bounded Extension",
    version: "1.2.3",
    manifest_version: 3,
    ...overrides,
  }));
}

function streamingZip(entries: Array<[string, Uint8Array]>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((error, chunk, final) => {
      if (error) {
        reject(error);
        return;
      }
      if (chunk) chunks.push(chunk);
      if (final) resolve(Buffer.concat(chunks.map((value) => Buffer.from(value))));
    });
    for (const [name, bytes] of entries) {
      const file = new ZipDeflate(name, { level: 6 });
      zip.add(file);
      file.push(bytes, true);
    }
    zip.end();
  });
}

function removeLastDescriptorSignature(bytes: Uint8Array): Uint8Array {
  const source = Buffer.from(bytes);
  const eocd = signatureOffsets(source, 0x06054b50).at(-1)!;
  const centralOffset = source.readUInt32LE(eocd + 16);
  const centralHeaders = signatureOffsets(source, CENTRAL_HEADER_SIGNATURE)
    .filter((offset) => offset >= centralOffset && offset < eocd);
  const lastCentral = centralHeaders.at(-1)!;
  const localOffset = source.readUInt32LE(lastCentral + 42);
  const localNameLength = source.readUInt16LE(localOffset + 26);
  const localExtraLength = source.readUInt16LE(localOffset + 28);
  const compressedSize = source.readUInt32LE(lastCentral + 20);
  const descriptorOffset = localOffset + 30 + localNameLength + localExtraLength + compressedSize;
  assert.equal(source.readUInt32LE(descriptorOffset), 0x08074b50);
  const output = Buffer.concat([
    source.subarray(0, descriptorOffset),
    source.subarray(descriptorOffset + 4),
  ]);
  const shiftedEocd = eocd - 4;
  output.writeUInt32LE(centralOffset - 4, shiftedEocd + 16);
  return output;
}

function unicodePathExtra(rawName: string, unicodeName: string): Uint8Array {
  const nameBytes = Buffer.from(unicodeName, "utf8");
  const output = Buffer.alloc(5 + nameBytes.byteLength);
  output[0] = 1;
  output.writeUInt32LE(testCrc32(Buffer.from(rawName, "ascii")), 1);
  nameBytes.copy(output, 5);
  return output;
}

function testCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function signatureOffsets(bytes: Uint8Array, signature: number): number[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsets: number[] = [];
  for (let offset = 0; offset <= buffer.byteLength - 4; offset += 1) {
    if (buffer.readUInt32LE(offset) === signature) offsets.push(offset);
  }
  return offsets;
}

function patchEveryHeader(
  bytes: Buffer,
  patch: { localOffset: number; centralOffset: number; value: number; width: 2 | 4 },
): void {
  for (const offset of signatureOffsets(bytes, LOCAL_HEADER_SIGNATURE)) {
    if (patch.width === 2) bytes.writeUInt16LE(patch.value, offset + patch.localOffset);
    else bytes.writeUInt32LE(patch.value, offset + patch.localOffset);
  }
  for (const offset of signatureOffsets(bytes, CENTRAL_HEADER_SIGNATURE)) {
    if (patch.width === 2) bytes.writeUInt16LE(patch.value, offset + patch.centralOffset);
    else bytes.writeUInt32LE(patch.value, offset + patch.centralOffset);
  }
}

async function expectArchiveCode(promise: Promise<unknown>, code: ExtensionArchiveErrorCode): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ExtensionArchiveAnalysisError);
    assert.equal(error.code, code);
    return true;
  });
}

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-bounded-zip-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
