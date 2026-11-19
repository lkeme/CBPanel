import {
  createHash,
  createPublicKey,
  createVerify,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs/promises";
import type { ExtensionAcquisitionErrorCode } from "../../src/shared/extensionAcquisition";
import {
  CHROMIUM_CWS_PUBLISHER_TRUST_ROOT,
  type Crx3PublisherTrustRoot,
} from "./crx3TrustRoot";

const CRX_MAGIC = Buffer.from("Cr24", "ascii");
const CRX3_VERSION = 3;
const CRX_PREFIX_BYTES = 12;
const SIGNATURE_CONTEXT = Buffer.from("CRX3 SignedData\0", "ascii");
const CANONICAL_EXTENSION_ID = /^[a-p]{32}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_PROTOBUF_FIELD_NUMBER = (2 ** 29) - 1;
const FILE_READ_CHUNK_BYTES = 64 * 1024;

const FORBIDDEN_HEADER_TOKENS = [
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x06, 0x07]),
  Buffer.from([0x50, 0x4b, 0x06, 0x06]),
] as const;

export const CRX3_VERIFIER_LIMITS = Object.freeze({
  maxFileBytes: 200 * 1024 * 1024,
  maxHeaderBytes: 1024 * 1024,
  maxSignedHeaderBytes: 64 * 1024,
  maxProofs: 8,
  maxHeaderFields: 256,
  maxSignedHeaderFields: 32,
  maxProofFields: 32,
  maxSpkiBytes: 4 * 1024,
  maxSignatureBytes: 4 * 1024,
  maxRsaModulusBits: 8 * 1024,
});

/** RSA is PKCS#1 v1.5; ECDSA is restricted to the NIST P-256 curve. */
export type Crx3ProofAlgorithm = "rsa-sha256" | "ecdsa-sha256";

export type Crx3VerificationErrorCode = Extract<
  ExtensionAcquisitionErrorCode,
  | "STORE_CRX3_REQUIRED"
  | "CRX_DEVELOPER_PROOF_INVALID"
  | "CRX_ID_MISMATCH"
  | "CWS_PUBLISHER_PROOF_REQUIRED"
>;

export interface Crx3VerificationFacts {
  readonly format: "crx3";
  readonly crxVersion: 3;
  readonly requestedId: string;
  readonly declaredId: string;
  readonly developerDerivedId: string;
  readonly developerSpkiBase64: string;
  readonly developerSpkiSha256: string;
  readonly developerProofAlgorithm: Crx3ProofAlgorithm;
  readonly publisherSpkiSha256: string;
  readonly publisherProofAlgorithm: Crx3ProofAlgorithm;
  readonly publisherTrustRootId: string;
  readonly publisherTrustRootVersion: number;
  readonly headerSize: number;
  readonly signedHeaderSize: number;
  readonly zipOffset: number;
  readonly zipSize: number;
  readonly crxSize: number;
  readonly crxSha256: string;
  readonly proofAlgorithms: readonly Crx3ProofAlgorithm[];
  readonly proofCounts: Readonly<{
    rsa: number;
    ecdsa: number;
    total: number;
  }>;
}

export class Crx3VerificationError extends Error {
  readonly code: Crx3VerificationErrorCode;

  readonly status = 422;

  constructor(code: Crx3VerificationErrorCode, message: string) {
    super(message);
    this.name = "Crx3VerificationError";
    this.code = code;
  }
}

export interface Crx3TestVerifier {
  verifyBytes(bytes: Uint8Array, requestedId: string): Crx3VerificationFacts;
  verifyFile(filePath: string, requestedId: string): Promise<Crx3VerificationFacts>;
}

interface ParsedCrx3 {
  readonly headerSize: number;
  readonly signedHeader: Uint8Array;
  readonly declaredId: string;
  readonly zipOffset: number;
  readonly proofs: readonly ParsedProof[];
}

interface ParsedProof {
  readonly algorithm: Crx3ProofAlgorithm;
  readonly publicKey: Uint8Array;
  readonly signature?: Uint8Array;
}

