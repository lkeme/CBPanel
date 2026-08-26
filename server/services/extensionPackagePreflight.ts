import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import type { ExtensionPermissionRisk } from "../../src/shared/entities";
import { analyzePermissionRisks } from "./extensionService";
import {
  analyzeAndStageBoundedZip,
  ExtensionArchiveAnalysisError,
  type BoundedZipArchiveInput,
  type ExtensionArchiveLimits,
} from "./boundedZipAnalyzer";

const MAX_MANIFEST_NAME_CHARACTERS = 256;
const MAX_MANIFEST_DESCRIPTION_CHARACTERS = 4096;
const MAX_MANIFEST_VERSION_CHARACTERS = 64;
const MAX_PERMISSION_ITEMS = 1024;
const MAX_PERMISSION_CHARACTERS = 2048;
const MAX_CONTENT_SCRIPTS = 1024;
const MAX_ICON_ASSET_BYTES = 512 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SAFE_LOCALE_TAG = /^[A-Za-z]{2,3}(?:[_-](?:[A-Za-z]{2}|[0-9]{3}))*$/;
const UNSAFE_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MESSAGE_PLACEHOLDER_PATTERN = /__MSG_([A-Za-z0-9_@]+)__/g;

const ICON_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
});

export type ExtensionPackagePreflightErrorCode = "EXTENSION_MANIFEST_INVALID";

export class ExtensionPackagePreflightError extends Error {
  readonly status = 422;

  readonly code: ExtensionPackagePreflightErrorCode = "EXTENSION_MANIFEST_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ExtensionPackagePreflightError";
  }
}

export interface ExtensionPackageCatalogFacts {
  name?: string;
  version?: string;
}

export interface ExtensionPackageIconMetadata {
  relativePath: string;
  mimeType: string;
  size: number;
}

export interface ExtensionPackageDiscrepancy {
  field: "name" | "version";
  catalog?: string;
  package: string;
}

export type PreflightExtensionPackageInput = BoundedZipArchiveInput & {
  stagingDir: string;
  catalog?: ExtensionPackageCatalogFacts;
  limits?: Partial<ExtensionArchiveLimits>;
  signal?: AbortSignal;
};

export interface ExtensionPackagePreflightResult {
  stagedRoot: string;
  treeSha256: string;
  manifestSha256: string;
  name: string;
  description: string;
  version: string;
  manifestVersion: 2 | 3;
  permissions: string[];
  hostPermissions: string[];
  optionalPermissions: string[];
  optionalHostPermissions: string[];
  permissionRisks: ExtensionPermissionRisk[];
  icon?: ExtensionPackageIconMetadata;
  discrepancies: ExtensionPackageDiscrepancy[];
  entryCount: number;
  filesystemNodeCount: number;
  fileCount: number;
  expandedBytes: number;
  stagedFileCount: number;
  stagedFilesystemNodeCount: number;
  stagedExpandedBytes: number;
}

type ManifestRecord = Record<string, unknown>;

/**
 * Produces package-derived facts from a bounded staged tree. Catalog fields are
 * compared only after the package Manifest has become authoritative.
 */
