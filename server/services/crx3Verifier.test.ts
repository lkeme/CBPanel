import assert from "node:assert/strict";
import {
  createHash,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CHROMIUM_VERSION } from "cloakbrowser";
import { ChromeWebStoreProvider } from "./extensionProviders/chromeWebStoreProvider";
import {
  CRX3_VERIFIER_LIMITS,
  Crx3VerificationError,
  createCrx3VerifierForTesting,
  verifyChromeWebStoreCrx3,
  verifyChromeWebStoreCrx3File,
  type Crx3ProofAlgorithm,
  type Crx3VerificationErrorCode,
} from "./crx3Verifier";
import { CHROMIUM_CWS_PUBLISHER_TRUST_ROOT } from "./crx3TrustRoot";

const SYNTHETIC_ZIP = Buffer.from([
  0x50, 0x4b, 0x03, 0x04,
  0x43, 0x42, 0x50, 0x61, 0x6e, 0x65, 0x6c,
]);
const TAMPERMONKEY_ID = "dhdgffkkebhmkfjojejmpbldmpobfkfo";

type SyntheticKey = {
  readonly algorithm: Crx3ProofAlgorithm;
  readonly publicKey: Buffer;
  readonly privateKey: KeyObject;
};

type FixtureProof = {
  readonly key: SyntheticKey;
  readonly fieldNumber?: 2 | 3;
  readonly message?: Buffer;
};

type SyntheticFixture = {
  readonly bytes: Buffer;
  readonly header: Buffer;
  readonly signedHeader: Buffer;
  readonly zip: Buffer;
  readonly extensionId: string;
};

const RSA_DEVELOPER = makeSyntheticKey("rsa-sha256");
const ECDSA_DEVELOPER = makeSyntheticKey("ecdsa-sha256");
const RSA_PUBLISHER = makeSyntheticKey("rsa-sha256");
const ECDSA_PUBLISHER = makeSyntheticKey("ecdsa-sha256");
const WRONG_PUBLISHER = makeSyntheticKey("ecdsa-sha256");
const OTHER_DEVELOPER = makeSyntheticKey("rsa-sha256");

test("pins Chromium's production Web Store publisher SPKI hash as versioned trust material", () => {
  assert.deepEqual(CHROMIUM_CWS_PUBLISHER_TRUST_ROOT, {
    id: "chromium-cws",
    version: 1,
    spkiSha256: "61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf",
  });
  assert.equal(Object.isFrozen(CHROMIUM_CWS_PUBLISHER_TRUST_ROOT), true);
});

test("verifies exact RSA developer and ECDSA publisher proofs and returns bounded package facts", () => {
  const fixture = makeFixture({
    developer: RSA_DEVELOPER,
    publisher: ECDSA_PUBLISHER,
  });
  const before = Buffer.from(fixture.bytes);
  const verifier = verifierForPublisher(ECDSA_PUBLISHER);
  const facts = verifier.verifyBytes(fixture.bytes, fixture.extensionId);

  assert.equal(fixture.bytes.equals(before), true);
  assert.equal(facts.format, "crx3");
  assert.equal(facts.crxVersion, 3);
  assert.equal(facts.requestedId, fixture.extensionId);
  assert.equal(facts.declaredId, fixture.extensionId);
  assert.equal(facts.developerDerivedId, fixture.extensionId);
  assert.equal(facts.developerSpkiBase64, RSA_DEVELOPER.publicKey.toString("base64"));
  assert.equal(facts.developerSpkiSha256, sha256Hex(RSA_DEVELOPER.publicKey));
  assert.equal(facts.developerProofAlgorithm, "rsa-sha256");
  assert.equal(facts.publisherSpkiSha256, sha256Hex(ECDSA_PUBLISHER.publicKey));
  assert.equal(facts.publisherProofAlgorithm, "ecdsa-sha256");
  assert.equal(facts.publisherTrustRootId, "cbpanel-test-only-cws");
  assert.equal(facts.publisherTrustRootVersion, 0);
  assert.equal(facts.headerSize, fixture.header.byteLength);
  assert.equal(facts.signedHeaderSize, fixture.signedHeader.byteLength);
  assert.equal(facts.zipOffset, 12 + fixture.header.byteLength);
  assert.equal(facts.zipSize, fixture.zip.byteLength);
  assert.equal(facts.crxSize, fixture.bytes.byteLength);
  assert.equal(facts.crxSha256, sha256Hex(fixture.bytes));
  assert.deepEqual(facts.proofAlgorithms, ["rsa-sha256", "ecdsa-sha256"]);
  assert.deepEqual(facts.proofCounts, { rsa: 1, ecdsa: 1, total: 2 });
  assert.equal(Object.isFrozen(facts), true);
  assert.equal(Object.isFrozen(facts.proofCounts), true);
});

