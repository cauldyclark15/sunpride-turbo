#!/usr/bin/env bun
/** One-shot fixture creation. TEST-ONLY key material; never enroll this key on DEV. */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const destination = fileURLToPath(
  new URL("../fixtures/mobile-v1/crypto/request-proof.json", import.meta.url),
);
const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const digest = async (bytes: Uint8Array) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
const scalar = (bytes: Uint8Array) => {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const unsigned = bytes.slice(i);
  return unsigned[0]! & 0x80 ? Uint8Array.of(0, ...unsigned) : unsigned;
};
function der(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64)
    throw new Error("Expected WebCrypto P1363 signature");
  const r = scalar(signature.slice(0, 32));
  const s = scalar(signature.slice(32));
  return Uint8Array.of(
    0x30,
    4 + r.length + s.length,
    0x02,
    r.length,
    ...r,
    0x02,
    s.length,
    ...s,
  );
}
const requests = [
  {
    name: "high-bit-DER-sign-byte",
    method: "POST",
    path: "/mobile/v1/bootstrap",
    bodyUtf8:
      '{"type":"bootstrap.request","contractVersion":1,"deviceId":"test-device","limit":100}',
    nonce: "10000000-0000-4000-8000-000000000001",
    timestamp: 1780000000000,
    condition: (s: Uint8Array) => !!((s[0]! | s[32]!) & 0x80),
  },
  {
    name: "short-scalar-DER-leading-zero",
    method: "POST",
    path: "/mobile/v1/pull",
    bodyUtf8:
      '{"type":"pull.request","contractVersion":1,"deviceId":"test-device","cursor":"test-only","limit":50}',
    nonce: "20000000-0000-4000-8000-000000000002",
    timestamp: 1780000000123,
    condition: (s: Uint8Array) => s[0] === 0 || s[32] === 0,
  },
  {
    name: "utf8-body",
    method: "POST",
    path: "/mobile/v1/push",
    bodyUtf8:
      '{"type":"push.request","contractVersion":1,"deviceId":"test-device","note":"café | 東京","operations":[]}',
    nonce: "30000000-0000-4000-8000-000000000003",
    timestamp: 1780000000456,
    condition: (_s: Uint8Array) => true,
  },
];

const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const vectors = [];
for (const { condition, ...request } of requests) {
  const bytes = encoder.encode(request.bodyUtf8);
  const bodyDigestHex = await digest(bytes);
  const canonical = `${request.method}|${request.path}|${bodyDigestHex}|${request.nonce}|${request.timestamp}`;
  let signature: Uint8Array | undefined;
  for (let attempt = 0; attempt < 10000; attempt++) {
    const candidate = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        encoder.encode(canonical),
      ),
    );
    if (condition(candidate)) {
      signature = candidate;
      break;
    }
  }
  if (!signature) throw new Error("Could not produce boundary signature");
  vectors.push({
    ...request,
    bodyBase64: base64(bytes),
    bodyDigestHex,
    canonical,
    signatureP1363Base64: base64(signature),
    signatureDerBase64: base64(der(signature)),
  });
}
const artifact = {
  warning:
    "TEST-ONLY generated key and signatures. Never use for DEV, production, or enrollment.",
  algorithm: "ECDSA P-256 / SHA-256 / IEEE P1363 raw r||s",
  publicKeySpkiBase64: base64(
    new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
  ),
  privateKeyJwkTEST_ONLY: await crypto.subtle.exportKey("jwk", pair.privateKey),
  vectors,
  tampered: {
    sourceVector: "utf8-body",
    bodyUtf8: requests[2]!.bodyUtf8.replace("café", "cafe"),
    expected:
      "reject: body digest and original signature do not match altered body",
  },
};
await mkdir(
  fileURLToPath(new URL("../fixtures/mobile-v1/crypto/", import.meta.url)),
  {
    recursive: true,
  },
);
// One-shot; never accidentally rotate the checked-in interop fixture.
await writeFile(destination, JSON.stringify(artifact, null, 2) + "\n", {
  flag: "wx",
  mode: 0o644,
});
console.log(
  "Created one-shot TEST-ONLY request-proof fixture (no key material printed).",
);