export async function preflightExtensionPackage(
  input: PreflightExtensionPackageInput,
): Promise<ExtensionPackagePreflightResult> {
  let stagedOutput: string | undefined;
  try {
    const analysis = await analyzeAndStageBoundedZip({
      ...(input.archivePath !== undefined
        ? {
            archivePath: input.archivePath,
            archiveOffset: input.archiveOffset,
            archiveLength: input.archiveLength,
          }
        : {
            zipBytes: input.zipBytes,
            archiveOffset: input.archiveOffset,
            archiveLength: input.archiveLength,
          }),
      outputDir: input.stagingDir,
      limits: input.limits,
      signal: input.signal,
    });
    stagedOutput = analysis.outputDir;
    throwIfPreflightAborted(input.signal);

    const maximumManifestBytes = input.limits?.maxManifestBytes ?? 4 * 1024 * 1024;
    const rawManifestBytes = await readBoundedRegularFileInsideRoot(
      analysis.stagedRoot,
      "manifest.json",
      maximumManifestBytes,
      "Extension Manifest",
    );
    const rawManifestText = decodeManifestText(rawManifestBytes);
    const rawManifest = parseManifest(rawManifestText);
    const normalizedManifest = validateManifest(rawManifest);

    const localizedManifest = await resolveDefaultLocaleManifest(
      analysis.stagedRoot,
      normalizedManifest,
      input.limits?.maxLocaleMessagesBytes ?? 4 * 1024 * 1024,
      input.signal,
    );
    throwIfPreflightAborted(input.signal);
    const name = requiredBoundedString(
      localizedManifest.name,
      "Manifest name",
      MAX_MANIFEST_NAME_CHARACTERS,
    );
    const description = optionalBoundedString(
      localizedManifest.description,
      "Manifest description",
      MAX_MANIFEST_DESCRIPTION_CHARACTERS,
    ) ?? "";

    const manifestPermissions = strictStringArray(normalizedManifest.permissions, "Manifest permissions");
    const declaredHostPermissions = strictStringArray(
      normalizedManifest.host_permissions,
      "Manifest host permissions",
    );
    const optionalManifestPermissions = strictStringArray(
      normalizedManifest.optional_permissions,
      "Manifest optional permissions",
    );
    const optionalDeclaredHostPermissions = strictStringArray(
      normalizedManifest.optional_host_permissions,
      "Manifest optional host permissions",
    );
    if (
      declaredHostPermissions.some((permission) => !isChromeMatchPattern(permission))
      || optionalDeclaredHostPermissions.some((permission) => !isChromeMatchPattern(permission))
    ) {
      throw manifestError("Manifest host permissions contain an invalid match pattern.");
    }
    const contentScriptMatches = readContentScriptMatches(normalizedManifest.content_scripts);
    assertNoMalformedUrlPermissions(manifestPermissions, "Manifest permissions");
    assertNoMalformedUrlPermissions(optionalManifestPermissions, "Manifest optional permissions");
    const permissions = uniqueStrings(manifestPermissions.filter((permission) => !isChromeMatchPattern(permission)));
    const hostPermissions = uniqueStrings([
      ...declaredHostPermissions,
      ...manifestPermissions.filter(isChromeMatchPattern),
      ...contentScriptMatches,
    ]);
    const optionalPermissions = uniqueStrings(
      optionalManifestPermissions.filter((permission) => !isChromeMatchPattern(permission)),
    );
    const optionalHostPermissions = uniqueStrings([
      ...optionalDeclaredHostPermissions,
      ...optionalManifestPermissions.filter(isChromeMatchPattern),
    ]);
    const permissionRisks = analyzePermissionRisks({
      permissions,
      hostPermissions,
      optionalPermissions,
      optionalHostPermissions,
      contentScriptMatches,
    });
    const version = normalizedManifest.version as string;
    const manifestVersion = normalizedManifest.manifest_version as 2 | 3;
    await validateReferencedResources(analysis.stagedRoot, normalizedManifest);
    const icon = await readSelectedIconMetadata(analysis.stagedRoot, rawManifest);
    const discrepancies = compareCatalogFacts(input.catalog, { name, version });
    throwIfPreflightAborted(input.signal);

    stagedOutput = undefined;
    return Object.freeze({
      stagedRoot: analysis.stagedRoot,
      treeSha256: analysis.treeSha256,
      manifestSha256: fingerprintManifest(rawManifest),
      name,
      description,
      version,
      manifestVersion,
      permissions,
      hostPermissions,
      optionalPermissions,
      optionalHostPermissions,
      permissionRisks,
      icon,
      discrepancies,
      entryCount: analysis.entryCount,
      filesystemNodeCount: analysis.filesystemNodeCount,
      fileCount: analysis.fileCount,
      expandedBytes: analysis.expandedBytes,
      stagedFileCount: analysis.stagedFileCount,
      stagedFilesystemNodeCount: analysis.stagedFilesystemNodeCount,
      stagedExpandedBytes: analysis.stagedExpandedBytes,
    });
  } catch (error) {
    if (stagedOutput) await fs.rm(stagedOutput, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof ExtensionArchiveAnalysisError || error instanceof ExtensionPackagePreflightError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw manifestError("Extension Manifest could not be safely parsed or analyzed.");
  }
}

function decodeManifestText(bytes: Uint8Array): string {
  try {
    const decoded = UTF8_DECODER.decode(bytes);
    return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  } catch {
    throw manifestError("Extension Manifest must be valid UTF-8 JSON.");
  }
}

function parseManifest(raw: string): ManifestRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw manifestError("Extension Manifest is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw manifestError("Extension Manifest must be a JSON object.");
  }
  return parsed as ManifestRecord;
}

async function resolveDefaultLocaleManifest(
  stagedRoot: string,
  manifest: ManifestRecord,
  maxMessagesBytes: number,
  signal?: AbortSignal,
): Promise<ManifestRecord> {
  const rawName = manifest.name as string;
  const rawDescription = typeof manifest.description === "string" ? manifest.description : "";
  const hasPlaceholders = containsMessagePlaceholder(rawName) || containsMessagePlaceholder(rawDescription);
  const defaultLocale = typeof manifest.default_locale === "string"
    ? manifest.default_locale.trim().replace(/-/g, "_")
    : "";
  if (!defaultLocale) {
    if (hasPlaceholders) throw manifestError("Localized Manifest fields require a valid default_locale.");
    return manifest;
  }

  throwIfPreflightAborted(signal);
  const messagesRelativePath = `_locales/${defaultLocale}/messages.json`;
  const messagesBytes = await readBoundedRegularFileInsideRoot(
    stagedRoot,
    messagesRelativePath,
    maxMessagesBytes,
    "Default locale messages",
  );
  let messagesValue: unknown;
  try {
    messagesValue = JSON.parse(decodeStrictUtf8(messagesBytes, "Default locale messages"));
  } catch (error) {
    if (error instanceof ExtensionPackagePreflightError) throw error;
    throw manifestError("Default locale messages are not valid JSON.");
  }
  const messages = requiredObject(messagesValue, "Default locale messages");
  const normalizedMessages = new Map<string, string>();
  for (const [key, value] of Object.entries(messages)) {
    if (!/^[A-Za-z0-9_@]+$/.test(key)) throw manifestError("Default locale messages contain an invalid key.");
    const record = requiredObject(value, "Default locale message");
    if (
      typeof record.message !== "string"
      || record.message.length > 64 * 1024
      || UNSAFE_TEXT_CONTROL.test(record.message)
    ) {
      throw manifestError("Default locale message text must be a bounded string.");
    }
    const message = record.message;
    const normalizedKey = key.toLowerCase();
    if (normalizedMessages.has(normalizedKey)) throw manifestError("Default locale messages contain duplicate keys.");
    normalizedMessages.set(normalizedKey, message);
  }

  const resolve = (value: string, label: string): string => value.replace(
    MESSAGE_PLACEHOLDER_PATTERN,
    (_placeholder, key: string) => {
      const message = normalizedMessages.get(key.toLowerCase());
      if (message === undefined) throw manifestError(`${label} references a missing default-locale message.`);
      return message;
    },
  );
  const name = requiredBoundedString(resolve(rawName, "Manifest name"), "Manifest name", MAX_MANIFEST_NAME_CHARACTERS);
  const description = optionalBoundedString(
    resolve(rawDescription, "Manifest description"),
    "Manifest description",
    MAX_MANIFEST_DESCRIPTION_CHARACTERS,
  ) ?? "";
  if (containsMessagePlaceholder(name) || containsMessagePlaceholder(description)) {
    throw manifestError("Manifest localization left an unresolved message placeholder.");
  }
  return { ...manifest, name, description };
}

