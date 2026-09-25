import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { AuthorizedDevice } from "./types";

const MAX_BYTES = 128 * 1024;
const kinds = new Set([
  "visit.checkIn",
  "visit.activity",
  "visit.checkOut",
  "task.complete",
  "collection.record",
]);
const businessCodes = new Set([
  "invalid_request",
  "invalid_plan",
  "conflict",
  "dependency_missing",
  "unsupported_operation",
  "out_of_scope",
  "evidence_pending_review",
]);
type Route = "bootstrap" | "pull" | "push";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: RecordValue, allowed: string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
const failure = (code: string, status: number): Response =>
  json(
    {
      type: "error.response",
      contractVersion: 1,
      serverTime: Date.now(),
      code,
      message: code,
      retryable: status >= 500,
    },
    status,
  );
function coded(error: unknown): string | null {
  // Convex wraps ConvexError messages when crossing the action/mutation boundary.
  const text = error instanceof Error ? error.message : "";
  for (const code of [
    ...businessCodes,
    "rebootstrap_required",
    "invalid_cursor",
  ]) {
    if (new RegExp(`(?:^|[:\\s])${code}(?:$|[\\s\\n])`).test(text)) return code;
  }
  return null;
}
async function rawBody(request: Request): Promise<Uint8Array | null> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
    return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
const hexDigest = async (bytes: Uint8Array): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
function validLocation(value: unknown): boolean {
  return (
    value === null ||
    (record(value) &&
      exact(value, [
        "latitude",
        "longitude",
        "accuracyMeters",
        "provider",
        "mockSignal",
        "fixTime",
      ]) &&
      finite(value.latitude) &&
      Math.abs(value.latitude) <= 90 &&
      finite(value.longitude) &&
      Math.abs(value.longitude) <= 180 &&
      finite(value.accuracyMeters) &&
      value.accuracyMeters >= 0 &&
      ["gps", "network", "fused", "unknown"].includes(String(value.provider)) &&
      (value.mockSignal === undefined ||
        typeof value.mockSignal === "boolean") &&
      Number.isSafeInteger(value.fixTime))
  );
}
function validActivity(value: unknown): boolean {
  if (!record(value)) return false;
  switch (value.kind) {
    case "note":
      return (
        exact(value, ["kind", "text"]) &&
        typeof value.text === "string" &&
        value.text.length <= 2000
      );
    case "merchandising":
      return (
        exact(value, ["kind", "displayCondition", "actionTaken"]) &&
        ["compliant", "needs_action", "not_present"].includes(
          String(value.displayCondition),
        ) &&
        (value.actionTaken === undefined ||
          (typeof value.actionTaken === "string" &&
            value.actionTaken.length <= 500))
      );
    case "inventory_check":
      return (
        exact(value, [
          "kind",
          "productId",
          "icoFinding",
          "observedQuantity",
          "uomId",
        ]) &&
        typeof value.productId === "string" &&
        ["present", "absent", "unknown"].includes(String(value.icoFinding)) &&
        (value.observedQuantity === undefined ||
          (finite(value.observedQuantity) && value.observedQuantity >= 0)) &&
        (value.uomId === undefined || typeof value.uomId === "string")
      );
    case "promotion":
      return (
        exact(value, ["kind", "programRef", "finding"]) &&
        typeof value.programRef === "string" &&
        ["executed", "not_executed", "not_applicable"].includes(
          String(value.finding),
        )
      );
    case "order_intent":
      return (
        exact(value, ["kind", "clientOrderId", "note"]) &&
        typeof value.clientOrderId === "string" &&
        uuid.test(value.clientOrderId) &&
        (value.note === undefined ||
          (typeof value.note === "string" && value.note.length <= 500))
      );
    case "price_check":
      return (
        exact(value, [
          "kind",
          "productId",
          "observedPriceMinor",
          "currency",
          "compliant",
        ]) &&
        typeof value.productId === "string" &&
        Number.isSafeInteger(value.observedPriceMinor) &&
        (value.observedPriceMinor as number) >= 0 &&
        typeof value.currency === "string" &&
        /^[A-Z]{3}$/.test(value.currency) &&
        (value.compliant === undefined || typeof value.compliant === "boolean")
      );
    default:
      return false;
  }
}
function validOperation(value: unknown): boolean {
  if (
    !record(value) ||
    typeof value.kind !== "string" ||
    !kinds.has(value.kind) ||
    typeof value.clientRequestId !== "string" ||
    !uuid.test(value.clientRequestId) ||
    !record(value.payload) ||
    !exact(value, [
      "kind",
      "clientRequestId",
      "clientVisitId",
      "dependsOn",
      "payload",
    ]) ||
    (value.clientVisitId !== undefined &&
      (typeof value.clientVisitId !== "string" ||
        !uuid.test(value.clientVisitId))) ||
    (value.dependsOn !== undefined &&
      (!Array.isArray(value.dependsOn) ||
        value.dependsOn.length > 20 ||
        !value.dependsOn.every(
          (x: unknown) => typeof x === "string" && uuid.test(x),
        )))
  )
    return false;
  const p = value.payload;
  switch (value.kind) {
    case "visit.checkIn":
      return (
        exact(p, [
          "clientVisitId",
          "plannedVisitId",
          "outletId",
          "serviceDate",
          "deviceTime",
          "location",
          "intents",
          "unplannedReason",
        ]) &&
        typeof p.clientVisitId === "string" &&
        uuid.test(p.clientVisitId) &&
        (p.plannedVisitId === null || typeof p.plannedVisitId === "string") &&
        typeof p.outletId === "string" &&
        typeof p.serviceDate === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(p.serviceDate) &&
        Number.isSafeInteger(p.deviceTime) &&
        validLocation(p.location) &&
        Array.isArray(p.intents) &&
        p.intents.length <= 8 &&
        p.intents.every(
          (x: unknown) =>
            typeof x === "string" &&
            [
              "sell",
              "collect",
              "merchandise",
              "audit",
              "deliver",
              "promotion",
              "complaint",
              "follow-up",
            ].includes(x),
        ) &&
        (p.unplannedReason === undefined ||
          (typeof p.unplannedReason === "string" &&
            p.unplannedReason.length <= 500))
      );
    case "visit.activity":
      return (
        exact(p, ["visitId", "activity", "deviceTime"]) &&
        typeof p.visitId === "string" &&
        Number.isSafeInteger(p.deviceTime) &&
        validActivity(p.activity)
      );
    case "visit.checkOut":
      return (
        exact(p, [
          "visitId",
          "outcome",
          "reasonCode",
          "deviceTime",
          "location",
        ]) &&
        typeof p.visitId === "string" &&
        ["completed", "nonproductive"].includes(String(p.outcome)) &&
        (p.reasonCode === null || typeof p.reasonCode === "string") &&
        Number.isSafeInteger(p.deviceTime) &&
        validLocation(p.location)
      );
    default:
      return true; // Unsupported variants are rejected by the operation writer.
  }
}

