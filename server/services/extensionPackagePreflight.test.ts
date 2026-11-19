import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync, type Zippable } from "fflate";
import {
  ExtensionPackagePreflightError,
  preflightExtensionPackage,
} from "./extensionPackagePreflight";

test("package preflight returns localized Manifest, effective hosts, risks, icon, fingerprints, and discrepancies", async (t) => {
  const directory = await temporaryDirectory(t);
  const iconBytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const manifest = {
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    default_locale: "en",
    version: "1.2.3",
    manifest_version: 3,
    permissions: ["storage", "tabs", "https://mv2.example/*"],
    host_permissions: ["<all_urls>"],
    optional_permissions: ["cookies", "https://optional.example/*"],
    content_scripts: [{ matches: ["https://content.example/*"], js: ["content.js"] }],
    icons: { 16: "icons/16.png", 128: "/icons/128.png" },
  };
  const bytes = packageZip({
    "manifest.json": jsonBytes(manifest),
    "content.js": strToU8("void 0"),
    "icons/16.png": Uint8Array.of(1),
    "icons/128.png": iconBytes,
    "_locales/en/messages.json": jsonBytes({
      extensionName: { message: "Localized Extension" },
      extensionDescription: { message: "Localized description" },
    }),
  });

  const result = await preflightExtensionPackage({
    zipBytes: bytes,
    stagingDir: path.join(directory, "stage"),
    catalog: { name: "Catalog Name", version: "9.9.9" },
  });

  assert.equal(result.name, "Localized Extension");
  assert.equal(result.description, "Localized description");
  assert.equal(result.version, "1.2.3");
  assert.equal(result.manifestVersion, 3);
  assert.deepEqual(result.permissions, ["storage", "tabs"]);
  assert.deepEqual(result.hostPermissions, [
    "<all_urls>",
    "https://mv2.example/*",
    "https://content.example/*",
  ]);
  assert.deepEqual(result.optionalPermissions, ["cookies"]);
  assert.deepEqual(result.optionalHostPermissions, ["https://optional.example/*"]);
  assert.ok(result.permissionRisks.some((risk) => risk.permission === "tabs" && risk.level === "medium"));
  assert.ok(result.permissionRisks.some((risk) => risk.permission === "<all_urls>" && risk.level === "high"));
  assert.ok(result.permissionRisks.some((risk) => risk.permission === "cookies" && risk.optional === true));
  assert.deepEqual(result.icon, {
    relativePath: "icons/128.png",
    mimeType: "image/png",
    size: iconBytes.byteLength,
  });
  assert.deepEqual(result.discrepancies, [
    { field: "name", catalog: "Catalog Name", package: "Localized Extension" },
    { field: "version", catalog: "9.9.9", package: "1.2.3" },
  ]);
  assert.match(result.treeSha256, /^[0-9a-f]{64}$/);
  assert.match(result.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.entryCount, 5);
  assert.equal(result.fileCount, 5);
  assert.equal(result.stagedFileCount, 5);
  const stagedManifest = JSON.parse(await fs.readFile(path.join(result.stagedRoot, "manifest.json"), "utf8"));
  assert.equal(stagedManifest.key, undefined, "preflight must not inject a Manifest key");
});

test("Manifest fingerprint is canonical across JSON layout and ignores only the top-level key", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = await preflightExtensionPackage({
    zipBytes: packageZip({
      "manifest.json": strToU8('{"name":"Same","version":"1.0.0","manifest_version":3,"key":"first"}'),
    }),
    stagingDir: path.join(directory, "first"),
  });
  const second = await preflightExtensionPackage({
    zipBytes: packageZip({
      "manifest.json": strToU8('{\n  "manifest_version": 3,\n  "version": "1.0.0",\n  "name": "Same",\n  "key": "second"\n}'),
    }),
    stagingDir: path.join(directory, "second"),
  });

  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.notEqual(first.treeSha256, second.treeSha256, "tree evidence still covers exact staged files");
});

