import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import * as tar from "tar";

import { extractZipArchive, isSafeArchivePath, normalizeArchivePath, safeJoin } from "./archiveUtils";

const UNSAFE = "Archive contains an unsafe path.";

/** Minimal ustar header, so a test can write entry names and types that tar.create would normalize away. */
function tarHeader(name: string, size: number, typeflag = "0", linkname = ""): Buffer {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, 100, "utf8");
  block.write("0000777\0", 100, 8, "ascii");
  block.write("0000000\0", 108, 8, "ascii");
  block.write("0000000\0", 116, 8, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  block.write("00000000000\0", 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");
  block.write(typeflag, 156, 1, "ascii");
  block.write(linkname.slice(0, 100), 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function tarFileEntry(name: string, body: string): Buffer {
  const data = Buffer.from(body, "utf8");
  return Buffer.concat([tarHeader(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

async function tempDir(name: string): Promise<string> {
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "cbp-archive-")), name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await listFiles(path.join(root, entry.name), relative)));
    else found.push(relative);
  }
  return found.sort();
}

test("isSafeArchivePath accepts ordinary entry names", () => {
  for (const name of ["chrome.exe", "dir/file.txt", "locales/en-US.pak", "./chrome", "."]) {
    assert.equal(isSafeArchivePath(name), true, `expected ${name} to be accepted`);
  }
});

test("isSafeArchivePath treats a trailing slash as a directory marker, not an empty segment", () => {
  // Explorer, 7-Zip and `zip -r` all write explicit directory entries. Rejecting them made
  // extractZipArchive fail any third-party archive with a security-flavoured 400.
  for (const name of ["dir/", "nested/deep/dir/"]) {
    assert.equal(isSafeArchivePath(name), true, `expected ${name} to be accepted`);
  }
  assert.equal(normalizeArchivePath("dir/"), "dir/");
});

test("isSafeArchivePath rejects traversal, absolute and drive-qualified names", () => {
  const hostile = [
    "../escape",
    "a/../../b",
    "/abs/path",
    "C:/Windows/System32/x",
    // Drive-relative: not absolute, so path.isAbsolute misses it, but path.resolve would send it
    // to that drive's working directory.
    "c:evil.txt",
    // Interior empty segment is a malformed name rather than a directory marker.
    "dir//file",
    "",
  ];
  for (const name of hostile) {
    assert.equal(isSafeArchivePath(name), false, `expected ${name} to be rejected`);
  }
});

test("safeJoin resolves inside the root and rejects anything that escapes it", () => {
  const root = path.resolve("/tmp/extract-root");

  assert.equal(safeJoin(root, "dir/file.txt", UNSAFE), path.resolve(root, "dir/file.txt"));
  assert.equal(safeJoin(root, ".", UNSAFE), root);

  for (const name of ["../sibling.txt", "/etc/passwd", "c:evil.txt"]) {
    assert.throws(() => safeJoin(root, name, UNSAFE), (error: Error & { status?: number }) => {
      assert.equal(error.message, UNSAFE);
      assert.equal(error.status, 400);
      return true;
    }, `expected ${name} to be rejected`);
  }
});

test("extractZipArchive accepts an archive that carries explicit directory entries", async () => {
  const root = await tempDir("with-dir-entries");
  const archive = path.join(root, "backup.cbpb");
  const outputDir = path.join(root, "out");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    archive,
    zipSync({
      "manifest.json": strToU8('{"kind":"cbpanel.appBackup"}'),
      "browser-data/": new Uint8Array(0),
      "browser-data/Default/": new Uint8Array(0),
      "browser-data/Default/Preferences": strToU8("{}"),
    }),
  );

  await extractZipArchive(archive, outputDir, UNSAFE);

  assert.deepEqual(await listFiles(outputDir), ["browser-data/Default/Preferences", "manifest.json"]);
});

test("extractZipArchive refuses an archive that tries to traverse out of the output directory", async () => {
  const root = await tempDir("traversal");
  const archive = path.join(root, "hostile.cbpb");
  const outputDir = path.join(root, "out");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    archive,
    zipSync({ "manifest.json": strToU8("{}"), "../escaped.txt": strToU8("pwned") }),
  );

  await assert.rejects(
    () => extractZipArchive(archive, outputDir, UNSAFE),
    (error: Error & { status?: number }) => {
      assert.equal(error.message, UNSAFE);
      assert.equal(error.status, 400);
      return true;
    },
  );
  assert.equal(
    await fs.access(path.join(root, "escaped.txt")).then(() => true, () => false),
    false,
    "the traversal target must not exist",
  );
});

// A path guard structurally cannot stop these: `link` and `link/payload.txt` are innocent names. What
// stops them is tar not writing through a link, which is an undocumented dependency of binaryService's
// extractTarArchive, so these two tests make it a contract that a tar upgrade would have to keep.
//
// They assert only that nothing lands outside the output directory. How tar gets there varies with
// platform privilege and must not be asserted: creating a symlink on Windows needs Developer Mode or
// elevation, so an unprivileged run sees the link entry fail and become a real directory, while a CI
// runner with the privilege sees the symlink created and the write through it withheld. Both are safe;
// only the resulting node type differs.
async function pathExistsForTest(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false);
}

test("tar does not write outside the output directory through a link entry in the archive", async () => {
  const root = await tempDir("tar-symlink-entry");
  const outputDir = path.join(root, "out");
  const outsideDir = path.join(root, "outside");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });

  const archive = path.join(root, "hostile.tar");
  await fs.writeFile(
    archive,
    Buffer.concat([
      tarHeader("link", 0, "2", outsideDir.replace(/\\/g, "/")),
      tarFileEntry("link/payload.txt", "must not land outside"),
      Buffer.alloc(1024),
    ]),
  );

  await tar.extract({ file: archive, cwd: outputDir });

  assert.deepEqual(await fs.readdir(outsideDir), [], "nothing may be written outside the output directory");
  assert.equal(await pathExistsForTest(path.join(outsideDir, "payload.txt")), false);
});

test("tar does not write outside the output directory through a link already sitting in the target", async () => {
  const root = await tempDir("tar-symlink-existing");
  const outputDir = path.join(root, "out");
  const outsideDir = path.join(root, "outside");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  // A junction, not a symlink: Windows creates those without elevation, so this variant — the output
  // path already being a link out of the tree — is reachable on every runner.
  await fs.symlink(outsideDir, path.join(outputDir, "link"), "junction");

  const archive = path.join(root, "hostile.tar");
  await fs.writeFile(
    archive,
    Buffer.concat([tarFileEntry("link/payload.txt", "must not land outside"), Buffer.alloc(1024)]),
  );

  await tar.extract({ file: archive, cwd: outputDir });

  assert.deepEqual(await fs.readdir(outsideDir), [], "nothing may be written outside the output directory");
  assert.equal(await pathExistsForTest(path.join(outsideDir, "payload.txt")), false);
});