test("supports ECDSA developer and RSA publisher proof fields", () => {
  const fixture = makeFixture({
    developer: ECDSA_DEVELOPER,
    publisher: RSA_PUBLISHER,
  });
  const facts = verifierForPublisher(RSA_PUBLISHER).verifyBytes(
    fixture.bytes,
    fixture.extensionId,
  );

  assert.equal(facts.developerProofAlgorithm, "ecdsa-sha256");
  assert.equal(facts.publisherProofAlgorithm, "rsa-sha256");
  assert.deepEqual(facts.proofCounts, { rsa: 1, ecdsa: 1, total: 2 });
});

test("the production entry point never accepts a synthetic injected publisher root", () => {
  const fixture = makeFixture({
    developer: RSA_DEVELOPER,
    publisher: ECDSA_PUBLISHER,
  });

  assert.throws(
    () => verifyChromeWebStoreCrx3(fixture.bytes, fixture.extensionId),
    hasVerificationCode("CWS_PUBLISHER_PROOF_REQUIRED"),
  );
  assert.doesNotThrow(() => (
    verifierForPublisher(ECDSA_PUBLISHER).verifyBytes(fixture.bytes, fixture.extensionId)
  ));
});

test("rejects missing and wrong publisher proofs separately from developer identity", () => {
  const missing = makeFixture({ developer: RSA_DEVELOPER });
  const wrong = makeFixture({
    developer: RSA_DEVELOPER,
    publisher: WRONG_PUBLISHER,
  });
  const verifier = verifierForPublisher(ECDSA_PUBLISHER);

  assert.throws(
    () => verifier.verifyBytes(missing.bytes, missing.extensionId),
    hasVerificationCode("CWS_PUBLISHER_PROOF_REQUIRED"),
  );
  assert.throws(
    () => verifier.verifyBytes(wrong.bytes, wrong.extensionId),
    hasVerificationCode("CWS_PUBLISHER_PROOF_REQUIRED"),
  );
});

test("rejects a missing developer proof even when the publisher proof is valid", () => {
  const signedHeader = encodeProtobufBytes(1, extensionIdBytes(RSA_DEVELOPER.publicKey));
  const fixture = makeFixture({
    developer: RSA_DEVELOPER,
    publisher: ECDSA_PUBLISHER,
    signedHeader,
    proofs: [{ key: ECDSA_PUBLISHER }],
  });

  assert.throws(
    () => verifierForPublisher(ECDSA_PUBLISHER).verifyBytes(fixture.bytes, fixture.extensionId),
    hasVerificationCode("CRX_DEVELOPER_PROOF_INVALID"),
  );
});

test("rejects a valid package whose proof-derived id differs from the requested id", () => {
  const fixture = makeFixture({
    developer: RSA_DEVELOPER,
    publisher: ECDSA_PUBLISHER,
  });
  const otherId = idFromPublicKey(OTHER_DEVELOPER.publicKey);

  assert.throws(
    () => verifierForPublisher(ECDSA_PUBLISHER).verifyBytes(fixture.bytes, otherId),
    hasVerificationCode("CRX_ID_MISMATCH"),
  );
  assert.throws(
    () => verifierForPublisher(ECDSA_PUBLISHER).verifyBytes(fixture.bytes, "not-an-id"),
    hasVerificationCode("CRX_ID_MISMATCH"),
  );
});

