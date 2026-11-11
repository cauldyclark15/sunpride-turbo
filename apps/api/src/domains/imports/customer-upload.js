// SP-0170 customer upload (machinery from SP-0169): validate → preview → background parallel
// import of Sunpride's customer master rows (their "Customer Information template" layout).
//
// - Template, header mapping and row rules live in @sunpride/import-templates/customers, which
//   runs the shared @sunpride/customer-master rules at the `complete` level. The browser runs
//   them on file pick (no geography); here they run again with PSGC geography and the database
//   (existing customers, scope) on preview AND inside every chunk transaction: the server is
//   authoritative.
// - Writes go through the customer-master writer (saveCustomer: store + profile + ship-to +
//   pending pin + 1:1 accounting customer, audit), never raw inserts. Create or update by
//   Customer Code; blank optional cells on an update keep the current values.
// - A run is split into chunks of CUSTOMER_CHUNK_SIZE rows processed by at most
//   `runtime.concurrency` workers. Each chunk is ONE transaction; each row a savepoint, so a bad
//   row fails alone and every row's outcome commits together with its chunk.
// - Interruption safety: a lease + heartbeat marks a live worker. A run whose lease expired is
//   swept to `interrupted`; resume processes only rows still `pending` (or retries `failed`).
// - Idempotency: the run identity is a server-computed hash of the file's header and rows, and
//   each chunk stores a server-owned chunk hash (chunkHashOf). Re-uploading the identical file
//   returns the existing run instead of writing again.
import { tx } from "@sunpride/db/client";
import { referenceIndex } from "@sunpride/customer-master";
import {
  CUSTOMER_CHUNK_SIZE,
  CUSTOMER_COLUMNS,
  CUSTOMER_MAX_ROWS,
  cellOf,
  columnById,
  columnOfField,
  geoLookup,
  headerError,
  listSheets,
  normaliseCode,
  sortErrors,
  validateCustomerRows,
  writerInput,
} from "@sunpride/import-templates/customers";
import { ApiError } from "../../core/errors.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { actorFor } from "../../core/context.js";
import { scopeFilterForActor } from "../org/scope.js";
import { writeAudit } from "../org/audit.js";
import {
  approveCustomer,
  readCustomer,
  referenceRows,
  saveCustomer,
} from "../masters/customers.js";
import { ORGANIZATION, chunkHashOf } from "./format.js";

export const CUSTOMER_UPLOAD_KIND = "customer_upload";
const CAP = "masterdata.manage";
const COLUMN_IDS = new Set(CUSTOMER_COLUMNS.map((c) => c.id));
/** @typedef {import('@sunpride/import-templates/customers').UploadRow} UploadRow */
/** @typedef {import('@sunpride/import-templates/customers').UploadError} UploadError */
/** @typedef {import('@sunpride/import-templates/customers').GeoData} GeoData */

/** Process-wide worker state. Tests tune the numbers and hooks. */
export const runtime = {
  /** @type {any} */ db: null,
  /** @type {any} */ platform: null,
  concurrency: 4,
  chunkSize: CUSTOMER_CHUNK_SIZE,
  leaseMs: 30_000,
  heartbeatMs: 5_000,
  autoStart: true,
  /** @type {{beforeChunk?: (runId:string, chunkIndex:number) => Promise<void>|void}} */
  hooks: {},
  /** @type {Map<string, Promise<void>>} */
  workers: new Map(),
};

/** @param {any} body */
function checkBody(body) {
  const header = body?.header;
  const bad = headerError(Array.isArray(header) ? header.map(String) : []);
  if (bad) throw new ApiError("header_mismatch", 400, bad.message);
  const rows = body.rows;
  if (!Array.isArray(rows) || !rows.length)
    throw new ApiError("empty_file", 400, "The file has no customer rows.");
  if (rows.length > CUSTOMER_MAX_ROWS)
    throw new ApiError(
      "too_many_rows",
      400,
      `Upload at most ${CUSTOMER_MAX_ROWS} customers per file. Split the file and upload each part.`,
    );
  const numbers = new Set();
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row?.rowNumber) ||
      row.rowNumber < 2 ||
      numbers.has(row.rowNumber) ||
      !row.values ||
      typeof row.values !== "object" ||
      Array.isArray(row.values) ||
      Object.entries(row.values).some(
        ([key, value]) =>
          !COLUMN_IDS.has(key) ||
          typeof value !== "string" ||
          value.length > 600,
      )
    )
      throw new ApiError(
        "invalid_format",
        400,
        "Each row needs a unique spreadsheet row number and text cells from the template.",
      );
    numbers.add(row.rowNumber);
  }
  const fileName =
    typeof body.fileName === "string" && body.fileName.trim()
      ? body.fileName.trim().slice(0, 200)
      : "upload.xlsx";
  /** @type {UploadRow[]} */
  const clean = rows.map((/** @type {any} */ r) => ({
    rowNumber: r.rowNumber,
    values: Object.fromEntries(
      Object.entries(r.values).map(([k, v]) => [k, String(v).trim()]),
    ),
  }));
  return { header: header.map(String), rows: clean, fileName };
}