function containsMessagePlaceholder(value: string): boolean {
  MESSAGE_PLACEHOLDER_PATTERN.lastIndex = 0;
  return MESSAGE_PLACEHOLDER_PATTERN.test(value);
}

function decodeStrictUtf8(bytes: Uint8Array, label: string): string {
  try {
    const decoded = UTF8_DECODER.decode(bytes);
    return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  } catch {
    throw manifestError(`${label} must be valid UTF-8.`);
  }
}

function validateManifest(manifest: ManifestRecord): ManifestRecord {
  const name = requiredBoundedString(manifest.name, "Manifest name", MAX_MANIFEST_NAME_CHARACTERS);
  const version = requiredBoundedString(
    manifest.version,
    "Manifest version",
    MAX_MANIFEST_VERSION_CHARACTERS,
  );
  validateChromeManifestVersion(version);
  if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) {
    throw manifestError("Manifest version must be 2 or 3.");
  }
  const description = optionalBoundedString(
    manifest.description,
    "Manifest description",
    MAX_MANIFEST_DESCRIPTION_CHARACTERS,
  );
  if (manifest.default_locale !== undefined) {
    const defaultLocale = requiredBoundedString(manifest.default_locale, "Manifest default locale", 64);
    if (!SAFE_LOCALE_TAG.test(defaultLocale)) {
      throw manifestError("Manifest default locale is invalid.");
    }
  }
  if (manifest.key !== undefined) requiredBoundedString(manifest.key, "Manifest key", 64 * 1024);
  strictStringArray(manifest.permissions, "Manifest permissions");
  strictStringArray(manifest.host_permissions, "Manifest host permissions");
  strictStringArray(manifest.optional_permissions, "Manifest optional permissions");
  strictStringArray(manifest.optional_host_permissions, "Manifest optional host permissions");
  readContentScriptMatches(manifest.content_scripts);
  validateManifestObjectFields(manifest);
  return {
    ...manifest,
    name,
    version,
    ...(description !== undefined ? { description } : {}),
  };
}

function validateManifestObjectFields(manifest: ManifestRecord): void {
  if (manifest.manifest_version === 3 && manifest.browser_action !== undefined) {
    throw manifestError("Manifest MV3 must use action instead of browser_action.");
  }
  if (manifest.manifest_version === 3 && manifest.page_action !== undefined) {
    throw manifestError("Manifest MV3 cannot declare page_action.");
  }
  if (manifest.manifest_version === 2 && manifest.action !== undefined) {
    throw manifestError("Manifest MV2 cannot declare action.");
  }
  validateActionLike(manifest.action, "Manifest action");
  validateActionLike(manifest.browser_action, "Manifest browser action");
  validateActionLike(manifest.page_action, "Manifest page action");
  validateSidePanel(manifest.side_panel);
  validateOmnibox(manifest.omnibox);
  if (manifest.background !== undefined) {
    const background = requiredObject(manifest.background, "Manifest background");
    if (background.scripts !== undefined) strictStringArray(background.scripts, "Manifest background scripts");
    optionalBoundedString(background.page, "Manifest background page", 1024);
    optionalBoundedString(background.service_worker, "Manifest service worker", 1024);
    if (background.persistent !== undefined && typeof background.persistent !== "boolean") {
      throw manifestError("Manifest background persistent must be boolean.");
    }
    if (background.type !== undefined && background.type !== "module") {
      throw manifestError("Manifest background type must be module when present.");
    }
    if (
      manifest.manifest_version === 3
      && (background.scripts !== undefined || background.page !== undefined || background.persistent !== undefined)
    ) {
      throw manifestError("Manifest MV3 background cannot declare MV2 background fields.");
    }
    if (manifest.manifest_version === 2 && background.scripts !== undefined && background.page !== undefined) {
      throw manifestError("Manifest MV2 background cannot declare both scripts and page.");
    }
    if (manifest.manifest_version === 2 && background.type !== undefined) {
      throw manifestError("Manifest MV2 background cannot declare a module type.");
    }
    if (manifest.manifest_version === 2 && background.service_worker !== undefined) {
      throw manifestError("Manifest MV2 background cannot declare a service worker.");
    }
    if (background.scripts === undefined && background.page === undefined && background.service_worker === undefined) {
      throw manifestError("Manifest background must declare a page, scripts, or service worker.");
    }
  }
  if (manifest.options_page !== undefined) optionalBoundedString(manifest.options_page, "Manifest options page", 1024);
  validateOptionsUi(manifest.options_ui);
  if (manifest.devtools_page !== undefined) optionalBoundedString(manifest.devtools_page, "Manifest DevTools page", 1024);
  if (manifest.chrome_url_overrides !== undefined) {
    const overrides = requiredObject(manifest.chrome_url_overrides, "Manifest chrome_url_overrides");
    for (const value of Object.values(overrides)) optionalBoundedString(value, "Manifest override page", 1024);
  }
  if (manifest.sandbox !== undefined) {
    const sandbox = requiredObject(manifest.sandbox, "Manifest sandbox");
    const pages = strictStringArray(sandbox.pages, "Manifest sandbox pages");
    if (pages.length === 0) throw manifestError("Manifest sandbox pages cannot be empty.");
    optionalBoundedString(sandbox.content_security_policy, "Manifest sandbox policy", 64 * 1024);
  }
  validateWebAccessibleResources(manifest.web_accessible_resources, manifest.manifest_version as 2 | 3);
  validateExternallyConnectable(manifest.externally_connectable);
  validateCommands(manifest.commands);
  validateIcons(manifest.icons, "Manifest icons", false);
  if (manifest.incognito !== undefined && !["spanning", "split", "not_allowed"].includes(String(manifest.incognito))) {
    throw manifestError("Manifest incognito mode is invalid.");
  }
  optionalBoundedString(manifest.short_name, "Manifest short name", MAX_MANIFEST_NAME_CHARACTERS);
  optionalBoundedString(manifest.author, "Manifest author", MAX_MANIFEST_NAME_CHARACTERS);
  if (manifest.minimum_chrome_version !== undefined) {
    const minimumChromeVersion = requiredBoundedString(
      manifest.minimum_chrome_version,
      "Manifest minimum Chrome version",
      MAX_MANIFEST_VERSION_CHARACTERS,
    );
    validateChromeManifestVersion(minimumChromeVersion);
  }
  if (manifest.update_url !== undefined) validateManifestUpdateUrl(manifest.update_url);
  validateContentSecurityPolicy(manifest.content_security_policy, manifest.manifest_version as 2 | 3);
  validateDeclarativeNetRequest(manifest.declarative_net_request);
  validateStorage(manifest.storage);
  validateOauth2(manifest.oauth2);
  validateFileHandlers(manifest.file_handlers);
  validateTtsEngine(manifest.tts_engine);
  validateTheme(manifest.theme);
}