test("rejects exact archive and signed-header tampering", () => {
  const fixture = makeFixture({
    developer: RSA_DEVELOPER,
    publisher: ECDSA_PUBLISHER,
  });
  const archiveTampered = Buffer.from(fixture.bytes);
  archiveTampered[archiveTampered.byteLength - 1] ^= 0x01;
  const signedHeaderTampered = Buffer.from(fixture.bytes);
  const signedHeaderOffset = signedHeaderTampered.indexOf(fixture.signedHeader, 12);
  assert.ok(signedHeaderOffset >= 12);
  signedHeaderTampered[signedHeaderOffset + fixture.signedHeader.byteLength - 1] ^= 0x01;
  const verifier = verifierForPublisher(ECDSA_PUBLISHER);

  assert.throws(
    () => verifier.verifyBytes(archiveTampered, fixture.extensionId),
    hasVerificationCode("CRX_DEVELOPER_PROOF_INVALID"),
  );
  assert.throws(
    () => verifier.verifyBytes(signedHeaderTampered, fixture.extensionId),
    (error: unknown) => {
      assert.ok(error instanceof Crx3VerificationError);
      assert.equal(
        error.code === "CRX_DEVELOPER_PROOF_INVALID" || error.code === "CRX_ID_MISMATCH",
        true,
      );
      return true;
    },
  );
});

test("rejects a publisher-root proof whose signature is invalid", () => {
  const signedHeader = encodeProtobufBytes(1, extensionIdBytes(RSA_DEVELOPER.publicKey));
  const wrongPayloadPublisherProof = makeProofMessage(
    ECDSA_PUBLISHER,
    signedHeader,
    Buffer.from("different archive"),
  );
  const fixture = makeFixture({
    developer: RSA_DEVELOPER,
    publisher: ECDSA_PUBLISHER,
    signedHeader,
    proofs: [
      { key: RSA_DEVELOPER },
      { key: ECDSA_PUBLISHER, message: wrongPayloadPublisherProof },
    ],
  });

  assert.throws(
    () => verifierForPublisher(ECDSA_PUBLISHER).verifyBytes(fixture.bytes, fixture.extensionId),
    hasVerificationCode("CWS_PUBLISHER_PROOF_REQUIRED"),
  );
});

test("rejects a proof field whose declared algorithm conflicts with its SPKI", () => {
  const fixture = makeFixture({
    developer: RSA_DEVELOPER,
    publisher: ECDSA_PUBLISHER,
    proofs: [
      { key: RSA_DEVELOPER, fieldNumber: 3 },
      { key: ECDSA_PUBLISHER },
    ],
  });

  assert.throws(
    () => verifierForPublisher(ECDSA_PUBLISHER).verifyBytes(fixture.bytes, fixture.extensionId),
    hasVerificationCode("CRX_DEVELOPER_PROOF_INVALID"),
  );
});

test("rejects ZIP masquerade, CRX2, wrong magic/version, and truncated containers", () => {
  const zipMasquerade = Buffer.concat([Buffer.from("PK\x03\x04", "binary"), Buffer.alloc(32)]);
  const crx2 = rawPrefix(2, 4, Buffer.alloc(4));
  const wrongMagic = rawPrefix(3, 4, Buffer.alloc(4));
  wrongMagic.write("NOPE", 0, "ascii");
  const zeroHeader = rawPrefix(3, 0, Buffer.from([1]));
  const truncatedHeader = rawPrefix(3, 20, Buffer.from([1, 2, 3]));
  const emptyArchiveHeader = encodeProtobufBytes(
    10000,
    encodeProtobufBytes(1, extensionIdBytes(RSA_DEVELOPER.publicKey)),
  );
  const emptyArchive = makeRawCrx3(emptyArchiveHeader, Buffer.alloc(0));

  for (const candidate of [
    Buffer.alloc(0),
    Buffer.alloc(11),
    zipMasquerade,
    crx2,
    wrongMagic,
    zeroHeader,
    truncatedHeader,
    emptyArchive,
  ]) {
    assert.throws(
      () => verifierForPublisher(ECDSA_PUBLISHER).verifyBytes(candidate, idFromPublicKey(RSA_DEVELOPER.publicKey)),
      hasVerificationCode("STORE_CRX3_REQUIRED"),
    );
  }
});

