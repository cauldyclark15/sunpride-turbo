// SP-0169 store ("customer") CSV upload: validate → preview → background parallel import.
//
// - Sync rules live in @sunpride/import-templates/customers and run in the browser AND here.
// - Async rules (channel/sub-channel/area lookups, existing codes, scope) run on preview and
//   again inside every chunk transaction at import time: the server is authoritative.
// - A run is split into chunks of CUSTOMER_CHUNK_SIZE rows processed by at most
//   `runtime.concurrency` workers. Each chunk is ONE transaction; each row a savepoint, so a bad
//   row fails alone and every row's outcome commits together with its chunk.
// - Interruption safety: a lease + heartbeat marks a live worker. A run whose lease expired is
//   swept to `interrupted`; resume processes only rows still `pending` (or retries `failed`).
// - Idempotency: the run identity is a server-computed hash of the file's header and rows, and
//   each chunk stores a server-owned chunk hash (chunkHashOf). Re-uploading the identical file
//   returns the existing run instead of writing again.
import { tx } from "@sunpride/db/client";
import {
  CUSTOMER_CHUNK_SIZE,
  CUSTOMER_MAX_ROWS,
  cellOf,
  composeAddress,
  headerError,
  normaliseCode,
  phMobile,
  validateCustomerRowsSync,
} from "@sunpride/import-templates/customers";
import { ApiError } from "../../core/errors.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { actorFor } from "../../core/context.js";
import { scopeFilterForActor } from "../org/scope.js";
import { outletCommand, pinCommand } from "../org/outlets.js";
import { writeAudit } from "../org/audit.js";
import { ORGANIZATION, chunkHashOf } from "./format.js";

export const STORE_UPLOAD_KIND = "store_upload";
const CAP = "masterdata.manage";
/** @typedef {import('@sunpride/import-templates/customers').UploadRow} UploadRow */
/** @typedef {import('@sunpride/import-templates/customers').UploadError} UploadError */

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
  const bad = headerError(Array.isArray(header) ? header : []);
  if (bad) throw new ApiError("header_mismatch", 400, bad.message);
  const rows = body.rows;
  if (!Array.isArray(rows) || !rows.length)
    throw new ApiError("empty_file", 400, "The file has no store rows.");
  if (rows.length > CUSTOMER_MAX_ROWS)
    throw new ApiError(
      "too_many_rows",
      400,
      `Upload at most ${CUSTOMER_MAX_ROWS} stores per file. Split the file and upload each part.`,
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
          !header.includes(key) ||
          typeof value !== "string" ||
          value.length > 500,
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
      : "upload.csv";
  /** @type {UploadRow[]} */
  const clean = rows.map((/** @type {any} */ r) => ({
    rowNumber: r.rowNumber,
    values: Object.fromEntries(
      Object.entries(r.values).map(([k, v]) => [k, String(v).trim()]),
    ),
  }));
  return { header: header.map(String), rows: clean, fileName };
}

/** Reference data loaded once per validation pass. @param {any} db @param {any} actor */
async function loadLookups(db, actor) {
  const channels =
    await db`select d.id,d.code,v.label from master_definitions d join master_versions v on v.master_id=d.id where d.kind='channel' and v.status='active' and v.effective_from<=now() and (v.effective_to is null or v.effective_to>now())`;
  const subchannels =
    await db`select d.id,d.code,v.label,v.data from master_definitions d join master_versions v on v.master_id=d.id where d.kind='subchannel' and v.status='active' and v.effective_from<=now() and (v.effective_to is null or v.effective_to>now())`;
  const aliases =
    await db`select legacy_key,channel_id,subchannel_id from master_channel_aliases`;
  const units =
    await db`select id,code,name from org_units where status='active' and deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now())`;
  const { unitIds } = await scopeFilterForActor(db, actor);
  return {
    channels,
    subchannels,
    aliases,
    units,
    scope: unitIds === null ? null : new Set(unitIds),
  };
}

