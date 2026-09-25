#!/usr/bin/env bun
/** DEV-only: register a phone's public key using an admin's Convex JWT. */
import { readFile } from "node:fs/promises";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const help = `DEV-only device administration (CONVEX_URL required)
Usage: bun run packages/backend/scripts/register_device.ts --admin-jwt-file PATH --profile-id ID --app IOS|ANDROID --public-key-file PATH [--tag TAG] [--model M] [--os-version V] [--app-version V]
       bun run packages/backend/scripts/register_device.ts --admin-jwt-file PATH --revoke DEVICE_ID --reason TEXT
JWTs are read from files, never command-line values. Revoke reason must be one of: lost, stolen, suspected_compromise, transfer, replacement, decommissioned, other.
`;
const valueFlags = new Set([
  "--admin-jwt-file",
  "--profile-id",
  "--app",
  "--public-key-file",
  "--tag",
  "--model",
  "--os-version",
  "--app-version",
  "--revoke",
  "--reason",
]);
const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i]!;
  if (flag === "--help" && process.argv.length === 3) {
    console.log(help);
    process.exit(0);
  }
  const value = process.argv[i + 1];
  if (
    !valueFlags.has(flag) ||
    !value ||
    value.startsWith("--") ||
    flags.has(flag)
  )
    throw new Error(`Unknown, repeated or incomplete flag: ${flag}`);
  flags.set(flag, value);
  i++;
}
function required(flag: string): string {
  const value = flags.get(flag);
  if (!value) throw new Error(`Missing ${flag}`);
  return value;
}
const url = process.env.CONVEX_URL;
if (!url || !/^https:\/\/[^/]+\.convex\.cloud$/.test(url))
  throw new Error("CONVEX_URL must be a Convex cloud HTTPS origin");
const jwt = (await readFile(required("--admin-jwt-file"), "utf8")).trim();
if (!jwt) throw new Error("Admin JWT file empty");
const admin = new ConvexHttpClient(url);
admin.setAuth(jwt);

if (flags.has("--revoke")) {
  for (const flag of flags.keys())
    if (!["--admin-jwt-file", "--revoke", "--reason"].includes(flag))
      throw new Error(`Registration flag ${flag} cannot be used with --revoke`);
  const deviceId = required("--revoke") as Id<"registeredDevices">;
  const reason = required("--reason");
  if (
    ![
      "lost",
      "stolen",
      "suspected_compromise",
      "transfer",
      "replacement",
      "decommissioned",
      "other",
    ].includes(reason)
  )
    throw new Error("Invalid revoke reason code (see --help)");
  const result = await admin.mutation(api.mobile.devices.revoke, {
    deviceId,
    reason,
  });
  console.log(JSON.stringify({ deviceId, status: result.status }));
} else {
  if (flags.has("--reason")) throw new Error("--reason requires --revoke");
  const app = required("--app");
  if (app !== "IOS" && app !== "ANDROID")
    throw new Error("--app must be IOS or ANDROID");
  const inventoryTag =
    flags.get("--tag") ??
    `DEV-${crypto.randomUUID().replaceAll("-", "").slice(0, 24).toUpperCase()}`;
  if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(inventoryTag))
    throw new Error("--tag must match ^[A-Z0-9][A-Z0-9_-]{0,39}$");
  const publicKey = (
    await readFile(required("--public-key-file"), "utf8")
  ).trim();
  if (!publicKey) throw new Error("Public key file empty");
  const result = await admin.mutation(api.mobile.devices.register, {
    profileId: required("--profile-id") as Id<"profiles">,
    allowedApp: app,
    platform: app === "IOS" ? "iOS" : "Android",
    publicKey,
    inventoryTag,
    model: flags.get("--model") ?? "DEV phone",
    osVersion: flags.get("--os-version") ?? "DEV",
    appVersion: flags.get("--app-version") ?? "DEV",
  });
  console.log(
    JSON.stringify({ deviceId: result.deviceId, status: result.status }),
  );
}