interface PreparedProof {
  readonly algorithm: Crx3ProofAlgorithm;
  readonly publicKey: Uint8Array;
  readonly signature: Uint8Array;
  readonly keyObject: KeyObject;
  readonly verifier: ReturnType<typeof createVerify>;
  readonly spkiSha256: string;
  readonly derivedId: string;
  readonly isDeveloperCandidate: boolean;
  readonly isPublisherCandidate: boolean;
}

interface VerificationContext {
  readonly parsed: ParsedCrx3;
  readonly requestedId: string;
  readonly trustRoot: Crx3PublisherTrustRoot;
  readonly proofs: readonly PreparedProof[];
  readonly developerProof: PreparedProof;
  readonly publisherProof: PreparedProof;
}

interface ProtobufField {
  readonly fieldNumber: number;
  readonly wireType: number;
  readonly value?: Uint8Array;
}

/**
 * Verifies in-memory bytes against Chromium's pinned production Web Store
 * publisher key. There is intentionally no trust-root option on this runtime
 * entry point.
 */
export function verifyChromeWebStoreCrx3(
  bytes: Uint8Array,
  requestedId: string,
): Crx3VerificationFacts {
  return verifyCrx3BytesWithTrustRoot(bytes, requestedId, CHROMIUM_CWS_PUBLISHER_TRUST_ROOT);
}

/**
 * Streaming counterpart for provider downloads. Only the bounded CRX3 header
 * is retained in memory; the exact archive bytes feed every proof and the file
 * fingerprint in fixed-size chunks.
 */
export async function verifyChromeWebStoreCrx3File(
  filePath: string,
  requestedId: string,
): Promise<Crx3VerificationFacts> {
  return verifyCrx3FileWithTrustRoot(filePath, requestedId, CHROMIUM_CWS_PUBLISHER_TRUST_ROOT);
}

/**
 * Explicit synthetic-root hook for offline adversarial tests. Production code
 * must call the two fixed-root functions above; no runtime request object can
 * supply or replace publisher trust material.
 */
export function createCrx3VerifierForTesting(publisherSpkiSha256: string): Crx3TestVerifier {
  const normalizedHash = publisherSpkiSha256.trim().toLowerCase();
  if (!SHA256_HEX.test(normalizedHash)) {
    throw new TypeError("Test publisher SPKI hash must be a SHA-256 hex digest.");
  }
  const trustRoot = Object.freeze({
    id: "cbpanel-test-only-cws",
    version: 0,
    spkiSha256: normalizedHash,
  }) satisfies Crx3PublisherTrustRoot;
  return Object.freeze({
    verifyBytes: (bytes: Uint8Array, requestedId: string) => (
      verifyCrx3BytesWithTrustRoot(bytes, requestedId, trustRoot)
    ),
    verifyFile: (filePath: string, requestedId: string) => (
      verifyCrx3FileWithTrustRoot(filePath, requestedId, trustRoot)
    ),
  });
}

function verifyCrx3BytesWithTrustRoot(
  bytes: Uint8Array,
  requestedId: string,
  trustRoot: Crx3PublisherTrustRoot,
): Crx3VerificationFacts {
  try {
    assertRequestedId(requestedId);
    const crx = bufferView(bytes);
    assertBoundedFileSize(crx.byteLength);
    const parsed = parseCrx3(
      crx.subarray(0, CRX_PREFIX_BYTES),
      crx.subarray(CRX_PREFIX_BYTES),
      crx.byteLength,
    );
    const context = prepareVerification(parsed, requestedId, trustRoot);
    const zipPayload = crx.subarray(parsed.zipOffset);
    updateProofs(context.proofs, zipPayload);
    return finishVerification(
      context,
      zipPayload.byteLength,
      crx.byteLength,
      sha256Hex(crx),
    );
  } catch (error) {
    throw normalizeVerifierFailure(error);
  }
}

