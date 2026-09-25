#!/usr/bin/env bun
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const help = `Usage: bun run packages/backend/scripts/mobile_fake_device.ts --sales-jwt-file PATH --admin-jwt-file PATH --profile-id ID [--json-out PATH] [--check-fixture] [--service-date YYYY-MM-DD] [--allow-no-visit --outlet-id ID] [--lat NUMBER --lng NUMBER]\nRequires CONVEX_URL, CONVEX_SITE_URL and TMPDIR. JWTs must be passed by file path, never as argv values. --check-fixture performs only authenticated queries; mutation mode registers and revokes a disposable device. Service date must be Manila today for push. Coordinates are never printed.\n`;
const flags = new Map<string, string>();
const switches = new Set(["--help", "--check-fixture", "--allow-no-visit"]);
const values = new Set([
  "--sales-jwt-file",
  "--admin-jwt-file",
  "--profile-id",
  "--json-out",
  "--service-date",
  "--outlet-id",
  "--lat",
  "--lng",
]);
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]!;
  if (switches.has(arg)) flags.set(arg, "true");
  else if (
    values.has(arg) &&
    process.argv[i + 1] &&
    !process.argv[i + 1]!.startsWith("--")
  )
    flags.set(arg, process.argv[++i]!);
  else throw new Error(`Unknown or incomplete flag: ${arg}`);
}
if (flags.has("--help")) {
  console.log(help);
  process.exit(0);
}
function required(name: string): string {
  const value = flags.get(name) ?? process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
const site = required("CONVEX_SITE_URL").replace(/\/$/, "");
const url = required("CONVEX_URL");
const tmp = required("TMPDIR");
if (
  !/^https:\/\/.+\.convex\.(site|cloud)$/.test(site) ||
  !/^https:\/\/.+\.convex\.cloud$/.test(url)
)
  throw new Error("Convex URL origins required");
const salesJWT = (await readFile(required("--sales-jwt-file"), "utf8")).trim();
const adminJWT = (await readFile(required("--admin-jwt-file"), "utf8")).trim();
if (!salesJWT || !adminJWT) throw new Error("JWT file empty");
const sales = new ConvexHttpClient(url);
sales.setAuth(salesJWT);
const admin = new ConvexHttpClient(url);
admin.setAuth(adminJWT);
const profileId = required("--profile-id") as Id<"profiles">;
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const date = flags.get("--service-date") ?? today;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid service date");
const plans = await sales.query(api.coverage.plans.list, {
  assigneeProfileId: profileId,
  localMonth: date.slice(0, 7),
});
const activePlans = plans.filter((p) => p.status === "active");
const summary: Record<string, unknown> = {
  serviceDate: date,
  today,
  activePlans: activePlans.length,
  mode: flags.has("--check-fixture") ? "read_only" : "live",
  statuses: [] as string[],
};
async function output(): Promise<void> {
  const text = JSON.stringify(summary, null, 2);
  if (flags.has("--json-out"))
    await writeFile(required("--json-out"), `${text}\n`, { mode: 0o600 });
  console.log(text);
}
if (flags.has("--check-fixture")) {
  summary.planIds = activePlans.map((p) => p._id);
  summary.statuses = ["fixture_read_only"];
  await output();
  process.exit(0);
}
const lat = Number(flags.get("--lat")),
  lng = Number(flags.get("--lng"));
if (
  !Number.isFinite(lat) ||
  !Number.isFinite(lng) ||
  Math.abs(lat) > 90 ||
  Math.abs(lng) > 180
)
  throw new Error(
    "--lat and --lng required: bootstrap v1 does not expose verified outlet pins",
  );
const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const spki = new Uint8Array(
  await crypto.subtle.exportKey("spki", pair.publicKey),
);
const b64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (x) => String.fromCharCode(x)).join(""));
const keyPath = join(tmp, `mobile-ephemeral-${crypto.randomUUID()}.pkcs8`);
await mkdir(tmp, { recursive: true });
await writeFile(
  keyPath,
  new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  { mode: 0o600, flag: "wx" },
);
const sign = async (text: string): Promise<string> =>
  b64(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(text),
      ),
    ),
  );
