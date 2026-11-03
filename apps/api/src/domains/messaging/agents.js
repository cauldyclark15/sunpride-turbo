import { resolveAuth } from "../../core/context.js";
import { ApiError, conflict, notFound } from "../../core/errors.js";
import { randomToken, sha256Hex } from "../../core/util.js";
import * as M from "./model.js";
/** Open long-polls one identity may hold at once (per API process). */
export const MAX_POLLS = 3;
/** @type {Map<string, number>} */
const polls = new Map();
/** @param {import('../../core/router.js').Router} router */
export function installAgents(router) {
  router.post("/api/v1/messaging/agents", async (c) => {
    const a = await M.gate(c, true),
      b = c.body;
    M.text(b?.display_name, 100);
    if (
      typeof b.handle !== "string" ||
      !/^[a-z][a-z0-9_-]{1,49}$/.test(b.handle)
    )
      throw M.invalid(
        "Use a handle of 2–50 lowercase letters, digits, underscores or hyphens",
      );
    const token = randomToken("spa_");
    // Keep the platform password verifier on a valid hash, but discard a random
    // high-entropy password so this identity has no usable password sign-in.
    const passwordHash = await Bun.password.hash(
      randomToken("chat_no_login_"),
      { algorithm: "argon2id" },
    );
    const id = await M.write(c.db, async (db) => {
      if (
        (await db`select user_id from chat_agents where handle=${b.handle}`)
          .length
      )
        throw conflict("Handle already exists");
      const email = `${crypto.randomUUID()}@chat-agents.sunpride.invalid`;
      const [u] =
        await db`insert into users(email,password_hash) values(${email},${passwordHash}) returning id`;
      await db`insert into profiles(user_id,name,email,role,status) values(${u.id},${b.display_name},${email},'viewer','active')`;
      await db`insert into chat_agents(user_id,handle,display_name,created_by,token_hash) values(${u.id},${b.handle},${b.display_name},${a.userId},${sha256Hex(token)})`;
      return u.id;
    });
    return {
      agent: { ...(await M.userLite(c.db, id)), handle: b.handle },
      token,
    };
  });
  router.get("/api/v1/messaging/agents", async (c) => {
    await M.gate(c);
    const rows =
      await c.db`select user_id,handle from chat_agents where disabled_at is null order by handle`;
    return Promise.all(
      rows.map(async (/** @type {any} */ r) => ({
        ...(await M.userLite(c.db, r.user_id)),
        handle: r.handle,
      })),
    );
  });
  router.delete("/api/v1/messaging/agents/:user_id", async (c) => {
    await M.gate(c, true);
    const id = M.uuid(c.params.user_id);
    await M.write(c.db, async (db) => {
      const rows =
        await db`update chat_agents set disabled_at=coalesce(disabled_at,now()) where user_id=${id} returning user_id`;
      if (!rows.length) throw notFound();
      await db`update users set disabled_at=coalesce(disabled_at,now()) where id=${id}`;
      await db`update profiles set status='disabled' where user_id=${id}`;
    });
    const conversations =
      await c.db`select conversation_id from chat_members where user_id=${id} and left_at is null`;
    for (const v of conversations) await M.changed(c, v.conversation_id);
    return { ok: true };
  });
  router.get("/api/v1/messaging/events", async (c) => {
    const a = await M.gate(c),
      wait = M.integer(c.url.searchParams.get("wait"), 25, 25),
      cur = M.decode(c.url.searchParams.get("after"));
    if (
      cur &&
      (cur.v !== 1 ||
        cur.user !== a.userId ||
        !/^\d{1,18}$/.test(String(cur.seq)))
    )
      throw M.invalid("Invalid event cursor");
    const open = polls.get(a.userId) ?? 0;
    if (open >= MAX_POLLS)
      throw new ApiError("rate_limited", 429, "Too many open event polls", true, {
        action: "retry",
        retryAfterMs: 1000,
      });
    polls.set(a.userId, open + 1);
    try {
      return await poll(c, a, cur, wait);
    } finally {
      const left = (polls.get(a.userId) ?? 1) - 1;
      if (left > 0) polls.set(a.userId, left);
      else polls.delete(a.userId);
    }
  });
}
/** @param {any} c @param {any} a @param {any} cur @param {number} wait */
async function poll(c, a, cur, wait) {
    const signal = c.req.signal;
    /** Resolves when the client goes away, so its permit is released promptly. */
    const gone = new Promise((resolve) =>
      signal.aborted
        ? resolve(undefined)
        : signal.addEventListener("abort", () => resolve(undefined), { once: true }),
    );
    let seq = cur?.seq ?? "0";
    const deadline = Date.now() + wait * 1000;
    c.server?.timeout?.(c.req, wait + 5);
    for (;;) {
      const fresh = await resolveAuth(c.db, c.req);
      c.actor = fresh.actor;
      await M.gate(c);
      const [max] =
        await c.db`select coalesce(max(id),0)::text as id from chat_events`;
      const rows =
        await c.db`select e.* from chat_events e join chat_members m on m.conversation_id=e.conversation_id
    where e.id>${seq}::bigint and e.id<=${max.id}::bigint and m.user_id=${a.userId} and m.left_at is null order by e.id limit 100`;
      if (rows.length) {
        const events = await Promise.all(
          rows.map(async (/** @type {any} */ r) => {
            const m = r.message_id
              ? await M.messageAccess(c.db, c.actor, r.message_id)
              : null;
            return {
              type: r.type,
              conversation_id: r.conversation_id,
              message: m ? await M.renderMessage(c.db, c.actor, m) : null,
              at: M.iso(r.created_at),
            };
          }),
        );
        return {
          events,
          cursor: M.cursor({
            v: 1,
            user: a.userId,
            seq: String(rows.at(-1).id),
          }),
        };
      }
      // The global writer lock guarantees no earlier event can commit after max.
      seq = max.id;
      if (Date.now() >= deadline || signal.aborted)
        return { events: [], cursor: M.cursor({ v: 1, user: a.userId, seq }) };
      await Promise.race([
        Bun.sleep(Math.min(250, Math.max(1, deadline - Date.now()))),
        gone,
      ]);
    }
}