/** Reference lists, the PSGC regions/provinces/municipalities and the actor's scope, loaded
 * once per validation pass or run. @param {any} db @param {any} actor */
async function loadLookups(db, actor) {
  const lists = await referenceRows(db);
  const regions = await db`select code,name from ph_regions order by code`;
  const provinces =
    await db`select code,name,region_code as "regionCode" from ph_provinces order by code`;
  const municipalities =
    await db`select code,name,province_code as "provinceCode",region_code as "regionCode" from ph_municipalities order by code`;
  const { unitIds } = await scopeFilterForActor(db, actor);
  return {
    lists,
    index: referenceIndex(lists),
    /** @type {Omit<GeoData,'barangays'|'postalCodes'>} */
    geo: { regions, provinces, municipalities },
    scope: unitIds === null ? null : new Set(unitIds),
  };
}
/** @typedef {Awaited<ReturnType<typeof loadLookups>>} Lookups */

/** Barangays and postal codes of the municipalities the rows name (42k barangays are never
 * loaded whole). @param {any} db @param {UploadRow[]} rows @param {Lookups} lookups */
async function geoFor(db, rows, lookups) {
  const light = geoLookup({
    ...lookups.geo,
    barangays: [],
    postalCodes: new Map(),
  });
  const codes = [
    ...new Set(
      rows
        .map((r) => light.resolve(r.values).municipality?.code)
        .filter(Boolean),
    ),
  ];
  const barangays = codes.length
    ? await db`select code,name,municipality_code as "municipalityCode" from ph_barangays where municipality_code=any(${db.array(codes, "TEXT")}::text[])`
    : [];
  const postal = codes.length
    ? await db`select municipality_code,postal_code from ph_postal_codes where municipality_code=any(${db.array(codes, "TEXT")}::text[]) order by postal_code`
    : [];
  /** @type {Map<string,string[]>} */ const postalCodes = new Map();
  for (const p of postal)
    postalCodes.set(p.municipality_code, [
      ...(postalCodes.get(p.municipality_code) ?? []),
      p.postal_code,
    ]);
  return geoLookup({ ...lookups.geo, barangays, postalCodes });
}

/**
 * Full server validation: the shared rules with PSGC geography, then the database rules
 * (existing customer in scope and not inactive). Returns errors and the resolved items.
 * @param {any} db @param {UploadRow[]} rows @param {Lookups} lookups
 */
async function resolveRows(db, rows, lookups) {
  const geo = await geoFor(db, rows, lookups);
  const checked = validateCustomerRows(rows, lookups.index, geo);
  /** @type {UploadError[]} */ const errors = [...checked.errors];
  const codes = [...checked.items.values()].map((i) => i.code).filter(Boolean);
  const outlets = codes.length
    ? await db`select id,code,status,custodian_org_unit_id from outlets where organization_id=${ORGANIZATION} and deleted_at is null and code=any(${db.array(codes, "TEXT")}::text[])`
    : [];
  /** @type {Map<string, any>} */ const outletByCode = new Map(
    outlets.map((/** @type {any} */ o) => [o.code, o]),
  );
  /** @type {Map<number, {item:any, existing:any}>} */ const resolved =
    new Map();
  const bad = new Set(checked.errors.map((e) => e.rowNumber));
  for (const row of rows) {
    const item = /** @type {any} */ (checked.items.get(row.rowNumber));
    const existing = outletByCode.get(item.code) ?? null;
    /** @param {string} code @param {string} message */
    const fail = (code, message) => {
      errors.push({
        rowNumber: row.rowNumber,
        column: "code",
        label: "Customer Code",
        code,
        message,
        value: cellOf(row, "code"),
      });
      bad.add(row.rowNumber);
    };
    if (existing) {
      if (lookups.scope && !lookups.scope.has(existing.custodian_org_unit_id))
        fail(
          "customer_out_of_scope",
          `Customer ${item.code} already exists in an area outside the ones you manage.`,
        );
      else if (existing.status === "inactive")
        fail(
          "customer_inactive",
          `Customer ${item.code} is inactive. Reactivate it on the Customers page before updating it by upload.`,
        );
    }
    if (!bad.has(row.rowNumber))
      resolved.set(row.rowNumber, { item, existing });
  }
  return { errors: sortErrors(errors), resolved, outletByCode };
}