function validateActionLike(value: unknown, label: string): void {
  if (value === undefined) return;
  const record = requiredObject(value, label);
  optionalBoundedString(record.default_title, `${label} default_title`, 1024);
  optionalBoundedString(record.default_popup, `${label} default_popup`, 1024);
  validateIcons(record.default_icon, `${label} default_icon`, true);
}

function validateSidePanel(value: unknown): void {
  if (value === undefined) return;
  const record = requiredObject(value, "Manifest side_panel");
  requiredBoundedString(record.default_path, "Manifest side_panel default_path", 1024);
}

function validateOmnibox(value: unknown): void {
  if (value === undefined) return;
  const record = requiredObject(value, "Manifest omnibox");
  requiredBoundedString(record.keyword, "Manifest omnibox keyword", 64);
}

function validateStorage(value: unknown): void {
  if (value === undefined) return;
  const record = requiredObject(value, "Manifest storage");
  optionalBoundedString(record.managed_schema, "Manifest storage managed_schema", 1024);
}

function validateOauth2(value: unknown): void {
  if (value === undefined) return;
  const record = requiredObject(value, "Manifest oauth2");
  requiredBoundedString(record.client_id, "Manifest oauth2 client_id", 512);
  const scopes = strictStringArray(record.scopes, "Manifest oauth2 scopes");
  if (scopes.length === 0) throw manifestError("Manifest oauth2 scopes cannot be empty.");
}

function validateFileHandlers(value: unknown): void {
  if (value === undefined) return;
  const items: unknown[] = Array.isArray(value)
    ? value
    : Object.values(requiredObject(value, "Manifest file_handlers"));
  if (items.length > MAX_PERMISSION_ITEMS) throw manifestError("Manifest file_handlers has too many entries.");
  for (const item of items) {
    const handler = requiredObject(item, "Manifest file handler");
    optionalBoundedString(handler.action, "Manifest file handler action", 1024);
    if (handler.accepts !== undefined) {
      const accepts = requiredObject(handler.accepts, "Manifest file handler accepts");
      if (Object.keys(accepts).length === 0) throw manifestError("Manifest file handler accepts cannot be empty.");
      for (const [mime, extensions] of Object.entries(accepts)) {
        if (!mime.includes("/") || !/^[-\w.+]+\/[-\w.+*]+$/.test(mime)) throw manifestError("Manifest file handler MIME type is invalid.");
        strictStringArray(extensions, "Manifest file handler extensions");
      }
    }
    if (handler.types !== undefined) strictStringArray(handler.types, "Manifest file handler types");
    if (handler.extensions !== undefined) strictStringArray(handler.extensions, "Manifest file handler extensions");
    validateIcons(handler.icons, "Manifest file handler icons", false);
  }
}

function validateTtsEngine(value: unknown): void {
  if (value === undefined) return;
  const record = requiredObject(value, "Manifest tts_engine");
  if (record.voices !== undefined) {
    if (!Array.isArray(record.voices) || record.voices.length > MAX_PERMISSION_ITEMS) {
      throw manifestError("Manifest tts_engine voices must be a bounded array.");
    }
    for (const voice of record.voices) {
      const item = requiredObject(voice, "Manifest tts_engine voice");
      optionalBoundedString(item.voice_name, "Manifest tts_engine voice_name", 256);
      optionalBoundedString(item.lang, "Manifest tts_engine lang", 64);
      if (item.event_types !== undefined) strictStringArray(item.event_types, "Manifest tts_engine event_types");
    }
  }
}

function validateTheme(value: unknown): void {
  if (value === undefined) return;
  const record = requiredObject(value, "Manifest theme");
  if (record.images !== undefined) {
    const images = requiredObject(record.images, "Manifest theme images");
    for (const image of Object.values(images)) requiredBoundedString(image, "Manifest theme image", 1024);
  }
  if (record.colors !== undefined) requiredObject(record.colors, "Manifest theme colors");
  if (record.tints !== undefined) requiredObject(record.tints, "Manifest theme tints");
  if (record.properties !== undefined) requiredObject(record.properties, "Manifest theme properties");
}

