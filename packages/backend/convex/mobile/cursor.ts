/* Convex runtime secret is not a Turborepo build input. */
/* eslint-disable turbo/no-undeclared-env-vars */
import { ConvexError, v } from "convex/values";
import { roleValidator } from "../lib/roles";

export const actorValidator = v.object({
  deviceId: v.id("registeredDevices"),
  profileId: v.id("profiles"),
  subject: v.string(),
  orgUnitId: v.id("orgUnits"),
  role: roleValidator,
  scopeFingerprint: v.string(),
});
import type { AuthorizedDevice } from "./types";

export const CURSOR_TTL_MS = 60 * 60 * 1000;
export type Cursor = {
  kind: "bootstrap" | "pull";
  version: 1;
  device: string;
  person: string;
  scope: string;
  watermark: number;
  after: number;
  tie: string;
  expires: number;
  day: string;
  manifest: string;
  page: number;
};
const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const unb64 = (text: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("encoding");
  const raw = text.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(
    atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0),
  );
};
async function key() {
  const secret = process.env.MOBILE_CURSOR_SECRET;
  if (!secret || secret.length < 32)
    throw new ConvexError(
      "MOBILE_CURSOR_SECRET must be configured (at least 32 characters)",
    );
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function signCursor(payload: Cursor): Promise<string> {
  const body = b64(enc.encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign("HMAC", await key(), enc.encode(body));
  return `${body}.${b64(new Uint8Array(mac))}`;
}
export async function readCursor(
  token: string,
  kind: Cursor["kind"],
  actor: AuthorizedDevice,
  now: number,
): Promise<Cursor> {
  // Missing configuration is an operational error, never an invalid token fallback.
  const signingKey = await key();
  try {
    if (token.length > 4096) throw new Error("length");
    const [body, mac, extra] = token.split(".");
    const macBytes = mac ? unb64(mac) : undefined;
    if (
      !body ||
      !mac ||
      extra ||
      !macBytes ||
      macBytes.length !== 32 ||
      // Reject non-canonical base64url: the unused low bits of the final
      // character must not let two spellings of one MAC both verify.
      b64(macBytes) !== mac ||
      !(await crypto.subtle.verify(
        "HMAC",
        signingKey,
        macBytes,
        enc.encode(body),
      ))
    )
      throw new Error("signature");
    const value: Cursor = JSON.parse(new TextDecoder().decode(unb64(body)));
    if (
      value.kind !== kind ||
      value.version !== 1 ||
      value.device !== actor.deviceId ||
      value.person !== actor.profileId ||
      value.scope !== actor.scopeFingerprint ||
      !Number.isSafeInteger(value.watermark) ||
      value.watermark < 0 ||
      !Number.isSafeInteger(value.after) ||
      value.after < 0 ||
      (kind === "pull" && value.after > Number.MAX_SAFE_INTEGER) ||
      typeof value.tie !== "string" ||
      typeof value.day !== "string" ||
      typeof value.manifest !== "string" ||
      !Number.isSafeInteger(value.page) ||
      value.page < 0 ||
      !Number.isSafeInteger(value.expires) ||
      value.expires <= now
    )
      throw new Error("binding");
    return value;
  } catch {
    throw new ConvexError("rebootstrap_required");
  }
}