/** @param {any} ctx */
async function authorize(ctx) {
  return requireCapability(ctx, CAP);
}

/** Runs the actor may see: national sees all; scoped sees own and in-scope starters. @param {any} db @param {any} actor */
async function visibility(db, actor) {
  const { unitIds } = await scopeFilterForActor(db, actor);
  return unitIds;
}
/** @param {any} run @param {string[]|null} unitIds @param {any} actor */
const canSee = (run, unitIds, actor) =>
  unitIds === null ||
  run.actor_user_id === actor.userId ||
  (run.actor_org_unit_id && unitIds.includes(run.actor_org_unit_id));

/** @param {any} run */
function runDto(run) {
  const total = run.row_count;
  const pending = Math.max(0, total - run.succeeded_count - run.failed_count);
  return {
    id: run.id,
    kind: CUSTOMER_UPLOAD_KIND,
    fileName: run.file_name,
    status: run.status,
    rowCount: total,
    succeeded: run.succeeded_count,
    failed: run.failed_count,
    pending,
    created: run.created_count,
    updated: run.updated_count,
    actorName: run.actor_name,
    createdAt: new Date(run.created_at).getTime(),
    startedAt: run.started_at ? new Date(run.started_at).getTime() : null,
    finishedAt: run.finished_at ? new Date(run.finished_at).getTime() : null,
    interruptedAt: run.interrupted_at
      ? new Date(run.interrupted_at).getTime()
      : null,
    heartbeatAt: run.heartbeat_at ? new Date(run.heartbeat_at).getTime() : null,
    chunkSize: run.chunk_size,
  };
}

/** Marks runs whose worker stopped heart-beating as interrupted. @param {any} db */
export async function sweepStaleRuns(db) {
  const rows =
    await db`update customer_upload_runs set status='interrupted', interrupted_at=now(), lease_owner=null, lease_expires_at=null where organization_id=${ORGANIZATION} and ((status='running' and lease_expires_at<now()) or (status='queued' and created_at<now()-${runtime.leaseMs}*interval '1 millisecond' and lease_owner is null and updated_at<now()-${runtime.leaseMs}*interval '1 millisecond')) returning id`;
  if (rows.length && runtime.platform)
    await runtime.platform.publish("imports");
  return rows.map((/** @type {any} */ r) => r.id);
}

/** @param {any} db @param {string} runId */
async function refreshCounts(db, runId) {
  await db`update customer_upload_runs r set succeeded_count=s.ok, failed_count=s.bad, created_count=s.created, updated_count=s.updated
    from (select count(*) filter (where status='succeeded')::int ok, count(*) filter (where status='failed')::int bad,
      count(*) filter (where status='succeeded' and action='new')::int created, count(*) filter (where status='succeeded' and action='update')::int updated
      from customer_upload_rows where run_id=${runId}) s where r.id=${runId}`;
}

/** Map a write failure to stable row errors (writer validation errors keep their column).
 * @param {any} e @param {Record<string,string>} cells */
function writeErrors(e, cells) {
  const pg = e?.errno ?? e?.code;
  if (["23505", "23P01", "40P01"].includes(pg))
    return [
      {
        column: null,
        label: null,
        code: "conflict",
        message:
          "Another change saved this customer at the same time. Retry failed rows.",
        value: "",
      },
    ];
  if (e instanceof ApiError) {
    const details = /** @type {any} */ (e.details);
    if (e.code === "validation_failed" && Array.isArray(details?.errors))
      return details.errors.map((/** @type {any} */ x) => {
        const column = columnOfField(String(x.field ?? ""));
        return {
          column: columnById(column) ? column : null,
          label: x.label ?? null,
          code: x.code,
          message: x.message,
          value: cells[column] ?? "",
        };
      });
    if (e.code === "out_of_scope" || e.code === "no_scope" || e.status === 403)
      return [
        {
          column: "code",
          label: "Customer Code",
          code: "customer_out_of_scope",
          message: "This customer is outside the areas you manage.",
          value: cells.code ?? "",
        },
      ];
    return [
      {
        column: ["code_taken", "invalid_code", "code_locked"].includes(e.code)
          ? "code"
          : null,
        label: null,
        code: e.code === "business_rule" ? "write_failed" : e.code,
        message: e.message,
        value: "",
      },
    ];
  }
  console.error("[customer-upload] row write failed", e);
  return [
    {
      column: null,
      label: null,
      code: "write_failed",
      message:
        "The customer could not be saved. Retry failed rows; if it fails again, contact support.",
      value: "",
    },
  ];
}