function validateOptionsUi(value: unknown): void {
  if (value === undefined) return;
  const record = requiredObject(value, "Manifest options_ui");
  requiredBoundedString(record.page, "Manifest options_ui page", 1024);
  if (record.open_in_tab !== undefined && typeof record.open_in_tab !== "boolean") {
    throw manifestError("Manifest options_ui open_in_tab must be boolean.");
  }
}

function validateWebAccessibleResources(value: unknown, manifestVersion: 2 | 3): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_PERMISSION_ITEMS) {
    throw manifestError("Manifest web_accessible_resources must be a bounded array.");
  }
  if (manifestVersion === 2) {
    strictStringArray(value, "Manifest web_accessible_resources");
    return;
  }
  for (const item of value) {
    const record = requiredObject(item, "Manifest web_accessible_resources entry");
    const resources = strictStringArray(record.resources, "Manifest web_accessible_resources resources");
    if (resources.length === 0) throw manifestError("Manifest web_accessible_resources resources cannot be empty.");
    const matches = record.matches === undefined ? [] : strictStringArray(record.matches, "Manifest web_accessible_resources matches");
    if (matches.some((match) => !isChromeMatchPattern(match))) {
      throw manifestError("Manifest web_accessible_resources matches contain an invalid host pattern.");
    }
    if (record.extension_ids !== undefined) strictStringArray(record.extension_ids, "Manifest web_accessible_resources extension_ids");
  }
}

function validateExternallyConnectable(value: unknown): void {
  if (value === undefined) return;
  const record = requiredObject(value, "Manifest externally_connectable");
  if (record.matches !== undefined) {
    const matches = strictStringArray(record.matches, "Manifest externally_connectable matches");
    if (matches.some((match) => !isChromeMatchPattern(match))) throw manifestError("Manifest externally_connectable matches are invalid.");
  }
  if (record.ids !== undefined) strictStringArray(record.ids, "Manifest externally_connectable ids");
  if (record.accepts_tls_channel_id !== undefined && typeof record.accepts_tls_channel_id !== "boolean") {
    throw manifestError("Manifest externally_connectable accepts_tls_channel_id must be boolean.");
  }
}

function validateCommands(value: unknown): void {
  if (value === undefined) return;
  const record = requiredObject(value, "Manifest commands");
  if (Object.keys(record).length > MAX_PERMISSION_ITEMS) throw manifestError("Manifest commands contain too many entries.");
  for (const command of Object.values(record)) {
    const item = requiredObject(command, "Manifest command");
    optionalBoundedString(item.description, "Manifest command description", 1024);
    if (item.suggested_key !== undefined) {
      const key = requiredObject(item.suggested_key, "Manifest command suggested_key");
      for (const value of Object.values(key)) optionalBoundedString(value, "Manifest command shortcut", 128);
    }
  }
}

function validateIcons(value: unknown, label = "Manifest icons", allowString = false): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    if (!allowString) throw manifestError(`${label} must be a size-to-path object.`);
    optionalBoundedString(value, label, 1024);
    return;
  }
  const record = requiredObject(value, label);
  for (const [size, pathValue] of Object.entries(record)) {
    if (!/^\d+$/.test(size) || Number(size) <= 0) throw manifestError(`${label} contains an invalid size.`);
    requiredBoundedString(pathValue, `${label} path`, 1024);
  }
}

function validateContentSecurityPolicy(value: unknown, manifestVersion: 2 | 3): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    if (manifestVersion === 3) throw manifestError("Manifest MV3 content security policy must be an object.");
    optionalBoundedString(value, "Manifest content security policy", 64 * 1024);
    return;
  }
  if (manifestVersion === 2) throw manifestError("Manifest MV2 content security policy must be a string.");
  const record = requiredObject(value, "Manifest content security policy");
  for (const policy of Object.values(record)) optionalBoundedString(policy, "Manifest content security policy", 64 * 1024);
}

function validateManifestUpdateUrl(value: unknown): void {
  const raw = requiredBoundedString(value, "Manifest update URL", 2048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw manifestError("Manifest update URL is invalid.");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    || parsed.username
    || parsed.password
    || !parsed.hostname
    || parsed.hostname.endsWith(".")
    || parsed.hash
    || /[\\%\u0000-\u0020\u007f]/.test(raw)
  ) {
    throw manifestError("Manifest update URL must use a safe exact HTTP(S) authority.");
  }
  const authorityStart = raw.indexOf("//") + 2;
  const authorityEnd = raw.slice(authorityStart).search(/[/?#]/);
  const rawAuthority = authorityEnd < 0
    ? raw.slice(authorityStart)
    : raw.slice(authorityStart, authorityStart + authorityEnd);
  if (!rawAuthority || rawAuthority.toLowerCase() !== parsed.host.toLowerCase()) {
    throw manifestError("Manifest update URL authority must be exact ASCII.");
  }
}

function validateDeclarativeNetRequest(value: unknown): void {
  if (value === undefined) return;
  const record = requiredObject(value, "Manifest declarative_net_request");
  if (record.rule_resources === undefined) return;
  if (!Array.isArray(record.rule_resources) || record.rule_resources.length > MAX_PERMISSION_ITEMS) {
    throw manifestError("Manifest declarative_net_request rule_resources must be a bounded array.");
  }
  for (const item of record.rule_resources) {
    const resource = requiredObject(item, "Manifest declarative_net_request rule resource");
    requiredBoundedString(resource.id, "Manifest rule resource id", 256);
    requiredBoundedString(resource.path, "Manifest rule resource path", 1024);
    if (resource.enabled !== undefined && typeof resource.enabled !== "boolean") {
      throw manifestError("Manifest rule resource enabled must be boolean.");
    }
  }
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw manifestError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function validateChromeManifestVersion(version: string): void {
  const parts = version.split(".");
  if (parts.length < 1 || parts.length > 4) throw manifestError("Manifest package version is invalid.");
  for (const part of parts) {
    if (!/^\d+$/.test(part) || (part.length > 1 && part.startsWith("0"))) {
      throw manifestError("Manifest package version is invalid.");
    }
    const value = Number(part);
    if (!Number.isSafeInteger(value) || value > 65_535) {
      throw manifestError("Manifest package version is invalid.");
    }
  }
  if (parts.every((part) => Number(part) === 0)) {
    throw manifestError("Manifest package version cannot be all zeroes.");
  }
}

function strictStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PERMISSION_ITEMS) {
    throw manifestError(`${label} must be a bounded string array.`);
  }
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw manifestError(`${label} must contain only strings.`);
    const normalized = item.trim();
    if (!normalized || normalized.length > MAX_PERMISSION_CHARACTERS) {
      throw manifestError(`${label} contains an invalid value.`);
    }
    output.push(normalized);
  }
  return uniqueStrings(output);
}