test("package preflight rejects malformed or semantically invalid Manifests and reclaims staging", async (t) => {
  const directory = await temporaryDirectory(t);
  const invalidManifests: Array<{ name: string; bytes: Uint8Array }> = [
    { name: "invalid-utf8", bytes: Uint8Array.of(0xff, 0xfe, 0xfd) },
    { name: "array", bytes: jsonBytes([]) },
    { name: "missing-name", bytes: jsonBytes({ version: "1.0.0", manifest_version: 3 }) },
    { name: "typed-name", bytes: jsonBytes({ name: {}, version: "1.0.0", manifest_version: 3 }) },
    { name: "leading-zero", bytes: jsonBytes({ name: "Bad", version: "01.0", manifest_version: 3 }) },
    { name: "all-zero", bytes: jsonBytes({ name: "Bad", version: "0.0.0", manifest_version: 3 }) },
    { name: "mv4", bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 4 }) },
    { name: "minimum-version", bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, minimum_chrome_version: "banana" }) },
    { name: "update-url-scheme", bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, update_url: "javascript:alert(1)" }) },
    { name: "update-url-userinfo", bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, update_url: "https://user@example.com/update" }) },
    { name: "mv3-csp-string", bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, content_security_policy: "script-src 'self'" }) },
    { name: "mv2-csp-object", bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 2, content_security_policy: { extension_pages: "script-src 'self'" } }) },
    { name: "icons-string", bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, icons: "icon.png" }) },
    { name: "background-number", bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, background: 7 }) },
    { name: "background-empty", bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, background: {} }) },
    { name: "action-number", bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, action: 7 }) },
    { name: "mv3-browser-action", bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, browser_action: {} }) },
    { name: "mv2-action", bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 2, action: {} }) },
    { name: "war-string", bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, web_accessible_resources: "x.js" }) },
    {
      name: "content-js-number",
      bytes: jsonBytes({
        name: "Bad",
        version: "1.0.0",
        manifest_version: 3,
        content_scripts: [{ matches: ["https://example.com/*"], js: "content.js" }],
      }),
    },
    {
      name: "content-missing-resource",
      bytes: jsonBytes({
        name: "Bad",
        version: "1.0.0",
        manifest_version: 3,
        content_scripts: [{ matches: ["https://example.com/*"], js: ["missing.js"] }],
      }),
    },
    {
      name: "permission-type",
      bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, permissions: [7] }),
    },
    {
      name: "content-matches",
      bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, content_scripts: [{}] }),
    },
    {
      name: "host-empty",
      bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, host_permissions: ["https://"] }),
    },
    {
      name: "host-extra-slash",
      bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, host_permissions: ["https:///x"] }),
    },
    {
      name: "host-missing-path",
      bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, host_permissions: ["https://example.com"] }),
    },
    {
      name: "host-invalid-wildcard",
      bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, host_permissions: ["https://*.example.*/*"] }),
    },
    {
      name: "host-port",
      bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 3, host_permissions: ["https://example.com:443/*"] }),
    },
    {
      name: "mv2-malformed-host-permission",
      bytes: jsonBytes({ name: "Bad", version: "1.0.0", manifest_version: 2, permissions: ["https://example.com"] }),
    },
    {
      name: "content-invalid-host",
      bytes: jsonBytes({
        name: "Bad",
        version: "1.0.0",
        manifest_version: 3,
        content_scripts: [{ matches: ["https://example.com:443/*"] }],
      }),
    },
  ];

  for (const invalid of invalidManifests) {
    const stagingDir = path.join(directory, invalid.name);
    await assert.rejects(
      preflightExtensionPackage({
        zipBytes: packageZip({ "manifest.json": invalid.bytes }),
        stagingDir,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ExtensionPackagePreflightError);
        assert.equal(error.code, "EXTENSION_MANIFEST_INVALID");
        return true;
      },
    );
    assert.equal(await exists(stagingDir), false);
  }
});