async function verifyCrx3FileWithTrustRoot(
  filePath: string,
  requestedId: string,
  trustRoot: Crx3PublisherTrustRoot,
): Promise<Crx3VerificationFacts> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    assertRequestedId(requestedId);
    if (typeof filePath !== "string" || !filePath.trim() || filePath.length > 32_768) {
      throw structuralFailure("CRX3 package path is invalid.");
    }
    handle = await fs.open(filePath, "r");
    const initialStat = await handle.stat();
    if (!initialStat.isFile()) throw structuralFailure("CRX3 package is not a regular file.");
    assertBoundedFileSize(initialStat.size);

    const prefix = await readExact(handle, CRX_PREFIX_BYTES, 0);
    const provisionalHeaderSize = readHeaderSize(prefix);
    if (provisionalHeaderSize > CRX3_VERIFIER_LIMITS.maxHeaderBytes) {
      throw structuralFailure("CRX3 header exceeds the verification limit.");
    }
    const header = await readExact(handle, provisionalHeaderSize, CRX_PREFIX_BYTES);
    const parsed = parseCrx3(prefix, header, initialStat.size);
    const context = prepareVerification(parsed, requestedId, trustRoot);
    const crxHash = createHash("sha256").update(prefix).update(header);

    let position = parsed.zipOffset;
    let remaining = initialStat.size - parsed.zipOffset;
    while (remaining > 0) {
      const chunk = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
      if (bytesRead <= 0) throw structuralFailure("CRX3 archive is truncated.");
      const consumed = chunk.subarray(0, bytesRead);
      updateProofs(context.proofs, consumed);
      crxHash.update(consumed);
      position += bytesRead;
      remaining -= bytesRead;
    }

    const finalStat = await handle.stat();
    if (finalStat.size !== initialStat.size) {
      throw structuralFailure("CRX3 package changed during verification.");
    }
    return finishVerification(
      context,
      initialStat.size - parsed.zipOffset,
      initialStat.size,
      crxHash.digest("hex"),
    );
  } catch (error) {
    throw normalizeVerifierFailure(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseCrx3(prefix: Uint8Array, headerAndArchive: Uint8Array, crxSize: number): ParsedCrx3 {
  if (prefix.byteLength !== CRX_PREFIX_BYTES) {
    throw structuralFailure("CRX3 package header is truncated.");
  }
  const prefixBuffer = bufferView(prefix);
  if (!prefixBuffer.subarray(0, CRX_MAGIC.byteLength).equals(CRX_MAGIC)) {
    throw structuralFailure("Remote store packages must use the CRX3 container.");
  }
  if (prefixBuffer.readUInt32LE(4) !== CRX3_VERSION) {
    throw structuralFailure("Remote store packages must use CRX3 version 3.");
  }
  const headerSize = readHeaderSize(prefixBuffer);
  if (headerSize === 0 || headerSize > CRX3_VERIFIER_LIMITS.maxHeaderBytes) {
    throw structuralFailure("CRX3 header size is invalid.");
  }
  const zipOffset = CRX_PREFIX_BYTES + headerSize;
  if (!Number.isSafeInteger(crxSize) || zipOffset >= crxSize) {
    throw structuralFailure("CRX3 header or archive is truncated.");
  }
  if (headerAndArchive.byteLength < headerSize) {
    throw structuralFailure("CRX3 header is truncated.");
  }
  const header = headerAndArchive.subarray(0, headerSize);
  rejectArchiveTokensInHeader(header);
  const fields = parseProtobufFields(header, CRX3_VERIFIER_LIMITS.maxHeaderFields);
  let signedHeader: Uint8Array | undefined;
  let verifiedContentsSeen = false;
  const proofs: ParsedProof[] = [];

  for (const field of fields) {
    switch (field.fieldNumber) {
      case 2:
      case 3: {
        requireLengthDelimited(field, "CRX3 proof");
        if (proofs.length >= CRX3_VERIFIER_LIMITS.maxProofs) {
          throw structuralFailure("CRX3 contains too many proofs.");
        }
        proofs.push(parseProof(field.value!, field.fieldNumber === 2 ? "rsa-sha256" : "ecdsa-sha256"));
        break;
      }
      case 4:
        requireLengthDelimited(field, "CRX3 verified contents");
        if (verifiedContentsSeen) {
          throw structuralFailure("CRX3 verified contents field is duplicated.");
        }
        verifiedContentsSeen = true;
        break;
      case 10000:
        requireLengthDelimited(field, "CRX3 signed header");
        if (signedHeader) throw structuralFailure("CRX3 signed header field is duplicated.");
        signedHeader = field.value;
        break;
      default:
        break;
    }
  }

  if (!signedHeader || signedHeader.byteLength === 0) {
    throw structuralFailure("CRX3 signed header is missing.");
  }
  if (signedHeader.byteLength > CRX3_VERIFIER_LIMITS.maxSignedHeaderBytes) {
    throw structuralFailure("CRX3 signed header exceeds the verification limit.");
  }
  const signedFields = parseProtobufFields(
    signedHeader,
    CRX3_VERIFIER_LIMITS.maxSignedHeaderFields,
  );
  let declaredIdBytes: Uint8Array | undefined;
  for (const field of signedFields) {
    if (field.fieldNumber !== 1) continue;
    requireLengthDelimited(field, "CRX3 declared id");
    if (declaredIdBytes) throw structuralFailure("CRX3 declared id field is duplicated.");
    declaredIdBytes = field.value;
  }
  if (!declaredIdBytes || declaredIdBytes.byteLength !== 16) {
    throw structuralFailure("CRX3 declared id must contain exactly 16 bytes.");
  }

  return {
    headerSize,
    signedHeader,
    declaredId: idFromRawBytes(declaredIdBytes),
    zipOffset,
    proofs,
  };
}

function parseProof(bytes: Uint8Array, algorithm: Crx3ProofAlgorithm): ParsedProof {
  const fields = parseProtobufFields(bytes, CRX3_VERIFIER_LIMITS.maxProofFields);
  let publicKey: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  for (const field of fields) {
    if (field.fieldNumber !== 1 && field.fieldNumber !== 2) continue;
    requireLengthDelimited(field, "CRX3 asymmetric proof");
    if (field.fieldNumber === 1) {
      if (publicKey) throw structuralFailure("CRX3 proof public key field is duplicated.");
      publicKey = field.value;
    } else {
      if (signature) throw structuralFailure("CRX3 proof signature field is duplicated.");
      signature = field.value;
    }
  }
  if (!publicKey || publicKey.byteLength === 0) {
    throw developerProofFailure("CRX3 proof public key is missing.");
  }
  if (publicKey.byteLength > CRX3_VERIFIER_LIMITS.maxSpkiBytes) {
    throw developerProofFailure("CRX3 proof public key exceeds the verification limit.");
  }
  return { algorithm, publicKey, signature };
}

function prepareVerification(
  parsed: ParsedCrx3,
  requestedId: string,
  trustRoot: Crx3PublisherTrustRoot,
): VerificationContext {
  if (parsed.proofs.length === 0) {
    throw developerProofFailure("CRX3 developer proof is missing.");
  }
  const signedPrefix = signaturePrefix(parsed.signedHeader.byteLength);
  const seenPublicKeys = new Set<string>();
  const proofs: PreparedProof[] = [];

  for (const proof of parsed.proofs) {
    const spkiSha256 = sha256Hex(proof.publicKey);
    const derivedId = idFromSha256Hex(spkiSha256);
    const isDeveloperCandidate = derivedId === parsed.declaredId;
    const isPublisherCandidate = spkiSha256 === trustRoot.spkiSha256;
    const keyIdentity = Buffer.from(proof.publicKey).toString("base64");
    if (seenPublicKeys.has(keyIdentity)) {
      throw structuralFailure("CRX3 repeats the same proof public key.");
    }
    seenPublicKeys.add(keyIdentity);
    if (!proof.signature || proof.signature.byteLength === 0) {
      throw proofFailureForCandidate(isPublisherCandidate, "CRX3 proof signature is missing.");
    }
    if (proof.signature.byteLength > CRX3_VERIFIER_LIMITS.maxSignatureBytes) {
      throw proofFailureForCandidate(
        isPublisherCandidate,
        "CRX3 proof signature exceeds the verification limit.",
      );
    }

    let keyObject: KeyObject;
    try {
      keyObject = createPublicKey({
        key: Buffer.from(proof.publicKey),
        format: "der",
        type: "spki",
      });
      const canonicalSpki = keyObject.export({ format: "der", type: "spki" });
      if (!Buffer.isBuffer(canonicalSpki) || !canonicalSpki.equals(bufferView(proof.publicKey))) {
        throw new Error("Non-canonical SPKI");
      }
      assertProofKeyAlgorithm(keyObject, proof.algorithm);
    } catch {
      throw proofFailureForCandidate(isPublisherCandidate, "CRX3 proof public key is invalid.");
    }

    const verifier = createVerify("sha256");
    verifier.update(signedPrefix);
    verifier.update(parsed.signedHeader);
    proofs.push({
      ...proof,
      signature: proof.signature,
      keyObject,
      verifier,
      spkiSha256,
      derivedId,
      isDeveloperCandidate,
      isPublisherCandidate,
    });
  }

  const developerProofs = proofs.filter((proof) => proof.isDeveloperCandidate);
  if (developerProofs.length !== 1) {
    throw developerProofFailure("CRX3 does not contain one unambiguous developer proof.");
  }
  const developerProof = developerProofs[0]!;
  if (developerProof.derivedId !== requestedId) {
    throw new Crx3VerificationError(
      "CRX_ID_MISMATCH",
      "CRX3 developer identity does not match the requested extension id.",
    );
  }
  const publisherProofs = proofs.filter((proof) => proof.isPublisherCandidate);
  if (publisherProofs.length !== 1) {
    throw publisherProofFailure("CRX3 Web Store publisher proof is missing or ambiguous.");
  }

  return {
    parsed,
    requestedId,
    trustRoot,
    proofs,
    developerProof,
    publisherProof: publisherProofs[0]!,
  };
}

function updateProofs(proofs: readonly PreparedProof[], bytes: Uint8Array): void {
  for (const proof of proofs) proof.verifier.update(bytes);
}

function finishVerification(
  context: VerificationContext,
  zipSize: number,
  crxSize: number,
  crxSha256: string,
): Crx3VerificationFacts {
  const invalidProofs: PreparedProof[] = [];
  for (const proof of context.proofs) {
    let verified = false;
    try {
      verified = proof.verifier.verify(proof.keyObject, proof.signature);
    } catch {
      verified = false;
    }
    if (!verified) invalidProofs.push(proof);
  }
  if (invalidProofs.length > 0) {
    if (invalidProofs.some((proof) => !proof.isPublisherCandidate)) {
      throw developerProofFailure("CRX3 developer proof does not verify over the exact package payload.");
    }
    if (invalidProofs.some((proof) => proof.isPublisherCandidate)) {
      throw publisherProofFailure("CRX3 publisher proof does not verify over the exact package payload.");
    }
    throw developerProofFailure("CRX3 contains an invalid asymmetric proof.");
  }

  const developerProof = context.developerProof;
  const publisherProof = context.publisherProof;
  const rsaCount = context.proofs.filter((proof) => proof.algorithm === "rsa-sha256").length;
  const ecdsaCount = context.proofs.length - rsaCount;
  const proofAlgorithms = Object.freeze([
    ...(rsaCount > 0 ? ["rsa-sha256" as const] : []),
    ...(ecdsaCount > 0 ? ["ecdsa-sha256" as const] : []),
  ]);

  return Object.freeze({
    format: "crx3",
    crxVersion: 3,
    requestedId: context.requestedId,
    declaredId: context.parsed.declaredId,
    developerDerivedId: developerProof.derivedId,
    developerSpkiBase64: Buffer.from(developerProof.publicKey).toString("base64"),
    developerSpkiSha256: developerProof.spkiSha256,
    developerProofAlgorithm: developerProof.algorithm,
    publisherSpkiSha256: publisherProof.spkiSha256,
    publisherProofAlgorithm: publisherProof.algorithm,
    publisherTrustRootId: context.trustRoot.id,
    publisherTrustRootVersion: context.trustRoot.version,
    headerSize: context.parsed.headerSize,
    signedHeaderSize: context.parsed.signedHeader.byteLength,
    zipOffset: context.parsed.zipOffset,
    zipSize,
    crxSize,
    crxSha256,
    proofAlgorithms,
    proofCounts: Object.freeze({
      rsa: rsaCount,
      ecdsa: ecdsaCount,
      total: context.proofs.length,
    }),
  });
}

function parseProtobufFields(bytes: Uint8Array, maxFields: number): ProtobufField[] {
  const fields: ProtobufField[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (fields.length >= maxFields) throw structuralFailure("CRX3 protobuf contains too many fields.");
    const tag = readCanonicalVarint(bytes, offset);
    offset = tag.nextOffset;
    if (tag.value === 0n || tag.value > BigInt((MAX_PROTOBUF_FIELD_NUMBER * 8) + 5)) {
      throw structuralFailure("CRX3 protobuf field tag is invalid.");
    }
    const wireType = Number(tag.value % 8n);
    const fieldNumber = Number(tag.value / 8n);
    if (fieldNumber < 1 || fieldNumber > MAX_PROTOBUF_FIELD_NUMBER) {
      throw structuralFailure("CRX3 protobuf field number is invalid.");
    }

    let value: Uint8Array | undefined;
    switch (wireType) {
      case 0: {
        const skipped = readCanonicalVarint(bytes, offset);
        offset = skipped.nextOffset;
        break;
      }
      case 1:
        offset = checkedAdvance(offset, 8, bytes.byteLength);
        break;
      case 2: {
        const encodedLength = readCanonicalVarint(bytes, offset);
        offset = encodedLength.nextOffset;
        if (encodedLength.value > BigInt(bytes.byteLength)) {
          throw structuralFailure("CRX3 protobuf field length is invalid.");
        }
        const length = Number(encodedLength.value);
        const end = checkedAdvance(offset, length, bytes.byteLength);
        value = bytes.subarray(offset, end);
        offset = end;
        break;
      }
      case 5:
        offset = checkedAdvance(offset, 4, bytes.byteLength);
        break;
      default:
        throw structuralFailure("CRX3 protobuf uses an unsupported wire type.");
    }
    fields.push({ fieldNumber, wireType, value });
  }
  return fields;
}

function readCanonicalVarint(
  bytes: Uint8Array,
  offset: number,
): { readonly value: bigint; readonly nextOffset: number } {
  const start = offset;
  let value = 0n;
  for (let index = 0; index < 10; index += 1) {
    if (offset >= bytes.byteLength) throw structuralFailure("CRX3 protobuf varint is truncated.");
    const octet = bytes[offset]!;
    offset += 1;
    if (index === 9 && octet > 1) throw structuralFailure("CRX3 protobuf varint overflows uint64.");
    value |= BigInt(octet & 0x7f) << BigInt(index * 7);
    if ((octet & 0x80) === 0) {
      if (offset - start > 1 && (octet & 0x7f) === 0) {
        throw structuralFailure("CRX3 protobuf varint is not canonically encoded.");
      }
      return { value, nextOffset: offset };
    }
  }
  throw structuralFailure("CRX3 protobuf varint is too long.");
}

function checkedAdvance(offset: number, length: number, limit: number): number {
  const end = offset + length;
  if (!Number.isSafeInteger(end) || end > limit) {
    throw structuralFailure("CRX3 protobuf field is truncated.");
  }
  return end;
}

function requireLengthDelimited(field: ProtobufField, label: string): void {
  if (field.wireType !== 2 || !field.value) {
    throw structuralFailure(`${label} has an invalid protobuf wire type.`);
  }
}

function rejectArchiveTokensInHeader(header: Uint8Array): void {
  const headerBuffer = bufferView(header);
  if (FORBIDDEN_HEADER_TOKENS.some((token) => headerBuffer.indexOf(token) >= 0)) {
    throw structuralFailure("CRX3 header contains an archive end marker.");
  }
}

function assertProofKeyAlgorithm(key: KeyObject, algorithm: Crx3ProofAlgorithm): void {
  if (algorithm === "rsa-sha256") {
    const modulusLength = key.asymmetricKeyDetails?.modulusLength;
    if (
      key.asymmetricKeyType !== "rsa"
      || typeof modulusLength !== "number"
      || modulusLength <= 0
      || modulusLength > CRX3_VERIFIER_LIMITS.maxRsaModulusBits
    ) {
      throw new Error("RSA proof uses an unsupported key.");
    }
    return;
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (
    key.asymmetricKeyType !== "ec"
    || (curve !== "prime256v1" && curve !== "secp256r1" && curve !== "P-256")
  ) {
    throw new Error("ECDSA proof must use NIST P-256.");
  }
}

function signaturePrefix(signedHeaderSize: number): Buffer {
  const prefix = Buffer.alloc(SIGNATURE_CONTEXT.byteLength + 4);
  SIGNATURE_CONTEXT.copy(prefix);
  prefix.writeUInt32LE(signedHeaderSize, SIGNATURE_CONTEXT.byteLength);
  return prefix;
}

function idFromRawBytes(bytes: Uint8Array): string {
  let id = "";
  for (const octet of bytes) {
    id += String.fromCharCode(0x61 + (octet >> 4), 0x61 + (octet & 0x0f));
  }
  return id;
}

function idFromSha256Hex(hash: string): string {
  return hash.slice(0, 32).replace(/[0-9a-f]/g, (digit) => (
    String.fromCharCode(0x61 + Number.parseInt(digit, 16))
  ));
}

function assertRequestedId(requestedId: string): void {
  if (typeof requestedId !== "string" || !CANONICAL_EXTENSION_ID.test(requestedId)) {
    throw new Crx3VerificationError(
      "CRX_ID_MISMATCH",
      "Remote store verification requires a canonical requested extension id.",
    );
  }
}

function assertBoundedFileSize(size: number): void {
  if (
    !Number.isSafeInteger(size)
    || size <= CRX_PREFIX_BYTES
    || size > CRX3_VERIFIER_LIMITS.maxFileBytes
  ) {
    throw structuralFailure("CRX3 package size is outside the verification limit.");
  }
}

function readHeaderSize(prefix: Uint8Array): number {
  if (prefix.byteLength < CRX_PREFIX_BYTES) {
    throw structuralFailure("CRX3 package header is truncated.");
  }
  return bufferView(prefix).readUInt32LE(8);
}

async function readExact(
  handle: Awaited<ReturnType<typeof fs.open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const output = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(output, offset, length - offset, position + offset);
    if (bytesRead <= 0) throw structuralFailure("CRX3 package is truncated.");
    offset += bytesRead;
  }
  return output;
}

function bufferView(bytes: Uint8Array): Buffer {
  if (!(bytes instanceof Uint8Array)) throw structuralFailure("CRX3 package bytes are invalid.");
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function structuralFailure(message: string): Crx3VerificationError {
  return new Crx3VerificationError("STORE_CRX3_REQUIRED", message);
}

function developerProofFailure(message: string): Crx3VerificationError {
  return new Crx3VerificationError("CRX_DEVELOPER_PROOF_INVALID", message);
}

function publisherProofFailure(message: string): Crx3VerificationError {
  return new Crx3VerificationError("CWS_PUBLISHER_PROOF_REQUIRED", message);
}

function proofFailureForCandidate(isPublisher: boolean, message: string): Crx3VerificationError {
  return isPublisher ? publisherProofFailure(message) : developerProofFailure(message);
}

function normalizeVerifierFailure(error: unknown): Crx3VerificationError {
  if (error instanceof Crx3VerificationError) return error;
  return structuralFailure("CRX3 package could not be read or verified.");
}