function readContentScriptMatches(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CONTENT_SCRIPTS) {
    throw manifestError("Manifest content scripts must be a bounded array.");
  }
  const matches: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw manifestError("Manifest content script entries must be objects.");
    }
    const record = item as Record<string, unknown>;
    const entryMatches = strictStringArray(record.matches, "Manifest content script matches");
    if (entryMatches.length === 0) {
      throw manifestError("Manifest content script entries require at least one match pattern.");
    }
    if (entryMatches.some((match) => !isChromeMatchPattern(match))) {
      throw manifestError("Manifest content script matches contain an invalid host pattern.");
    }
    for (const field of ["exclude_matches"] as const) {
      if (record[field] === undefined) continue;
      const patterns = strictStringArray(record[field], `Manifest content script ${field}`);
      if (patterns.some((match) => !isChromeMatchPattern(match))) {
        throw manifestError(`Manifest content script ${field} contains an invalid host pattern.`);
      }
    }
    const scripts = record.js === undefined ? [] : strictStringArray(record.js, "Manifest content script js");
    const styles = record.css === undefined ? [] : strictStringArray(record.css, "Manifest content script css");
    if (scripts.length === 0 && styles.length === 0) {
      throw manifestError("Manifest content script entries require js or css resources.");
    }
    if (record.run_at !== undefined && !["document_start", "document_end", "document_idle"].includes(String(record.run_at))) {
      throw manifestError("Manifest content script run_at is invalid.");
    }
    for (const field of ["all_frames", "match_about_blank", "match_origin_as_fallback"] as const) {
      if (record[field] !== undefined && typeof record[field] !== "boolean") {
        throw manifestError(`Manifest content script ${field} must be boolean.`);
      }
    }
    for (const field of ["include_globs", "exclude_globs"] as const) {
      if (record[field] !== undefined) strictStringArray(record[field], `Manifest content script ${field}`);
    }
    if (record.world !== undefined && !["ISOLATED", "MAIN", "USER_SCRIPT"].includes(String(record.world))) {
      throw manifestError("Manifest content script world is invalid.");
    }
    matches.push(...entryMatches);
  }
  return uniqueStrings(matches);
}

function requiredBoundedString(value: unknown, label: string, maximumCharacters: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximumCharacters || UNSAFE_TEXT_CONTROL.test(normalized)) {
    throw manifestError(`${label} must be a non-empty bounded string.`);
  }
  return normalized;
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maximumCharacters: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximumCharacters || UNSAFE_TEXT_CONTROL.test(value)) {
    throw manifestError(`${label} must be a bounded string.`);
  }
  return value.trim();
}

function isChromeMatchPattern(value: string): boolean {
  if (value === "<all_urls>") return true;
  const schemeSeparator = value.indexOf("://");
  if (schemeSeparator <= 0) return false;
  const scheme = value.slice(0, schemeSeparator).toLowerCase();
  if (
    scheme !== "*"
    && scheme !== "http"
    && scheme !== "https"
    && scheme !== "file"
    && scheme !== "ftp"
    && scheme !== "chrome"
  ) {
    return false;
  }
  const authorityAndPath = value.slice(schemeSeparator + 3);
  const pathStart = authorityAndPath.indexOf("/");
  if (pathStart < 0) return false;
  const host = authorityAndPath.slice(0, pathStart);
  const resourcePath = authorityAndPath.slice(pathStart);
  if (!isValidMatchPatternPath(resourcePath)) return false;
  if (scheme === "file") return host === "";
  return isValidMatchPatternHost(host);
}

function isValidMatchPatternPath(value: string): boolean {
  return value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("#")
    && !/[\u0000-\u0020\u007f]/.test(value);
}

function isValidMatchPatternHost(value: string): boolean {
  if (!value || value.endsWith(".") || value.includes("@") || value.includes("%")) return false;
  if (value === "*") return true;
  if (value.startsWith("[")) {
    return value.endsWith("]") && isIP(value.slice(1, -1)) === 6;
  }
  if (value.includes(":")) return false;
  const wildcard = value.startsWith("*.");
  const hostname = wildcard ? value.slice(2) : value;
  if (!hostname || hostname.includes("*")) return false;
  if (/^[0-9.]+$/.test(hostname)) return !wildcard && isIP(hostname) === 4;
  if (hostname.length > 253) return false;
  return hostname.split(".").every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[A-Za-z0-9-]+$/.test(label)
    && !label.startsWith("-")
    && !label.endsWith("-")
  ));
}

function assertNoMalformedUrlPermissions(values: string[], label: string): void {
  if (values.some((value) => value.includes("://") && !isChromeMatchPattern(value))) {
    throw manifestError(`${label} contains an invalid match pattern.`);
  }
}