test("rejects malformed, truncated, overlong, and unsupported protobuf encodings", () => {
  const truncatedVarint = makeRawCrx3(Buffer.from([0x80]), SYNTHETIC_ZIP);
  const truncatedValue = makeRawCrx3(
    Buffer.concat([encodeVarint((10000 * 8) + 2), encodeVarint(8), Buffer.from([1])]),
    SYNTHETIC_ZIP,
  );
  const overlongTag = makeRawCrx3(Buffer.from([0x92, 0x00]), SYNTHETIC_ZIP);
  const groupWireType = makeRawCrx3(encodeVarint((9 * 8) + 3), SYNTHETIC_ZIP);
  const zeroTag = makeRawCrx3(Buffer.from([0]), SYNTHETIC_ZIP);

  for (const candidate of [truncatedVarint, truncatedValue, overlongTag, groupWireType, zeroTag]) {
    assert.throws(
      () => verifierForPublisher(ECDSA_PUBLISHER).verifyBytes(candidate, idFromPublicKey(RSA_DEVELOPER.publicKey)),
      hasVerificationCode("STORE_CRX3_REQUIRED"),
    );
  }
});

test("rejects duplicate or conflicting singular protobuf fields", () => {
  const valid = makeFixture({
    developer: RSA_DEVELOPER,
    publisher: ECDSA_PUBLISHER,
  });
  const proofFields = validProofFields(
    [RSA_DEVELOPER, ECDSA_PUBLISHER],
    valid.signedHeader,
    valid.zip,
  );
  const duplicateSignedHeader = makeRawCrx3(
    Buffer.concat([
      ...proofFields,
      encodeProtobufBytes(10000, valid.signedHeader),
      encodeProtobufBytes(10000, valid.signedHeader),
    ]),
    valid.zip,
  );
  const conflictingSignedId = Buffer.concat([
    encodeProtobufBytes(1, extensionIdBytes(RSA_DEVELOPER.publicKey)),
    encodeProtobufBytes(1, extensionIdBytes(OTHER_DEVELOPER.publicKey)),
  ]);
  const conflictingIdFixture = makeFixture({
    developer: RSA_DEVELOPER,
    publisher: ECDSA_PUBLISHER,
    signedHeader: conflictingSignedId,
  });
  const validDeveloperProof = makeProofMessage(RSA_DEVELOPER, valid.signedHeader, valid.zip);
  const duplicateProofKey = Buffer.concat([
    encodeProtobufBytes(1, RSA_DEVELOPER.publicKey),
    encodeProtobufBytes(1, RSA_DEVELOPER.publicKey),
    encodeProtobufBytes(2, signatureFor(RSA_DEVELOPER, valid.signedHeader, valid.zip)),
  ]);
  const duplicateProofKeyFixture = makeRawCrx3(
    Buffer.concat([
      encodeProtobufBytes(2, duplicateProofKey),
      encodeProtobufBytes(3, makeProofMessage(ECDSA_PUBLISHER, valid.signedHeader, valid.zip)),
      encodeProtobufBytes(10000, valid.signedHeader),
    ]),
    valid.zip,
  );
  const validDeveloperSignature = signatureFor(RSA_DEVELOPER, valid.signedHeader, valid.zip);
  const duplicateProofSignature = Buffer.concat([
    encodeProtobufBytes(1, RSA_DEVELOPER.publicKey),
    encodeProtobufBytes(2, validDeveloperSignature),
    encodeProtobufBytes(2, validDeveloperSignature),
  ]);
  const duplicateProofSignatureFixture = makeRawCrx3(
    Buffer.concat([
      encodeProtobufBytes(2, duplicateProofSignature),
      encodeProtobufBytes(3, makeProofMessage(ECDSA_PUBLISHER, valid.signedHeader, valid.zip)),
      encodeProtobufBytes(10000, valid.signedHeader),
    ]),
    valid.zip,
  );
  const duplicateRepeatedProof = makeRawCrx3(
    Buffer.concat([
      encodeProtobufBytes(2, validDeveloperProof),
      encodeProtobufBytes(2, validDeveloperProof),
      encodeProtobufBytes(3, makeProofMessage(ECDSA_PUBLISHER, valid.signedHeader, valid.zip)),
      encodeProtobufBytes(10000, valid.signedHeader),
    ]),
    valid.zip,
  );

  for (const candidate of [
    duplicateSignedHeader,
    conflictingIdFixture.bytes,
    duplicateProofKeyFixture,
    duplicateProofSignatureFixture,
    duplicateRepeatedProof,
  ]) {
    assert.throws(
      () => verifierForPublisher(ECDSA_PUBLISHER).verifyBytes(candidate, valid.extensionId),
      hasVerificationCode("STORE_CRX3_REQUIRED"),
    );
  }
});