/**
 * Writes ONE customer through the customer-master writer (the same one the Customers page
 * uses): create or update by Customer Code, ship-to, pending pin, 1:1 accounting customer.
 * New customers are approved (active) when the uploader may approve customers; otherwise they
 * wait as prospects in the usual approval queue.
 * @param {any} c ctx with db (a savepoint), actor, now @param {{item:any, existing:any}} entry
 * @param {UploadRow} row @param {Lookups} lookups @param {any} run
 */
async function writeRow(c, entry, row, lookups, run) {
  const reason = `Customer upload ${run.file_name}, row ${row.rowNumber}`;
  const { item } = entry;
  // Re-read inside the savepoint: a concurrent change may have created or touched the code.
  const [current] =
    await c.db`select id,status from outlets where organization_id=${ORGANIZATION} and deleted_at is null and code=${item.code} for update`;
  let outletId, action;
  if (current) {
    action = "update";
    if (current.status === "inactive")
      throw new ApiError(
        "customer_inactive",
        422,
        `Customer ${item.code} is inactive. Reactivate it on the Customers page before updating it by upload.`,
      );
    const existing = await readCustomer(c.db, current.id);
    outletId = await saveCustomer(
      c,
      {
        customer: writerInput(item, row, lookups.index, existing),
        reason,
      },
      { outletId: current.id },
    );
  } else {
    action = "new";
    outletId = await saveCustomer(c, {
      customer: writerInput(item, row, lookups.index, null),
      code: item.code,
      custodianOrgUnitId: c.actor.orgUnitId,
      reason,
    });
    if (roleHas(c.actor.role, "outlet.enrol.approve"))
      await approveCustomer(c, outletId, { reason });
  }
  await writeAudit(c.db, {
    subject: c.actor.userId,
    action: `SP-0170.customer.upload_${action}`,
    entityType: "outlets",
    entityId: outletId,
    details: { runId: run.id, rowNumber: row.rowNumber },
  });
  await runtime.platform?.recordChange(c.db, {
    entity: "org.reference",
    entityId: outletId,
    scopeKey: "global",
    op: "upsert",
  });
  return { action, outletId };
}

/** @param {UploadError[]} errors */
const rowErrors = (errors) =>
  errors.map((e) => ({
    column: e.column ?? null,
    label: e.label ?? (e.column ? (columnById(e.column)?.label ?? null) : null),
    code: e.code,
    message: e.message,
    value: e.value ?? "",
  }));

/**
 * One chunk = one transaction. Returns false when the worker lost its lease.
 * @param {any} run @param {any} actor @param {Lookups} lookups @param {number} chunkIndex @param {string} owner
 */
