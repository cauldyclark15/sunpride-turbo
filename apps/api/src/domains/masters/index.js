import { tx } from "@sunpride/db/client";
import { catalogueImage, catalogueSetup, saveCatalogue } from "./catalogue.js";
import { uploadCatalogueImage } from "./catalogue-images.js";
import {
  taxonomyMigrationPreview,
  migrateLegacyTaxonomy,
  assignLegacyTaxonomy,
} from "./taxonomy.js";
import { OpRejected } from "../../core/sync.js";
import { currentActor } from "../van/access.js"; // Reuse the existing persisted-person transaction guard.
import {
  captureCensus,
  createBatch,
  reviewCensus,
  censusConfig,
  censusQueue,
  censusPhoto,
} from "./census.js";
import {
  requireCapability,
  requireNationalScope,
  roleHas,
} from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { canonicalJson, isPlainObject } from "../../core/util.js";
import { access } from "../org/readers.js";
import { scopeFilterForActor } from "../org/scope.js";
import { required, uuid, integer, rule } from "../org/model.js";
import {
  KINDS,
  definitionsAt,
  masterDto,
  saveDefinition,
  gate,
  potentialClass,
} from "./definitions.js";
import {
  classify,
  setTaxonomy,
  duplicateCandidates,
  mergeOutlets,
  canonicalOutletId,
} from "./outlets.js";

/** F-017 AVAILABILITY seam: governed profiles only. The assignment engine remains
 * owned by AVAILABILITY. Identities and immutable version IDs are both supplied.
 * @param {any} ctx @param {number} [at] */