let deviceId: Id<"registeredDevices"> | undefined;
const statuses = summary.statuses as string[];
async function post(
  route: "bootstrap" | "pull" | "push",
  data: Record<string, unknown>,
  nonceOverride?: string,
  expectedStatus = 200,
) {
  if (!deviceId) throw new Error("Device not registered");
  const body = JSON.stringify({
    type: `${route}.request`,
    contractVersion: 1,
    deviceId,
    ...data,
  });
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
  const nonce =
    nonceOverride ??
    (await sales.mutation(api.mobile.devices.challenge, { deviceId })).nonce;
  const timestamp = Date.now();
  const path = `/mobile/v1/${route}`;
  const response = await fetch(`${site}${path}`, {
    method: "POST",
    body,
    headers: {
      authorization: `Bearer ${salesJWT}`,
      "content-type": "application/json",
      "x-mobile-contract-version": "1",
      "x-mobile-device-id": deviceId,
      "x-mobile-app": "IOS",
      "x-mobile-nonce": nonce,
      "x-mobile-timestamp": String(timestamp),
      "x-mobile-body-digest": digest,
      "x-mobile-signature": await sign(
        `POST|${path}|${digest}|${nonce}|${timestamp}`,
      ),
    },
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (response.status !== expectedStatus)
    throw new Error(
      `${route} status ${response.status}; expected ${expectedStatus}; code ${String(result.code ?? "unknown")}`,
    );
  return result;
}
try {
  const registered = await admin.mutation(api.mobile.devices.register, {
    inventoryTag: `FAKE-${crypto.randomUUID()}`,
    allowedApp: "IOS",
    platform: "iOS",
    model: "DEV fake phone",
    osVersion: "test",
    appVersion: "1",
    profileId,
    publicKey: b64(spki),
  });
  deviceId = registered.deviceId;
  summary.deviceId = deviceId;
  statuses.push("registered");
  const credentialId = crypto.randomUUID();
  const challenge = await sales.mutation(api.mobile.devices.challenge, {
    deviceId,
  });
  const timestamp = Date.now();
  await sales.mutation(api.mobile.devices.bind, {
    deviceId,
    credentialId,
    attestation: { format: "dev-unverified" },
    nonce: challenge.nonce,
    timestamp,
    proof: await sign(
      `BIND|${deviceId}|${credentialId}|${challenge.nonce}|${timestamp}`,
    ),
  });
  statuses.push("bound");
  let snapshot = await post("bootstrap", { limit: 100 });
  const visits = [...(snapshot.plannedVisits as Record<string, unknown>[])];
  const outlets = [...(snapshot.outlets as Record<string, unknown>[])];
  while (snapshot.nextPageCursor) {
    snapshot = await post("bootstrap", {
      pageCursor: snapshot.nextPageCursor,
      limit: 100,
    });
    visits.push(...(snapshot.plannedVisits as Record<string, unknown>[]));
    outlets.push(...(snapshot.outlets as Record<string, unknown>[]));
  }
  summary.snapshotVisits = visits.length;
  statuses.push("bootstrapped");
  const cursor = snapshot.syncCursor;
  if (typeof cursor !== "string") throw new Error("Bootstrap did not complete");
  const pulled = await post("pull", { cursor, limit: 50 });
  summary.pullChanges = (pulled.changes as unknown[]).length;
  statuses.push("pulled");
  const planned = visits.find((v) => v.serviceDate === today);
  if (date !== today || (!planned && !flags.has("--allow-no-visit"))) {
    statuses.push(
      date !== today
        ? "push_skipped_service_date_not_today"
        : "push_skipped_no_planned_visit_today",
    );
  } else {
    const outletId = (planned?.outletId ?? flags.get("--outlet-id")) as
      Id<"outlets"> | undefined;
    if (!outletId)
      throw new Error(
        "--allow-no-visit requires --outlet-id when no visit is planned",
      );
    const clientVisitId = crypto.randomUUID();
    const checkId = crypto.randomUUID(),
      activityId = crypto.randomUUID(),
      outId = crypto.randomUUID();
    const location = {
      latitude: lat,
      longitude: lng,
      accuracyMeters: 10,
      provider: "gps",
      mockSignal: false,
      fixTime: Date.now(),
    };
    const op = {
      kind: "visit.checkIn",
      clientRequestId: checkId,
      payload: {
        clientVisitId,
        plannedVisitId: planned?.id ?? null,
        outletId,
        serviceDate: today,
        deviceTime: Date.now(),
        location,
        intents: planned?.intents ?? [],
        ...(!planned ? { unplannedReason: "DEV verification" } : {}),
      },
    };
    const first = await post("push", { operations: [op] });
    const ack = (
      first.results as { status: string; ack?: { entityId: string } }[]
    )[0];
    if (ack?.status !== "accepted" || !ack.ack)
      throw new Error(`check-in not accepted: ${ack?.status ?? "missing"}`);
    const visitId = ack.ack.entityId as Id<"visitExecutions">;
    const activity = {
      kind: "visit.activity",
      clientRequestId: activityId,
      dependsOn: [checkId],
      payload: {
        visitId,
        activity: { kind: "note", text: "DEV smoke test" },
        deviceTime: Date.now(),
      },
    };
    const checkout = {
      kind: "visit.checkOut",
      clientRequestId: outId,
      dependsOn: [activityId],
      payload: {
        visitId,
        outcome: "completed",
        reasonCode: null,
        deviceTime: Date.now(),
        location: { ...location, fixTime: Date.now() },
      },
    };
    const second = await post("push", { operations: [activity, checkout] });
    const replayFirst = await post("push", { operations: [op] });
    const replaySecond = await post("push", {
      operations: [activity, checkout],
    });
    if (
      JSON.stringify(first.results) !== JSON.stringify(replayFirst.results) ||
      JSON.stringify(second.results) !== JSON.stringify(replaySecond.results)
    )
      throw new Error("Replay ack changed");
    const conflict = await post("push", {
      operations: [{ ...op, payload: { ...op.payload, intents: ["audit"] } }],
    });
    summary.visitId = visitId;
    summary.accepted = [first, second]
      .flatMap((r) => r.results as { status: string }[])
      .filter((r) => r.status === "accepted").length;
    summary.conflict = (conflict.results as { status: string }[])[0]?.status;
    if (summary.accepted !== 3 || summary.conflict !== "conflict")
      throw new Error("Push or conflict expectation failed");
    statuses.push("pushed", "replayed", "conflict_confirmed");
  }
  const revokeNonce = (
    await sales.mutation(api.mobile.devices.challenge, { deviceId })
  ).nonce;
  await admin.mutation(api.mobile.devices.revoke, {
    deviceId,
    reason: "decommissioned",
  });
  statuses.push("revoked");
  const denied = await post("bootstrap", {}, revokeNonce, 401);
  if (denied.code !== "unauthorized")
    throw new Error("Revocation did not deny the HTTP request");
  statuses.push("revocation_denied");
} finally {
  await unlink(keyPath);
  if (deviceId && !statuses.includes("revoked")) {
    try {
      await admin.mutation(api.mobile.devices.revoke, {
        deviceId,
        reason: "decommissioned",
      });
      statuses.push("revoked_after_failure");
    } catch {
      statuses.push("revoke_failed_manual_cleanup_required");
    }
  }
  await output();
}