async function processChunk(run, actor, lookups, chunkIndex, owner) {
  return tx(runtime.db, async (/** @type {any} */ t) => {
    const [chunk] =
      await t`select * from customer_upload_chunks where run_id=${run.id} and chunk_index=${chunkIndex} for update skip locked`;
    if (!chunk) return true; // another worker holds this chunk
    const [live] =
      await t`select lease_owner from customer_upload_runs where id=${run.id}`;
    if (live?.lease_owner !== owner) return false;
    await t`select set_config('sunpride.actor',${actor.userId},true)`;
    const all =
      await t`select row_number,cells,status from customer_upload_rows where run_id=${run.id} and chunk_index=${chunkIndex} order by row_number`;
    const digest = chunkHashOf({
      kind: CUSTOMER_UPLOAD_KIND,
      fileHash: run.file_hash,
      chunkIndex,
      rows: all.map((/** @type {any} */ r) => ({
        rowNumber: r.row_number,
        values: r.cells,
      })),
    });
    if (digest !== chunk.chunk_hash)
      throw new Error(`customer upload chunk ${chunkIndex} integrity mismatch`);
    const pending = all.filter(
      (/** @type {any} */ r) => r.status === "pending",
    );
    if (!pending.length) return true;
    /** @type {UploadRow[]} */
    const rows = pending.map((/** @type {any} */ r) => ({
      rowNumber: r.row_number,
      values: r.cells,
    }));
    // Authoritative re-check against the database as it is NOW.
    const checked = await resolveRows(t, rows, lookups);
    // The writers' effective-dated links and readers' `<= now()` checks must agree inside this
    // transaction: use the transaction's own clock for every row of the chunk.
    const [{ ms }] =
      await t`select (extract(epoch from now())*1000)::float8 as ms`;
    const c = { db: t, actor, now: Math.floor(ms), env: {} };
    for (const row of rows) {
      const errs = checked.errors.filter((e) => e.rowNumber === row.rowNumber);
      const entry = checked.resolved.get(row.rowNumber);
      if (errs.length || !entry) {
        await t`update customer_upload_rows set status='failed', errors=${rowErrors(errs)}, attempts=attempts+1, processed_at=now() where run_id=${run.id} and row_number=${row.rowNumber}`;
        continue;
      }
      try {
        const result = await tx(t, (/** @type {any} */ sp) =>
          writeRow({ ...c, db: sp }, entry, row, lookups, run),
        );
        await t`update customer_upload_rows set status='succeeded', action=${result.action}, outlet_id=${result.outletId}, errors='[]'::jsonb, attempts=attempts+1, processed_at=now() where run_id=${run.id} and row_number=${row.rowNumber}`;
      } catch (e) {
        await t`update customer_upload_rows set status='failed', errors=${writeErrors(e, row.values)}, attempts=attempts+1, processed_at=now() where run_id=${run.id} and row_number=${row.rowNumber}`;
      }
    }
    await t`update customer_upload_chunks set attempts=attempts+1, completed_at=now() where run_id=${run.id} and chunk_index=${chunkIndex}`;
    await refreshCounts(t, run.id);
    return true;
  });
}

/** Bounded-concurrency pool that lets in-flight work settle before reporting a failure. @template T @param {T[]} items @param {number} n @param {(item:T)=>Promise<boolean>} fn */
async function pool(items, n, fn) {
  let next = 0,
    stop = false;
  /** @type {unknown} */ let failure = null;
  const lanes = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (!stop && next < items.length) {
      const item = /** @type {T} */ (items[next++]);
      try {
        if (!(await fn(item))) stop = true;
      } catch (e) {
        failure ??= e;
        stop = true;
      }
    }
  });
  await Promise.all(lanes);
  if (failure) throw failure;
  return !stop;
}

/** @param {string} runId */
async function processRun(runId) {
  const db = runtime.db;
  const owner = crypto.randomUUID();
  const [run] =
    await db`update customer_upload_runs set status='running', lease_owner=${owner}, lease_expires_at=now()+${runtime.leaseMs}*interval '1 millisecond', heartbeat_at=now(), attempt=attempt+1, started_at=coalesce(started_at,now()), interrupted_at=null, finished_at=null where id=${runId} and (status='queued' or (status='running' and lease_expires_at<now())) returning *`;
  if (!run) return;
  const beat = setInterval(() => {
    db`update customer_upload_runs set heartbeat_at=now(), lease_expires_at=now()+${runtime.leaseMs}*interval '1 millisecond' where id=${runId} and lease_owner=${owner}`.catch(
      (/** @type {unknown} */ e) =>
        console.error("[customer-upload] heartbeat failed", e),
    );
  }, runtime.heartbeatMs);
  try {
    const actor = await actorFor(db, run.acting_user_id);
    if (
      !actor ||
      !roleHas(actor.role, CAP) ||
      !roleHas(actor.role, "outlet.manage")
    ) {
      await db`update customer_upload_rows set status='failed', errors=${[{ column: null, label: null, code: "forbidden", message: "The person running this upload no longer has permission to manage customers.", value: "" }]}, processed_at=now() where run_id=${runId} and status='pending'`;
    } else {
      const lookups = await loadLookups(db, actor);
      const chunks = (
        await db`select distinct chunk_index from customer_upload_rows where run_id=${runId} and status='pending' order by chunk_index`
      ).map((/** @type {any} */ r) => r.chunk_index);
      const kept = await pool(chunks, runtime.concurrency, async (ci) => {
        await runtime.hooks.beforeChunk?.(runId, ci);
        const ok = await processChunk(run, actor, lookups, ci, owner);
        await runtime.platform?.publish("imports");
        return ok;
      });
      if (!kept) return; // lease lost: the new owner finalises
    }
    await refreshCounts(db, runId);
    await db`update customer_upload_runs set status=case when exists(select 1 from customer_upload_rows where run_id=${runId} and status in ('pending','failed')) then 'completed_with_errors' else 'completed' end, finished_at=now(), lease_owner=null, lease_expires_at=null where id=${runId} and lease_owner=${owner}`;
  } catch (e) {
    console.error("[customer-upload] run stopped", e);
    await db`update customer_upload_runs set status='interrupted', interrupted_at=now(), lease_owner=null, lease_expires_at=null where id=${runId} and lease_owner=${owner}`.catch(
      () => {},
    );
  } finally {
    clearInterval(beat);
    await runtime.platform?.publish("imports");
    for (const topic of ["outlets", "masters", "org"])
      await runtime.platform?.publish(topic);
  }
}