export async function readMslFramework(ctx, at = ctx.now) {
  return (await definitionsAt(ctx, "msl", at))
    .filter((/** @type {any} */ r) => r.status === "active")
    .map(masterDto);
}
/** @param {any} router @param {any} platform */
export function install(router, platform) {
  platform.registerOp("census.capture", async (/** @type {any} */ ctx) => {
    try {
      return await captureCensus({ ...ctx, env: platform.env }, ctx.payload);
    } catch (e) {
      if (e instanceof ApiError)
        throw new OpRejected(
          e.status === 403 ? "out_of_scope" : "invalid_request",
        );
      throw e;
    }
  });
  router.get("/api/v1/masters/catalogue-images/:id", catalogueImage);
  router.get("/api/v1/masters/catalogue", catalogueSetup);
  router.get("/api/v1/masters/taxonomy-migration", taxonomyMigrationPreview);
  router.get("/api/v1/masters/census-config", censusConfig);
  router.get("/api/v1/masters/census-queue", censusQueue);
  router.get("/api/v1/masters/census/:id/photo", censusPhoto);
  platform.registerTopic("masters", (/** @type {any} */ actor) =>
    roleHas(actor.role, "outlet.read"),
  );
  /** Authorization is rechecked before receipt lookup; a prior success is not a grant.
   * @param {string} name @param {string} capability @param {(c:any,p:any)=>Promise<any>} handler */
  function command(name, capability, handler) {
    router.post(`/api/v1/masters/${name}`, async (/** @type {any} */ ctx) => {
      if (!isPlainObject(ctx.body)) rule("Enter a valid command.");
      const result = await tx(ctx.db, async (db) => {
        const c = { ...ctx, db, actor: await currentActor(db, ctx.actor) };
        const actor = await requireCapability(c, capability);
        if (
          name.startsWith("catalogue/") ||
          name.startsWith("taxonomy-migration/")
        )
          await requireNationalScope(c, ["admin", "operations"]);
        await db`select pg_advisory_xact_lock(4310420)`;
        // Gate every referenced target before a previous response can be returned.
        if (ctx.body.outletId)
          await access(c, "outlets", ctx.body.outletId, capability);
        if (ctx.body.sourceOutletId)
          await access(c, "outlets", ctx.body.sourceOutletId, capability);
        if (ctx.body.survivorOutletId)
          await access(c, "outlets", ctx.body.survivorOutletId, capability);
        if (name === "definitions/save") {
          const [definition] =
            await db`select * from master_definitions where kind=${String(ctx.body.kind)} and code=${String(ctx.body.code).toUpperCase()}`;
          if (definition) await gate(c, definition, true);
          else
            await requireCapability(c, capability, ctx.body.orgUnitId ?? null);
        }
        const key = required(
          ctx.req.headers.get("idempotency-key"),
          "Request key",
          128,
        );
        const digest = new Bun.CryptoHasher("sha256")
          .update(canonicalJson(ctx.body))
          .digest("hex");
        const [prior] =
          await db`select * from master_command_receipts where actor_profile_id=${actor.profileId} and command=${name} and request_key=${key}`;
        if (prior) {
          if (prior.payload_hash !== digest)
            throw new ApiError(
              "idempotency_conflict",
              409,
              "This request key was used for different details.",
            );
          return prior.result;
        }
        const value = await handler(c, ctx.body);
        await db`insert into master_command_receipts(actor_profile_id,command,request_key,payload_hash,result) values(${actor.profileId},${name},${key},${digest},${value})`;
        await platform.recordChange(db, {
          entity: "org.reference",
          entityId: value.id ?? value.outletId ?? actor.profileId,
          scopeKey: "global",
          op: "upsert",
        });
        return value;
      });
      await ctx.publish("masters");
      await ctx.publish("org");
      return result;
    });
  }
  command(
    "taxonomy-migration/apply",
    "masterdata.manage",
    migrateLegacyTaxonomy,
  );
  command(
    "taxonomy-migration/assign",
    "masterdata.manage",
    assignLegacyTaxonomy,
  );
  command("catalogue/image", "masterdata.manage", uploadCatalogueImage);
  command("catalogue/save", "masterdata.manage", saveCatalogue);
  command("definitions/save", "masterdata.manage", saveDefinition);
  command("outlets/classify", "outlet.verify", classify);
  command("outlets/taxonomy", "outlet.manage", setTaxonomy);
  command("outlets/merge", "outlet.verify", mergeOutlets);
  command("census/batches", "outlet.manage", createBatch);
  command("census/review", "outlet.verify", reviewCensus);
  router.get("/api/v1/masters/definitions", async (/** @type {any} */ ctx) => ({
    rows: (
      await definitionsAt(
        ctx,
        ctx.url.searchParams.get("kind"),
        ctx.url.searchParams.has("at")
          ? integer(Number(ctx.url.searchParams.get("at")), 0)
          : ctx.now,
      )
    ).map(masterDto),
  }));
  router.get(
    "/api/v1/masters/msl-framework",
    async (/** @type {any} */ ctx) => ({ rows: await readMslFramework(ctx) }),
  );
  router.get("/api/v1/masters/history/:id", async (/** @type {any} */ ctx) => {
    uuid(ctx.params.id);
    const [definition] =
      await ctx.db`select * from master_definitions where id=${ctx.params.id}`;
    if (!definition) throw new ApiError("not_found", 404, "Master not found.");
    await gate(ctx, definition);
    const rows =
      await ctx.db`select v.*,p.name actor_name from master_versions v left join profiles p on p.id=v.actor_profile_id where master_id=${definition.id} order by version desc limit 101`;
    return {
      rows: rows.slice(0, 100).map((/** @type {any} */ v) => ({
        ...masterDto({
          ...definition,
          ...v,
          id: definition.id,
          version_id: v.id,
        }),
        reason: v.reason,
        actorName: v.actor_name ?? "Sample setup",
      })),
      truncated: rows.length > 100,
    };
  });
  router.post(
    "/api/v1/masters/class-preview",
    async (/** @type {any} */ ctx) => {
      await requireCapability(ctx, "outlet.verify");
      const policies = (await definitionsAt(ctx, "class_policy")).filter(
        (/** @type {any} */ p) => p.status === "active",
      );
      if (policies.length !== 1)
        rule("Set up one effective potential policy first.");
      return {
        ...potentialClass(ctx.body?.inputs, policies[0].data),
        policyVersionId: policies[0].version_id,
      };
    },
  );
  router.get(
    "/api/v1/masters/outlets/:id/duplicates",
    (/** @type {any} */ ctx) => duplicateCandidates(ctx, ctx.params.id),
  );
  router.get(
    "/api/v1/masters/outlets/:id/history",
    async (/** @type {any} */ ctx) => {
      await access(ctx, "outlets", uuid(ctx.params.id), "outlet.read");
      const survivorId = await canonicalOutletId(ctx.db, ctx.params.id);
      await access(ctx, "outlets", survivorId, "outlet.read");
      const decisions =
        await ctx.db`select c.*,p.name actor_name from outlet_class_decisions c join profiles p on p.id=c.actor_profile_id where c.outlet_id=${ctx.params.id} order by c.effective_from desc limit 101`;
      return {
        survivorId,
        decisions: decisions.slice(0, 100).map((/** @type {any} */ d) => ({
          id: d.id,
          derivedClass: d.derived_class,
          assignedClass: d.assigned_class,
          potentialCentavos: Number(d.potential_centavos),
          inputs: d.inputs,
          reason: d.reason,
          actorName: d.actor_name,
          effectiveFrom: new Date(d.effective_from).getTime(),
        })),
        truncated: decisions.length > 100,
      };
    },
  );
  router.get("/api/v1/masters/setup", async (/** @type {any} */ ctx) => {
    await requireCapability(ctx, "masterdata.manage");
    /** @type {Record<string,any[]>} */ const sections = {};
    for (const kind of KINDS)
      sections[kind] = (await definitionsAt(ctx, kind)).map(masterDto);
    return { sections };
  });
  router.get("/api/v1/masters/options", async (/** @type {any} */ ctx) => {
    const actor = await requireCapability(ctx, "masterdata.manage");
    const { unitIds } = await scopeFilterForActor(ctx.db, actor);
    const units =
      await ctx.db`select id,name from org_units where status='active' and deleted_at is null and (${unitIds === null} or id::text=any(${ctx.db.array(unitIds ?? [], "TEXT")})) order by name limit 501`;
    const products =
      await ctx.db`select id,name,code from products where active and deleted_at is null order by name limit 1001`;
    const people =
      await ctx.db`select id,name from profiles where role='sales' and status='active' and deleted_at is null and (${unitIds === null} or org_unit_id::text=any(${ctx.db.array(unitIds ?? [], "TEXT")})) order by name limit 501`;
    const vans =
      await ctx.db`select id,name from vehicles where status='active' and deleted_at is null and (${unitIds === null} or org_unit_id::text=any(${ctx.db.array(unitIds ?? [], "TEXT")})) order by name limit 501`;
    const outlets =
      await ctx.db`select id,name,code from outlets where status='active' and deleted_at is null order by name limit 2001`;
    const routes =
      await ctx.db`select id,name,code from routes where status='active' and deleted_at is null order by name limit 1001`;
    const customers =
      await ctx.db`select id,name,code from customers where active and deleted_at is null order by name limit 2001`;
    if (
      units.length > 500 ||
      products.length > 1000 ||
      people.length > 500 ||
      vans.length > 500 ||
      outlets.length > 2000 ||
      routes.length > 1000 ||
      customers.length > 2000
    )
      rule(
        "Setup pickers exceed their supported bounds. Narrow your scope.",
        "overflow",
      );
    const visibleOutlets = [],
      visibleRoutes = [];
    for (const o of outlets) {
      try {
        await access(ctx, "outlets", o.id, "outlet.read");
        visibleOutlets.push(o);
      } catch (e) {
        if (![403, 404].includes(/** @type {any} */ (e).status)) throw e;
      }
    }
    for (const r of routes) {
      try {
        await access(ctx, "routes", r.id, "route.read");
        visibleRoutes.push(r);
      } catch (e) {
        if (![403, 404].includes(/** @type {any} */ (e).status)) throw e;
      }
    }
    const links = visibleOutlets.length
      ? await ctx.db`select distinct customer_id from outlet_customer_links where outlet_id::text=any(${ctx.db.array(
          visibleOutlets.map((o) => o.id),
          "TEXT",
        )}) and deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now())`
      : [];
    return {
      units,
      products,
      people,
      vans,
      outlets: visibleOutlets,
      routes: visibleRoutes,
      customers: customers.filter((/** @type {any} */ c) =>
        links.some((/** @type {any} */ l) => l.customer_id === c.id),
      ),
    };
  });
}
