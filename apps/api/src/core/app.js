import { domainInstallers } from "../domains/index.js";
import { enforcePartnerHttp } from "../domains/partners/boundary.js";
import { installAuth } from "./auth.js";
import { buildCtx, passwordChangeBlocks } from "./context.js";
import { installDevices } from "./devices.js";
import { ApiError } from "./errors.js";
import { registerTopic } from "./hooks.js";
import { createScheduler, enqueue, registerJob } from "./jobs.js";
import { installMedia } from "./media.js";
import { createRealtime, publish } from "./realtime.js";
import {
  MAX_JSON_BYTES,
  Reply,
  Router,
  errorResponse,
  json,
  parseJson,
  readCapped,
} from "./router.js";
import {
  installSync,
  recordChange,
  registerOp,
  registerProjection,
} from "./sync.js";

/**
 * Compose the API: core routes + domain installers + realtime hub + scheduler.
 * @param {{ db: any, dbUrl: string, env?: Record<string,string|undefined>, installers?: Array<(router: Router, ctx: any) => void>,
 *   schedulerPollMs?: number }} opts
 */
export function createApp(opts) {
  const db = opts.db;
  const env = opts.env ?? process.env;
  const router = new Router();
  installAuth(router);
  installDevices(router);
  installSync(router);
  installMedia(router);

  const realtime = createRealtime({ db, url: opts.dbUrl });
  const scheduler = createScheduler({
    db,
    dbUrl: opts.dbUrl,
    pollMs: opts.schedulerPollMs,
  });
  const installCtx = {
    db,
    env,
    scheduler,
    registerOp,
    registerProjection,
    registerJob,
    registerTopic,
    recordChange,
    publish: (/** @type {string} */ topic) => publish(db, topic),
  };
  for (const install of opts.installers ?? domainInstallers)
    install(router, installCtx);

  /** @type {any} */
  let server = null;

  /** @param {Request} req @param {any} srv */
  async function fetch(req, srv) {
    const now = Date.now();
    const url = new URL(req.url);
    let v2 = Boolean(
      req.headers.get("authorization") || req.headers.get("x-app"),
    );
    /** @type {import('./context.js').Ctx|null} */
    let ctx = null;
    try {
      if (
        url.pathname === "/healthz" &&
        (req.method === "GET" || req.method === "HEAD")
      ) {
        try {
          await db`select 1`;
          return json({ ok: true, db: true });
        } catch {
          return json({ ok: false, db: false }, 503);
        }
      }
      if (url.pathname === "/ws") return await realtime.upgrade(req, srv);
      const match = router.match(req.method, url.pathname);
      if (!match)
        throw new ApiError("not_found", 404, "Not found", false, {
          action: "none",
        });
      if ("methodNotAllowed" in match)
        throw new ApiError(
          "method_not_allowed",
          405,
          "Method not allowed",
          false,
          { action: "none" },
        );
      const { route, params } = match;
      v2 ||= Boolean(route.options.v2);
      /** @type {Uint8Array} */
      let rawBody = new Uint8Array(0);
      /** @type {any} */
      let body = null;
      if (!route.options.raw && req.method !== "GET" && req.method !== "HEAD") {
        // A route may raise the JSON cap (e.g. a 5,000-row upload); never above the server limit.
        rawBody = await readCapped(
          req,
          route.options.maxBytes ?? MAX_JSON_BYTES,
        );
        body = parseJson(rawBody);
        // The web client sends the per-intent key as the `idempotency-key` header; many
        // commands read `body.idempotencyKey`. One contract for both, body wins.
        const headerKey = req.headers.get("idempotency-key");
        if (
          headerKey &&
          body &&
          typeof body === "object" &&
          !Array.isArray(body) &&
          body.idempotencyKey == null
        )
          body.idempotencyKey = headerKey;
      }
      ctx = await buildCtx({
        db,
        req,
        url,
        params,
        rawBody,
        body,
        env,
        server: srv,
        v2,
        publish,
        enqueue,
      });
      if (passwordChangeBlocks(ctx.user, url.pathname))
        throw new ApiError(
          "password_change_required",
          403,
          "Set a new password first.",
        );
      await enforcePartnerHttp(ctx);
      const result = await route.handler(ctx);
      /** @type {Response} */
      let res;
      if (result instanceof Response) res = result;
      else if (result instanceof Reply)
        res = json(result.body, result.status, result.headers);
      else res = json(result ?? null);
      for (const c of ctx.cookies) res.headers.append("set-cookie", c);
      if (ctx.actor) res.headers.set("cache-control", "private, no-store");
      return res;
    } catch (error) {
      const res = errorResponse(error, ctx ? ctx.v2 : v2, now, url.pathname);
      if (ctx) for (const c of ctx.cookies) res.headers.append("set-cookie", c);
      return res;
    }
  }

  return {
    router,
    realtime,
    scheduler,
    fetch,
    /** @param {{ port?: number, hostname?: string, listen?: boolean, schedule?: boolean }} [o] */
    async start(o = {}) {
      server = Bun.serve({
        port: o.port ?? 4310,
        hostname: o.hostname ?? "127.0.0.1",
        maxRequestBodySize: 25 * 1024 * 1024,
        fetch: (req, srv) => fetch(req, srv),
        websocket: /** @type {any} */ (realtime.websocket),
      });
      realtime.attach(server);
      if (o.listen !== false) await realtime.start();
      if (o.schedule !== false) scheduler.start();
      return server;
    },
    /**
     * Graceful stop for rolling releases: stop background work, stop accepting connections,
     * let in-flight requests finish (up to `drainMs`), then close what is left (websockets
     * reconnect to the new pod). drainMs 0 = close at once (tests).
     * @param {{ drainMs?: number }} [o]
     */
    async stop(o = {}) {
      // A long scheduled task must not use up the drain time: stop both at once.
      const scheduled = scheduler.stop();
      const s = server;
      server = null;
      if (s) {
        void Promise.resolve(s.stop(false)).catch(() => {});
        const deadline = Date.now() + (o.drainMs ?? 0);
        while (s.pendingRequests > 0 && Date.now() < deadline)
          await Bun.sleep(25);
        s.stop(true);
      }
      await scheduled;
      await realtime.stop();
    },
    get server() {
      return server;
    },
  };
}
