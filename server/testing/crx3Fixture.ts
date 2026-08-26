import {
  createHash,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { zipSync } from "fflate";

export interface SyntheticStoreCrx3Fixture {
  bytes: Buffer;
  storeId: string;
  developerSpkiBase64: string;
  developerSpkiSha256: string;
  publisherSpkiSha256: string;
  manifestSha256: string;
}

export interface SyntheticCrx3SigningKeys {
  developer: SyntheticKey;
  publisher: SyntheticKey;
}

/** Offline-only genuine-structure CRX3 fixture. Its synthetic publisher hash is never a production root. */
export function createSyntheticStoreCrx3(options: {
  name?: string;
  version?: string;
  permissions?: string[];
  hostPermissions?: string[];
  signingKeys?: SyntheticCrx3SigningKeys;
} = {}): SyntheticStoreCrx3Fixture {
  const developer = options.signingKeys?.developer ?? syntheticKey("rsa");
  const publisher = options.signingKeys?.publisher ?? syntheticKey("ec");
  const manifest = {
    manifest_version: 3,
    name: options.name ?? "Synthetic Store Extension",
    version: options.version ?? "1.0.0",
    permissions: options.permissions ?? ["storage"],
    host_permissions: options.hostPermissions ?? ["https://example.test/*"],
    background: { service_worker: "worker.js" },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const zip = Buffer.from(zipSync({
    "manifest.json": manifestBytes,
    "worker.js": Buffer.from("chrome.runtime.onInstalled.addListener(() => undefined);", "utf8"),
  }, { level: 6 }));
  const signedHeader = protobufBytes(1, createHash("sha256").update(developer.publicKey).digest().subarray(0, 16));
  const header = Buffer.concat([
    protobufBytes(2, proofMessage(developer, signedHeader, zip)),
    protobufBytes(3, proofMessage(publisher, signedHeader, zip)),
    protobufBytes(10000, signedHeader),
  ]);
  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "ascii");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.byteLength, 8);
  const developerHash = sha256(developer.publicKey);
  return {
    bytes: Buffer.concat([prefix, header, zip]),
    storeId: chromeIdFromHash(developerHash),
    developerSpkiBase64: developer.publicKey.toString("base64"),
    developerSpkiSha256: developerHash,
    publisherSpkiSha256: sha256(publisher.publicKey),
    manifestSha256: sha256(Buffer.from(JSON.stringify(manifestWithoutKey(manifest)), "utf8")),
  };
}

export type SyntheticKey = { publicKey: Buffer; privateKey: KeyObject };

export function createSyntheticCrx3SigningKeys(): SyntheticCrx3SigningKeys {
  return { developer: syntheticKey("rsa"), publisher: syntheticKey("ec") };
}

function syntheticKey(kind: "rsa" | "ec"): SyntheticKey {
  const pair = kind === "rsa"
    ? generateKeyPairSync("rsa", { modulusLength: 2048 })
    : generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey: Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })),
    privateKey: pair.privateKey,
  };
}

function proofMessage(key: SyntheticKey, signedHeader: Buffer, zip: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signedHeader.byteLength);
  const signature = createSign("sha256")
    .update(Buffer.from("CRX3 SignedData\0", "ascii"))
    .update(size)
    .update(signedHeader)
    .update(zip)
    .sign(key.privateKey);
  return Buffer.concat([protobufBytes(1, key.publicKey), protobufBytes(2, signature)]);
}

function protobufBytes(fieldNumber: number, value: Uint8Array): Buffer {
  return Buffer.concat([varint((fieldNumber * 8) + 2), varint(value.byteLength), Buffer.from(value)]);
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function chromeIdFromHash(hash: string): string {
  return hash.slice(0, 32).replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

function manifestWithoutKey<T extends Record<string, unknown>>(manifest: T): T {
  const clone = { ...manifest };
  delete clone.key;
  return clone;
}
