import { tx } from "@sunpride/db/client";
import { actorFor } from "../../core/context.js";
import {
  requireCapability,
  requireNationalScope,
  roleHas,
} from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { setHooks } from "../../core/hooks.js";
import { identityHooks, ORG_LOCK, profileDto } from "./identity.js";
import { writeAudit } from "./audit.js";
import {
  canonical,
  dto,
  get,
  history,
  instant,
  page,
  paging,
  query,
  required,
  rule,
  uuid,
} from "./model.js";
import {
  access,
  detail,
  list,
  orgTree,
  queue,
  readHistory,
  enrichProduct,
} from "./readers.js";
import { rootUnitId } from "./scope.js";
import {
  assignPerson,
  geographyCommand,
  invitationCommand,
  orgCommand,
  teamCommand,
} from "./commands.js";
import {
  assignmentCommand,
  enrolmentCommand,
  outletCommand,
  pinCommand,
} from "./outlets.js";
import { catalogCommand } from "./catalog.js";
import { currentStandards, foundation, setStandard } from "./standards.js";
import { deviceCommand, deviceReport, registerDevice } from "./devices.js";
import { supervisorOptions, roster, notifications } from "./extra-readers.js";
import { setupHealth } from "./setup.js";
import { readEvidence } from "./evidence.js";
import { enqueue } from "../../core/jobs.js";
import { installOrgJobs } from "./jobs.js";

/** @typedef {import('./model.js').Ctx} Ctx */
/** @typedef {import('./model.js').Row} Row */

