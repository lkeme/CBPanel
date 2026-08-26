import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type ExtensionCommitJournalPhase =
  | "prepared"
  | "files-published"
  | "database-committed"
  | "complete";

export interface ExtensionCommitPublication {
  kind: "artifact" | "tree";
  stagedPath: string;
  livePath: string;
  asidePath: string;
  oldFingerprint?: string;
  newFingerprint: string;
}

export interface ExtensionCommitJournalRecord {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  targetExtensionId: string;
  phase: ExtensionCommitJournalPhase;
  createdAt: string;
  updatedAt: string;
  oldEntityFingerprint?: string;
  newEntityFingerprint: string;
  publications: [ExtensionCommitPublication, ExtensionCommitPublication];
}

export interface ExtensionCommitReconciler {
  /** Determines whether SQLite durably contains the journal's old or new entity projection. */
  databaseState(record: ExtensionCommitJournalRecord): Promise<"old" | "new">;
  rollbackFiles(record: ExtensionCommitJournalRecord): Promise<void>;
  finalizeFiles(record: ExtensionCommitJournalRecord): Promise<void>;
  cleanupSession?(record: ExtensionCommitJournalRecord): Promise<void>;
}

export class ExtensionAcquisitionCommitJournal {
  private readonly journalRoot: string;

  private readonly allowedRoots: string[];

  private initialized = false;