test("package preflight never follows an unsafe or unsupported Manifest icon path", async (t) => {
  const directory = await temporaryDirectory(t);
  const outside = path.join(directory, "outside.png");
  await fs.writeFile(outside, "secret");
  await assert.rejects(
    preflightExtensionPackage({
      zipBytes: packageZip({
        "manifest.json": jsonBytes({
          name: "No icon authority",
          version: "1.0.0",
          manifest_version: 3,
          icons: { 128: "../../outside.png" },
        }),
      }),
      stagingDir: path.join(directory, "stage"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ExtensionPackagePreflightError);
      assert.equal(error.code, "EXTENSION_MANIFEST_INVALID");
      return true;
    },
  );
  assert.equal(await fs.readFile(outside, "utf8"), "secret");
});

test("package preflight rejects locale traversal before the shared resolver can read outside staging", async (t) => {
  const directory = await temporaryDirectory(t);
  const outsideMessages = path.join(directory, "outside", "messages.json");
  await fs.mkdir(path.dirname(outsideMessages), { recursive: true });
  await fs.writeFile(outsideMessages, JSON.stringify({ extensionName: { message: "Must not be read" } }));
  const stagingDir = path.join(directory, "stage");

  await assert.rejects(
    preflightExtensionPackage({
      zipBytes: packageZip({
        "manifest.json": jsonBytes({
          name: "__MSG_extensionName__",
          version: "1.0.0",
          manifest_version: 3,
          default_locale: "../../outside",
        }),
      }),
      stagingDir,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ExtensionPackagePreflightError);
      assert.equal(error.code, "EXTENSION_MANIFEST_INVALID");
      return true;
    },
  );
  assert.equal(await fs.readFile(outsideMessages, "utf8"), JSON.stringify({ extensionName: { message: "Must not be read" } }));
  assert.equal(await exists(stagingDir), false);
});

test("package preflight strictly resolves only the declared default-locale catalog", async (t) => {
  const directory = await temporaryDirectory(t);
  const result = await preflightExtensionPackage({
    zipBytes: packageZip({
      "manifest.json": jsonBytes({
        name: "__MSG_name__",
        description: "__MSG_description__",
        version: "1.0.0",
        manifest_version: 3,
        default_locale: "en",
      }),
      "_locales/en/messages.json": jsonBytes({
        name: { message: "English default" },
        description: { message: "Default description" },
      }),
      "_locales/zh_CN/messages.json": jsonBytes({
        name: { message: "Non-default preference" },
        description: { message: "Non-default description" },
      }),
    }),
    stagingDir: path.join(directory, "strict-default"),
  });
  assert.equal(result.name, "English default");
  assert.equal(result.description, "Default description");
});

test("package preflight rejects unusable default-locale catalogs and unresolved messages", async (t) => {
  const directory = await temporaryDirectory(t);
  const cases: Array<{ name: string; entries: Zippable }> = [
    {
      name: "missing-catalog",
      entries: {
        "manifest.json": jsonBytes({ name: "__MSG_name__", version: "1.0.0", manifest_version: 3, default_locale: "en" }),
      },
    },
    {
      name: "invalid-utf8-catalog",
      entries: {
        "manifest.json": jsonBytes({ name: "__MSG_name__", version: "1.0.0", manifest_version: 3, default_locale: "en" }),
        "_locales/en/messages.json": Uint8Array.of(0xff, 0xfe),
      },
    },
    {
      name: "invalid-json-catalog",
      entries: {
        "manifest.json": jsonBytes({ name: "__MSG_name__", version: "1.0.0", manifest_version: 3, default_locale: "en" }),
        "_locales/en/messages.json": strToU8("{"),
      },
    },
    {
      name: "missing-message",
      entries: {
        "manifest.json": jsonBytes({ name: "__MSG_name__", version: "1.0.0", manifest_version: 3, default_locale: "en" }),
        "_locales/en/messages.json": jsonBytes({ other: { message: "Other" } }),
      },
    },
    {
      name: "wrong-message-shape",
      entries: {
        "manifest.json": jsonBytes({ name: "__MSG_name__", version: "1.0.0", manifest_version: 3, default_locale: "en" }),
        "_locales/en/messages.json": jsonBytes({ name: "not-an-object" }),
      },
    },
  ];
  for (const value of cases) {
    const stagingDir = path.join(directory, value.name);
    await assert.rejects(
      preflightExtensionPackage({ zipBytes: packageZip(value.entries), stagingDir }),
      (error: unknown) => error instanceof ExtensionPackagePreflightError,
    );
    assert.equal(await exists(stagingDir), false);
  }
});

test("package preflight validates versioned CSP, minimum Chrome version, and exact HTTP(S) update URL", async (t) => {
  const directory = await temporaryDirectory(t);
  const mv3 = await preflightExtensionPackage({
    zipBytes: packageZip({
      "manifest.json": jsonBytes({
        name: "MV3",
        version: "1.0.0",
        manifest_version: 3,
        minimum_chrome_version: "120.0.0.0",
        update_url: "https://clients2.google.com/service/update2/crx",
        content_security_policy: { extension_pages: "script-src 'self'" },
      }),
    }),
    stagingDir: path.join(directory, "valid-mv3"),
  });
  const mv2 = await preflightExtensionPackage({
    zipBytes: packageZip({
      "manifest.json": jsonBytes({
        name: "MV2",
        version: "1.0.0",
        manifest_version: 2,
        content_security_policy: "script-src 'self'",
      }),
    }),
    stagingDir: path.join(directory, "valid-mv2"),
  });
  assert.equal(mv3.manifestVersion, 3);
  assert.equal(mv2.manifestVersion, 2);
});

test("package preflight rejects extension-spoofed icon bytes", async (t) => {
  const directory = await temporaryDirectory(t);
  const stagingDir = path.join(directory, "spoofed-icon");
  await assert.rejects(
    preflightExtensionPackage({
      zipBytes: packageZip({
        "manifest.json": jsonBytes({
          name: "Spoofed icon",
          version: "1.0.0",
          manifest_version: 3,
          icons: { 128: "icon.png" },
        }),
        "icon.png": strToU8("<script>not png</script>"),
      }),
      stagingDir,
    }),
    (error: unknown) => error instanceof ExtensionPackagePreflightError,
  );
  assert.equal(await exists(stagingDir), false);
});

test("package preflight treats absent or equal catalog facts as non-discrepant", async (t) => {
  const directory = await temporaryDirectory(t);
  const bytes = packageZip({
    "manifest.json": jsonBytes({ name: "Exact", version: "2.0.0", manifest_version: 2 }),
  });
  const absent = await preflightExtensionPackage({
    zipBytes: bytes,
    stagingDir: path.join(directory, "absent"),
  });
  const equal = await preflightExtensionPackage({
    zipBytes: bytes,
    stagingDir: path.join(directory, "equal"),
    catalog: { name: "Exact", version: "2.0.0" },
  });
  assert.deepEqual(absent.discrepancies, []);
  assert.deepEqual(equal.discrepancies, []);
});

test("package preflight normalizes surrounding Manifest name/version whitespace", async (t) => {
  const directory = await temporaryDirectory(t);
  const result = await preflightExtensionPackage({
    zipBytes: packageZip({
      "manifest.json": jsonBytes({ name: "  Padded Name  ", version: " 1.2.3 ", manifest_version: 3 }),
    }),
    stagingDir: path.join(directory, "padded"),
  });
  assert.equal(result.name, "Padded Name");
  assert.equal(result.version, "1.2.3");
});

function packageZip(entries: Zippable): Uint8Array {
  return zipSync(entries, { level: 6 });
}

function jsonBytes(value: unknown): Uint8Array {
  return strToU8(JSON.stringify(value));
}

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-package-preflight-"));
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