async function validateReferencedResources(stagedRoot: string, manifest: ManifestRecord): Promise<void> {
  const resources = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) resources.add(value.trim());
  };
  const addArray = (value: unknown): void => {
    if (Array.isArray(value)) for (const item of value) add(item);
  };
  const addIcons = (value: unknown): void => {
    if (typeof value === "string") {
      add(value);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const item of Object.values(value as Record<string, unknown>)) add(item);
  };
  const addAction = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const action = value as Record<string, unknown>;
    add(action.default_popup);
    addIcons(action.default_icon);
  };

  addIcons(manifest.icons);
  addAction(manifest.action);
  addAction(manifest.browser_action);
  addAction(manifest.page_action);
  add(manifest.options_page);
  add(manifest.devtools_page);
  if (manifest.options_ui && typeof manifest.options_ui === "object" && !Array.isArray(manifest.options_ui)) {
    add((manifest.options_ui as ManifestRecord).page);
  }
  if (manifest.side_panel && typeof manifest.side_panel === "object" && !Array.isArray(manifest.side_panel)) {
    add((manifest.side_panel as ManifestRecord).default_path);
  }
  if (manifest.background && typeof manifest.background === "object" && !Array.isArray(manifest.background)) {
    const background = manifest.background as ManifestRecord;
    add(background.page);
    add(background.service_worker);
    addArray(background.scripts);
  }
  if (Array.isArray(manifest.content_scripts)) {
    for (const value of manifest.content_scripts) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const contentScript = value as ManifestRecord;
      addArray(contentScript.js);
      addArray(contentScript.css);
    }
  }
  if (manifest.chrome_url_overrides && typeof manifest.chrome_url_overrides === "object" && !Array.isArray(manifest.chrome_url_overrides)) {
    for (const value of Object.values(manifest.chrome_url_overrides as ManifestRecord)) add(value);
  }
  if (manifest.sandbox && typeof manifest.sandbox === "object" && !Array.isArray(manifest.sandbox)) {
    addArray((manifest.sandbox as ManifestRecord).pages);
  }
  if (manifest.declarative_net_request && typeof manifest.declarative_net_request === "object" && !Array.isArray(manifest.declarative_net_request)) {
    const resourcesValue = (manifest.declarative_net_request as ManifestRecord).rule_resources;
    if (Array.isArray(resourcesValue)) {
      for (const value of resourcesValue) {
        if (value && typeof value === "object" && !Array.isArray(value)) add((value as ManifestRecord).path);
      }
    }
  }
  if (manifest.storage && typeof manifest.storage === "object" && !Array.isArray(manifest.storage)) {
    add((manifest.storage as ManifestRecord).managed_schema);
  }
  if (manifest.file_handlers) {
    const handlers = Array.isArray(manifest.file_handlers)
      ? manifest.file_handlers
      : Object.values(manifest.file_handlers as ManifestRecord);
    for (const value of handlers) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      add((value as ManifestRecord).action);
      addIcons((value as ManifestRecord).icons);
    }
  }
  if (manifest.theme && typeof manifest.theme === "object" && !Array.isArray(manifest.theme)) {
    const images = (manifest.theme as ManifestRecord).images;
    if (images && typeof images === "object" && !Array.isArray(images)) {
      for (const value of Object.values(images as ManifestRecord)) add(value);
    }
  }

  for (const resource of resources) {
    const relativePath = normalizeManifestResourcePath(resource);
    if (!relativePath || relativePath.includes("*")) {
      throw manifestError("Manifest contains an unsafe package resource path.");
    }
    await inspectRegularFileInsideRoot(stagedRoot, relativePath, "Manifest package resource");
  }
}

async function inspectRegularFileInsideRoot(
  stagedRoot: string,
  relativePath: string,
  label: string,
): Promise<{ absolutePath: string; size: number; dev: number; ino: number }> {
  const normalized = normalizeManifestResourcePath(relativePath);
  if (!normalized || normalized.includes("*")) throw manifestError(`${label} path is unsafe.`);
  const rootStats = await fs.lstat(stagedRoot).catch(() => undefined);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) throw manifestError(`${label} root is unsafe.`);
  const canonicalRoot = await fs.realpath(stagedRoot).catch(() => undefined);
  if (!canonicalRoot) throw manifestError(`${label} root cannot be resolved safely.`);
  const absolutePath = path.resolve(stagedRoot, ...normalized.split("/"));
  if (!isPathInside(absolutePath, stagedRoot)) throw manifestError(`${label} escapes the extension root.`);
  const stats = await fs.lstat(absolutePath).catch(() => undefined);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw manifestError(`${label} is missing, linked, or not a regular file.`);
  }
  const canonicalPath = await fs.realpath(absolutePath).catch(() => undefined);
  if (!canonicalPath || !isPathInside(canonicalPath, canonicalRoot)) {
    throw manifestError(`${label} resolves outside the extension root.`);
  }
  const handle = await fs.open(absolutePath, "r");
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== stats.dev
      || opened.ino !== stats.ino
      || opened.size !== stats.size
    ) {
      throw manifestError(`${label} changed or became linked during inspection.`);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (await fs.realpath(absolutePath).catch(() => undefined) !== canonicalPath) {
    throw manifestError(`${label} changed or became linked during inspection.`);
  }
  return { absolutePath, size: stats.size, dev: stats.dev, ino: stats.ino };
}

