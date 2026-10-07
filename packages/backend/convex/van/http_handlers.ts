import { ConvexError } from "convex/values";
import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { AuthorizedDevice } from "../mobile/types";
import { MOBILE_LIMITS } from "../mobile/rate_limits";
import { hexDigest, rawBody } from "../mobile/http_handlers";

/**
 * VAN-003 sync gateway for the separate van-sales app (ADR-010): `/van/v1/bootstrap` and
 * `/van/v1/push`, signed exactly like the field gateway (`x-mobile-*` headers, device
 * proof over `POST|path|bodyDigest|nonce|timestamp`) but only for `VAN_ANDROID` devices,
 * whose proofs `mobile/device_auth.authorize` accepts on van paths only.
 * Contract: `packages/domain-contracts/schemas/van-v1.schema.json`.
 */
type Route = "bootstrap" | "push";
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
        : ["type", "contractVersion", "deviceId", "operations"],
    ) ||
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
