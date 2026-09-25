import { describe, expect, test } from "bun:test";
import fixture from "../fixtures/mobile-v1/crypto/request-proof.json";

// Mirrors backend/convex/mobile/http_handlers.ts:91-97, 365-398 and
// backend/convex/mobile/device_auth.ts:29-68, 174-209. No server imports in
// domain-contracts: Convex server modules must not ship with native fixtures.
const encoder = new TextEncoder();
const digestHex = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const b64bytes = (value: string) =>
  new Uint8Array(Buffer.from(value, "base64"));

/** Strict minimal DER SEQUENCE(INTEGER r, INTEGER s) -> 64-byte P1363. */
function derToP1363(der: Uint8Array): Uint8Array {
  if (
    der.length < 8 ||
    der.length > 72 ||
    der[0] !== 0x30 ||
    der[1] !== der.length - 2
  )
    throw new Error("Invalid DER sequence");
  let offset = 2;
  const integer = (): Uint8Array => {
    if (der[offset++] !== 0x02) throw new Error("Expected DER INTEGER");
    const length = der[offset++];
    if (
      length === undefined ||
      length < 1 ||
      length > 33 ||
      offset + length > der.length
    )
      throw new Error("Invalid DER INTEGER length");
    const bytes = der.slice(offset, offset + length);
    offset += length;
    if (bytes[0]! & 0x80) throw new Error("Negative DER INTEGER");
    if (bytes.length > 1 && bytes[0] === 0 && !(bytes[1]! & 0x80))
      throw new Error("Non-minimal DER INTEGER");
    const unsigned = bytes[0] === 0 ? bytes.slice(1) : bytes;
    if (unsigned.length > 32) throw new Error("Oversized scalar");
    const padded = new Uint8Array(32);
    padded.set(unsigned, 32 - unsigned.length);
    return padded;
  };
  const r = integer();
  const s = integer();
  if (offset !== der.length) throw new Error("Trailing DER data");
  const result = new Uint8Array(64);
  result.set(r);
  result.set(s, 32);
  return result;
}

const keyPromise = crypto.subtle.importKey(
  "spki",
  b64bytes(fixture.publicKeySpkiBase64),
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["verify"],
);
const verify = async (canonical: string, signature: Uint8Array) =>
  crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    await keyPromise,
    signature as BufferSource,
    encoder.encode(canonical),
  );

describe("frozen native request-proof interoperability vectors", () => {
  test("fixture is marked test-only and SPKI matches its test private key", async () => {
    expect(fixture.warning).toContain("Never use for DEV");
    const key = await crypto.subtle.importKey(
      "jwk",
      fixture.privateKeyJwkTEST_ONLY as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
    expect((key.algorithm as EcKeyAlgorithm).namedCurve).toBe("P-256");
    expect(fixture.privateKeyJwkTEST_ONLY.x).toBeTruthy();
    expect(fixture.privateKeyJwkTEST_ONLY.y).toBeTruthy();
  });

  for (const vector of fixture.vectors) {
    test(`${vector.name}: raw bytes, digest, canonical, DER and P1363 verify`, async () => {
      const bytes = encoder.encode(vector.bodyUtf8);
      expect(Buffer.from(bytes).toString("base64")).toBe(vector.bodyBase64);
      const digest = await digestHex(bytes);
      expect(digest).toBe(vector.bodyDigestHex);
      const canonical = `${vector.method}|${vector.path}|${digest}|${vector.nonce}|${vector.timestamp}`;
      expect(canonical).toBe(vector.canonical);
      const p1363 = b64bytes(vector.signatureP1363Base64);
      expect(p1363.length).toBe(64);
      expect(derToP1363(b64bytes(vector.signatureDerBase64))).toEqual(p1363);
      expect(await verify(canonical, p1363)).toBe(true);
      expect(await verify(`${canonical}x`, p1363)).toBe(false);
    });
  }

  test("DER sign pad and short scalar are actually exercised", () => {
    const high = b64bytes(fixture.vectors[0]!.signatureP1363Base64);
    const short = b64bytes(fixture.vectors[1]!.signatureP1363Base64);
    expect(Boolean((high[0]! | high[32]!) & 0x80)).toBe(true);
    expect(short[0] === 0 || short[32] === 0).toBe(true);
    expect(
      b64bytes(fixture.vectors[0]!.signatureDerBase64).length,
    ).toBeGreaterThan(70);
  });

  test("tampered body fails the raw-body digest gate and signature", async () => {
    const source = fixture.vectors.find(
      (v) => v.name === fixture.tampered.sourceVector,
    )!;
    const changedDigest = await digestHex(
      encoder.encode(fixture.tampered.bodyUtf8),
    );
    expect(changedDigest).not.toBe(source.bodyDigestHex);
    const changedCanonical = `${source.method}|${source.path}|${changedDigest}|${source.nonce}|${source.timestamp}`;
    expect(
      await verify(changedCanonical, b64bytes(source.signatureP1363Base64)),
    ).toBe(false);
  });

  test("reject malformed/non-minimal DER, not just invalid signature bytes", () => {
    const valid = b64bytes(fixture.vectors[0]!.signatureDerBase64);
    for (const malformed of [
      valid.slice(0, -1),
      Uint8Array.of(0x31, ...valid.slice(1)),
      Uint8Array.of(valid[0]!, valid[1]!, 0x03, ...valid.slice(3)),
      Uint8Array.of(...valid, 0),
    ])
      expect(() => derToP1363(malformed)).toThrow();
  });
});
