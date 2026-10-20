import { tx } from "@sunpride/db/client";
import { ApiError } from "../../core/errors.js";
import {
  requireCapability,
  requireNationalScope,
  roleHas,
} from "../../core/capabilities.js";
import { hooks } from "../../core/hooks.js";
import { postMovement } from "../inventory/posting.js";
import { HEADERS, ORGANIZATION, checkInput, chunkHashOf } from "./format.js";
import { validateProducts, writeProducts } from "./products.js";
import { validateStock, locationAccess } from "./stock.js";
import { planAccess, validateMcp, writeMcp } from "./mcp.js";
import {
  MIGRATION_KINDS,
  validateMigration,
  stageMigration,
  installMigrationReview,
} from "./migration.js";

const CAPS = {
  customers: "masterdata.manage",
  outlet_universe: "masterdata.manage",
  route_master: "masterdata.manage",
  open_ar: "masterdata.manage",
  products: "masterdata.manage",
  opening_stock: "inventory.write",
  stock_adjustment: "inventory.adjustment.request",
  cycle_count: "inventory.count.submit",
  mcp: "mcp.plan",
};
/** @param {any} ctx @param {string} kind */
async function authorize(ctx, kind) {
  const cap = CAPS[/** @type {keyof typeof CAPS} */ (kind)];
  if (!cap) throw new ApiError("invalid_format", 400, "Choose an import task.");
  const actor = await requireCapability(ctx, cap);
  if (["products", "opening_stock", ...MIGRATION_KINDS].includes(kind))
    await requireNationalScope(ctx, ["admin", "operations"]);
  return actor;
}
/** Reauthorize stored locations before disclosing an earlier receipt. @param {any} ctx @param {any} run */
async function authorizeRun(ctx, run) {
  await authorize(ctx, run.import_type);
  if (run.import_type === "mcp") await planAccess(ctx, run.mcp_plan_id, false);
  const locations =
    await ctx.db`select l.* from import_run_locations r join inventory_locations l on l.id=r.location_id where r.import_run_id=${run.id}`;
  for (const location of locations)
    await locationAccess(
      ctx,
      location,
      CAPS[/** @type {keyof typeof CAPS} */ (run.import_type)],
    );
  if (
    ["cycle_count", "stock_adjustment"].includes(run.import_type) &&
    !locations.length &&
    run.actor_subject !== ctx.actor.userId
  )
    throw new ApiError(
      "scope_denied",
      403,
      "This import is not in your scope.",
    );
}
/** @param {any} ctx @param {string} kind @param {any} input */
async function validate(ctx, kind, input) {
  if (MIGRATION_KINDS.includes(kind))
    return validateMigration(ctx, kind, input.rows);
  if (kind === "products") return validateProducts(ctx.db, input.rows);
  if (kind === "mcp") return validateMcp(ctx, input);
  return validateStock(ctx, kind, input);
}
/** @param {any} result @param {number} rowCount @param {string} kind */
function previewResult(result, rowCount, kind) {
  return {
    rowCount,
    accepted: result.errors.length ? 0 : result.resolved.length,
    errorCount: result.errors.length,
    errors: result.errors,
    lines:
      kind === "cycle_count"
        ? result.resolved.map((/** @type {any} */ r) => ({
            rowNumber: r.rowNumber,
            countedBase: r.quantityBase,
            status: result.errors.length ? "blocked" : "valid",
          }))
        : [],
    commitAvailable: !["cycle_count", "stock_adjustment"].includes(kind),
    ...(MIGRATION_KINDS.includes(kind)
      ? {
          notice:
            "Submission stages these rows only. Review mappings and duplicates in Migration review before applying masters or the SAP open-AR projection.",
          candidates: result.resolved.map((/** @type {any} */ r) => ({
            rowNumber: r.rowNumber,
            candidates: r.candidates,
          })),
        }
      : {}),
    ...(["cycle_count", "stock_adjustment"].includes(kind)
      ? {
          notice:
            "Validation is available. Submission awaits the inventory owner's count/adjustment command seam; no stock or approval state will be changed.",
        }
      : {}),
  };
}
/** @param {any} ctx @param {string} kind @param {any} input @param {any} platform */
export async function commitImport(ctx, kind, input, platform) {
  checkInput(kind, input, true);
  const result = await tx(ctx.db, async (db) => {
    const scoped = { ...ctx, db };
    const actor = await authorize(scoped, kind);
    // Serializes import writers before lookup AND validation, preventing two fresh run keys from double-posting.
    await db`select pg_advisory_xact_lock(hashtextextended(${`imports:${ORGANIZATION}`},0))`;
    if (kind === "mcp") await planAccess(scoped, input.planId);
    const digest = chunkHashOf({
      kind,
      chunkIndex: input.chunkIndex,
      rows: input.rows,
      header: input.header,
      rowCount: input.rowCount,
      sourceReference: input.sourceReference ?? null,
      planId: input.planId ?? null,
      format: input.format ?? null,
    });
    const previous =
      await db`select * from import_runs where organization_id=${ORGANIZATION} and import_type=${kind} and (run_key=${input.runKey} or file_hash=${input.fileHash} or idempotency_key=${input.idempotencyKey}) order by created_at`;
    for (const run of previous) {
      await authorizeRun(scoped, run);
      if (
        (run.run_key === input.runKey ||
          run.idempotency_key === input.idempotencyKey) &&
        (run.file_hash !== input.fileHash ||
          run.file_row_count !== input.rowCount)
      )
        throw new ApiError(
          "idempotency_conflict",
          409,
          "This import key was already used for a different file.",
        );
      if (
        run.chunk_index === input.chunkIndex &&
        (run.run_key === input.runKey ||
          (run.file_hash === input.fileHash &&
            (run.mcp_plan_id ?? null) === (input.planId ?? null)))
      ) {
        if (run.chunk_hash !== digest)
          throw new ApiError(
            "idempotency_conflict",
            409,
            "The same import key or file hash contains different rows.",
          );
        return { ...run.result, duplicate: true };
      }
    }
    const checked = await validate(scoped, kind, input);
    const rowKeys = input.rows.map(
      (/** @type {import('./format.js').Row} */ r) =>
        kind === "products"
          ? (r.values.product_code ?? "").trim().toUpperCase()
          : String(r.rowNumber),
    );
    const earlierKeys = new Set(
      previous
        .filter(
          (/** @type {any} */ r) =>
            r.status === "completed" &&
            (r.mcp_plan_id ?? null) === (input.planId ?? null),
        )
        .flatMap((/** @type {any} */ r) => r.row_keys),
    );
    for (let i = 0; i < rowKeys.length; i++)
      if (earlierKeys.has(rowKeys[i]))
        checked.errors.push({
          rowNumber: input.rows[i].rowNumber,
          code: "duplicate_in_file",
          message: "This row or product already appeared in an earlier chunk.",
        });
    if (["cycle_count", "stock_adjustment"].includes(kind))
      throw new ApiError(
        "owner_seam_required",
        503,
        "Count and adjustment submission needs the inventory owner's command seam. Nothing has been changed.",
      );
    const runId = crypto.randomUUID();
    let movementId = null;
    /** @type {string[]} */
    let products = [];
    if (!checked.errors.length) {
      if (kind === "products")
        products = await writeProducts(db, checked.resolved);
      else if (kind === "opening_stock") {
        const movement = await postMovement(db, {
          kind: "opening_balance",
          sourceType: "cutover",
          sourceId: runId,
          idempotencyKey: input.idempotencyKey,
          occurredAt: ctx.now,
          actor: { profileId: actor.profileId, userId: actor.userId },
          organizationId: ORGANIZATION,
          lines: checked.resolved.map((/** @type {any} */ r) => ({
            productId: r.product.id,
            fromLocationId: null,
            toLocationId: r.location.id,
            quantityBase: r.quantityBase,
            uom: r.product.uom,
            lotId: r.lot?.id ?? null,
            stockStatus: "available",
          })),
          note: input.sourceReference,
        });
        movementId = movement.movementId;
      } else if (kind === "mcp" && "plan" in checked)
        await writeMcp(db, checked.plan, checked.resolved, actor.userId);
    }
    const accepted = checked.errors.length ? 0 : checked.resolved.length;
    const receipt = {
      runId,
      accepted,
      failed: checked.errors.length ? input.rows.length : 0,
      duplicate: false,
      errors: checked.errors,
      movementId,
    };
    await db`insert into import_runs(id,organization_id,import_type,mcp_plan_id,run_key,chunk_index,file_hash,chunk_hash,idempotency_key,actor_subject,status,source_reference,row_count,file_row_count,created_count,updated_count,skipped_count,failed_count,movement_id,completed_at,result)
      values(${runId},${ORGANIZATION},${kind},${input.planId ?? null},${input.runKey},${input.chunkIndex},${input.fileHash},${digest},${input.idempotencyKey},${actor.userId},${checked.errors.length ? "failed" : "completed"},${input.sourceReference ?? null},${input.rows.length},${input.rowCount},${accepted},0,0,${receipt.failed},${movementId},now(),${receipt})`;
    await db`update import_runs set row_keys=${db.array(rowKeys, "TEXT")} where id=${runId}`;
    if (MIGRATION_KINDS.includes(kind) && !checked.errors.length)
      await stageMigration(
        db,
        kind,
        checked.resolved,
        runId,
        input.sourceReference,
      );
    const locations = [
      ...new Set(
        checked.resolved
          .map((/** @type {any} */ r) => r.location?.id)
          .filter(Boolean),
      ),
    ];
    for (let i = 0; i < locations.length; i++)
      await db`insert into import_run_locations(import_run_id,ordinal,location_id) values(${runId},${i},${locations[i]})`;
    for (const e of checked.errors)
      await db`insert into import_run_errors(organization_id,run_id,row_number,column_name,code,message,raw_row) values(${ORGANIZATION},${runId},${e.rowNumber},${e.column ?? null},${e.code},${e.message},'')`;
    await db`insert into import_audit_events(run_id,actor_profile_id,actor_user_id,action,details) values(${runId},${actor.profileId},${actor.userId},${checked.errors.length ? "rejected" : "committed"},${{ kind, accepted, failed: receipt.failed }})`;
    for (const id of products)
      await platform.recordChange(db, {
        entity: "products",
        entityId: id,
        scopeKey: "national",
        op: "upsert",
      });
    if (accepted && kind === "mcp")
      await platform.recordChange(db, {
        entity: "coverage_plans",
        entityId: input.planId,
        scopeKey: actor.orgUnitId ?? "national",
        op: "upsert",
      });
    return receipt;
  });
  if (!result.duplicate) await ctx.publish("imports");
  if (!result.duplicate && result.accepted && kind === "mcp")
    await ctx.publish("coverage");
  return result;
}
/** @param {import('../../core/router.js').Router} router @param {any} platform */
export function install(router, platform) {
  installMigrationReview(router, platform);
  platform.registerTopic("imports", (/** @type {any} */ actor) =>
    Object.values(CAPS).some((cap) => roleHas(actor.role, cap)),
  );
  router.get("/api/v1/imports/options", async (ctx) => {
    if (!ctx.actor) await requireCapability(ctx, "mcp.plan");
    const kinds = [];
    for (const kind of Object.keys(CAPS)) {
      try {
        await authorize(ctx, kind);
        kinds.push(kind);
      } catch (e) {
        if (!(e instanceof ApiError) || ![401, 403].includes(e.status)) throw e;
      }
    }
    return {
      kinds,
      headers: HEADERS,
      unavailable: ["stock_adjustment", "cycle_count"],
    };
  });
  router.post("/api/v1/imports/:kind/preview", async (ctx) => {
    const kind = ctx.params.kind;
    await authorize(ctx, kind);
    checkInput(kind, ctx.body, false);
    return tx(ctx.db, async (db) =>
      previewResult(
        await validate({ ...ctx, db }, kind, ctx.body),
        ctx.body.rows.length,
        kind,
      ),
    );
  });
  router.post("/api/v1/imports/:kind/commit", (ctx) =>
    commitImport(ctx, ctx.params.kind, ctx.body, platform),
  );
  router.get("/api/v1/imports/plans", async (ctx) => {
    const actor = await requireCapability(ctx, "mcp.plan");
    const units = await hooks.scopeUnitIds(ctx.db, actor);
    const rows =
      await ctx.db`select p.id,p.local_month as month,p.version,u.name as assignee from coverage_plans p join profiles u on u.id=p.assignee_profile_id where p.organization_id=${ORGANIZATION} and p.status='draft' and p.deleted_at is null and u.status='active' and u.deleted_at is null and (${actor.role === "super_admin"} or u.org_unit_id::text=any(${ctx.db.array(units, "TEXT")}::text[])) and (${actor.role === "super_admin"} or p.org_unit_id::text=any(${ctx.db.array(units, "TEXT")}::text[])) and (${actor.role !== "sales"} or p.assignee_profile_id=${actor.profileId}) order by p.local_month desc,p.id limit 101`;
    return { rows: rows.slice(0, 100), truncated: rows.length > 100 };
  });
  router.get("/api/v1/imports/runs", async (ctx) => {
    const kind = ctx.url.searchParams.get("kind") ?? "products";
    await authorize(ctx, kind);
    const offset = Number(ctx.url.searchParams.get("cursor") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new ApiError("invalid_format", 400, "Invalid history cursor.");
    const candidates =
      await ctx.db`select * from import_runs where organization_id=${ORGANIZATION} and import_type=${kind} order by created_at desc,id desc limit 51 offset ${offset}`;
    const rows = [];
    for (const run of candidates.slice(0, 50)) {
      try {
        await authorizeRun(ctx, run);
      } catch (e) {
        if (e instanceof ApiError && [403, 404].includes(e.status)) continue;
        throw e;
      }
      rows.push({
        id: run.id,
        kind: run.import_type,
        status: run.status,
        rowCount: run.row_count,
        accepted: run.created_count,
        failed: run.failed_count,
        createdAt: new Date(run.created_at).getTime(),
        errors: run.result?.errors ?? [],
      });
    }
    return { rows, next: candidates.length > 50 ? String(offset + 50) : null };
  });
}
