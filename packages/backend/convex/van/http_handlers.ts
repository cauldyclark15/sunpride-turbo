import { ConvexError } from "convex/values";
import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { AuthorizedDevice } from "../mobile/types";
import { MOBILE_LIMITS } from "../mobile/rate_limits";
import { hexDigest, rawBody } from "../mobile/http_handlers";
import { SHA256_HEX } from "./damage";
import { VAN_DAMAGE_POLICY } from "./model";

/**
 * VAN-003 sync gateway for the separate van-sales app (ADR-010): `/van/v1/bootstrap` and
 * `/van/v1/push`, signed exactly like the field gateway (`x-mobile-*` headers, device
 * proof over `POST|path|bodyDigest|nonce|timestamp`) but only for `VAN_ANDROID` devices,
 * whose proofs `mobile/device_auth.authorize` accepts on van paths only.
 * Contract: `packages/domain-contracts/schemas/van-v1.schema.json`.
 */
type Route = "bootstrap" | "push" | "evidence";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: RecordValue, allowed: string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const kinds = new Set(["trip.start", "load.confirm", "truck.damage"]);
/** Business outcomes reported per operation instead of failing the whole push. */
const businessCodes = new Set([
  "invalid_request",
  "conflict",
  "out_of_scope",
  "wrong_date",
  "load_not_posted",
  "photo_required",
]);
const MAX_OPERATIONS = 20;

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
      retryable: status >= 500 || status === 429,
    },
    status,
  );
/** The per-transaction recheck (van/access.requireCurrentDeviceActor) refused the actor. */
function unauthorized(error: unknown): boolean {
  if (error instanceof ConvexError && error.data === "unauthorized")
    return true;
  const text = error instanceof Error ? error.message : "";
  return /(?:^|[:\s])unauthorized(?:$|[\s\n])/.test(text);
}
function coded(error: unknown): string | null {
  const text = error instanceof Error ? error.message : "";
  for (const code of businessCodes)
    if (new RegExp(`(?:^|[:\\s])${code}(?:$|[\\s\\n])`).test(text)) return code;
  return null;
}

export async function handleVan(
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
  const subject = identity.tokenIdentifier;
  // QSR-009: reserve the caller's invalid-request budget before any parsing or proof work.
  let wait: number;
  try {
    wait = await ctx.runMutation(internal.mobile.rate_limits.reserve, {
      subject,
    });
  } catch {
    return failure("temporarily_unavailable", 429);
  }
  if (wait > 0) {
    const response = failure("temporarily_unavailable", 429);
    response.headers.set(
      "retry-after",
      String(Math.max(1, Math.ceil(wait / 1000))),
    );
    return response;
  }
  let response: Response;
  try {
    response = await serve(ctx, request, route);
  } catch (error) {
    await refund(ctx, subject);
    throw error;
  }
  if (![400, 401, 413].includes(response.status)) await refund(ctx, subject);
  return response;
}

async function refund(ctx: ActionCtx, subject: string) {
  try {
    await ctx.runMutation(internal.mobile.rate_limits.refund, { subject });
  } catch {
    // Accounting never turns a served response into a failure.
  }
}

function validOperation(value: unknown): boolean {
  return (
    record(value) &&
    exact(value, ["kind", "clientRequestId", "payload"]) &&
    typeof value.kind === "string" &&
    kinds.has(value.kind) &&
    typeof value.clientRequestId === "string" &&
    uuid.test(value.clientRequestId) &&
    record(value.payload) &&
    typeof value.payload.tripId === "string" &&
    value.payload.tripId.length <= 64 &&
    JSON.stringify(value.payload).length <= 32_000
  );
}

/** VAN-020 evidence body shape; the bytes themselves are checked after the proof. */
function validEvidence(body: RecordValue): boolean {
  return (
    body.contentType === "image/jpeg" &&
    typeof body.sha256 === "string" &&
    SHA256_HEX.test(body.sha256) &&
    typeof body.dataBase64 === "string" &&
    body.dataBase64.length >= 4 &&
    body.dataBase64.length <= 128_000 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(body.dataBase64)
  );
}

function decodeBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++)
      bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Stores one damage photo for the proven seller. The decoded bytes must be a JPEG within
 * the policy size whose SHA-256 equals the declared digest; a repeat upload is a no-op.
 */
