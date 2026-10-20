import { Database } from "bun:sqlite";
import { sampleMasters } from "./sample.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  masterKinds,
  postingKinds,
  validate,
  payloadHash,
} from "../../../packages/integration-contracts/sap/v1/index.js";

/** F-001/F-003: persistent mock, including the accepted-but-response-lost window.
 * @param {{path:string,port?:number,token?:string,seed?:boolean}} opts
 */
export function startMock(opts) {
  mkdirSync(dirname(opts.path), { recursive: true });
  const db = /** @type {any} */ (new Database(opts.path, { create: true }));
  db.exec(`pragma journal_mode=WAL; pragma synchronous=FULL;
    create table if not exists masters(seq integer primary key autoincrement, kind text not null, key text not null, version integer not null, hash text not null, body text not null, unique(kind,key,version));
    create table if not exists receipts(effect text primary key, hash text not null, body text not null, result text not null);
    create table if not exists credit_accounts(customer text primary key, credit_limit integer, exposure integer not null);
    create table if not exists decisions(request text primary key, hash text not null, result text not null);
    create table if not exists reservations(request text primary key,customer text not null,amount integer not null,expires integer not null);
    create table if not exists controls(target text primary key, mode text not null, remaining integer not null, delay integer not null);`);
  /** @param {any} v @param {number} [status] */
  const json = (v, status = 200) => Response.json(v, { status });
  /** @param {string} code @param {number} status @param {boolean} [retryable] */
  const error = (code, status, retryable = false) =>
    json(
      { error: { code, message: code.replaceAll("_", " "), retryable } },
      status,
    );
  /** @param {any} m */
  function putMaster(m) {
    validate(m.kind, m);
    if (
      !masterKinds.includes(m.kind) ||
      (m.effectiveTo !== null && m.effectiveTo <= m.effectiveFrom)
    )
      throw new Error("invalid_contract:master");
    const hash = payloadHash(m);
    const previous = db
      .query("select hash from masters where kind=? and key=? and version=?")
      .get(m.kind, m.key, m.version);
    if (previous && previous.hash !== hash) throw new Error("payload_conflict");
    db.query(
      "insert or ignore into masters(kind,key,version,hash,body) values(?,?,?,?,?)",
    ).run(m.kind, m.key, m.version, hash, JSON.stringify(m));
  }
  if (opts.seed !== false) {
    db.transaction(() => sampleMasters.forEach(putMaster))();
    db.query("insert or ignore into credit_accounts values(?,?,?)").run(
      "MOCK-C1",
      5000000,
      150000,
    );
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 4435,
    maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(req) {
      const u = new URL(req.url),
        parts = u.pathname.split("/").filter(Boolean);
      if (
        opts.token &&
        req.headers.get("authorization") !== `Bearer ${opts.token}`
      )
        return error("unauthorized", 401);
      try {
        if (u.pathname === "/healthz")
          return json({ ok: true, source: "sample", schemaVersion: 1 });
        const target = parts[2] ?? "all";
        const control = db
          .query(
            "select * from controls where target in (?, 'all') and remaining>0 order by target='all' limit 1",
          )
          .get(target);
        if (parts[0] !== "control" && control) {
          db.query(
            "update controls set remaining=remaining-1 where target=?",
          ).run(control.target);
          if (control.mode === "slow") await Bun.sleep(control.delay);
          if (control.mode === "fail") return error("unavailable", 503, true);
          if (control.mode === "reject") return error("rejected", 422);
        }
        if (req.method === "POST" && u.pathname === "/control/fault") {
          const b = await req.json();
          if (
            ![
              "fail",
              "slow",
              "reject",
              "accept_drop",
              "accept_slow",
              "none",
            ].includes(b.mode) ||
            !Number.isSafeInteger(b.count ?? 1) ||
            (b.count ?? 1) < 0 ||
            !Number.isSafeInteger(b.delayMs ?? 1500) ||
            (b.delayMs ?? 1500) < 0
          )
            return error("invalid_contract", 400);
          db.query("insert or replace into controls values(?,?,?,?)").run(
            b.target ?? "all",
            b.mode,
            b.count ?? 1,
            b.delayMs ?? 1500,
          );
          return json({ ok: true });
        }
        if (req.method === "POST" && u.pathname === "/control/masters") {
          const b = await req.json();
          if (!Array.isArray(b.items) || b.items.length > 1000)
            return error("invalid_contract", 400);
          db.transaction(() => b.items.forEach(putMaster))();
          return json({ accepted: b.items.length });
        }
        if (req.method === "POST" && u.pathname === "/control/credit") {
          const b = await req.json();
          if (
            typeof b.customerCode !== "string" ||
            (b.limitCentavos !== null &&
              (!Number.isSafeInteger(b.limitCentavos) ||
                b.limitCentavos < 0)) ||
            !Number.isSafeInteger(b.exposureCentavos) ||
            b.exposureCentavos < 0
          )
            return error("invalid_contract", 400);
          db.query(
            b.ifAbsent
              ? "insert or ignore into credit_accounts values(?,?,?)"
              : "insert or replace into credit_accounts values(?,?,?)",
          ).run(b.customerCode, b.limitCentavos, b.exposureCentavos);
          return json({ ok: true });
        }
        if (req.method === "GET" && u.pathname === "/control/receipts")
          return json({
            rows: db
              .query("select effect,hash,result from receipts order by effect")
              .all()
              .map((/** @type {any} */ r) => ({
                ...r,
                result: JSON.parse(r.result),
              })),
          });
        if (
          req.method === "GET" &&
          parts[0] === "v1" &&
          parts[1] === "masters" &&
          masterKinds.includes(target)
        ) {
          const after = u.searchParams.get("after") ?? "0";
          if (
            !/^(0|[1-9]\d*)$/.test(after) ||
            !Number.isSafeInteger(Number(after))
          )
            return error("invalid_contract", 400);
          const rows = db
            .query(
              "select seq,body from masters where kind=? and seq>? order by seq limit 101",
            )
            .all(target, Number(after));
          const page = rows.slice(0, 100);
          return json(
            validate("masterPage", {
              items: page.map((/** @type {any} */ r) => JSON.parse(r.body)),
              watermark: String(page.at(-1)?.seq ?? after),
              nextCursor: rows.length > 100 ? String(page.at(-1).seq) : null,
            }),
          );
        }
        if (req.method === "POST" && u.pathname === "/v1/credit/check") {
          const b = validate("creditRequest", await req.json()),
            hash = payloadHash(b);
          const result = db.transaction(() => {
            const held = db
              .query("select * from reservations where request=?")
              .get(b.requestId);
            if (
              held &&
              (held.customer !== b.customerCode ||
                held.amount !== b.amountCentavos)
            )
              throw new Error("payload_conflict");
            const previous = db
              .query("select * from decisions where request=?")
              .get(b.requestId);
            if (previous) {
              if (previous.hash !== hash) throw new Error("payload_conflict");
              const decision = JSON.parse(previous.result);
              if (decision.expiresAt > Date.now()) return decision;
              db.query("delete from decisions where request=?").run(
                b.requestId,
              );
            }
            const account = db
              .query("select * from credit_accounts where customer=?")
              .get(b.customerCode);
            const exposureBefore = account
              ? account.exposure - (held?.amount ?? 0)
              : null;
            const now = Date.now(),
              total = account ? exposureBefore + b.amountCentavos : null;
            const status =
              !account || !Number.isSafeInteger(total)
                ? "unknown"
                : account.credit_limit === null
                  ? "no_limit"
                  : total > account.credit_limit
                    ? "over"
                    : "within";
            const r = validate("creditResult", {
              schemaVersion: 1,
              ...b,
              decisionToken: `sample-${crypto.randomUUID()}`,
              expiresAt: now + 120000,
              checkedAt: now,
              status,
              limitCentavos: account?.credit_limit ?? null,
              exposureCentavos: exposureBefore,
              projectedExposureCentavos: Number.isSafeInteger(total)
                ? total
                : null,
              source: "sample",
            });
            db.query("insert into decisions values(?,?,?)").run(
              b.requestId,
              hash,
              JSON.stringify(r),
            );
            // SAP-issued commitment: competing channels see the reservation, not a local sum.
            if (b.reserve && ["within", "no_limit"].includes(status)) {
              if (!held)
                db.query(
                  "update credit_accounts set exposure=exposure+? where customer=?",
                ).run(b.amountCentavos, b.customerCode);
              db.query(
                "insert or replace into reservations values(?,?,?,?)",
              ).run(b.requestId, b.customerCode, b.amountCentavos, r.expiresAt);
            }
            return r;
          })();
          return json(result);
        }
        if (
          req.method === "GET" &&
          parts[1] === "postings" &&
          parts.length === 3
        ) {
          const r = db
            .query("select result from receipts where effect=?")
            .get(decodeURIComponent(parts[2]));
          return r ? json(JSON.parse(r.result)) : error("not_found", 404);
        }
        if (
          req.method === "POST" &&
          parts[1] === "postings" &&
          postingKinds.includes(target)
        ) {
          const b = validate(target, await req.json()),
            hash = payloadHash(b);
          if (b.kind !== target) return error("invalid_contract", 400);
          const r = db.transaction(() => {
            const old = db
              .query("select * from receipts where effect=?")
              .get(b.effectId);
            if (old) {
              if (old.hash !== hash) throw new Error("payload_conflict");
              return JSON.parse(old.result);
            }
            if (b.kind === "goods_movement") {
              for (const line of b.document.lines) {
                for (const code of [
                  line.fromLocationCode,
                  line.toLocationCode,
                ].filter(Boolean)) {
                  const location = db
                    .query(
                      "select body from masters where kind='location' and json_extract(body,'$.data.locationCode')=? and json_extract(body,'$.effectiveFrom')<=? order by version desc limit 1",
                    )
                    .get(code, Date.now());
                  const master = location ? JSON.parse(location.body) : null;
                  if (
                    !master ||
                    master.deleted ||
                    master.data.status !== "active" ||
                    (master.effectiveTo !== null &&
                      master.effectiveTo <= Date.now())
                  )
                    throw new Error("mapping_rejected");
                }
              }
            }
            const credit = b.document.facts.creditDecision;
            if (
              b.document.sourceType === "order" &&
              b.kind === "order" &&
              !credit
            )
              throw new Error("credit_rejected");
            if (credit) {
              const decision = db
                .query(
                  "select request,result from decisions where json_extract(result,'$.decisionToken')=?",
                )
                .get(credit.token);
              const d = decision ? JSON.parse(decision.result) : null;
              if (
                !d ||
                d.customerCode !== b.document.customerCode ||
                d.amountCentavos !== b.document.amountCentavos ||
                decision.request !==
                  `confirm:${b.document.sourceType}:${b.document.sourceId}` ||
                !["within", "no_limit"].includes(d.status)
              )
                throw new Error("credit_rejected");
            }
            const n =
              db.query("select count(*) as n from receipts").get().n + 1;
            const r = validate("postingResult", {
              schemaVersion: 1,
              effectId: b.effectId,
              correlationId: b.correlationId,
              documentNumber: `SAMPLE-${target.toUpperCase()}-${String(n).padStart(8, "0")}`,
              payloadHash: hash,
              postedAt: Date.now(),
              source: "sample",
            });
            db.query("insert into receipts values(?,?,?,?)").run(
              b.effectId,
              hash,
              JSON.stringify(b),
              JSON.stringify(r),
            );
            return r;
          })();
          if (control?.mode === "accept_slow") await Bun.sleep(control.delay);
          if (control?.mode === "accept_drop")
            return error("unavailable", 503, true);
          return json(r);
        }
        return error("not_found", 404);
      } catch (e) {
        const conflict = e instanceof Error && e.message === "payload_conflict";
        if (
          e instanceof Error &&
          ["credit_rejected", "mapping_rejected"].includes(e.message)
        )
          return error("rejected", 422);
        return error(
          conflict ? "payload_conflict" : "invalid_contract",
          conflict ? 409 : 400,
        );
      }
    },
  });
  return {
    server,
    db,
    origin: `http://127.0.0.1:${server.port}`,
    putMaster,
    stop() {
      server.stop(true);
      db.close();
    },
  };
}

if (import.meta.main) {
  const mock = startMock({
    path:
      process.env.SAP_MOCK_DB ??
      `${process.env.TMPDIR ?? process.env.HOME + "/.hermes/cache/scratch"}/sunpride-sap-mock.sqlite`,
    port: Number(process.env.PORT ?? 4435),
    token: process.env.SAP_MOCK_TOKEN,
  });
  console.log(`Sample SAP v1 listening on ${mock.origin}`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      mock.stop();
      process.exit(0);
    });
}
