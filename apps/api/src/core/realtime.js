import { ambient } from "@sunpride/db/client";
import { resolveAuth } from "./context.js";
import { partnerTopicAllowed } from "../domains/partners/boundary.js";
import { canSubscribe } from "./hooks.js";
import { PgListener } from "./pglisten.js";

/**
 * Realtime invalidation hub (contract §4). Clients send
 * `{"type":"subscribe","topics":[...]}`; the server answers `{"type":"subscribed","topics":[...]}`,
 * refuses ungranted topics with `{"type":"error","code":"forbidden","topic":...}` and pushes
 * `{"type":"invalidate","topic":...,"seq":n}`. Fan-out goes through Postgres NOTIFY on
 * `sp_events`, so several API processes stay correct.
 */

export const CHANNEL = "sp_events";
const TOPIC_RE = /^[a-z][a-z0-9_.-]{0,63}(:[A-Za-z0-9_.-]{1,128}){0,3}$/;
const MAX_TOPICS = 100;

/**
 * NOTIFY a topic. On a transaction handle Postgres delivers it only after COMMIT (and never on
 * rollback); on the pool it goes out immediately — call it after your `tx()` returns.
 * @param {any} db @param {string} topic
 */
export async function publish(db, topic) {
  if (!TOPIC_RE.test(topic)) throw new Error(`invalid topic ${topic}`);
  // SP-0169: inside a transaction this path holds, notify on it (sent at COMMIT).
  await ambient(db)`select pg_notify(${CHANNEL}, json_build_object('topic', ${topic}::text, 'seq', nextval('event_seq'))::text)`;
}

/**
 * @typedef {{ actor: import('./context.js').Actor, topics: Set<string>, request: Request }} WsData
 */

/**
 * @param {{ db: any, url: string }} opts
 */
export function createRealtime(opts) {
  /** @type {any} */
  let server = null;
  /** @type {PgListener|null} */
  let listener = null;
  /** @type {Set<import('bun').ServerWebSocket<WsData>>} */
  const sockets = new Set();
  /** Recheck the session and partner grant at delivery, not only subscribe.
   * @param {import('bun').ServerWebSocket<WsData>} ws @param {string} topic */
  async function allowed(ws, topic) {
    const auth = await resolveAuth(opts.db, ws.data.request);
    if (!auth.actor) return false;
    ws.data.actor = auth.actor;
    const partner = await partnerTopicAllowed(opts.db, auth.actor, topic);
    return partner ?? Boolean(await canSubscribe(auth.actor, topic));
  }

  return {
    /** @param {any} s */
    attach(s) {
      server = s;
    },
    async start() {
      listener = new PgListener(opts.url, CHANNEL, async (payload) => {
        /** @type {any} */
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          return;
        }
        if (!server || typeof event?.topic !== "string") return;
        const message = JSON.stringify({
          type: "invalidate",
          topic: event.topic,
          seq: Number(event.seq),
        });
        for (const ws of sockets)
          if (ws.data.topics.has(event.topic)) {
            try {
              if (await allowed(ws, event.topic)) ws.send(message);
              else {
                ws.data.topics.delete(event.topic);
                ws.unsubscribe(event.topic);
              }
            } catch {
              ws.data.topics.delete(event.topic);
              ws.unsubscribe(event.topic);
            }
          }
      });
      await listener.start();
    },
    async stop() {
      await listener?.close();
      listener = null;
    },
    /**
     * Authenticate and upgrade `/ws` (cookie or access bearer).
     * @param {Request} req @param {any} srv
     * @returns {Promise<Response|undefined>}
     */
    async upgrade(req, srv) {
      const auth = await resolveAuth(opts.db, req);
      if (!auth.actor)
        return new Response(
          JSON.stringify({
            error: {
              code: "unauthenticated",
              message: "Sign in required",
              retryable: false,
            },
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        );
      /** @type {WsData} */
      const data = { actor: auth.actor, topics: new Set(), request: req };
      if (srv.upgrade(req, { data })) return undefined;
      return new Response("Upgrade required", { status: 426 });
    },
    websocket: {
      idleTimeout: 120,
      maxPayloadLength: 64 * 1024,
      /** @param {import('bun').ServerWebSocket<WsData>} ws @param {string|Buffer} message */
      async message(ws, message) {
        /** @type {any} */
        let m;
        try {
          m = JSON.parse(String(message));
        } catch {
          ws.send(JSON.stringify({ type: "error", code: "invalid_json" }));
          return;
        }
        if (m?.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (
          (m?.type !== "subscribe" && m?.type !== "unsubscribe") ||
          !Array.isArray(m.topics)
        ) {
          ws.send(JSON.stringify({ type: "error", code: "invalid_request" }));
          return;
        }
        if (m.type === "unsubscribe") {
          for (const t of m.topics)
            if (typeof t === "string" && ws.data.topics.delete(t))
              ws.unsubscribe(t);
          ws.send(
            JSON.stringify({
              type: "unsubscribed",
              topics: m.topics.filter(
                (/** @type {unknown} */ t) => typeof t === "string",
              ),
            }),
          );
          return;
        }
        /** @type {string[]} */
        const granted = [];
        for (const topic of m.topics) {
          if (typeof topic !== "string" || !TOPIC_RE.test(topic)) {
            ws.send(
              JSON.stringify({
                type: "error",
                code: "invalid_topic",
                topic: typeof topic === "string" ? topic : null,
              }),
            );
            continue;
          }
          if (ws.data.topics.size >= MAX_TOPICS && !ws.data.topics.has(topic)) {
            ws.send(
              JSON.stringify({ type: "error", code: "too_many_topics", topic }),
            );
            continue;
          }
          let ok = false;
          try {
            ok = Boolean(await allowed(ws, topic));
          } catch {
            ok = false;
          }
          if (!ok) {
            ws.send(
              JSON.stringify({ type: "error", code: "forbidden", topic }),
            );
            continue;
          }
          ws.data.topics.add(topic);
          ws.subscribe(topic);
          granted.push(topic);
        }
        ws.send(JSON.stringify({ type: "subscribed", topics: granted }));
      },
      /** @param {import('bun').ServerWebSocket<WsData>} ws */
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ type: "ready" }));
      },
      /** @param {import('bun').ServerWebSocket<WsData>} ws */
      close(ws) {
        sockets.delete(ws);
        ws.data.topics.clear();
      },
    },
  };
}
