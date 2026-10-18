import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  boundDevice,
  profileStore,
  signedPost,
  startHarness,
} from "./harness.js";

/** @type {import('./harness.js').Harness} */
let h;
/** @type {ReturnType<typeof profileStore>} */
let profiles;

beforeAll(async () => {
  h = await startHarness();
  profiles = profileStore(h);
});
afterAll(async () => {
  await h?.close();
});

/** @param {Uint8Array} bytes */
const sha = (bytes) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** @param {string} url @param {string} token @param {Uint8Array} bytes @param {string} [mime] */
const put = (url, token, bytes, mime = "image/jpeg") =>
  fetch(url, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": mime },
    body: /** @type {any} */ (bytes),
  });

describe("media claims and uploads", () => {
  test("wrong sha refused, upload stored, identical retry idempotent, reissued claim keeps blob id", async () => {
    const d = await boundDevice(h, profiles);
    const who = { access: d.access, deviceId: d.deviceId, key: d.key };
    const bytes = crypto.getRandomValues(new Uint8Array(4096));
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
    const digest = sha(bytes);
    const visitId = crypto.randomUUID();
    const claimBody = {
      version: 2,
      deviceId: d.deviceId,
      purpose: "visit-photo",
      ownerId: visitId,
      mime: "image/jpeg",
      size: bytes.length,
      sha256: digest,
    };
    const c = await signedPost(h, who, "/api/media/claims", claimBody);
    expect(c.res.status).toBe(200);
    expect(Object.keys(c.body).sort()).toEqual([
      "expiresAt",
      "uploadId",
      "uploadToken",
      "uploadUrl",
      "version",
    ]);
    expect(c.body.uploadUrl).toBe(
      `${h.origin}/api/media/uploads/${c.body.uploadId}`,
    );

    // Unsigned claim is refused.
    const unsigned = await h.fetch("/api/media/claims", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${d.access}`,
      },
      body: JSON.stringify(claimBody),
    });
    expect(unsigned.status).toBe(400);

    // Same size, different bytes → checksum mismatch, nothing stored.
    const wrong = new Uint8Array(bytes);
    wrong[100] = /** @type {number} */ (wrong[100] + 1) % 256;
    const bad = await put(c.body.uploadUrl, c.body.uploadToken, wrong);
    expect(bad.status).toBe(400);
    expect(/** @type {any} */ (await bad.json()).error.code).toBe(
      "checksum_mismatch",
    );
    let [row] =
      await h.db`select status, path from files where id = ${c.body.uploadId}`;
    expect(row.status).toBe("pending");

    const tooBig = await put(
      c.body.uploadUrl,
      c.body.uploadToken,
      new Uint8Array(bytes.length + 10),
    );
    expect([400, 413]).toContain(tooBig.status);
    const wrongType = await put(
      c.body.uploadUrl,
      c.body.uploadToken,
      bytes,
      "image/png",
    );
    expect(wrongType.status).toBe(400);
    const noToken = await fetch(c.body.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: /** @type {any} */ (bytes),
    });
    expect(noToken.status).toBe(401);
    const sessionToken = await put(c.body.uploadUrl, d.access, bytes);
    expect(sessionToken.status).toBe(401);

    const ok = await put(c.body.uploadUrl, c.body.uploadToken, bytes);
    expect(ok.status).toBe(200);
    const ob = /** @type {any} */ (await ok.json());
    expect(Object.keys(ob).sort()).toEqual([
      "blobId",
      "serverTime",
      "sha256",
      "status",
      "version",
    ]);
    expect(ob).toMatchObject({
      version: 2,
      blobId: c.body.uploadId,
      sha256: digest,
      status: "stored",
    });
    [row] =
      await h.db`select status, path from files where id = ${c.body.uploadId}`;
    expect(row.status).toBe("stored");
    const stored = join(h.filesDir, row.path);
    expect(existsSync(stored)).toBe(true);
    expect(sha(new Uint8Array(await Bun.file(stored).arrayBuffer()))).toBe(
      digest,
    );

    const retry = await put(c.body.uploadUrl, c.body.uploadToken, bytes);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      blobId: c.body.uploadId,
      sha256: digest,
      status: "stored",
    });

    const c2 = await signedPost(h, who, "/api/media/claims", claimBody);
    expect(c2.body.uploadId).toBe(c.body.uploadId);
    expect(c2.body.uploadToken).not.toBe(c.body.uploadToken);
    const stale = await put(c.body.uploadUrl, c.body.uploadToken, bytes);
    expect(stale.status).toBe(401);
    const again = await put(c2.body.uploadUrl, c2.body.uploadToken, bytes);
    expect(await again.json()).toMatchObject({
      blobId: c.body.uploadId,
      status: "stored",
    });
    const count = await h.db`select count(*)::int as n from files`;
    expect(count[0].n).toBe(1);
  });

  test("claim validation and the canClaimMedia hook", async () => {
    const d = await boundDevice(h, profiles);
    const who = { access: d.access, deviceId: d.deviceId, key: d.key };
    const base = {
      version: 2,
      deviceId: d.deviceId,
      purpose: "visit-photo",
      ownerId: crypto.randomUUID(),
      mime: "image/jpeg",
      size: 10,
      sha256: "a".repeat(64),
    };
    expect(
      (
        await signedPost(h, who, "/api/media/claims", {
          ...base,
          mime: "image/gif",
        })
      ).res.status,
    ).toBe(400);
    expect(
      (
        await signedPost(h, who, "/api/media/claims", {
          ...base,
          size: 11 * 1024 * 1024,
        })
      ).res.status,
    ).toBe(400);
    expect(
      (
        await signedPost(h, who, "/api/media/claims", {
          ...base,
          purpose: "selfie",
        })
      ).res.status,
    ).toBe(400);
    expect(
      (
        await signedPost(h, who, "/api/media/claims", {
          ...base,
          ownerId: null,
        })
      ).res.status,
    ).toBe(400);
    h.setHooks({ canClaimMedia: async () => false });
    const denied = await signedPost(h, who, "/api/media/claims", base);
    expect(denied.res.status).toBe(403);
    expect(denied.body.error.code).toBe("out_of_scope");
    h.setHooks({ canClaimMedia: async () => true });
    const damage = await signedPost(h, who, "/api/media/claims", {
      ...base,
      purpose: "truck-damage",
      ownerId: null,
    });
    expect(damage.res.status).toBe(200);
  });
});
