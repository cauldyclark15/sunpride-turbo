/* Convex runtime secret is not a Turborepo build input. */
/* eslint-disable turbo/no-undeclared-env-vars */
import { afterEach, describe, expect, it, vi } from "vitest";
import { signCursor, readCursor, type Cursor } from "./cursor";
import type { AuthorizedDevice } from "./types";

process.env.MOBILE_CURSOR_SECRET =
  "test-only-mobile-cursor-secret-32-bytes-long";
const actor = {
  deviceId: "device",
  profileId: "person",
  subject: "issuer|person",
  orgUnitId: "unit",
  role: "sales",
  scopeFingerprint: "fingerprint",
} as AuthorizedDevice;
const payload = (): Cursor => ({
  kind: "pull",
  version: 1,
  device: actor.deviceId,
  person: actor.profileId,
  scope: actor.scopeFingerprint,
  watermark: 4,
  after: 4,
  tie: "change",
  expires: Date.now() + 60_000,
  day: "2026-09-26",
  manifest: "hash",
  page: 1,
});
afterEach(() => vi.useRealTimers());
describe("mobile signed cursor", () => {
  it("round-trips and binds device, person, scope and version", async () => {
    const value = payload();
    const token = await signCursor(value);
    expect(await readCursor(token, "pull", actor, Date.now())).toEqual(value);
    for (const other of [
      { ...actor, deviceId: "other" },
      { ...actor, profileId: "other" },
      { ...actor, scopeFingerprint: "other" },
    ])
      await expect(
        readCursor(token, "pull", other as AuthorizedDevice, Date.now()),
      ).rejects.toThrow("rebootstrap_required");
    await expect(
      readCursor(token, "bootstrap", actor, Date.now()),
    ).rejects.toThrow("rebootstrap_required");
    await expect(
      readCursor(
        await signCursor({ ...payload(), version: 2 as 1 }),
        "pull",
        actor,
        Date.now(),
      ),
    ).rejects.toThrow("rebootstrap_required");
  });
  it("rejects altered MAC, expiry and missing key without fallback", async () => {
    const token = await signCursor(payload());
    await expect(
      readCursor(
        token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"),
        "pull",
        actor,
        Date.now(),
      ),
    ).rejects.toThrow("rebootstrap_required");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    await expect(readCursor(token, "pull", actor, Date.now())).rejects.toThrow(
      "rebootstrap_required",
    );
    const old = process.env.MOBILE_CURSOR_SECRET;
    delete process.env.MOBILE_CURSOR_SECRET;
    try {
      await expect(signCursor(payload())).rejects.toThrow(
        "MOBILE_CURSOR_SECRET",
      );
    } finally {
      process.env.MOBILE_CURSOR_SECRET = old;
    }
  });
});
