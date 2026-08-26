/**
 * Chromium's production Chrome Web Store CRX3 publisher key.
 *
 * The hash is SHA-256 over the exact DER SubjectPublicKeyInfo bytes. Chromium
 * calls this key `ecdsa_2017_public` and pins the same digest in
 * components/crx_file/crx_verifier.cc. Increment the version only when this
 * reviewed production trust material changes.
 *
 * Reviewed 2026-08-27 against Chromium commit
 * 350782eec39ec6f1a2072b1cc5dcc46cbf86ff99:
 * https://chromium.googlesource.com/chromium/src/+/350782eec39ec6f1a2072b1cc5dcc46cbf86ff99/components/crx_file/crx_verifier.cc
 */
export interface Crx3PublisherTrustRoot {
  readonly id: string;
  readonly version: number;
  readonly spkiSha256: string;
}

export const CHROMIUM_CWS_PUBLISHER_TRUST_ROOT = Object.freeze({
  id: "chromium-cws",
  version: 1,
  spkiSha256: "61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf",
}) satisfies Crx3PublisherTrustRoot;