  constructor(options: { journalRoot: string; allowedRoots: string[] }) {
    this.journalRoot = path.resolve(options.journalRoot);
    this.allowedRoots = [...new Set(options.allowedRoots.map((root) => path.resolve(root)))];
    if (this.allowedRoots.length === 0) throw new TypeError("Commit journal requires managed path roots.");
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.journalRoot, { recursive: true });
    await assertOrdinaryDirectory(this.journalRoot);
    for (const root of this.allowedRoots) {
      await fs.mkdir(root, { recursive: true });
      await assertOrdinaryDirectory(root);
    }
    this.initialized = true;
  }

  async create(input: Omit<ExtensionCommitJournalRecord, "schemaVersion" | "id" | "phase" | "createdAt" | "updatedAt">): Promise<ExtensionCommitJournalRecord> {
    this.assertInitialized();
    const timestamp = new Date().toISOString();
    const record = normalizeRecord({
      ...input,
      schemaVersion: 1,
      id: randomBytes(24).toString("base64url"),
      phase: "prepared",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.assertRecordPaths(record);
    await this.writeRecord(record, { createOnly: true });
    return record;
  }

  async advance(record: ExtensionCommitJournalRecord, nextPhase: ExtensionCommitJournalPhase): Promise<ExtensionCommitJournalRecord> {
    this.assertInitialized();
    const current = normalizeRecord(record);
    const expected = nextJournalPhase(current.phase);
    if (expected !== nextPhase) {
      throw new Error(`Invalid extension commit journal transition: ${current.phase} -> ${nextPhase}`);
    }
    const updated = normalizeRecord({ ...current, phase: nextPhase, updatedAt: new Date().toISOString() });
    await this.assertRecordPaths(updated);
    await this.writeRecord(updated, { createOnly: false });
    return updated;
  }

  async remove(recordOrId: ExtensionCommitJournalRecord | string): Promise<void> {
    this.assertInitialized();
    const id = typeof recordOrId === "string" ? normalizeId(recordOrId, "Journal id") : normalizeRecord(recordOrId).id;
    await fs.rm(this.recordPath(id), { force: true });
    await syncDirectory(this.journalRoot);
  }

  async list(): Promise<ExtensionCommitJournalRecord[]> {
    this.assertInitialized();
    const entries = await fs.readdir(this.journalRoot, { withFileTypes: true });
    const records: ExtensionCommitJournalRecord[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const id = entry.name.slice(0, -5);
        normalizeId(id, "Journal filename");
        const raw = JSON.parse(await fs.readFile(path.join(this.journalRoot, entry.name), "utf8")) as unknown;
        const record = normalizeRecord(raw);
        if (record.id !== id) throw new Error("Extension commit journal filename and id disagree.");
        await this.assertRecordPaths(record);
        records.push(record);
        continue;
      }
      // Atomic-write debris has no authority. Other entries indicate a corrupted managed root.
      if (entry.isFile() && entry.name.includes(".tmp-")) {
        await fs.rm(path.join(this.journalRoot, entry.name), { force: true });
        continue;
      }
      throw new Error(`Unexpected extension commit journal entry: ${entry.name}`);
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async reconcileAll(reconciler: ExtensionCommitReconciler): Promise<void> {
    for (const record of await this.list()) await this.reconcile(record, reconciler);
  }

  async reconcile(record: ExtensionCommitJournalRecord, reconciler: ExtensionCommitReconciler): Promise<void> {
    const current = normalizeRecord(record);
    await this.assertRecordPaths(current);
    if (current.phase === "complete") {
      const databaseState = await reconciler.databaseState(current);
      if (databaseState === "new") {
        await reconciler.finalizeFiles(current);
      } else {
        await reconciler.rollbackFiles(current);
      }
      await reconciler.cleanupSession?.(current);
      await this.remove(current);
      return;
    }

    const databaseState = await reconciler.databaseState(current);
    if (databaseState === "new") {
      await reconciler.finalizeFiles(current);
    } else if (databaseState === "old") {
      await reconciler.rollbackFiles(current);
    } else {
      throw new Error("Extension commit journal database state is unresolved.");
    }
    await reconciler.cleanupSession?.(current);
    // Do not manufacture a `complete` phase for a transaction that was rolled back. A
    // crash after writing such a marker would make the next startup take the complete
    // branch and finalize files that belong to the old database state. The original
    // phase is deliberately retained until removal; replaying rollback/finalize is
    // idempotent and therefore crash-safe.
    await this.remove(current);
  }

  private async writeRecord(record: ExtensionCommitJournalRecord, options: { createOnly: boolean }): Promise<void> {
    const target = this.recordPath(record.id);
    if (options.createOnly && await pathExists(target)) throw new Error("Extension commit journal already exists.");
    const temporary = path.join(this.journalRoot, `${record.id}.tmp-${randomBytes(8).toString("hex")}`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (options.createOnly && await pathExists(target)) throw new Error("Extension commit journal already exists.");
      await fs.rename(temporary, target);
      await syncDirectory(this.journalRoot);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async assertRecordPaths(record: ExtensionCommitJournalRecord): Promise<void> {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(record.sessionId)) {
      throw new Error("Extension commit journal session id is invalid.");
    }
    if (
      !/^[A-Za-z0-9_-]{1,256}$/.test(record.targetExtensionId)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(record.targetExtensionId)
    ) {
      throw new Error("Extension commit journal target id is invalid.");
    }
    const artifact = record.publications.find((publication) => publication.kind === "artifact");
    const tree = record.publications.find((publication) => publication.kind === "tree");
    if (!artifact || !tree) throw new Error("Extension commit journal publication kinds are incomplete.");
    for (const publication of record.publications) {
      for (const candidate of [publication.stagedPath, publication.livePath, publication.asidePath]) {
        await assertManagedPath(candidate, this.allowedRoots);
      }
    }
    if (
      path.basename(artifact.livePath) !== "current.crx"
      || path.basename(tree.livePath) !== record.targetExtensionId
      || path.basename(artifact.stagedPath) !== "artifact.crx"
      || path.basename(tree.stagedPath) !== "unpacked"
      || !path.basename(artifact.asidePath).startsWith(".old-")
      || !path.basename(tree.asidePath).startsWith(".old-")
      || path.basename(path.dirname(artifact.stagedPath)) !== record.sessionId
      || path.basename(path.dirname(tree.stagedPath)) !== record.sessionId
      || path.basename(path.dirname(artifact.livePath)) !== record.targetExtensionId
      || path.basename(path.dirname(artifact.asidePath)) !== record.targetExtensionId
      || path.dirname(tree.asidePath) !== path.dirname(tree.livePath)
      || path.dirname(artifact.asidePath) !== path.dirname(artifact.livePath)
    ) {
      throw new Error("Extension commit journal publication paths do not match the acquisition layout.");
    }
    const allPaths = record.publications.flatMap((publication) => [
      publication.stagedPath,
      publication.livePath,
      publication.asidePath,
    ]);
    for (let index = 0; index < allPaths.length; index += 1) {
      for (let next = index + 1; next < allPaths.length; next += 1) {
        if (isPathInside(allPaths[index], allPaths[next]) || isPathInside(allPaths[next], allPaths[index])) {
          throw new Error("Extension commit journal publication paths overlap.");
        }
      }
    }
    for (const publication of record.publications) {
      if (publication.stagedPath === publication.livePath || publication.livePath === publication.asidePath) {
        throw new Error("Extension commit journal publication paths must be distinct.");
      }
    }
  }

  private recordPath(id: string): string {
    return path.join(this.journalRoot, `${normalizeId(id, "Journal id")}.json`);
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("Extension commit journal has not been initialized.");
  }
}

export function normalizeExtensionCommitJournal(input: unknown): ExtensionCommitJournalRecord {
  return normalizeRecord(input);
}

function normalizeRecord(input: unknown): ExtensionCommitJournalRecord {
  const record = requiredRecord(input, "Extension commit journal");
  if (record.schemaVersion !== 1) throw new Error("Unsupported extension commit journal schema.");
  const phase = enumValue(record.phase, ["prepared", "files-published", "database-committed", "complete"] as const, "Journal phase");
  if (!Array.isArray(record.publications) || record.publications.length !== 2) {
    throw new Error("Extension commit journal must contain exactly two publications.");
  }
  const publications = record.publications.map(normalizePublication) as [ExtensionCommitPublication, ExtensionCommitPublication];
  if (new Set(publications.map((item) => item.kind)).size !== 2) {
    throw new Error("Extension commit journal must contain artifact and tree publications.");
  }
  return {
    schemaVersion: 1,
    id: normalizeId(record.id, "Journal id"),
    sessionId: normalizeId(record.sessionId, "Journal session id"),
    targetExtensionId: boundedString(record.targetExtensionId, "Journal target extension id"),
    phase,
    createdAt: isoTimestamp(record.createdAt, "Journal created time"),
    updatedAt: isoTimestamp(record.updatedAt, "Journal updated time"),
    oldEntityFingerprint: optionalSha256(record.oldEntityFingerprint, "Old entity fingerprint"),
    newEntityFingerprint: sha256(record.newEntityFingerprint, "New entity fingerprint"),
    publications,
  };
}

function normalizePublication(input: unknown): ExtensionCommitPublication {
  const record = requiredRecord(input, "Journal publication");
  return {
    kind: enumValue(record.kind, ["artifact", "tree"] as const, "Publication kind"),
    stagedPath: absolutePath(record.stagedPath, "Publication staged path"),
    livePath: absolutePath(record.livePath, "Publication live path"),
    asidePath: absolutePath(record.asidePath, "Publication aside path"),
    oldFingerprint: optionalSha256(record.oldFingerprint, "Old publication fingerprint"),
    newFingerprint: sha256(record.newFingerprint, "New publication fingerprint"),
  };
}

function nextJournalPhase(phase: ExtensionCommitJournalPhase): ExtensionCommitJournalPhase | undefined {
  switch (phase) {
    case "prepared": return "files-published";
    case "files-published": return "database-committed";
    case "database-committed": return "complete";
    case "complete": return undefined;
  }
}

async function assertManagedPath(candidate: string, roots: readonly string[]): Promise<void> {
  const absolute = path.resolve(candidate);
  if (absolute !== candidate) throw new Error("Extension commit journal paths must be normalized absolute paths.");
  const root = roots.find((value) => isPathInside(absolute, value));
  if (!root) throw new Error("Extension commit journal path escapes managed roots.");
  const existing = await nearestExistingPath(absolute);
  const [canonicalExisting, canonicalRoot] = await Promise.all([fs.realpath(existing), fs.realpath(root)]);
  if (!isPathInside(canonicalExisting, canonicalRoot)) {
    throw new Error("Extension commit journal path traverses a linked managed root.");
  }
}

async function nearestExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  for (;;) {
    if (await pathExists(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Extension commit journal path has no existing ancestor.");
    current = parent;
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertOrdinaryDirectory(candidate: string): Promise<void> {
  const stats = await fs.lstat(candidate);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Managed journal roots must be ordinary directories.");
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EISDIR" && code !== "EPERM" && code !== "EINVAL")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Error(`${label} is invalid.`);
  return value as T[number];
}

function normalizeId(value: unknown, label: string): string {
  const result = boundedString(value, label);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(result)) throw new Error(`${label} is invalid.`);
  return result;
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a non-empty bounded string.`);
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const candidate = boundedString(value, label);
  if (!path.isAbsolute(candidate) || path.resolve(candidate) !== candidate) throw new Error(`${label} must be an absolute normalized path.`);
  return candidate;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} must be a SHA-256 digest.`);
  return value.toLowerCase();
}

function optionalSha256(value: unknown, label: string): string | undefined {
  return value === undefined || value === null ? undefined : sha256(value, label);
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}