/** Start (or join) the in-process worker for a run. @param {string} runId */
export function startRun(runId) {
  const existing = runtime.workers.get(runId);
  if (existing) return existing;
  const work = processRun(runId).finally(() => runtime.workers.delete(runId));
  runtime.workers.set(runId, work);
  return work;
}

/** Full server validation for a set of rows. @param {any} db @param {any} actor @param {UploadRow[]} rows */
export async function validateUploadRows(db, actor, rows) {
  return resolveRows(db, rows, await loadLookups(db, actor));
}

/** Create a run from a validated file. @param {any} ctx @param {any} body */
export async function createRun(ctx, body) {
  const actor = await authorize(ctx);
  await requireCapability(ctx, "outlet.manage");
  const input = checkBody(body);
  const fileHash = chunkHashOf({
    kind: CUSTOMER_UPLOAD_KIND,
    header: input.header,
    rows: input.rows,
  });
  const size = runtime.chunkSize;
  const result = await tx(ctx.db, async (/** @type {any} */ t) => {
    await t`select pg_advisory_xact_lock(hashtextextended(${`customer-upload:${ORGANIZATION}:${fileHash}`},0))`;
    const [previous] =
      await t`select * from customer_upload_runs where organization_id=${ORGANIZATION} and file_hash=${fileHash} order by created_at desc limit 1`;
    if (previous) {
      const unitIds = await visibility(t, actor);
      if (!canSee(previous, unitIds, actor))
        throw new ApiError(
          "idempotency_conflict",
          409,
          "This exact file was already uploaded by someone outside your areas.",
        );
      return { run: previous, duplicate: true };
    }
    const checked = await validateUploadRows(t, actor, input.rows);
    const [profile] =
      await t`select name from profiles where id=${actor.profileId}`;
    const [run] =
      await t`insert into customer_upload_runs(organization_id,file_name,file_hash,row_count,chunk_size,status,actor_user_id,acting_user_id,actor_profile_id,actor_name,actor_org_unit_id)
        values(${ORGANIZATION},${input.fileName},${fileHash},${input.rows.length},${size},'queued',${actor.userId},${actor.userId},${actor.profileId},${profile?.name ?? actor.name ?? null},${actor.orgUnitId ?? null}) returning *`;
    const chunkCount = Math.ceil(input.rows.length / size);
    /** @type {any[]} */ const chunkRecords = [];
    /** @type {any[]} */ const rowRecords = [];
    for (let ci = 0; ci < chunkCount; ci++) {
      const part = input.rows.slice(ci * size, (ci + 1) * size);
      chunkRecords.push({
        run_id: run.id,
        chunk_index: ci,
        chunk_hash: chunkHashOf({
          kind: CUSTOMER_UPLOAD_KIND,
          fileHash,
          chunkIndex: ci,
          rows: [...part].sort((a, b) => a.rowNumber - b.rowNumber),
        }),
        row_count: part.length,
      });
      for (const row of part) {
        const errs = checked.errors.filter(
          (e) => e.rowNumber === row.rowNumber,
        );
        const entry = checked.resolved.get(row.rowNumber);
        rowRecords.push({
          run_id: run.id,
          row_number: row.rowNumber,
          chunk_index: ci,
          customer_code: normaliseCode(cellOf(row, "code")),
          cells: row.values,
          action: entry ? (entry.existing ? "update" : "new") : null,
          status: errs.length ? "failed" : "pending",
          errors: rowErrors(errs),
        });
      }
    }
    for (let i = 0; i < chunkRecords.length; i += 500)
      await t`insert into customer_upload_chunks ${t(chunkRecords.slice(i, i + 500))}`;
    for (const r of rowRecords)
      await t`insert into customer_upload_rows(run_id,row_number,chunk_index,customer_code,cells,action,status,errors,processed_at) values(${r.run_id},${r.row_number},${r.chunk_index},${r.customer_code},${r.cells},${r.action},${r.status},${r.errors},${r.status === "failed" ? new Date() : null})`;
    await refreshCounts(t, run.id);
    const pending = rowRecords.some((r) => r.status === "pending");
    if (!pending)
      await t`update customer_upload_runs set status='completed_with_errors', finished_at=now() where id=${run.id}`;
    await writeAudit(t, {
      subject: actor.userId,
      action: "SP-0170.customer_upload.start",
      entityType: "customer_upload_runs",
      entityId: run.id,
      details: {
        fileName: input.fileName,
        rows: input.rows.length,
        invalid:
          rowRecords.length -
          rowRecords.filter((r) => r.status === "pending").length,
      },
    });
    const [fresh] =
      await t`select * from customer_upload_runs where id=${run.id}`;
    return { run: fresh, duplicate: false, pending };
  });
  await ctx.publish?.("imports");
  if (!result.duplicate && result.pending && runtime.autoStart)
    void startRun(result.run.id);
  return { ...runDto(result.run), duplicate: result.duplicate };
}

