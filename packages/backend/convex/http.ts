import { httpRouter } from "convex/server";
import { env, httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { authComponent, createAuth } from "./auth";

const http = httpRouter();
authComponent.registerRoutes(http, createAuth, { cors: true });

const encoder = new TextEncoder();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function verifyRequest(request: Request, body: string) {
  const secret = env.CONNECTOR_SIGNING_SECRET;
  const timestamp = request.headers.get("x-sunpride-timestamp");
  const signature = request.headers.get("x-sunpride-signature");
  if (!secret || !timestamp || !signature) return false;
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed) || Math.abs(Date.now() - parsed) > 300_000)
    return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = signature
    .match(/.{1,2}/g)
    ?.map((pair) => Number.parseInt(pair, 16));
  if (!bytes || bytes.some(Number.isNaN)) return false;
  return crypto.subtle.verify(
    "HMAC",
    key,
    new Uint8Array(bytes),
    encoder.encode(`${timestamp}.${body}`),
  );
}

const withAuth = (
  handler: (
    ctx: ActionCtx,
    request: Request,
    body: string,
  ) => Promise<Response>,
) =>
  httpAction(async (ctx, request) => {
    const body = request.method === "GET" ? "" : await request.text();
    if (!(await verifyRequest(request, body)))
      return json({ error: "invalid_signature" }, 401);
    try {
      return await handler(ctx, request, body);
    } catch (error) {
      console.error("SAP HTTP route failed", error);
      return json({ error: "request_failed" }, 500);
    }
  });

http.route({
  path: "/api/sap/events",
  method: "POST",
  handler: withAuth(async (ctx, _request, body) => {
    const envelope: unknown = JSON.parse(body);
    if (
      !isRecord(envelope) ||
      typeof envelope.eventId !== "string" ||
      typeof envelope.eventType !== "string" ||
      envelope.payload === undefined
    )
      return json({ error: "invalid_envelope" }, 400);
    const result = await ctx.runMutation(
      internal.integration.sap.recordInbound,
      {
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        payload: envelope.payload,
        contractVersion:
          typeof envelope.contractVersion === "string"
            ? envelope.contractVersion
            : undefined,
        occurredAt:
          typeof envelope.occurredAt === "string"
            ? Date.parse(envelope.occurredAt)
            : undefined,
        sourceSequence:
          typeof envelope.sourceSequence === "string"
            ? envelope.sourceSequence
            : undefined,
        correlationId:
          typeof envelope.correlationId === "string"
            ? envelope.correlationId
            : undefined,
        payloadHash:
          typeof envelope.payloadHash === "string"
            ? envelope.payloadHash
            : undefined,
      },
    );
    return json({ ok: true, ...result }, result.duplicate ? 200 : 202);
  }),
});

http.route({
  path: "/api/sap/tasks",
  method: "GET",
  handler: withAuth(async (ctx) =>
    json({
      tasks: await ctx.runQuery(internal.integration.sap.pendingTasks, {
        limit: 20,
        now: Date.now(),
      }),
    }),
  ),
});

http.route({
  path: "/api/sap/tasks/ack",
  method: "POST",
  handler: withAuth(async (ctx, _request, body) => {
    const ack: unknown = JSON.parse(body);
    if (
      !isRecord(ack) ||
      typeof ack.eventId !== "string" ||
      typeof ack.success !== "boolean"
    )
      return json({ error: "invalid_ack" }, 400);
    await ctx.runMutation(internal.integration.sap.acknowledgeTask, {
      eventId: ack.eventId,
      success: ack.success,
      sapDocumentNumber:
        typeof ack.sapDocumentNumber === "string"
          ? ack.sapDocumentNumber
          : undefined,
      error: typeof ack.error === "string" ? ack.error : undefined,
    });
    return json({ ok: true });
  }),
});

http.route({
  path: "/api/sap/heartbeat",
  method: "POST",
  handler: withAuth(async (ctx, _request, body) => {
    const beat: unknown = JSON.parse(body);
    if (
      !isRecord(beat) ||
      typeof beat.connectorId !== "string" ||
      !["online", "degraded", "offline"].includes(String(beat.status)) ||
      typeof beat.adapter !== "string"
    )
      return json({ error: "invalid_heartbeat" }, 400);
    await ctx.runMutation(internal.integration.sap.heartbeat, {
      connectorId: beat.connectorId,
      status: beat.status as "online" | "degraded" | "offline",
      adapter: beat.adapter,
      details: typeof beat.details === "string" ? beat.details : undefined,
    });
    return json({ ok: true });
  }),
});

export default http;