/** @param {any[]} list @param {string} key */
function byCodeOrLabel(list, key) {
  const upper = key.toUpperCase(),
    lower = key.toLowerCase();
  return list.filter(
    (r) =>
      String(r.code).toUpperCase() === upper ||
      String(r.label ?? "").toLowerCase() === lower,
  );
}

/**
 * Async (database) rules. Adds errors for rows and returns resolved items for valid rows.
 * @param {any} db @param {UploadRow[]} rows @param {Awaited<ReturnType<typeof loadLookups>>} lookups @param {UploadError[]} syncErrors
 */
async function resolveRows(db, rows, lookups, syncErrors) {
  /** @type {UploadError[]} */ const errors = [...syncErrors];
  const bad = new Set(syncErrors.map((e) => `${e.rowNumber}:${e.column}`));
  const codes = rows
    .map((r) => normaliseCode(cellOf(r, "customer_code")))
    .filter(Boolean);
  const billingCodes = rows.map((r) =>
    normaliseCode(
      cellOf(r, "billing_account_code") || cellOf(r, "customer_code"),
    ),
  );
  const outlets = codes.length
    ? await db`select id,code,status,custodian_org_unit_id from outlets where organization_id=${ORGANIZATION} and deleted_at is null and code=any(${db.array(codes, "TEXT")}::text[])`
    : [];
  const customers =
    await db`select id,code,active from customers where deleted_at is null and code=any(${db.array(billingCodes, "TEXT")}::text[])`;
  const outletByCode = new Map(
    outlets.map((/** @type {any} */ o) => [o.code, o]),
  );
  const customerByCode = new Map(
    customers.map((/** @type {any} */ c) => [c.code, c]),
  );
  const unitName = new Map(
    lookups.units.map((/** @type {any} */ u) => [u.id, u.name]),
  );
  /** @type {Map<number, any>} */ const resolved = new Map();
  for (const row of rows) {
    const start = errors.length;
    /** @param {string} column @param {string} code @param {string} message */
    const fail = (column, code, message) => {
      if (bad.has(`${row.rowNumber}:${column}`)) return;
      errors.push({
        rowNumber: row.rowNumber,
        column,
        code,
        message,
        value: cellOf(row, column),
      });
    };
    const rowHadSync = syncErrors.some((e) => e.rowNumber === row.rowNumber);
    // channel: governed code, exact label, or a mapped legacy key
    const channelKey = cellOf(row, "channel");
    /** @type {any} */ let channel = null;
    if (channelKey) {
      const ids = new Set(
        byCodeOrLabel(lookups.channels, channelKey).map((c) => c.id),
      );
      for (const a of lookups.aliases)
        if (a.legacy_key === channelKey.toLowerCase()) ids.add(a.channel_id);
      if (ids.size !== 1)
        fail(
          "channel",
          "unknown_channel",
          `"${channelKey}" is not a channel. Use a channel code or name from Master data → Channels.`,
        );
      else
        channel = lookups.channels.find(
          (/** @type {any} */ c) => c.id === [...ids][0],
        );
    }
    const subKey = cellOf(row, "sub_channel");
    /** @type {any} */ let sub = null;
    if (subKey && channel) {
      const matches = byCodeOrLabel(lookups.subchannels, subKey);
      for (const a of lookups.aliases)
        if (a.legacy_key === subKey.toLowerCase() && a.subchannel_id) {
          const s = lookups.subchannels.find(
            (/** @type {any} */ x) => x.id === a.subchannel_id,
          );
          if (s && !matches.includes(s)) matches.push(s);
        }
      const inChannel = matches.filter((s) => s.data?.channelId === channel.id);
      if (inChannel.length === 1) sub = inChannel[0];
      else if (matches.length && !inChannel.length)
        fail(
          "sub_channel",
          "sub_channel_mismatch",
          `"${subKey}" belongs to a different channel than "${channelKey}".`,
        );
      else
        fail(
          "sub_channel",
          "unknown_sub_channel",
          `"${subKey}" is not a sub-channel of "${channelKey}".`,
        );
    }
    const areaKey = cellOf(row, "area");
    /** @type {any} */ let unit = null;
    if (areaKey) {
      const byCode = lookups.units.filter(
        (/** @type {any} */ u) =>
          String(u.code).toUpperCase() === areaKey.toUpperCase(),
      );
      const byName = lookups.units.filter(
        (/** @type {any} */ u) =>
          String(u.name).toLowerCase() === areaKey.toLowerCase(),
      );
      const found = byCode.length === 1 ? byCode : byName;
      if (!found.length)
        fail(
          "area",
          "unknown_area",
          `"${areaKey}" is not an active territory or branch. Use its code or exact name.`,
        );
      else if (found.length > 1)
        fail(
          "area",
          "ambiguous_area",
          `More than one area is named "${areaKey}". Use the area's code instead.`,
        );
      else if (lookups.scope && !lookups.scope.has(found[0].id))
        fail(
          "area",
          "area_out_of_scope",
          `"${areaKey}" is outside the areas you manage.`,
        );
      else unit = found[0];
    }
    const code = normaliseCode(cellOf(row, "customer_code"));
    const status = (cellOf(row, "status") || "active").toLowerCase();
    const existing = code ? outletByCode.get(code) : undefined;
    if (existing) {
      if (lookups.scope && !lookups.scope.has(existing.custodian_org_unit_id))
        fail(
          "customer_code",
          "store_out_of_scope",
          `Store ${code} already exists in an area outside the ones you manage.`,
        );
      else if (existing.status === "inactive" && status !== "inactive")
        fail(
          "status",
          "store_inactive",
          `Store ${code} is inactive. Reactivate it on the Stores page before updating it by upload.`,
        );
      else if (unit && existing.custodian_org_unit_id !== unit.id)
        fail(
          "area",
          "area_change_not_supported",
          `Store ${code} is in ${unitName.get(existing.custodian_org_unit_id) ?? "another area"}. Move stores between areas on the Stores page.`,
        );
    }
    const billingCode = normaliseCode(
      cellOf(row, "billing_account_code") || cellOf(row, "customer_code"),
    );
    const billing = customerByCode.get(billingCode);
    if (billing && !billing.active)
      fail(
        cellOf(row, "billing_account_code")
          ? "billing_account_code"
          : "customer_code",
        "billing_account_inactive",
        `Billing account ${billingCode} is inactive.`,
      );
    if (errors.length === start && !rowHadSync)
      resolved.set(row.rowNumber, {
        rowNumber: row.rowNumber,
        code,
        name: cellOf(row, "customer_name"),
        status,
        channel,
        sub,
        unit,
        existing: existing ?? null,
        billingCode,
        billingExists: Boolean(billing),
        sapId: cellOf(row, "sap_id") || null,
        classification: cellOf(row, "classification") || null,
        address: composeAddress(row),
        ownerName: cellOf(row, "owner_name") || null,
        ownerPhone: cellOf(row, "owner_phone")
          ? phMobile(cellOf(row, "owner_phone"))
          : null,
        latitude: cellOf(row, "latitude")
          ? Number(cellOf(row, "latitude"))
          : null,
        longitude: cellOf(row, "longitude")
          ? Number(cellOf(row, "longitude"))
          : null,
        visitFrequencyDays: cellOf(row, "visit_frequency_days")
          ? Number(cellOf(row, "visit_frequency_days"))
          : null,
      });
  }
  errors.sort(
    (a, b) =>
      a.rowNumber - b.rowNumber ||
      String(a.column).localeCompare(String(b.column)),
  );
  return { errors, resolved, outletByCode };
}