/** @param {import('../../core/router.js').Router} router @param {any} platform */
export function install(router, platform) {
  setHooks(identityHooks(platform.env));
  installOrgJobs(platform);
  for (const [topic, cap] of [
    ["org", "org.read"],
    ["people", "people.read"],
    ["outlets", "outlet.read"],
    ["catalog", "inventory.read"],
  ])
    platform.registerTopic(
      topic,
      (/** @type {any} */ actor, /** @type {string} */ requested) =>
        requested === topic && roleHas(actor.role, cap),
    );

  /** @param {string} path @param {(c:Ctx,p:Row)=>Promise<any>} fn */
  const read = (path, fn) =>
    router.get(`/api/v1/${path}`, (c) => fn(c, query(c)));
  /** Every command reauthenticates inside the same transaction, serializes domain invariants, audits, and records an invalidation last. @param {string} path @param {string} cap @param {(c:Ctx,b:Row)=>Promise<any>} fn */
  const command = (path, cap, fn) =>
    router.post(`/api/v1/${path}`, async (c) => {
      if (!c.body || typeof c.body !== "object" || Array.isArray(c.body))
        throw new ApiError(
          "invalid_request",
          400,
          "A command object is required",
        );
      const body = { ...c.body };
      if (
        (body.assignments !== undefined && !Array.isArray(body.assignments)) ||
        (body.outletIds !== undefined && !Array.isArray(body.outletIds))
      )
        throw new ApiError("invalid_request", 400, "Choose a list of records");
      const result = await tx(c.db, async (t) => {
        await t`select pg_advisory_xact_lock(${ORG_LOCK})`;
        const actor = c.user ? await actorFor(t, c.user.id) : null;
        const current = { ...c, db: t, actor, now: Date.now() };
        await requireCapability(current, cap);
        if (
          path.startsWith("catalog/") ||
          path === "people/invite" ||
          path === "people/revoke"
        )
          await requireNationalScope(
            current,
            cap === "masterdata.manage" ? ["admin", "operations"] : ["admin"],
          );
        if (path.endsWith("endSalespersonAssignment") && body.assignmentId) {
          const routeAssignment = path.startsWith("territories/routes/");
          const assignment = await get(
            t,
            routeAssignment ? "route_salespeople" : "territory_salespeople",
            uuid(body.assignmentId),
          );
          body[routeAssignment ? "routeId" : "territoryId"] =
            assignment[routeAssignment ? "route_id" : "territory_id"];
          body.profileId = assignment.profile_id;
        }
        // Scope is checked even on a successful receipt replay.
        if (body.outletId)
          await access(current, "outlets", uuid(body.outletId), cap);
        if (body.profileId && path !== "people/invite")
          await access(current, "people", uuid(body.profileId), cap);
        if (body.orgUnitId)
          await requireCapability(current, cap, uuid(body.orgUnitId));
        if (body.unitId)
          await requireCapability(current, cap, uuid(body.unitId));
        if (body.teamId) await access(current, "teams", uuid(body.teamId), cap);
        if (body.routeId)
          await access(current, "routes", uuid(body.routeId), cap);
        if (body.territoryId)
          await access(current, "territories", uuid(body.territoryId), cap);
        if (body.pinId)
          await access(
            current,
            "outlets",
            (await get(t, "outlet_pins", body.pinId)).outlet_id,
            cap,
          );
        if (body.enrolmentId)
          await access(
            current,
            "outlets",
            (await get(t, "outlet_enrolments", body.enrolmentId)).outlet_id,
            cap,
          );
        if (body.deviceId)
          await access(current, "devices", uuid(body.deviceId), cap);
        for (const change of body.assignments ?? [])
          await access(current, "outlets", uuid(change.outletId), cap);
        for (const id of body.outletIds ?? [])
          await access(current, "outlets", uuid(id), cap);
        const key =
          c.req.headers.get("idempotency-key") ?? body.idempotencyKey ?? null;
        const hash = new Bun.CryptoHasher("sha256")
          .update(canonical(body))
          .digest("hex");
        if (key) {
          required(key, "Request key", 200);
          const [receipt] =
            await t`select * from org_command_receipts where profile_id=${actor?.profileId} and command=${path} and request_key=${key}`;
          if (receipt) {
            if (receipt.payload_hash !== hash)
              throw new ApiError(
                "idempotency_conflict",
                409,
                "Request key was already used for different input",
              );
            return receipt.result;
          }
        }
        await t`select set_config('sunpride.actor',${actor?.userId ?? actor?.subject ?? "system:org"},true)`;
        const value = await fn(current, body);
        const table =
          path === "people/assign"
            ? "profiles"
            : path.startsWith("org/teams/")
              ? "teams"
              : path.startsWith("org/")
                ? "org_units"
                : path.startsWith("territories/routes/")
                  ? "routes"
                  : path.startsWith("territories/")
                    ? "territories"
                    : null;
        const materializeId =
          path.endsWith("/create") || path.endsWith("/duplicateTemplate")
            ? typeof value === "string"
              ? value
              : null
            : (body.unitId ??
              body.teamId ??
              body.routeId ??
              body.territoryId ??
              body.profileId ??
              null);
        if (table && materializeId)
          for (const at of [body.effectiveFrom, body.effectiveTo])
            if (Number.isSafeInteger(at) && at > current.now)
              await enqueue(t, {
                kind: "org.materialize",
                key: `${table}:${materializeId}:${at}`,
                runAt: at,
                payload: { table, id: materializeId },
              });
        const entityId =
          body.outletId ??
          body.profileId ??
          body.unitId ??
          body.teamId ??
          body.routeId ??
          body.territoryId ??
          body.pinId ??
          body.enrolmentId ??
          body.deviceId ??
          (typeof value === "string"
            ? value
            : (value?.outletId ?? actor?.profileId));
        await writeAudit(t, {
          subject: actor?.subject,
          action: path.replaceAll("/", "."),
          entityType: path.split("/")[0],
          entityId,
          details:
            path.includes("pins/") || path.includes("enrolment/")
              ? "Store reviewed"
              : (body.reason ?? "Setup updated"),
        });
        if (key)
          await t`insert into org_command_receipts(profile_id,command,request_key,payload_hash,result) values(${actor?.profileId},${path},${key},${hash},${{ value: value ?? null }})`;
        // Unsupported reference changes force FIELDSYNC to refresh its authorized bundle.
        await platform.recordChange(t, {
          entity: "org.reference",
          entityId,
          scopeKey: "global",
          op: "upsert",
        });
        return { value: value ?? null };
      }).catch((error) => {
        if (["23505", "23P01"].includes(error?.errno ?? error?.code))
          throw new ApiError(
            "conflict",
            409,
            "A duplicate or overlapping record already exists",
          );
        if ((error?.errno ?? error?.code) === "23503")
          throw new ApiError(
            "invalid_reference",
            422,
            "A referenced record is missing",
          );
        throw error;
      });
      for (const topic of ["org", "people", "outlets", "catalog"])
        await c.publish(topic);
      return result?.value ?? null;
    });

  read("org/tree", orgTree);
  read("org/types", async (c) => {
    await requireCapability(c, "org.read");
    /** @type {Row[]} */ const rows =
      await c.db`select * from org_unit_types where organization_id='sunpride' order by level`;
    return rows.map(dto);
  });
  read("org/setup-health", setupHealth);
  read("outlets/evidence", readEvidence);
  read("people/current", async (c) => {
    await requireCapability(c, "org.read");
    return profileDto(c.db, /** @type {any} */ (c.actor).userId);
  });
  read("org/permissions", async (c) => {
    const actor = await requireCapability(c, "org.read");
    return {
      capabilities: [...actor.capabilities],
      role: actor.role,
      national:
        actor.role === "super_admin" ||
        Boolean(
          actor.orgUnitId && actor.orgUnitId === (await rootUnitId(c.db)),
        ),
      scopeUnitIds: await identityHooks(platform.env).scopeUnitIds(c.db, actor),
    };
  });
  for (const kind of [
    "people",
    "teams",
    "territories",
    "routes",
    "outlets",
    "products",
    "customers",
    "invitations",
    "devices",
  ]) {
    const prefix =
      kind === "teams"
        ? "org/teams"
        : kind === "routes"
          ? "territories/routes"
          : ["products", "customers"].includes(kind)
            ? `catalog/${kind}`
            : kind === "invitations"
              ? "people/invitations"
              : kind === "devices"
                ? "people/devices"
                : kind;
    read(`${prefix}/list`, (c, p) => list(c, kind, p));
    if (["people", "teams", "territories", "routes", "outlets"].includes(kind))
      read(`${prefix}/detail`, (c, p) => detail(c, kind, p));
  }
  for (const [path, kind, table, field] of [
    ["org/history", "org", "org_unit_parent_edges", "unit_id"],
    ["people/history", "people", "employee_assignments", "profile_id"],
    ["org/teams/member-history", "teams", "team_memberships", "team_id"],
    [
      "territories/ownership-history",
      "territories",
      "territory_ownerships",
      "territory_id",
    ],
    [
      "territories/salespeople-at",
      "territories",
      "territory_salespeople",
      "territory_id",
    ],
    [
      "outlets/customer-history",
      "outlets",
      "outlet_customer_links",
      "outlet_id",
    ],
    ["outlets/pin-history", "outlets", "outlet_pins", "outlet_id"],
    [
      "outlets/assignments/history",
      "outlets",
      "outlet_assignments",
      "outlet_id",
    ],
  ])
    read(path, (c, p) => readHistory(c, kind, table, field, p));
  read("territories/routes/history", async (c, p) => ({
    territories: await readHistory(
      c,
      "routes",
      "route_territories",
      "route_id",
      p,
    ),
    salespeople: await readHistory(
      c,
      "routes",
      "route_salespeople",
      "route_id",
      p,
    ),
  }));
  read("outlets/unassigned", (c, p) =>
    list(c, "outlets", { ...p, unassigned: "true" }),
  );
  read("outlets/pins/queue", (c, p) => queue(c, "pins", p));
  read("outlets/enrolment/pending", (c, p) => queue(c, "enrolments", p));
  read("outlets/enrolment/mine", (c, p) =>
    queue(c, "enrolments", { ...p, mine: true }),
  );
  read("outlets/enrolment/code-format", async (c) => {
    await requireCapability(c, "outlet.read");
    const [s] =
      await c.db`select * from outlet_code_settings where organization_id='sunpride'`;
    return {
      prefix: s?.prefix ?? "SP",
      digits: s?.digits ?? 6,
      example: `${s?.prefix ?? "SP"}${String(s?.next_sequence ?? 1).padStart(s?.digits ?? 6, "0")}`,
    };
  });
  read("people/devices/report", deviceReport);
  read("people/supervisor-options", supervisorOptions);
  read("outlets/assignments/route-stops", (c, p) => roster(c, "route", p));
  read("outlets/assignments/territory-roster", (c, p) =>
    roster(c, "territory", p),
  );
  read("outlets/enrolment/notifications", notifications);
  read("catalog/uoms", async (c) => {
    await requireCapability(c, "inventory.read");
    /** @type {Row[]} */ const rows =
      await c.db`select * from units_of_measure where deleted_at is null and organization_id='sunpride' order by code limit 501`;
    if (rows.length > 500) rule("Unit list exceeds supported size");
    return rows.map(dto);
  });
  read("catalog/positions", async (c) => {
    await requireCapability(c, "org.read");
    /** @type {Row[]} */ const rows =
      await c.db`select * from positions where organization_id='sunpride' and active order by code limit 101`;
    if (rows.length > 100) rule("Position list exceeds supported size");
    return rows.map(dto);
  });
  read("catalog/position-standards", async (c, p) => {
    await requireCapability(c, "org.read");
    await get(c.db, "positions", uuid(p.positionId));
    return (
      await history(c.db, "position_standards", "position_id", p.positionId)
    ).map(dto);
  });
  read("catalog/standards", currentStandards);
  read("catalog/products/detail", async (c, p) => {
    await requireCapability(c, "inventory.read");
    const row = await get(c.db, "products", uuid(p.productId));
    /** @type {Row[]} */ const barcodes =
      await c.db`select b.*,u.code as uom_code from product_barcodes b join units_of_measure u on u.id=b.uom_id where b.product_id=${row.id} and b.deleted_at is null order by b.barcode,b.id limit 501`;
    if (barcodes.length > 500) rule("Barcode history exceeds supported size");
    return {
      product: dto(await enrichProduct(c.db, row)),
      barcodes: barcodes.map(dto),
    };
  });
  read("catalog/customers/detail", async (c, p) => {
    const rows = await list(c, "customers", {
      id: uuid(p.customerId),
      limit: 1,
    });
    if (!rows.page.length)
      throw new ApiError("not_found", 404, "Customer not found");
    return rows.page[0];
  });
  for (const action of ["create", "edit", "reparent", "deactivate"])
    command(`org/${action}`, "admin.manage", (c, b) =>
      orgCommand(c, /** @type {any} */ (action), b),
    );
  command("people/assign", "admin.manage", assignPerson);
  command("people/invite", "admin.manage", (c, b) =>
    invitationCommand(c, "invite", b),
  );
  command("people/revoke", "admin.manage", (c, b) =>
    invitationCommand(c, "revoke", b),
  );
  for (const action of [
    "create",
    "edit",
    "deactivate",
    "addMember",
    "removeMember",
  ])
    command(`org/teams/${action}`, "admin.manage", (c, b) =>
      teamCommand(c, action, b),
    );
  for (const kind of ["territories", "routes"])
    for (const action of [
      "create",
      "edit",
      "deactivate",
      "assignSalesperson",
      "endSalespersonAssignment",
      ...(kind === "routes"
        ? ["move", "duplicateTemplate"]
        : ["transferOwner"]),
    ])
      command(
        `${kind === "routes" ? "territories/routes" : kind}/${action}`,
        kind === "routes" ? "route.manage" : "territory.manage",
        (c, b) => geographyCommand(c, kind, action, b),
      );
  for (const action of ["create", "edit", "deactivate", "changeCustomerLink"])
    command(`outlets/${action}`, "outlet.manage", (c, b) =>
      outletCommand(c, action, b),
    );
  for (const action of ["propose", "decide"])
    command(
      `outlets/pins/${action}`,
      action === "propose" ? "outlet.manage" : "outlet.verify",
      (c, b) => pinCommand(c, action, b),
    );
  for (const action of ["assign", "batchAssign", "reorder"])
    command(`outlets/assignments/${action}`, "outlet.assign", (c, b) =>
      assignmentCommand(c, action, b),
    );
  for (const action of ["propose", "decide", "setCodeFormat"])
    command(
      `outlets/enrolment/${action}`,
      action === "propose"
        ? "outlet.enrol.propose"
        : action === "decide"
          ? "outlet.enrol.approve"
          : "admin.manage",
      (c, b) => enrolmentCommand(c, action, b),
    );
  for (const action of [
    "saveUom",
    "saveProduct",
    "saveCustomer",
    "saveBarcode",
    "saveConversion",
  ])
    command(`catalog/${action}`, "masterdata.manage", (c, b) =>
      catalogCommand(c, action, b),
    );
  command("catalog/foundation", "admin.manage", foundation);
  command("catalog/set-standard", "admin.manage", setStandard);
  command("people/devices/register", "admin.manage", registerDevice);
  for (const action of ["suspend", "revoke", "reinstate"])
    command(`people/devices/${action}`, "admin.manage", (c, b) =>
      deviceCommand(c, /** @type {any} */ (action), b),
    );
}