test("enforces finite header, proof, and protobuf-field limits before crypto verification", () => {
  const oversizedHeaderPrefix = rawPrefix(
    3,
    CRX3_VERIFIER_LIMITS.maxHeaderBytes + 1,
    Buffer.from([1]),
  );
  const signedHeader = encodeProtobufBytes(1, extensionIdBytes(RSA_DEVELOPER.publicKey));
  const proof = encodeProtobufBytes(
    2,
    makeProofMessage(RSA_DEVELOPER, signedHeader, SYNTHETIC_ZIP),
  );
  const tooManyProofs = makeRawCrx3(
    Buffer.concat([
      ...Array.from({ length: CRX3_VERIFIER_LIMITS.maxProofs + 1 }, () => proof),
      encodeProtobufBytes(10000, signedHeader),
    ]),
    SYNTHETIC_ZIP,
  );
  const unknownField = Buffer.concat([encodeVarint(8), Buffer.from([0])]);
  const tooManyFields = makeRawCrx3(
    Buffer.concat(Array.from(
      { length: CRX3_VERIFIER_LIMITS.maxHeaderFields + 1 },
      () => unknownField,
    )),
    SYNTHETIC_ZIP,
  );
  const archiveTokenHeader = makeRawCrx3(
    encodeProtobufBytes(77, Buffer.from([0x50, 0x4b, 0x05, 0x06])),
    SYNTHETIC_ZIP,
  );

  for (const candidate of [oversizedHeaderPrefix, tooManyProofs, tooManyFields, archiveTokenHeader]) {
    assert.throws(
      () => verifierForPublisher(ECDSA_PUBLISHER).verifyBytes(candidate, idFromPublicKey(RSA_DEVELOPER.publicKey)),
      hasVerificationCode("STORE_CRX3_REQUIRED"),
    );
  }
});