/** @param {any} ctx @param {string} id */
async function loadVisibleRun(ctx, id) {
  const actor = await authorize(ctx);
  if (!/^[0-9a-f-]{36}$/i.test(id ?? ""))
    throw new ApiError("not_found", 404, "Upload not found.");
  await sweepStaleRuns(ctx.db);
  const [run] =
    await ctx.db`select * from customer_upload_runs where id=${id} and organization_id=${ORGANIZATION}`;
  if (!run || !canSee(run, await visibility(ctx.db, actor), actor))
    throw new ApiError("not_found", 404, "Upload not found.");
  return { run, actor };
}

/** @param {any} ctx @param {any} body */
export async function previewUpload(ctx, body) {
  const actor = await authorize(ctx);
  const input = checkBody(body);
  const checked = await validateUploadRows(ctx.db, actor, input.rows);
  const errorRows = new Set(checked.errors.map((e) => e.rowNumber));
  const rows = input.rows.map((r) => {
    const code = normaliseCode(cellOf(r, "code"));
    return {
      rowNumber: r.rowNumber,
      customerCode: code,
      action: checked.outletByCode.has(code) ? "update" : "new",
      valid: !errorRows.has(r.rowNumber),
    };
  });
  return {
    rowCount: rows.length,
    validCount: rows.filter((r) => r.valid).length,
    errorRowCount: errorRows.size,
    newCount: rows.filter((r) => r.valid && r.action === "new").length,
    updateCount: rows.filter((r) => r.valid && r.action === "update").length,
    errors: checked.errors,
    rows,
  };
}

/** Rows of customer_reference_values the template's list sheets are generated from (the
 * client's lists only; the Sales Partner fallback is not written into the template).
 * @param {any} db */
export async function templateReference(db) {
  return (
    await db`select list,sales_org_code,channel_code,group1_code,code,name from customer_reference_values where active order by list, sales_org_code, channel_code, group1_code, sort_order`
  ).map((/** @type {any} */ r) => ({
    list: r.list,
    salesOrgCode: r.sales_org_code ?? "",
    channelCode: r.channel_code ?? "",
    group1Code: r.group1_code ?? "",
    code: r.code,
    name: r.name,
  }));
}

