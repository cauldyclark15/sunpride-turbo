import { tx } from "@sunpride/db/client";
import {
  requireCapability,
  requireNationalScope,
} from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { currentActor } from "../van/access.js";
import { cell, error, dateOnly, chunkHashOf } from "./format.js";
import { required, uuid, rule } from "../org/model.js";

export { MIGRATION_KINDS, MIGRATION_HEADERS } from "./migration-headers.js";
/** F-022 staged legacy/SAP identities are never inferred from row position.
 * @param {any} ctx @param {string} kind @param {import('./format.js').Row[]} rows */
export async function validateMigration(ctx, kind, rows) {
  /** @type {import('./format.js').RowError[]} */ const errors = [];
  /** @type {any[]} */ const resolved = [];
  const seenLegacy = new Set(),
    seenSap = new Set(),
    seenCodes = new Set();
  for (const row of rows) {
    const start = errors.length;
    const fail = (
      /** @type {string} */ column,
      /** @type {string} */ message,
      code = "invalid_format",
    ) => errors.push(error(row.rowNumber, code, message, column));
    const legacyId = cell(row, "legacy_id"),
      sapId = cell(row, "sap_id"),
      code = cell(row, "code"),
      name = cell(row, "name");
    if (!legacyId || legacyId.length > 120)
      fail(
        "legacy_id",
        "Keep the legacy identity as text, including leading zeroes.",
      );
    if (!sapId || sapId.length > 120)
      fail("sap_id", "An explicit SAP identity is required.");
    if (seenLegacy.has(legacyId) || seenSap.has(sapId))
      fail(
        "legacy_id",
        "Duplicate legacy or SAP identity in this file.",
        "duplicate_in_file",
      );
    seenLegacy.add(legacyId);
    seenSap.add(sapId);
    /** @type {any} */ const item = {
      rowNumber: row.rowNumber,
      raw: row.values,
      legacyId,
      sapId,
      code,
      name,
      candidates: [],
    };
    if (kind !== "open_ar") {
      if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code))
        fail(
          "code",
          "Use a stable code, up to 40 letters, numbers, hyphens or underscores.",
        );
      if (!name || name.length > 200)
        fail("name", "Enter a name up to 200 characters.");
      if (seenCodes.has(code))
        fail("code", "Duplicate master code in the file.", "duplicate_in_file");
      seenCodes.add(code);
      const [unit] =
        await ctx.db`select id,name from org_units where code=${cell(row, "org_unit_code")} and status='active' and deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now())`;
      if (!unit)
        fail(
          "org_unit_code",
          "Map to an existing active organizational unit.",
          "unknown_reference",
        );
      else item.unit = unit;
    }
    if (["customers", "outlet_universe"].includes(kind)) {
      const key = cell(row, "channel_code");
      const channels =
        await ctx.db`select d.id,d.code,v.label from master_definitions d join master_versions v on v.master_id=d.id where d.kind='channel' and v.status='active' and v.effective_from<=now() and (v.effective_to is null or v.effective_to>now()) and (d.code=${key.toUpperCase()} or d.id in(select channel_id from master_channel_aliases where legacy_key=${key.toLowerCase()}))`;
      if (channels.length !== 1)
        fail(
          "channel_code",
          "Choose a single governed channel or mapped legacy key.",
          "unknown_reference",
        );
      else item.channel = channels[0];
    }
    if (["outlet_universe", "open_ar"].includes(kind)) {
      const [customer] =
        await ctx.db`select id,code,name from customers where code=${cell(row, "customer_code")} and active and deleted_at is null`;
      if (!customer)
        fail(
          "customer_code",
          "Import or map the accounting customer first.",
          "unknown_reference",
        );
      else item.customer = customer;
    }
    if (kind === "outlet_universe") {
      item.address = cell(row, "address");
      item.ownerName = cell(row, "owner_name");
      item.ownerPhone = cell(row, "owner_phone");
      if (
        !item.address ||
        !item.ownerName ||
        item.ownerPhone.replace(/\D/g, "").length < 7
      )
        fail("address", "Complete the physical address and owner contact.");
      const [sub] =
        await ctx.db`select d.id,v.data from master_definitions d join master_versions v on v.master_id=d.id where d.kind='subchannel' and d.code=${cell(row, "subchannel_code").toUpperCase()} and v.status='active' and v.effective_from<=now() and (v.effective_to is null or v.effective_to>now())`;
      if (!sub || sub.data.channelId !== item.channel?.id)
        fail(
          "subchannel_code",
          "Sub-channel must belong to the selected channel.",
          "unknown_reference",
        );
      else item.subchannelId = sub.id;
      item.latitude = Number(cell(row, "latitude"));
      item.longitude = Number(cell(row, "longitude"));
      item.accuracy = Number(cell(row, "accuracy_meters"));
      if (
        !cell(row, "latitude") ||
        !cell(row, "longitude") ||
        !Number.isFinite(item.latitude) ||
        Math.abs(item.latitude) > 90 ||
        !Number.isFinite(item.longitude) ||
        Math.abs(item.longitude) > 180 ||
        !Number.isFinite(item.accuracy) ||
        item.accuracy <= 0 ||
        item.accuracy >= 50
      )
        fail(
          "accuracy_meters",
          "Geocoding needs valid coordinates and measured accuracy under 50 m.",
        );
    }
    if (kind === "route_master") {
      const [territory] =
        await ctx.db`select t.id,t.name from territories t join territory_ownerships o on o.territory_id=t.id where t.code=${cell(row, "territory_code")} and t.status='active' and t.deleted_at is null and o.org_unit_id=${item.unit?.id ?? null} and o.deleted_at is null and o.effective_from<=now() and (o.effective_to is null or o.effective_to>now())`;
      if (!territory)
        fail(
          "territory_code",
          "Map a territory owned by this unit.",
          "unknown_reference",
        );
      else item.territoryId = territory.id;
      const weekdays = cell(row, "weekdays").split(";");
      item.weekdays = weekdays.map(Number);
      item.cycleDays = Number(cell(row, "cycle_days"));
      if (
        weekdays.some((d) => !/^\d$/.test(d) || Number(d) > 6) ||
        new Set(weekdays).size !== weekdays.length
      )
        fail(
          "weekdays",
          "Use distinct weekday numbers 0–6 separated by semicolons.",
        );
      if (
        !Number.isInteger(item.cycleDays) ||
        item.cycleDays < 1 ||
        item.cycleDays > 84
      )
        fail("cycle_days", "Use a cycle of 1–84 days.");
    }
    if (kind === "open_ar") {
      for (const key of ["document_date", "due_date", "as_of"])
        if (!dateOnly(cell(row, key)))
          fail(key, "Use an unambiguous YYYY-MM-DD date.");
      item.document = cell(row, "document_number");
      item.currency = cell(row, "currency");
      if (!item.document || item.currency !== "PHP")
        fail("currency", "Document number and PHP currency are required.");
      const original = cell(row, "original_centavos"),
        open = cell(row, "open_centavos");
      item.original = Number(original);
      item.open = Number(open);
      if (
        !/^\d+$/.test(original) ||
        !/^\d+$/.test(open) ||
        !Number.isSafeInteger(item.original) ||
        !Number.isSafeInteger(item.open) ||
        item.open > item.original
      )
        fail(
          "open_centavos",
          "Use exact non-negative integer centavos; open cannot exceed original.",
        );
      const candidates =
        await ctx.db`select id,document_number name from sap_open_ar_projection where sap_id=${sapId}`;
      item.candidates = candidates;
    } else {
      // The table is selected from a closed server-owned kind allowlist.
      const table =
        kind === "customers"
          ? "customers"
          : kind === "outlet_universe"
            ? "outlets"
            : "routes";
      item.candidates = await ctx.db.unsafe(
        `select id,name from ${table} where code=$1 or lower(name)=lower($2) order by code limit 101`,
        [code, name],
      );
      if (item.candidates.length > 100)
        fail(
          "name",
          "More than 100 duplicate candidates; cleanse this name first.",
          "overflow",
        );
    }
    const [mapped] =
      await ctx.db`select target_id from migration_source_maps where kind=${kind} and sap_id=${sapId}`;
    if (
      mapped &&
      !item.candidates.some((/** @type {any} */ c) => c.id === mapped.target_id)
    )
      item.candidates.push({
        id: mapped.target_id,
        name: "Already mapped SAP identity",
      });
    if (errors.length === start) resolved.push(item);
  }
  return { errors, resolved };
}
/** @param {any} db @param {string} kind @param {any[]} rows @param {string} runId @param {string} source */
export async function stageMigration(db, kind, rows, runId, source) {
  required(source, "Source reference", 200);
  for (const r of rows)
    await db`insert into migration_staging_rows(import_run_id,kind,source_reference,legacy_id,sap_id,row_number,payload,payload_hash) values(${runId},${kind},${source},${r.legacyId},${r.sapId},${r.rowNumber},${r.raw},${chunkHashOf(r.raw)})`;
}
/** @param {any} ctx @param {any} row */
async function authorize(ctx, row) {
  await requireCapability(ctx, "masterdata.manage");
  await requireNationalScope(ctx, ["admin", "operations"]);
  return row;
}
/** @param {any} router @param {any} platform */
export function installMigrationReview(router, platform) {
  router.get(
    "/api/v1/imports/migration/queue",
    async (/** @type {any} */ ctx) => {
      await authorize(ctx, null);
      const staged =
        await ctx.db`select s.*,r.import_type from migration_staging_rows s join import_runs r on r.id=s.import_run_id where s.status='staged' order by s.created_at,s.row_number limit 101`;
      const rows = [];
      for (const r of staged.slice(0, 100)) {
        const checked = await validateMigration(ctx, r.kind, [
          { rowNumber: r.row_number, values: r.payload },
        ]);
        rows.push({
          id: r.id,
          kind: r.kind,
          sourceReference: r.source_reference,
          legacyId: r.legacy_id,
          sapId: r.sap_id,
          rowNumber: r.row_number,
          name: r.payload.name ?? r.payload.document_number,
          payloadHash: r.payload_hash,
          candidates: checked.resolved[0]?.candidates ?? [],
          errors: checked.errors,
        });
      }
      const totals =
        await ctx.db`select kind,status,count(*)::int rows,coalesce(sum(case when kind='open_ar' then (payload->>'open_centavos')::bigint else 0 end),0)::text open_centavos from migration_staging_rows group by kind,status order by kind,status`;
      return { rows, totals, truncated: staged.length > 100 };
    },
  );
  router.post(
    "/api/v1/imports/migration/review",
    async (/** @type {any} */ ctx) => {
      const result = await tx(ctx.db, async (db) => {
        const c = { ...ctx, db, actor: await currentActor(db, ctx.actor) };
        await authorize(c, null);
        await db`select pg_advisory_xact_lock(4310420)`;
        const p = ctx.body;
        const [row] =
          await db`select * from migration_staging_rows where id=${uuid(p.stagingId)}`;
        if (!row) throw new ApiError("not_found", 404, "Staged row not found.");
        const actor = ctx.actor,
          reason = required(p.reason, "Review reason", 500);
        if (
          !["create", "map", "reject"].includes(p.action) ||
          p.payloadHash !== row.payload_hash
        )
          rule("Reload the unchanged staged row and choose a review action.");
        const [prior] =
          await db`select * from migration_review_events where staging_row_id=${row.id}`;
        if (prior) {
          if (
            prior.action !== p.action ||
            (p.targetId ?? null) !==
              (p.action === "map" ? prior.target_id : null) ||
            prior.reason !== reason
          )
            throw new ApiError(
              "idempotency_conflict",
              409,
              "This staged row already has a different decision.",
            );
          return {
            id: row.id,
            status: row.status,
            targetId: row.target_id,
            duplicate: true,
          };
        }
        /** @type {string|null} */ let targetId = null;
        if (p.action !== "reject") {
          const checked = await validateMigration(c, row.kind, [
            { rowNumber: row.row_number, values: row.payload },
          ]);
          if (checked.errors.length)
            throw new ApiError(
              "mapping_invalid",
              422,
              "Fix the source mapping before applying this staged row.",
              false,
            );
          const r = checked.resolved[0];
          const [already] =
            await db`select target_id from migration_source_maps where kind=${row.kind} and (sap_id=${row.sap_id} or source_reference=${row.source_reference} and legacy_id=${row.legacy_id})`;
          if (already)
            rule(
              "This legacy or SAP identity already has a mapping. Do not create another master.",
            );
          if (p.action === "map") {
            targetId = uuid(p.targetId);
            if (
              !r.candidates.some(
                (/** @type {any} */ candidate) => candidate.id === targetId,
              )
            )
              rule("Choose one of the reviewed duplicate candidates.");
          } else {
            if (r.candidates.length && !p.confirmDistinct)
              rule(
                "Review duplicate candidates, then explicitly confirm this is a different master.",
              );
            if (row.kind !== "open_ar") {
              const table =
                row.kind === "customers"
                  ? "customers"
                  : row.kind === "outlet_universe"
                    ? "outlets"
                    : "routes";
              const existing = await db.unsafe(
                `select id from ${table} where code=$1`,
                [r.code],
              );
              if (existing.length)
                rule(
                  "This code already exists. Map the source to the existing master instead of creating it again.",
                );
            }
            const at = new Date(ctx.now);
            if (row.kind === "customers") {
              const [customer] =
                await db`insert into customers(code,name,channel,territory,credit_limit,active,external_id) values(${r.code},${r.name},${r.channel.code},${r.unit.name},0,true,${r.sapId}) returning id`;
              targetId = customer.id;
              await db`update customers set channel_id=${r.channel.id} where id=${targetId}`;
            } else if (row.kind === "outlet_universe") {
              const [outlet] =
                await db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,address,created_by) values('sunpride',${r.code},${r.name},'active',${r.unit.id},${r.address},${actor.userId}) returning id`;
              targetId = outlet.id;
              await db`update outlets set channel_id=${r.channel.id},subchannel_id=${r.subchannelId} where id=${targetId}`;
              await db`insert into outlet_contacts(outlet_id,ordinal,name,phone) values(${targetId},0,${r.ownerName},${r.ownerPhone})`;
              await db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) values(${targetId},${r.customer.id},'sap_cutover',${at},${actor.userId},${reason})`;
              // Imported geo remains pending: source accuracy is not independent verification.
              await db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,source,evidence_note,status,effective_from,proposed_by,proposed_at) values(${targetId},${r.latitude},${r.longitude},50,'migration',${`Source accuracy ${r.accuracy} m; ${row.source_reference}`},'pending',${at},${actor.userId},${at})`;
            } else if (row.kind === "route_master") {
              const [route] =
                await db`insert into routes(organization_id,code,name,status,effective_from,weekday_template,cycle_days,created_by) values('sunpride',${r.code},${r.name},'active',${at},${db.array(r.weekdays, "INT4")},${r.cycleDays},${actor.userId}) returning id`;
              targetId = route.id;
              await db`insert into route_territories(route_id,territory_id,effective_from,actor_subject,reason) values(${targetId},${r.territoryId},${at},${actor.userId},${reason})`;
            } else {
              const v = r.raw;
              const [ar] =
                await db`insert into sap_open_ar_projection(customer_id,sap_id,document_number,document_date,due_date,currency,original_centavos,open_centavos,source_reference,as_of) values(${r.customer.id},${r.sapId},${r.document},${v.document_date},${v.due_date},'PHP',${r.original},${r.open},${row.source_reference},${v.as_of}) returning id`;
              targetId = ar.id;
            }
          }
          await db`insert into migration_source_maps(kind,source_reference,legacy_id,sap_id,target_id,staging_row_id) values(${row.kind},${row.source_reference},${row.legacy_id},${row.sap_id},${targetId},${row.id})`;
        }
        const status =
          p.action === "create"
            ? "applied"
            : p.action === "map"
              ? "mapped"
              : "rejected";
        await db`update migration_staging_rows set status=${status},target_id=${targetId} where id=${row.id}`;
        await db`insert into migration_review_events(staging_row_id,action,actor_profile_id,target_id,reason) values(${row.id},${p.action},${actor.profileId},${targetId},${reason})`;
        await db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${actor.userId},'F-022.migration.review','migration',${row.id},${JSON.stringify({ action: p.action, targetId, reason, sourceReference: row.source_reference })})`;
        await platform.recordChange(db, {
          entity: "org.reference",
          entityId: targetId ?? row.id,
          scopeKey: "global",
          op: "upsert",
        });
        return { id: row.id, status, targetId, duplicate: false };
      });
      await ctx.publish("imports");
      await ctx.publish("masters");
      return result;
    },
  );
}
