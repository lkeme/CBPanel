import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

type SecretCommand = (file: string, args: string[], input?: string) => Promise<string>;

const webAccessQueues = new Map<string, Promise<void>>();
const UUID_PATTERN = "[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}";
const OWNER_PATTERN = new RegExp(`^owner-([1-9][0-9]*)-(${UUID_PATTERN})$`);

/** GitHub tokens never enter app_settings, backups, diagnostics or process arguments. */
export class PrivateCoreSecretStore {
  private target?: Promise<string>;
  private readonly filePath: string;
  private readonly identityPath: string;
  private cached?: { value: string | undefined; at: number };
  private accessQueue: Promise<void> = Promise.resolve();
  constructor(private readonly options: { dataDir: string; desktop: boolean; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: SecretCommand }) {
    this.filePath = path.join(options.dataDir, "private-github-token");
    this.identityPath = path.join(options.dataDir, "private-core-credential-id");
  }

  async read(): Promise<string | undefined> {
    return this.withExclusiveAccess(() => this.readStored());
  }

  private async readStored(): Promise<string | undefined> {
    const envToken = (this.options.env ?? process.env).CBPANEL_PRIVATE_GITHUB_TOKEN?.trim();
    if (envToken) return envToken;
    if (!this.options.desktop) {
      try { return (await fs.readFile(this.filePath, "utf8")).trim() || undefined; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw secretStorageError();
      }
    }
    if (this.cached && Date.now() - this.cached.at < 60_000) return this.cached.value;
    const value = (await this.osStore("read"))?.trim() || undefined;
    this.cached = { value, at: Date.now() };
    return value;
  }

  async write(token: string): Promise<void> {
    return this.withExclusiveAccess(() => this.writeStored(token));
  }