test("streams a CRX file without changing its exact ZIP offset, size, or fingerprint", async () => {
  const fixture = makeFixture({
    developer: RSA_DEVELOPER,
    publisher: ECDSA_PUBLISHER,
    zip: Buffer.concat([SYNTHETIC_ZIP, Buffer.alloc(256 * 1024, 0xa5)]),
  });
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-crx3-verifier-"));
  const crxPath = path.join(tempDirectory, "fixture.crx");
  try {
    await fs.writeFile(crxPath, fixture.bytes);
    const verifier = verifierForPublisher(ECDSA_PUBLISHER);
    const memoryFacts = verifier.verifyBytes(fixture.bytes, fixture.extensionId);
    const fileFacts = await verifier.verifyFile(crxPath, fixture.extensionId);
    assert.deepEqual(fileFacts, memoryFacts);
    const stored = await fs.readFile(crxPath);
    assert.equal(stored.equals(fixture.bytes), true);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("the production file entry point also keeps synthetic trust roots unreachable", async () => {
  const fixture = makeFixture({
    developer: RSA_DEVELOPER,
    publisher: ECDSA_PUBLISHER,
  });
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-crx3-production-root-"));
  const crxPath = path.join(tempDirectory, "fixture.crx");
  try {
    await fs.writeFile(crxPath, fixture.bytes);
    await assert.rejects(
      verifyChromeWebStoreCrx3File(crxPath, fixture.extensionId),
      hasVerificationCode("CWS_PUBLISHER_PROOF_REQUIRED"),
    );
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

const OPT_IN_CWS_PATH = process.env.CBPANEL_GENUINE_CWS_CRX_PATH?.trim();
const OPT_IN_LIVE_PROVIDER = process.env.CBPANEL_LIVE_EXTENSION_PROVIDERS === "1";

test("opt-in genuine Google CRX satisfies the pinned production publisher proof", {
  skip: !OPT_IN_CWS_PATH && !OPT_IN_LIVE_PROVIDER,
}, async (t) => {
  const requestedId = process.env.CBPANEL_GENUINE_CWS_ID?.trim() || TAMPERMONKEY_ID;
  const acquired = await acquireOptInGoogleCrx(OPT_IN_CWS_PATH, requestedId);
  try {
    const facts = await verifyChromeWebStoreCrx3File(acquired.path, requestedId);
    assert.equal(facts.developerDerivedId, requestedId);
    assert.equal(facts.publisherSpkiSha256, CHROMIUM_CWS_PUBLISHER_TRUST_ROOT.spkiSha256);
    assert.equal(facts.publisherTrustRootId, CHROMIUM_CWS_PUBLISHER_TRUST_ROOT.id);
    assert.equal(facts.publisherTrustRootVersion, CHROMIUM_CWS_PUBLISHER_TRUST_ROOT.version);
    assert.ok(facts.zipSize > 0);
    t.diagnostic(JSON.stringify({
      verifiedAt: new Date().toISOString(),
      evidenceSource: OPT_IN_CWS_PATH ? "configured-local-path" : "chrome-web-store-provider",
      requestedId: facts.requestedId,
      crxSize: facts.crxSize,
      crxSha256: facts.crxSha256,
      developerProofAlgorithm: facts.developerProofAlgorithm,
      developerSpkiSha256: facts.developerSpkiSha256,
      publisherProofAlgorithm: facts.publisherProofAlgorithm,
      publisherSpkiSha256: facts.publisherSpkiSha256,
      publisherTrustRootId: facts.publisherTrustRootId,
      publisherTrustRootVersion: facts.publisherTrustRootVersion,
      proofAlgorithms: facts.proofAlgorithms,
      proofCounts: facts.proofCounts,
      zipOffset: facts.zipOffset,
      zipSize: facts.zipSize,
    }));
  } finally {
    await acquired.cleanup();
  }
});

function makeSyntheticKey(algorithm: Crx3ProofAlgorithm): SyntheticKey {
  const pair = algorithm === "rsa-sha256"
    ? generateKeyPairSync("rsa", { modulusLength: 2048 })
    : generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    algorithm,
    publicKey: Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })),
    privateKey: pair.privateKey,
  };
}

function verifierForPublisher(key: SyntheticKey) {
  return createCrx3VerifierForTesting(sha256Hex(key.publicKey));
}

function makeFixture(options: {
  readonly developer: SyntheticKey;
  readonly publisher?: SyntheticKey;
  readonly proofs?: readonly FixtureProof[];
  readonly signedHeader?: Buffer;
  readonly zip?: Buffer;
}): SyntheticFixture {
  const zip = options.zip ?? SYNTHETIC_ZIP;
  const signedHeader = options.signedHeader
    ?? encodeProtobufBytes(1, extensionIdBytes(options.developer.publicKey));
  const proofInputs = options.proofs ?? [
    { key: options.developer },
    ...(options.publisher ? [{ key: options.publisher }] : []),
  ];
  const proofFields = proofInputs.map((proof) => encodeProtobufBytes(
    proof.fieldNumber ?? proofFieldNumber(proof.key.algorithm),
    proof.message ?? makeProofMessage(proof.key, signedHeader, zip),
  ));
  const header = Buffer.concat([
    ...proofFields,
    encodeProtobufBytes(10000, signedHeader),
  ]);
  return {
    bytes: makeRawCrx3(header, zip),
    header,
    signedHeader,
    zip,
    extensionId: idFromPublicKey(options.developer.publicKey),
  };
}

function validProofFields(
  keys: readonly SyntheticKey[],
  signedHeader: Buffer,
  zip: Buffer,
): Buffer[] {
  return keys.map((key) => encodeProtobufBytes(
    proofFieldNumber(key.algorithm),
    makeProofMessage(key, signedHeader, zip),
  ));
}

function makeProofMessage(key: SyntheticKey, signedHeader: Buffer, zip: Buffer): Buffer {
  return Buffer.concat([
    encodeProtobufBytes(1, key.publicKey),
    encodeProtobufBytes(2, signatureFor(key, signedHeader, zip)),
  ]);
}

function signatureFor(key: SyntheticKey, signedHeader: Buffer, zip: Buffer): Buffer {
  const context = Buffer.from("CRX3 SignedData\0", "ascii");
  const signedHeaderSize = Buffer.alloc(4);
  signedHeaderSize.writeUInt32LE(signedHeader.byteLength);
  return createSign("sha256")
    .update(context)
    .update(signedHeaderSize)
    .update(signedHeader)
    .update(zip)
    .sign(key.privateKey);
}

function proofFieldNumber(algorithm: Crx3ProofAlgorithm): 2 | 3 {
  return algorithm === "rsa-sha256" ? 2 : 3;
}

function makeRawCrx3(header: Uint8Array, zip: Uint8Array): Buffer {
  return rawPrefix(3, header.byteLength, Buffer.concat([Buffer.from(header), Buffer.from(zip)]));
}

function rawPrefix(version: number, headerSize: number, remainder: Buffer): Buffer {
  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "ascii");
  prefix.writeUInt32LE(version, 4);
  prefix.writeUInt32LE(headerSize, 8);
  return Buffer.concat([prefix, remainder]);
}

function encodeProtobufBytes(fieldNumber: number, value: Uint8Array): Buffer {
  return Buffer.concat([
    encodeVarint((fieldNumber * 8) + 2),
    encodeVarint(value.byteLength),
    Buffer.from(value),
  ]);
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining % 128) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function extensionIdBytes(publicKey: Uint8Array): Buffer {
  return createHash("sha256").update(publicKey).digest().subarray(0, 16);
}

function idFromPublicKey(publicKey: Uint8Array): string {
  let id = "";
  for (const octet of extensionIdBytes(publicKey)) {
    id += String.fromCharCode(0x61 + (octet >> 4), 0x61 + (octet & 0x0f));
  }
  return id;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasVerificationCode(code: Crx3VerificationErrorCode): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof Crx3VerificationError);
    assert.equal(error.code, code);
    assert.equal(error.status, 422);
    return true;
  };
}

async function acquireOptInGoogleCrx(
  configuredPath: string | undefined,
  requestedId: string,
): Promise<{ readonly path: string; readonly cleanup: () => Promise<void> }> {
  if (configuredPath) {
    return {
      path: path.resolve(configuredPath),
      cleanup: async () => undefined,
    };
  }
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-genuine-cws-crx-"));
  const destinationPath = path.join(tempDirectory, "current.crx");
  try {
    await new ChromeWebStoreProvider({
      readBrowserCoreVersion: () => CHROMIUM_VERSION,
    }).resolveCurrent(
      { storeId: requestedId, destinationPath },
      AbortSignal.timeout(5 * 60_000),
    );
  } catch (error) {
    await fs.rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    path: destinationPath,
    cleanup: () => fs.rm(tempDirectory, { recursive: true, force: true }),
  };
}