/** @param {import('../../core/router.js').Router} router @param {any} platform */
export function installCustomerUpload(router, platform) {
  runtime.db = platform.db;
  runtime.platform = platform;
  platform.scheduler?.every?.(15_000, "imports.customer_upload.sweep", () =>
    sweepStaleRuns(platform.db),
  );
  const base = "/api/v1/imports/customer-upload";
  // A full 5,000-row template file is a few MB of JSON: raise the cap for these two routes only.
  const big = { maxBytes: 8 * 1024 * 1024 };
  router.post(`${base}/preview`, (ctx) => previewUpload(ctx, ctx.body), big);
  router.post(`${base}/runs`, (ctx) => createRun(ctx, ctx.body), big);
  // Template: the reference rows its list sheets and dropdowns are generated from (the browser
  // builds the .xlsx with the shared code), plus the list sheets for checking.
  router.get(`${base}/template`, async (ctx) => {
    await authorize(ctx);
    const reference = await templateReference(ctx.db);
    return { reference, sheets: listSheets(reference) };
  });
  // Lists for the browser's instant checks (incl. the Sales Partner fallback the server accepts).
  router.get(`${base}/reference`, async (ctx) => {
    await authorize(ctx);
    return { rows: await referenceRows(ctx.db) };
  });
  router.get(`${base}/runs`, async (ctx) => {
    const actor = await authorize(ctx);
    await sweepStaleRuns(ctx.db);
    const offset = Number(ctx.url.searchParams.get("cursor") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new ApiError("invalid_format", 400, "Invalid history cursor.");
    const unitIds = await visibility(ctx.db, actor);
    const national = unitIds === null;
    const runs =
      await ctx.db`select * from customer_upload_runs where organization_id=${ORGANIZATION} and (${national} or actor_user_id=${actor.userId} or actor_org_unit_id::text=any(${ctx.db.array(unitIds ?? [], "TEXT")}::text[])) order by created_at desc,id desc limit 26 offset ${offset}`;
    return {
      rows: runs.slice(0, 25).map(runDto),
      next: runs.length > 25 ? String(offset + 25) : null,
    };
  });
  router.get(`${base}/runs/:id`, async (ctx) => {
    const { run } = await loadVisibleRun(ctx, ctx.params.id);
    const withRows = ctx.url.searchParams.get("rows") !== "0";
    const rows = withRows
      ? await ctx.db`select row_number,customer_code,cells,action,status,errors,outlet_id,attempts from customer_upload_rows where run_id=${run.id} order by row_number`
      : [];
    return {
      run: runDto(run),
      rows: rows.map((/** @type {any} */ r) => ({
        rowNumber: r.row_number,
        customerCode: r.customer_code,
        values: r.cells,
        action: r.action,
        status: r.status,
        errors: r.errors,
        outletId: r.outlet_id,
        attempts: r.attempts,
      })),
    };
  });
  router.post(`${base}/runs/:id/resume`, async (ctx) => {
    const { run, actor } = await loadVisibleRun(ctx, ctx.params.id);
    await requireCapability(ctx, "outlet.manage");
    const retryFailed = ctx.body?.retryFailed === true;
    if (["queued", "running"].includes(run.status))
      throw new ApiError(
        "run_in_progress",
        409,
        "This upload is still running. Wait for it to finish or stop.",
      );
    const resumed = await tx(ctx.db, async (/** @type {any} */ t) => {
      const [locked] =
        await t`select * from customer_upload_runs where id=${run.id} for update`;
      if (["queued", "running"].includes(locked.status))
        throw new ApiError(
          "run_in_progress",
          409,
          "This upload is already running.",
        );
      if (retryFailed)
        await t`update customer_upload_rows set status='pending', errors='[]'::jsonb, processed_at=null where run_id=${run.id} and status='failed'`;
      const [{ pending }] =
        await t`select count(*)::int pending from customer_upload_rows where run_id=${run.id} and status='pending'`;
      if (!pending) return false;
      await t`update customer_upload_chunks set completed_at=null where run_id=${run.id} and chunk_index in (select chunk_index from customer_upload_rows where run_id=${run.id} and status='pending')`;
      await refreshCounts(t, run.id);
      await t`update customer_upload_runs set status='queued', acting_user_id=${actor.userId}, finished_at=null, lease_owner=null, lease_expires_at=null where id=${run.id}`;
      await writeAudit(t, {
        subject: actor.userId,
        action: retryFailed
          ? "SP-0170.customer_upload.retry_failed"
          : "SP-0170.customer_upload.resume",
        entityType: "customer_upload_runs",
        entityId: run.id,
        details: { pending },
      });
      return true;
    });
    if (resumed && runtime.autoStart) void startRun(run.id);
    const [fresh] =
      await ctx.db`select * from customer_upload_runs where id=${run.id}`;
    await ctx.publish?.("imports");
    return { ...runDto(fresh), resumed };
  });
}