export async function handleMobile(
  ctx: ActionCtx,
  request: Request,
  route: Route,
): Promise<Response> {
  if (request.headers.get("x-mobile-contract-version") !== "1")
    return failure("version_unsupported", 400);
  const bearer = request.headers.get("authorization");
  let identity;
  try {
    identity = await ctx.auth.getUserIdentity();
  } catch {
    return failure("unauthorized", 401);
  }
  if (!bearer || !/^Bearer [^\s]+$/.test(bearer) || !identity)
    return failure("unauthorized", 401);
  const bytes = await rawBody(request);
  if (!bytes) return failure("invalid_request", 413);
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    return failure("invalid_request", 400);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return failure("invalid_request", 400);
  }
  if (record(body) && body.contractVersion !== 1)
    return failure("version_unsupported", 400);
  if (
    !record(body) ||
    body.type !== `${route}.request` ||
    typeof body.deviceId !== "string" ||
    body.deviceId.length > 128
  )
    return failure("invalid_request", 400);
  const allowed =
    route === "bootstrap"
      ? [
          "type",
          "contractVersion",
          "deviceId",
          "dayFrom",
          "pageCursor",
          "limit",
        ]
      : route === "pull"
        ? ["type", "contractVersion", "deviceId", "cursor", "limit"]
        : ["type", "contractVersion", "deviceId", "operations"];
  if (
    !exact(body, allowed) ||
    (route === "bootstrap" &&
      ((body.dayFrom !== undefined &&
        (typeof body.dayFrom !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(body.dayFrom))) ||
        (body.pageCursor !== undefined &&
          typeof body.pageCursor !== "string"))) ||
    (route === "pull" &&
      (typeof body.cursor !== "string" || body.cursor.length > 4096)) ||
    (route !== "push" &&
      body.limit !== undefined &&
      (!Number.isSafeInteger(body.limit) ||
        (body.limit as number) < 1 ||
        (body.limit as number) > (route === "pull" ? 50 : 100))) ||
    (route === "push" &&
      (!Array.isArray(body.operations) ||
        body.operations.length < 1 ||
        body.operations.length > 20 ||
        !body.operations.every(validOperation)))
  )
    return failure("invalid_request", 400);
  const deviceId = request.headers.get("x-mobile-device-id");
  const app = request.headers.get("x-mobile-app");
  const nonce = request.headers.get("x-mobile-nonce");
  const time = request.headers.get("x-mobile-timestamp");
  const proof = request.headers.get("x-mobile-signature");
  const digest = request.headers.get("x-mobile-body-digest");
  if (
    deviceId !== body.deviceId ||
    !deviceId ||
    !["IOS", "ANDROID"].includes(app ?? "") ||
    !nonce ||
    !/^[0-9a-f-]{36}$/i.test(nonce) ||
    !time ||
    !/^\d{13}$/.test(time) ||
    !proof ||
    proof.length > 256 ||
    !digest ||
    !/^[0-9a-f]{64}$/.test(digest) ||
    digest !== (await hexDigest(bytes))
  )
    return failure("unauthorized", 401);
  let actor: AuthorizedDevice;
  try {
    actor = await ctx.runMutation(internal.mobile.device_auth.authorize, {
      deviceId: deviceId as Id<"registeredDevices">,
      app: app as "IOS" | "ANDROID",
      proof,
      method: "POST",
      path: `/mobile/v1/${route}`,
      bodyDigest: digest,
      nonce,
      timestamp: Number(time),
    });
  } catch {
    return failure("unauthorized", 401);
  }
  try {
    if (route === "bootstrap") {
      const value = await ctx.runQuery(internal.mobile.bootstrap.snapshot, {
        actor,
        dayFrom: body.dayFrom as string | undefined,
        pageCursor: body.pageCursor as string | undefined,
        limit: body.limit as number | undefined,
      });
      return json(value);
    }
    if (route === "pull") {
      const value = await ctx.runQuery(internal.mobile.pull.delta, {
        actor,
        cursor: body.cursor as string,
        limit: body.limit as number | undefined,
      });
      return json(value);
    }
    const results: unknown[] = [];
    for (const entry of body.operations as RecordValue[]) {
      try {
        // The wire contract uses a safe JSON integer; Convex's int64 validator requires bigint.
        const p = entry.payload as RecordValue;
        const activity = p.activity;
        const operation =
          record(activity) && activity.kind === "price_check"
            ? {
                ...entry,
                payload: {
                  ...p,
                  activity: {
                    ...activity,
                    observedPriceMinor: BigInt(
                      activity.observedPriceMinor as number,
                    ),
                  },
                },
              }
            : entry;
        const result = await ctx.runMutation(internal.mobile.push.applyOne, {
          actor,
          deviceId: actor.deviceId,
          operation: operation as Parameters<
            typeof ctx.runMutation<typeof internal.mobile.push.applyOne>
          >[1]["operation"],
        });
        results.push(
          result.status === "accepted"
            ? {
                kind: entry.kind,
                clientRequestId: entry.clientRequestId,
                status: "accepted",
                ack: {
                  entityId: result.ack.entityId,
                  eventIds: result.ack.eventIds,
                  serverTime: result.ack.serverTime,
                },
              }
            : {
                kind: entry.kind,
                clientRequestId: entry.clientRequestId,
                status: result.status,
                code: result.code,
              },
        );
      } catch (error) {
        const code = coded(error);
        if (!code || !businessCodes.has(code)) throw error;
        results.push({
          kind: entry.kind,
          clientRequestId: entry.clientRequestId,
          status: code === "conflict" ? "conflict" : "rejected",
          code,
        });
      }
    }
    return json({
      type: "push.response",
      contractVersion: 1,
      serverTime: Date.now(),
      results,
    });
  } catch (error) {
    const code = coded(error);
    if (code === "rebootstrap_required" || code === "invalid_cursor")
      return failure(code, 409);
    return failure("temporarily_unavailable", 500);
  }
}
export const bootstrap = httpAction((ctx, request) =>
  handleMobile(ctx, request, "bootstrap"),
);
export const pull = httpAction((ctx, request) =>
  handleMobile(ctx, request, "pull"),
);
export const push = httpAction((ctx, request) =>
  handleMobile(ctx, request, "push"),
);