async function storeEvidence(
  ctx: ActionCtx,
  actor: AuthorizedDevice,
  body: RecordValue,
): Promise<Response> {
  const sha256 = body.sha256 as string;
  const bytes = decodeBase64(body.dataBase64 as string);
  if (
    !bytes ||
    bytes.length < 4 ||
    bytes.length > VAN_DAMAGE_POLICY.photoMaxBytes ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    (await hexDigest(bytes)) !== sha256
  )
    return failure("invalid_request", 400);
  const stored = () =>
    json({
      type: "van.evidence.response",
      contractVersion: 1,
      serverTime: Date.now(),
      sha256,
      status: "stored",
    });
  if (await ctx.runQuery(internal.van.damage.photoExists, { actor, sha256 }))
    return stored();
  const storageId = await ctx.storage.store(
    new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/jpeg" }),
  );
  let registered = false;
  try {
    registered = await ctx.runMutation(internal.van.damage.registerPhoto, {
      actor,
      sha256,
      storageId,
      size: bytes.length,
    });
  } finally {
    if (!registered) await ctx.storage.delete(storageId);
  }
  return stored();
}

async function serve(
  ctx: ActionCtx,
  request: Request,
  route: Route,
): Promise<Response> {
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
    body.type !== `van.${route}.request` ||
    typeof body.deviceId !== "string" ||
    body.deviceId.length > 128 ||
    !exact(
      body,
      route === "bootstrap"
        ? ["type", "contractVersion", "deviceId"]
        : route === "evidence"
          ? [
              "type",
              "contractVersion",
              "deviceId",
              "contentType",
              "sha256",
              "dataBase64",
            ]
          : ["type", "contractVersion", "deviceId", "operations"],
    ) ||
    (route === "evidence" && !validEvidence(body)) ||
    (route === "push" &&
      (!Array.isArray(body.operations) ||
        body.operations.length < 1 ||
        body.operations.length >
          Math.min(MAX_OPERATIONS, MOBILE_LIMITS.maxPushOperations) ||
        !body.operations.every(validOperation)))
  )
    return failure("invalid_request", 400);
  const deviceId = request.headers.get("x-mobile-device-id");
  const nonce = request.headers.get("x-mobile-nonce");
  const time = request.headers.get("x-mobile-timestamp");
  const proof = request.headers.get("x-mobile-signature");
  const digest = request.headers.get("x-mobile-body-digest");
  if (
    deviceId !== body.deviceId ||
    !deviceId ||
    request.headers.get("x-mobile-app") !== "VAN_ANDROID" ||
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
      app: "VAN_ANDROID",
      proof,
      method: "POST",
      path: `/van/v1/${route}`,
      bodyDigest: digest,
      nonce,
      timestamp: Number(time),
    });
  } catch {
    return failure("unauthorized", 401);
  }
  try {
    if (route === "evidence") return await storeEvidence(ctx, actor, body);
    if (route === "bootstrap")
      return json(
        await ctx.runQuery(internal.van.device.bootstrap, {
          actor,
          now: Date.now(),
        }),
      );
    const results: unknown[] = [];
    for (const entry of body.operations as RecordValue[]) {
      try {
        const result = await ctx.runMutation(internal.van.device.applyOne, {
          actor,
          operation: {
            kind: entry.kind as "trip.start" | "load.confirm" | "truck.damage",
            clientRequestId: entry.clientRequestId as string,
            payload: entry.payload,
          },
        });
        results.push({
          kind: entry.kind,
          clientRequestId: entry.clientRequestId,
          status: "accepted",
          ack: result.ack,
        });
      } catch (error) {
        const code = coded(error);
        if (!code) throw error;
        results.push({
          kind: entry.kind,
          clientRequestId: entry.clientRequestId,
          status: code === "conflict" ? "conflict" : "rejected",
          code,
        });
      }
    }
    return json({
      type: "van.push.response",
      contractVersion: 1,
      serverTime: Date.now(),
      results,
    });
  } catch (error) {
    // Suspended, revoked, deactivated or re-scoped after the proof was verified: the whole
    // request is refused so the phone holds its outbox (VanSync) instead of retrying.
    if (unauthorized(error)) return failure("unauthorized", 401);
    return failure("temporarily_unavailable", 500);
  }
}

export const bootstrap = httpAction((ctx, request) =>
  handleVan(ctx, request, "bootstrap"),
);
export const push = httpAction((ctx, request) =>
  handleVan(ctx, request, "push"),
);
export const evidence = httpAction((ctx, request) =>
  handleVan(ctx, request, "evidence"),
);