/** Full server validation (sync + async). @param {any} db @param {any} actor @param {UploadRow[]} rows */
export async function validateStoreRows(db, actor, rows) {
  const lookups = await loadLookups(db, actor);
  return resolveRows(db, rows, lookups, validateCustomerRowsSync(rows));
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
    kind: STORE_UPLOAD_KIND,
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

/** Map a write failure to a stable row error. @param {any} e */
function writeError(e) {
  const pg = e?.errno ?? e?.code;
  if (["23505", "23P01"].includes(pg))
    return {
      code: "conflict",
      message:
        "Another change saved this store or its billing account at the same time. Retry failed rows.",
    };
  if (e instanceof ApiError) {
    if (e.code === "out_of_scope" || e.code === "no_scope")
      return {
        code: "store_out_of_scope",
        message: "This store is outside the areas you manage.",
      };
    return {
      code: e.code === "business_rule" ? "write_failed" : e.code,
      message: e.message,
    };
  }
  console.error("[store-upload] row write failed", e);
  return {
    code: "write_failed",
    message:
      "The store could not be saved. Retry failed rows; if it fails again, contact support.",
  };
}

/**
 * Writes ONE store through the same writers the Stores page uses (outletCommand / pinCommand),
 * so effective-dated links, change_seq and audit invariants hold.
 * @param {any} c ctx with db (a savepoint), actor, now @param {any} item @param {any} run
 */
async function writeRow(c, item, run) {
  const db = c.db;
  const reason = `Store upload ${run.file_name}, row ${item.rowNumber}`;
  // Billing (accounting) customer: create if missing; concurrent chunks may race on a shared code.
  await db`insert into customers(code,name,channel,territory,credit_limit,active,external_id,channel_id) values(${item.billingCode},${item.name},${item.channel.code},${item.unit.name},0,true,${item.sapId},${item.channel.id}) on conflict (code) do nothing`;
  const [customer] =
    await db`select id,active,external_id from customers where code=${item.billingCode}`;
  if (!customer.active)
    throw new ApiError(
      "billing_account_inactive",
      422,
      `Billing account ${item.billingCode} is inactive.`,
    );
  if (item.sapId && !customer.external_id)
    await db`update customers set external_id=${item.sapId} where id=${customer.id}`;
  const contacts = item.ownerName
    ? [{ name: item.ownerName, phone: item.ownerPhone ?? undefined }]
    : undefined;
  let outletId, action;
  if (item.existing) {
    action = "update";
    outletId = item.existing.id;
    const [current] =
      await db`select status,channel_id from outlets where id=${outletId} for update`;
    if (current.status === "inactive") {
      // Validation allows this only when the file also says inactive: nothing to change.
      return { action, outletId };
    }
    await outletCommand(c, "edit", {
      outletId,
      name: item.name,
      ...(item.status !== "inactive" ? { status: item.status } : {}),
      ...(item.classification ? { classification: item.classification } : {}),
      address: item.address,
      ...(item.visitFrequencyDays
        ? { visitFrequencyDays: item.visitFrequencyDays }
        : {}),
      ...(contacts ? { contacts } : {}),
      reason,
    });
    const [link] =
      await db`select customer_id from outlet_customer_links where outlet_id=${outletId} and deleted_at is null and effective_from<=${new Date(c.now)} and (effective_to is null or effective_to>${new Date(c.now)})`;
    if (link?.customer_id !== customer.id)
      await outletCommand(c, "changeCustomerLink", {
        outletId,
        customerId: customer.id,
        source: "customer_upload",
        reason,
      });
    const subId =
      item.sub?.id ??
      (current.channel_id === item.channel.id ? undefined : null);
    if (subId === undefined)
      await db`update outlets set channel_id=${item.channel.id} where id=${outletId}`;
    else
      await db`update outlets set channel_id=${item.channel.id},subchannel_id=${subId} where id=${outletId}`;
  } else {
    action = "new";
    outletId = await outletCommand(c, "create", {
      name: item.name,
      code: item.code,
      custodianOrgUnitId: item.unit.id,
      status: item.status === "inactive" ? "active" : item.status,
      ...(item.classification ? { classification: item.classification } : {}),
      address: item.address,
      ...(item.visitFrequencyDays
        ? { visitFrequencyDays: item.visitFrequencyDays }
        : {}),
      ...(contacts ? { contacts } : {}),
      customerId: customer.id,
      customerLinkSource: "customer_upload",
      reason,
    });
    await db`update outlets set channel_id=${item.channel.id},subchannel_id=${item.sub?.id ?? null} where id=${outletId}`;
  }
  if (item.latitude !== null && item.longitude !== null) {
    const [same] =
      await db`select id from outlet_pins where outlet_id=${outletId} and deleted_at is null and status in ('pending','verified') and latitude=${item.latitude} and longitude=${item.longitude} limit 1`;
    // Imported coordinates are a PROPOSAL: the field team verifies the pin on a visit.
    if (!same)
      await pinCommand(c, "propose", {
        outletId,
        latitude: item.latitude,
        longitude: item.longitude,
        radiusMeters: 75,
        source: "customer_upload",
        evidenceNote: `From store upload ${run.file_name}`,
        reason,
      });
  }
  if (item.status === "inactive")
    await outletCommand(c, "deactivate", { outletId, reason });
  await writeAudit(db, {
    subject: c.actor.userId,
    action: `SP-0169.store.upload_${action}`,
    entityType: "outlets",
    entityId: outletId,
    details: { runId: run.id, rowNumber: item.rowNumber },
  });
  await runtime.platform?.recordChange(db, {
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
    code: e.code,
    message: e.message,
    value: e.value ?? "",
  }));

/**
 * One chunk = one transaction. Returns false when the worker lost its lease.
 * @param {any} run @param {any} actor @param {any} lookups @param {number} chunkIndex @param {string} owner
 */
async function processChunk(run, actor, lookups, chunkIndex, owner) {
  return tx(runtime.db, async (/** @type {any} */ t) => {
    const [chunk] =
      await t`select * from customer_upload_chunks where run_id=${run.id} and chunk_index=${chunkIndex} for update skip locked`;
    if (!chunk) return true; // another worker holds this chunk
    const [live] =
      await t`select lease_owner from customer_upload_runs where id=${run.id}`;
    if (live?.lease_owner !== owner) return false;
    const all =
      await t`select row_number,cells,status from customer_upload_rows where run_id=${run.id} and chunk_index=${chunkIndex} order by row_number`;
    const digest = chunkHashOf({
      kind: STORE_UPLOAD_KIND,
      fileHash: run.file_hash,
      chunkIndex,
      rows: all.map((/** @type {any} */ r) => ({
        rowNumber: r.row_number,
        values: r.cells,
      })),
    });
    if (digest !== chunk.chunk_hash)
      throw new Error(`store upload chunk ${chunkIndex} integrity mismatch`);
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
    const checked = await resolveRows(
      t,
      rows,
      lookups,
      validateCustomerRowsSync(rows),
    );
    const c = { db: t, actor, now: Date.now(), env: {} };
    for (const row of rows) {
      const errs = checked.errors.filter((e) => e.rowNumber === row.rowNumber);
      const item = checked.resolved.get(row.rowNumber);
      if (errs.length || !item) {
        await t`update customer_upload_rows set status='failed', errors=${rowErrors(errs)}, attempts=attempts+1, processed_at=now() where run_id=${run.id} and row_number=${row.rowNumber}`;
        continue;
      }
      try {
        const result = await tx(t, (/** @type {any} */ sp) =>
          writeRow({ ...c, db: sp, now: Date.now() }, item, run),
        );
        await t`update customer_upload_rows set status='succeeded', action=${result.action}, outlet_id=${result.outletId}, errors='[]'::jsonb, attempts=attempts+1, processed_at=now() where run_id=${run.id} and row_number=${row.rowNumber}`;
      } catch (e) {
        const err = writeError(e);
        await t`update customer_upload_rows set status='failed', errors=${[{ column: null, ...err, value: "" }]}, attempts=attempts+1, processed_at=now() where run_id=${run.id} and row_number=${row.rowNumber}`;
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
      const item = items[next++];
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
        console.error("[store-upload] heartbeat failed", e),
    );
  }, runtime.heartbeatMs);
  try {
    const actor = await actorFor(db, run.acting_user_id);
    if (!actor || !roleHas(actor.role, CAP)) {
      await db`update customer_upload_rows set status='failed', errors=${[{ column: null, code: "forbidden", message: "The person running this upload no longer has permission to manage master data.", value: "" }]}, processed_at=now() where run_id=${runId} and status='pending'`;
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
    console.error("[store-upload] run stopped", e);
    await db`update customer_upload_runs set status='interrupted', interrupted_at=now(), lease_owner=null, lease_expires_at=null where id=${runId} and lease_owner=${owner}`.catch(
      () => {},
    );
  } finally {
    clearInterval(beat);
    await runtime.platform?.publish("imports");
    await runtime.platform?.publish("outlets");
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

/** Create a run from a validated file. @param {any} ctx @param {any} body */
export async function createRun(ctx, body) {
  const actor = await authorize(ctx);
  const input = checkBody(body);
  const fileHash = chunkHashOf({
    kind: STORE_UPLOAD_KIND,
    header: input.header,
    rows: input.rows,
  });
  const size = runtime.chunkSize;
  const result = await tx(ctx.db, async (/** @type {any} */ t) => {
    await t`select pg_advisory_xact_lock(hashtextextended(${`store-upload:${ORGANIZATION}:${fileHash}`},0))`;
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
    const checked = await validateStoreRows(t, actor, input.rows);
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
          kind: STORE_UPLOAD_KIND,
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
        const item = checked.resolved.get(row.rowNumber);
        rowRecords.push({
          run_id: run.id,
          row_number: row.rowNumber,
          chunk_index: ci,
          customer_code: normaliseCode(cellOf(row, "customer_code")),
          cells: row.values,
          action: item ? (item.existing ? "update" : "new") : null,
          status: errs.length ? "failed" : "pending",
          errors: rowErrors(errs),
        });
      }
    }
    for (let i = 0; i < chunkRecords.length; i += 500)
      await t`insert into customer_upload_chunks ${t(chunkRecords.slice(i, i + 500))}`;
    for (let i = 0; i < rowRecords.length; i += 500)
      for (const r of rowRecords.slice(i, i + 500))
        await t`insert into customer_upload_rows(run_id,row_number,chunk_index,customer_code,cells,action,status,errors,processed_at) values(${r.run_id},${r.row_number},${r.chunk_index},${r.customer_code},${r.cells},${r.action},${r.status},${r.errors},${r.status === "failed" ? new Date() : null})`;
    await refreshCounts(t, run.id);
    const pending = rowRecords.some((r) => r.status === "pending");
    if (!pending)
      await t`update customer_upload_runs set status='completed_with_errors', finished_at=now() where id=${run.id}`;
    await writeAudit(t, {
      subject: actor.userId,
      action: "SP-0169.store_upload.start",
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
  const checked = await validateStoreRows(ctx.db, actor, input.rows);
  const errorRows = new Set(checked.errors.map((e) => e.rowNumber));
  const rows = input.rows.map((r) => {
    const code = normaliseCode(cellOf(r, "customer_code"));
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

/** @param {import('../../core/router.js').Router} router @param {any} platform */
export function installStoreUpload(router, platform) {
  runtime.db = platform.db;
  runtime.platform = platform;
  platform.scheduler?.every?.(15_000, "imports.store_upload.sweep", () =>
    sweepStaleRuns(platform.db),
  );
  const base = "/api/v1/imports/store-upload";
  // A full 5,000-row template file is ~3 MB of JSON: raise the cap for these two routes only.
  const big = { maxBytes: 8 * 1024 * 1024 };
  router.post(`${base}/preview`, (ctx) => previewUpload(ctx, ctx.body), big);
  router.post(`${base}/runs`, (ctx) => createRun(ctx, ctx.body), big);
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
          ? "SP-0169.store_upload.retry_failed"
          : "SP-0169.store_upload.resume",
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
