// SP-0170 routes: one canonical customer route set (/api/v1/customers), the client's reference
// lists and PSGC geography. Old outlet routes stay for current apps. Contract:
// docs/architecture/CUSTOMER_MASTER_CONTRACT.md.
import { tx } from "@sunpride/db/client";
import { optionLabel, validateCustomer } from "@sunpride/customer-master";
import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { canonicalJson, isPlainObject } from "../../core/util.js";
import { currentActor } from "../van/access.js";
import { access } from "../org/readers.js";
import { required, rule, uuid } from "../org/model.js";
import {
  approveCustomer,
  deactivateCustomer,
  fieldList,
  listCustomers,
  derive,
  readCustomer,
  referenceRows,
  saveCustomer,
} from "./customers.js";
import { REFERENCE_LISTS } from "@sunpride/db/customer-reference";

/** @type {readonly string[]} */
const REFERENCE_LISTS_PUBLIC = REFERENCE_LISTS;

/** @param {any} router @param {any} platform */
export function installCustomers(router, platform) {
  /** Transactional command: reauthorize inside the transaction, optional Idempotency-Key replay,
   * audit by the writer, then a sync invalidation and realtime publish.
   * @param {string} method @param {string} path @param {string} name @param {(c:any,b:any)=>Promise<string>} handler */
  const command = (method, path, name, handler) =>
    router[method](path, async (/** @type {any} */ ctx) => {
      if (!isPlainObject(ctx.body)) rule("Enter the customer details.");
      const id = await tx(ctx.db, async (db) => {
        const c = {
          ...ctx,
          db,
          actor: await currentActor(db, ctx.actor),
          now: Date.now(),
        };
        await db`select pg_advisory_xact_lock(4310420)`;
        await db`select set_config('sunpride.actor',${c.actor.userId ?? c.actor.subject ?? "system:customers"},true)`;
        const key = ctx.req.headers.get("idempotency-key");
        const digest = new Bun.CryptoHasher("sha256")
          .update(canonicalJson({ path: ctx.url.pathname, body: ctx.body }))
          .digest("hex");
        if (key) {
          required(key, "Request key", 128);
          const [prior] =
            await db`select * from master_command_receipts where actor_profile_id=${c.actor.profileId} and command=${name} and request_key=${key}`;
          if (prior) {
            if (prior.payload_hash !== digest)
              throw new ApiError(
                "idempotency_conflict",
                409,
                "This request key was used for different details.",
              );
            return prior.result.id;
          }
        }
        const value = await handler(c, ctx.body);
        if (key)
          await db`insert into master_command_receipts(actor_profile_id,command,request_key,payload_hash,result) values(${c.actor.profileId},${name},${key},${digest},${{ id: value }})`;
        await platform.recordChange(db, {
          entity: "org.reference",
          entityId: value,
          scopeKey: "global",
          op: "upsert",
        });
        return value;
      });
      for (const topic of ["masters", "outlets", "org"])
        await ctx.publish(topic);
      return readCustomer(ctx.db, id);
    });

  router.get("/api/v1/customers", listCustomers);
  router.get("/api/v1/customers/fields", async (/** @type {any} */ ctx) => {
    await requireCapability(ctx, "outlet.read");
    return { fields: fieldList() };
  });
  router.get("/api/v1/customers/reference", async (/** @type {any} */ ctx) => {
    await requireCapability(ctx, "outlet.read");
    const rows = await referenceRows(ctx.db);
    /** @type {Record<string, any[]>} */ const lists = {};
    for (const list of REFERENCE_LISTS_PUBLIC) lists[list] = [];
    for (const r of rows) (lists[r.list] ??= []).push(r);
    return { lists };
  });
  router.get(
    "/api/v1/customers/reference/:list",
    async (/** @type {any} */ ctx) => {
      await requireCapability(ctx, "outlet.read");
      const list = ctx.params.list.replaceAll("-", "_");
      if (!REFERENCE_LISTS_PUBLIC.includes(list))
        throw new ApiError("not_found", 404, "Unknown list.");
      const q = ctx.url.searchParams;
      const salesOrgCode = q.get("salesOrgCode"),
        channelCode = q.get("distributionChannelCode"),
        group1Code = q.get("customerGroup1Code");
      if (
        [
          "sales_office",
          "distribution_channel",
          "delivering_plant",
          "customer_group_1",
          "customer_group_2",
        ].includes(list) &&
        !salesOrgCode
      )
        throw new ApiError(
          "invalid_request",
          400,
          "Choose Sales Organization first.",
        );
      if (
        ["customer_group_1", "customer_group_2"].includes(list) &&
        !channelCode
      )
        throw new ApiError(
          "invalid_request",
          400,
          "Choose Distribution Channel first.",
        );
      if (list === "customer_group_2" && !group1Code)
        throw new ApiError(
          "invalid_request",
          400,
          "Choose Customer Grp 1 first.",
        );
      const rows = (await referenceRows(ctx.db)).filter(
        (/** @type {any} */ r) =>
          r.list === list &&
          (!r.salesOrgCode || r.salesOrgCode === salesOrgCode) &&
          (!r.channelCode || r.channelCode === channelCode) &&
          (!r.group1Code || r.group1Code === group1Code),
      );
      return { list, options: rows };
    },
  );
  router.post("/api/v1/customers/validate", async (/** @type {any} */ ctx) => {
    await requireCapability(ctx, "outlet.read");
    if (!isPlainObject(ctx.body) || !isPlainObject(ctx.body.customer))
      rule("Send { customer, level }.");
    const level = ctx.body.level === "draft" ? "draft" : "complete";
    const customer = { ...ctx.body.customer };
    // Same server-derived values as a save: Country default, address one-liner, ship-to copy.
    const geography = await derive(ctx.db, customer, ctx.body.customer, null);
    const result = validateCustomer(customer, {
      level,
      lists: await referenceRows(ctx.db),
      geography,
    });
    return { ok: result.ok, level, errors: result.errors };
  });
  router.get("/api/v1/customers/:id", async (/** @type {any} */ ctx) => {
    await access(ctx, "outlets", uuid(ctx.params.id), "outlet.read");
    return readCustomer(ctx.db, ctx.params.id);
  });
  command("post", "/api/v1/customers", "customers/create", async (c, b) => {
    await requireCapability(
      c,
      "outlet.manage",
      uuid(b.custodianOrgUnitId ?? c.actor.orgUnitId, "Area"),
    );
    return saveCustomer(c, b);
  });
  command("put", "/api/v1/customers/:id", "customers/update", async (c, b) => {
    const id = uuid(c.params.id);
    await access(c, "outlets", id, "outlet.manage");
    return saveCustomer(c, b, { outletId: id });
  });
  command(
    "post",
    "/api/v1/customers/:id/approve",
    "customers/approve",
    async (c, b) => approveCustomer(c, uuid(c.params.id), b),
  );
  command(
    "post",
    "/api/v1/customers/:id/deactivate",
    "customers/deactivate",
    async (c, b) => {
      const id = uuid(c.params.id);
      await access(c, "outlets", id, "outlet.manage");
      return deactivateCustomer(c, id, b);
    },
  );

  // PSGC geography (dependent dropdowns). Country is the reference list "country" (PH only).
  /** @param {string} path @param {(ctx:any, q:URLSearchParams)=>Promise<any[]>} fn */
  const geo = (path, fn) =>
    router.get(`/api/v1/geography/${path}`, async (/** @type {any} */ ctx) => {
      await requireCapability(ctx, "outlet.read");
      const rows = await fn(ctx, ctx.url.searchParams);
      return {
        options: rows.map((r) => ({
          ...r,
          label: r.code === r.name ? r.name : optionLabel(r),
        })),
      };
    });
  /** @param {URLSearchParams} q @param {string} name */
  const need = (q, name) => {
    const v = q.get(name);
    if (!v || !/^[0-9]{10}$/.test(v))
      throw new ApiError("invalid_request", 400, `Send ${name}.`);
    return v;
  };
  geo("countries", async () => [{ code: "PH", name: "Philippines" }]);
  geo(
    "regions",
    async (ctx) => ctx.db`select code,name from ph_regions order by code`,
  );
  geo(
    "provinces",
    async (ctx, q) =>
      ctx.db`select code,name,region_code as "regionCode",kind from ph_provinces where region_code=${need(q, "regionCode")} order by name`,
  );
  geo(
    "municipalities",
    async (ctx, q) =>
      ctx.db`select code,name,province_code as "provinceCode",region_code as "regionCode",kind,city_class as "cityClass" from ph_municipalities where province_code=${need(q, "provinceCode")} order by name`,
  );
  geo(
    "barangays",
    async (ctx, q) =>
      ctx.db`select code,name,municipality_code as "municipalityCode" from ph_barangays where municipality_code=${need(q, "municipalityCode")} order by name`,
  );
  geo("postal-codes", async (ctx, q) =>
    (
      await ctx.db`select postal_code,area,source from ph_postal_codes where municipality_code=${need(q, "municipalityCode")} order by postal_code`
    ).map((/** @type {any} */ r) => ({
      code: r.postal_code,
      name: r.area ? `${r.postal_code} ${r.area}` : r.postal_code,
      source: r.source,
    })),
  );
  // SP-0170 offline pack for the field app (docs/runbooks/CUSTOMER_MASTER.md "Field app
  // offline"): every region, province, municipality and postal code nationally (~1.7k rows,
  // one request) plus barangays one province at a time (the phone keeps its area's provinces).
  router.get("/api/v1/geography/pack", async (/** @type {any} */ ctx) => {
    await requireCapability(ctx, "outlet.read");
    const [release] =
      await ctx.db`select release from ph_geography_releases order by created_at desc limit 1`;
    return {
      release: release?.release ?? null,
      regions: await ctx.db`select code,name from ph_regions order by code`,
      provinces:
        await ctx.db`select code,name,region_code as "regionCode" from ph_provinces order by name`,
      municipalities:
        await ctx.db`select code,name,province_code as "provinceCode" from ph_municipalities order by name`,
      postalCodes:
        await ctx.db`select municipality_code as "municipalityCode",postal_code as code from ph_postal_codes order by municipality_code,postal_code`,
    };
  });
  router.get(
    "/api/v1/geography/pack/barangays",
    async (/** @type {any} */ ctx) => {
      await requireCapability(ctx, "outlet.read");
      const provinceCode = need(ctx.url.searchParams, "provinceCode");
      return {
        provinceCode,
        barangays:
          await ctx.db`select b.code,b.name,b.municipality_code as "municipalityCode" from ph_barangays b join ph_municipalities m on m.code=b.municipality_code where m.province_code=${provinceCode} order by b.municipality_code,b.name`,
      };
    },
  );
  geo("release", async (ctx) =>
    (
      await ctx.db`select release,counts,created_at from ph_geography_releases order by created_at desc limit 1`
    ).map((/** @type {any} */ r) => ({
      code: r.release,
      name: r.release,
      counts: r.counts,
    })),
  );
}