async function readBoundedRegularFileInsideRoot(
  stagedRoot: string,
  relativePath: string,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw manifestError(`${label} read limit is invalid.`);
  const inspected = await inspectRegularFileInsideRoot(stagedRoot, relativePath, label);
  if (inspected.size > maxBytes) throw manifestError(`${label} exceeds its read limit.`);
  const handle = await fs.open(inspected.absolutePath, "r");
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.size !== inspected.size
      || before.dev !== inspected.dev
      || before.ino !== inspected.ino
    ) {
      throw manifestError(`${label} changed or became linked before reading.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== inspected.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      throw manifestError(`${label} changed during reading.`);
    }
    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function fingerprintManifest(manifest: ManifestRecord): string {
  const withoutKey = { ...manifest };
  delete withoutKey.key;
  return createHash("sha256").update(canonicalJsonText(withoutKey), "utf8").digest("hex");
}

function canonicalJsonText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonText).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonText(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readSelectedIconMetadata(
  stagedRoot: string,
  manifest: ManifestRecord,
): Promise<ExtensionPackageIconMetadata | undefined> {
  const selected = pickManifestIcon(manifest);
  const relativePath = selected ? normalizeManifestResourcePath(selected) : undefined;
  if (!relativePath) return undefined;
  const mimeType = ICON_MIME_TYPES[path.extname(relativePath).toLowerCase()];
  if (!mimeType) return undefined;
  const bytes = await readBoundedRegularFileInsideRoot(
    stagedRoot,
    relativePath,
    MAX_ICON_ASSET_BYTES,
    "Manifest icon",
  );
  if (!matchesIconMagic(bytes, mimeType)) {
    throw manifestError("Manifest icon bytes do not match the declared image type.");
  }
  return Object.freeze({ relativePath, mimeType, size: bytes.byteLength });
}

function matchesIconMagic(bytes: Uint8Array, mimeType: string): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mimeType === "image/png") {
    return buffer.byteLength >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/jpeg") {
    return buffer.byteLength >= 4
      && buffer[0] === 0xff
      && buffer[1] === 0xd8
      && buffer[2] === 0xff
      && buffer.at(-2) === 0xff
      && buffer.at(-1) === 0xd9;
  }
  if (mimeType === "image/webp") {
    return buffer.byteLength >= 12
      && buffer.subarray(0, 4).toString("ascii") === "RIFF"
      && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  if (mimeType === "image/svg+xml") {
    let text: string;
    try {
      text = decodeStrictUtf8(buffer, "Manifest SVG icon").trimStart();
    } catch {
      return false;
    }
    if (text.startsWith("<?xml")) {
      const declarationEnd = text.indexOf("?>");
      if (declarationEnd < 0) return false;
      text = text.slice(declarationEnd + 2).trimStart();
    }
    return /^<svg(?:\s|>)/i.test(text) && !/<script(?:\s|>)/i.test(text);
  }
  return false;
}

function pickManifestIcon(manifest: ManifestRecord): string | undefined {
  return pickIconFromSizeMap(manifest.icons)
    ?? pickActionIcon(manifest.action)
    ?? pickActionIcon(manifest.browser_action);
}

function pickActionIcon(action: unknown): string | undefined {
  if (typeof action === "string") return action;
  if (!action || typeof action !== "object" || Array.isArray(action)) return undefined;
  const defaultIcon = (action as { default_icon?: unknown }).default_icon;
  if (typeof defaultIcon === "string") return defaultIcon;
  return pickIconFromSizeMap(defaultIcon);
}

function pickIconFromSizeMap(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidates: Array<{ pixels: number; value: string }> = [];
  for (const [size, pathValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof pathValue !== "string" || !pathValue.trim()) continue;
    const pixels = Number.parseInt(size, 10);
    if (!Number.isSafeInteger(pixels) || pixels <= 0) continue;
    candidates.push({ pixels, value: pathValue });
  }
  candidates.sort((left, right) => right.pixels - left.pixels);
  return (
    candidates.find((candidate) => candidate.pixels === 128)
    ?? candidates.find((candidate) => candidate.pixels <= 256)
    ?? candidates[0]
  )?.value;
}

function normalizeManifestResourcePath(value: string): string | undefined {
  const trimmed = value.trim().replace(/^\/+/, "");
  if (!trimmed || trimmed.includes("\\") || trimmed.includes("\0")) return undefined;
  const normalized = path.posix.normalize(trimmed).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
    return undefined;
  }
  return segments.join("/");
}

function isPathInside(target: string, root: string): boolean {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  const comparableTarget = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;
  const comparableRoot = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
  return comparableTarget !== comparableRoot && comparableTarget.startsWith(`${comparableRoot}${path.sep}`);
}

function compareCatalogFacts(
  catalog: ExtensionPackageCatalogFacts | undefined,
  packageFacts: { name: string; version: string },
): ExtensionPackageDiscrepancy[] {
  const discrepancies: ExtensionPackageDiscrepancy[] = [];
  const catalogName = boundedCatalogFact(catalog?.name, MAX_MANIFEST_NAME_CHARACTERS);
  const catalogVersion = boundedCatalogFact(catalog?.version, MAX_MANIFEST_VERSION_CHARACTERS);
  if (catalogName !== undefined && catalogName !== packageFacts.name) {
    discrepancies.push({ field: "name", catalog: catalogName, package: packageFacts.name });
  }
  if (catalogVersion !== undefined && catalogVersion !== packageFacts.version) {
    discrepancies.push({ field: "version", catalog: catalogVersion, package: packageFacts.version });
  }
  return discrepancies;
}

function boundedCatalogFact(value: unknown, maximumCharacters: number): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized.length <= maximumCharacters ? normalized : undefined;
}

function manifestError(message: string): ExtensionPackagePreflightError {
  return new ExtensionPackagePreflightError(message);
}

function throwIfPreflightAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new ExtensionArchiveAnalysisError(
    "ACQUISITION_CANCELLED",
    "Extension package analysis was cancelled.",
    409,
  );
}