  private async writeStored(token: string): Promise<void> {
    if ((this.options.env ?? process.env).CBPANEL_PRIVATE_GITHUB_TOKEN?.trim()) throw Object.assign(new Error("The GitHub token is managed by CBPANEL_PRIVATE_GITHUB_TOKEN. Change the server environment to replace or remove it."), { status: 409, code: "PRIVATE_TOKEN_ENV_MANAGED" });
    if (token.length > 1024 || /[\r\n\0]/.test(token)) throw Object.assign(new Error("The GitHub token has an invalid format."), { status: 400, code: "PRIVATE_TOKEN_INVALID" });
    if (this.options.desktop) {
      await this.osStore(token ? "write" : "delete", token);
      this.cached = { value: token || undefined, at: Date.now() };
      // Retire the old development-only plaintext store only after the OS store succeeds.
      await fs.rm(this.filePath, { force: true });
      return;
    }
    await fs.mkdir(this.options.dataDir, { recursive: true });
    if (!token) { await fs.rm(this.filePath, { force: true }); return; }
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${token}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, this.filePath);
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  }

  private withExclusiveAccess<T>(operation: () => Promise<T>): Promise<T> {
    // OS reads can finish after a later write and otherwise replace its fresh cached value.
    // Order reads, writes and clears together; a rejected operation must not poison the queue.
    if (!this.options.desktop) {
      // Windows cannot replace a destination being read/replaced by another instance. All Web
      // instances in this process must finish their file operation before the next one starts.
      const resolved = path.resolve(this.filePath);
      const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
      const pending = (webAccessQueues.get(key) ?? Promise.resolve()).then(operation);
      const settled = pending.then(() => undefined, () => undefined);
      webAccessQueues.set(key, settled);
      void settled.then(() => { if (webAccessQueues.get(key) === settled) webAccessQueues.delete(key); });
      return pending;
    }
    const pending = this.accessQueue.then(operation);
    this.accessQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async credentialTarget(): Promise<string> {
    this.target ??= this.loadCredentialTarget();
    try { return await this.target; }
    catch (error) { this.target = undefined; throw error; }
  }

  private async readCredentialIdentity(): Promise<string | undefined> {
    let identity: string;
    try { identity = (await fs.readFile(this.identityPath, "utf8")).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(identity)) {
      throw Object.assign(new Error("The private credential identity file is damaged. Restore the original private-core-credential-id file to access the existing token."), { status: 503, code: "PRIVATE_TOKEN_IDENTITY_INVALID" });
    }
    return identity.toLowerCase();
  }

  private async loadCredentialTarget(): Promise<string> {
    await fs.mkdir(this.options.dataDir, { recursive: true });
    const lockPath = `${this.identityPath}.lock`;
    await recoverAbandonedIdentityLocks(lockPath);
    const existing = await this.readCredentialIdentity();
    if (existing) return `CBPanel/private-core/${existing}`;
    const nonce = randomUUID();
    const owner = `owner-${process.pid}-${nonce}`;
    const temporary = `identity-${nonce}.tmp`;
    const pendingPath = `${lockPath}.${process.pid}.${nonce}.pending`;
    const identity = randomUUID();
    // Preparing a nonempty directory before its atomic rename leaves no ownerless live lock,
    // even if the process exits immediately after mkdir. This also works on FAT/exFAT.
    try {
      await fs.mkdir(pendingPath);
      await fs.writeFile(path.join(pendingPath, owner), "", { flag: "wx", mode: 0o600 });
      await fs.writeFile(path.join(pendingPath, temporary), `${identity}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      for (let attempt = 0; attempt < 80; attempt += 1) {
        let ownsLock = false;
        try {
          try { await fs.rename(pendingPath, lockPath); ownsLock = true; }
          catch (error) {
            // Windows reports EPERM/EACCES for an existing destination directory as well as for
            // real permission errors, and the competing owner can retire its directory between
            // the failed rename and any later probe. Treating that window as terminal would turn
            // ordinary contention into an unavailable credential store, so every contention code
            // retries instead: a genuine permission error exhausts the attempts below into the
            // same sanitized failure, just without mistaking a completed peer for a broken store.
            if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          }
          const installed = await this.readCredentialIdentity();
          if (installed) return `CBPanel/private-core/${installed}`;
          if (ownsLock) {
            try { await fs.rename(path.join(lockPath, temporary), this.identityPath); }
            catch (error) {
              // A competing process can publish the identity before this owner's rename lands.
              // Adopt what is already there rather than reporting the now-taken destination as a
              // storage failure.
              const published = await this.readCredentialIdentity().catch(() => undefined);
              if (published) return `CBPanel/private-core/${published}`;
              throw error;
            }
            return `CBPanel/private-core/${identity}`;
          }
          await recoverIdentityLock(lockPath);
        } finally {
          if (ownsLock) await removeIdentityLockFiles(lockPath, owner, temporary);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      throw secretStorageError();
    } finally { await removeIdentityLockFiles(pendingPath, owner, temporary); }
  }

  private async osStore(action: "read" | "write" | "delete", token = ""): Promise<string | undefined> {
    const run = this.options.run ?? runSecretCommand;
    const platform = this.options.platform ?? process.platform;
    try {
      const target = await this.credentialTarget();
      if (platform === "win32") {
        const script = windowsCredentialScript;
        const encoded = Buffer.from(script, "utf16le").toString("base64");
        return await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], JSON.stringify({ action, target, token }));
      }
      if (platform === "darwin") {
        if (action === "read") {
          try { return await run("/usr/bin/security", ["find-generic-password", "-a", "CBPanel", "-s", target, "-w"]); } catch (error) { if ((error as { exitCode?: number }).exitCode === 44) return undefined; throw error; }
        }
        if (action === "delete") {
          try { await run("/usr/bin/security", ["delete-generic-password", "-a", "CBPanel", "-s", target]); } catch (error) { if ((error as { exitCode?: number }).exitCode !== 44) throw error; }
        } else {
          // security's interactive mode reads its command from stdin; the password is never argv.
          const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
          await run("/usr/bin/security", ["-i"], `add-generic-password -U -a CBPanel -s ${quote(target)} -w ${quote(token)}\n`);
        }
        return undefined;
      }
      if (platform === "linux") {
        if (action === "read") {
          try { return await run("secret-tool", ["lookup", "application", "CBPanel", "private-core", target]); } catch (error) { if ((error as { exitCode?: number }).exitCode === 1) return undefined; throw error; }
        }
        try { await run("secret-tool", action === "delete"
          ? ["clear", "application", "CBPanel", "private-core", target]
          : ["store", "--label=CBPanel private CloakBrowser repository", "application", "CBPanel", "private-core", target], action === "write" ? `${token}\n` : undefined); }
        catch (error) { if (action !== "delete" || (error as { exitCode?: number }).exitCode !== 1) throw error; }
        return undefined;
      }
      throw new Error("Unsupported credential platform");
    } catch (error) {
      if ((error as { code?: string }).code === "PRIVATE_TOKEN_IDENTITY_INVALID") throw error;
      throw secretStorageError();
    }
  }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function isDirectory(directory: string): Promise<boolean> {
  try { const stat = await fs.lstat(directory); return stat.isDirectory() && !stat.isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function removeIdentityLockFiles(directory: string, owner: string, temporary: string): Promise<void> {
  // Never recursively remove the shared lock: another process may already have installed a
  // new generation. Its unique marker survives, so rmdir cannot remove that live directory.
  await fs.rm(path.join(directory, temporary), { force: true }).catch(() => undefined);
  await fs.rm(path.join(directory, owner), { force: true }).catch(() => undefined);
  await fs.rmdir(directory).catch(() => undefined);
}

async function recoverIdentityLock(directory: string): Promise<void> {
  if (!(await isDirectory(directory))) return;
  let entries: string[];
  try { entries = await fs.readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!entries.length) {
    // Only older interrupted creations can leave the published lock empty. An active lock
    // in this protocol always contains its complete owner marker before it becomes visible.
    await fs.rmdir(directory).catch(() => undefined);
    return;
  }
  const owners = entries.flatMap((name) => {
    const match = OWNER_PATTERN.exec(name);
    const pid = Number(match?.[1]);
    return match && Number.isSafeInteger(pid) && pid <= 0x7fffffff ? [{ name, pid, nonce: match[2] }] : [];
  });
  if (owners.length !== 1 || processIsAlive(owners[0].pid)) return;
  const owner = owners[0];
  const temporary = `identity-${owner.nonce}.tmp`;
  if (entries.some((name) => name !== owner.name && name !== temporary)) return;
  await removeIdentityLockFiles(directory, owner.name, temporary);
}

async function recoverAbandonedIdentityLocks(lockPath: string): Promise<void> {
  await recoverIdentityLock(lockPath);
  const prefix = `${path.basename(lockPath)}.`;
  const pendingPattern = new RegExp(`^([1-9][0-9]*)\\.(${UUID_PATTERN})\\.pending$`);
  for (const entry of await fs.readdir(path.dirname(lockPath), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const match = pendingPattern.exec(entry.name.slice(prefix.length));
    const pid = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(pid) || pid > 0x7fffffff || processIsAlive(pid)) continue;
    await removeIdentityLockFiles(path.join(path.dirname(lockPath), entry.name), `owner-${pid}-${match[2]}`, `identity-${match[2]}.tmp`);
  }
}

function secretStorageError(): Error {
  return Object.assign(new Error("The system credential store is unavailable. Unlock the system keyring or configure CBPANEL_PRIVATE_GITHUB_TOKEN for this process."), { status: 503, code: "PRIVATE_TOKEN_STORAGE_UNAVAILABLE" });
}

async function runSecretCommand(file: string, args: string[], input = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Credential store timed out")); }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024) child.kill(); else chunks.push(chunk); });
    child.stderr.resume();
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => { clearTimeout(timeout); if (code === 0) resolve(Buffer.concat(chunks).toString("utf8").trim()); else reject(Object.assign(new Error("Credential operation failed"), { exitCode: code })); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input, "utf8");
  });
}

const windowsCredentialScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CBPanelCredential {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Credential {
  public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize;
  public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes;
  public string TargetAlias; public string UserName;
 }
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Read(string target, UInt32 type, UInt32 flags, out IntPtr pointer);
 [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Write(ref Credential credential, UInt32 flags);
 [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Delete(string target, UInt32 type, UInt32 flags);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr pointer);
}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.action -eq 'read') {
 $pointer = [IntPtr]::Zero
 if ([CBPanelCredential]::Read($request.target, 1, 0, [ref]$pointer)) {
  try { $item = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][CBPanelCredential+Credential]); [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringUni($item.CredentialBlob, $item.CredentialBlobSize / 2)) } finally { [CBPanelCredential]::CredFree($pointer) }
 } elseif ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'Credential read failed' }
} elseif ($request.action -eq 'delete') {
 if (-not [CBPanelCredential]::Delete($request.target, 1, 0) -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'Credential delete failed' }
} else {
 $item = New-Object CBPanelCredential+Credential
 $item.Type = 1; $item.TargetName = $request.target; $item.UserName = 'CBPanel'; $item.Persist = 2
 $item.CredentialBlobSize = [Text.Encoding]::Unicode.GetByteCount($request.token)
 $item.CredentialBlob = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($request.token)
 try { if (-not [CBPanelCredential]::Write([ref]$item, 0)) { throw 'Credential write failed' } } finally { [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($item.CredentialBlob) }
}
`;
