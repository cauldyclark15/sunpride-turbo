import { tx } from "@sunpride/db/client";
import { setRoutePolicy } from "./route-policy.js";
import { planningChoices } from "./planning.js";
import { decideObservation } from "./route-evidence.js";
import { decideSettlement, decideVariance } from "./settlement.js";
import { reloadAction } from "./reloads.js";
import { pickupQueue, reviewPickup } from "./pickups.js";
import {
  requestCorrection,
  decideCorrection,
  correctionQueue,
  reviseSettlement,
} from "./corrections.js";
import { suggestLoad, applySuggestion } from "./load-suggestions.js";
import { join } from "node:path";
import { filesDir } from "../../core/media.js";
import { requireCapability } from "../../core/capabilities.js";
import { enqueue } from "../../core/jobs.js";
import { enqueueRefresh } from "../analytics/refresh.js";
import { scopeFilterForActor } from "../org/scope.js";
import { currentActor, tripFor, can } from "./access.js";
import {
  command,
  createVehicle,
  planTrip,
  planLoad,
  approveLoad,
  cancelTrip,
  decideDamage,
  setCreditTerms,
  remitCash,
  issueCode,
} from "./commands.js";
import { applyOperation, VAN_OPS } from "./operations.js";
import { vanProjection } from "./projection.js";
import {
  tripsForDay,
  tripDetail,
  damageReview,
  loadDifferences,
  csv,
} from "./queries.js";
import { uuid } from "./model.js";
import {
  bindDevice,
  crewSessionCommand,
  crewPinPrecheck,
  verifyCrewPinOnline,
  handoverTrip,
  listRosters,
  saveRoster,
  setCrewPin,
  setTripCrew,
  tripCrewDetail,
  unbindDevice,
} from "./roster.js";
import {
  copyTrips,
  generateCommand,
  installNightly,
  saveMustCarry,
} from "./nightly.js";
import {
  amendLoad,
  approvePlans,
  copyYesterday,
  dispatchLoad,
  editPlan,
  pickLoad,
  recountLoad,
} from "./loadout.js";
import { dayBoard, pickList, planDetail } from "./dayboard.js";

/** @param {any} router @param {any} ctx */
export function install(router, ctx) {
  ctx.registerTopic(
    "van",
    (/** @type {any} */ actor, /** @type {string} */ topic) =>
      topic === "van" && can(actor, "van.read"),
  );
  for (const name of VAN_OPS)
    ctx.registerOp(name, (/** @type {any} */ op) =>
      applyOperation(op, ctx.env),
    );
  ctx.registerProjection("van.bundle", vanProjection(ctx.env));
  ctx.registerJob("van.refresh", async (/** @type {any} */ job) =>
    enqueueRefresh(
      {
        ...job,
        publish: ctx.publish,
        enqueue: (
          /** @type {import('../../core/context.js').JobSpec} */ spec,
        ) => enqueue(job.db, spec),
        now: Date.now(),
        env: ctx.env,
      },
      { kind: "van", date: job.payload.date, unitId: job.payload.unitId },
    ),
  );
  router.get("/api/v1/van/trips", async (/** @type {any} */ request) => {
    const data = await tripsForDay(request);
    if (request.url.searchParams.get("format") === "csv")
      return new Response(
        csv([
          [
            "Trip",
            "Truck",
            "Seller",
            "Settlement",
            "Sales centavos",
            "Cash expected centavos",
            "Remitted centavos",
            "Cash variance centavos",
          ],
          ...data.rows.map((r) => [
            r.tripNumber,
            r.truck,
            r.seller,
            r.settlementStatus,
            r.salesCentavos,
            r.cash.expectedCentavos,
            r.cash.remittedCentavos,
            r.cash.varianceCentavos,
          ]),
        ]),
        {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": "attachment; filename=van-trips.csv",
          },
        },
      );
    return data;
  });
  router.get("/api/v1/van/trip", (/** @type {any} */ request) =>
    tx(request.db, async (db) =>
      tripDetail(
        db,
        await currentActor(db, request.actor),
        uuid(request.url.searchParams.get("tripId")),
      ),
    ),
  );
  router.get("/api/v1/van/planning", (/** @type {any} */ request) =>
    tx(request.db, async (db) =>
      planningChoices(
        db,
        await currentActor(db, request.actor),
        request.url.searchParams.get("date"),
      ),
    ),
  );
  router.get("/api/v1/van/return-pickups", (/** @type {any} */ c) =>
    tx(c.db, async (db) =>
      pickupQueue(
        db,
        await currentActor(db, c.actor),
        c.url.searchParams.get("tripId"),
      ),
    ),
  );
  router.get("/api/v1/van/corrections", (/** @type {any} */ c) =>
    tx(c.db, async (db) =>
      correctionQueue(
        db,
        await currentActor(db, c.actor),
        c.url.searchParams.get("tripId"),
      ),
    ),
  );
  // IP-VANDAY: the day board, the suggested/approved load, the pick list, the roster and the crew.
  router.get("/api/v1/van/day-board", dayBoard);
  router.get("/api/v1/van/loads/plan", planDetail);
  router.get("/api/v1/van/loads/pick-list", pickList);
  router.get("/api/v1/van/rosters", (/** @type {any} */ c) =>
    tx(c.db, async (db) =>
      listRosters(db, await currentActor(db, c.actor), {
        unitId: c.url.searchParams.get("unitId"),
        day: c.url.searchParams.get("date"),
        vehicleId: c.url.searchParams.get("vehicleId"),
      }),
    ),
  );
  router.get("/api/v1/van/crew", (/** @type {any} */ c) =>
    tx(c.db, async (db) =>
      tripCrewDetail(db, await currentActor(db, c.actor), c.url.searchParams.get("tripId")),
    ),
  );
  installNightly(ctx);
  router.get("/api/v1/van/damage", damageReview);
  router.get("/api/v1/van/load-differences", loadDifferences);
  router.get("/api/v1/van/damage-photo", async (/** @type {any} */ request) => {
    const row = await tx(request.db, async (db) => {
      const actor = await currentActor(db, request.actor);
      const [r] =
        await db`select d.trip_id,f.path from van_damage_records d join van_damage_photos p on p.id=d.photo_id join files f on f.id=p.storage_id where d.id=${uuid(request.url.searchParams.get("damageId"))} and f.status='stored'`;
      if (!r) return null;
      await tripFor(db, actor, r.trip_id);
      return r;
    });
    if (!row) return new Response("Not found", { status: 404 });
    // files.path is a server-created leaf, not a user-supplied path.
    return new Response(Bun.file(join(filesDir(request.env), row.path)), {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "private, no-store",
      },
    });
  });
  router.get("/api/v1/van/vehicles", async (/** @type {any} */ request) => {
    await requireCapability(request, "van.read");
    const scope = await scopeFilterForActor(request.db, request.actor),
      ids = scope.unitIds?.length
        ? scope.unitIds
        : ["00000000-0000-0000-0000-000000000000"];
    return {
      items:
        await request.db`select id as "vehicleId",vehicle_code as "vehicleCode",plate_number as "plateNumber",name,status from vehicles where deleted_at is null and (${scope.unitIds === null} or org_unit_id in ${request.db(ids)}) order by vehicle_code`,
    };
  });
  /** @type {Array<[string,string,(db:any,actor:any,p:any)=>Promise<any>]>} */
  const commands = [
    ["corrections/request", "van.read", requestCorrection],
    ["corrections/decide", "van.read", decideCorrection],
    ["settlements/revise", "van.stock.approve", reviseSettlement],
    ["pickups/decide", "van.stock.approve", reviewPickup],
    ["policies/set", "van.manage", setRoutePolicy],
    ["observations/decide", "van.stock.approve", decideObservation],
    ["settlements/decide", "van.stock.approve", decideSettlement],
    ["variances/decide", "van.stock.approve", decideVariance],
    ["reloads/action", "van.load.approve", reloadAction],
    ["loads/suggest", "van.manage", suggestLoad],
    ["loads/apply-suggestion", "van.manage", applySuggestion],
    ["vehicles/create", "van.manage", createVehicle],
    ["trips/plan", "van.manage", planTrip],
    ["trips/cancel", "van.manage", cancelTrip],
    ["loads/plan", "van.manage", planLoad],
    ["loads/approve", "van.load.approve", approveLoad],
    ["damage/decide", "van.damage.approve", decideDamage],
    ["credit/set", "van.manage", setCreditTerms],
    ["cash/remit", "van.cash.approve", remitCash],
    // IP-VANDAY
    ["rosters/save", "van.manage", saveRoster],
    ["must-carry/save", "van.manage", saveMustCarry],
    ["trips/generate", "van.manage", generateCommand],
    ["trips/copy", "van.manage", copyTrips],
    ["trips/crew", "van.manage", setTripCrew],
    ["trips/handover", "van.load.approve", handoverTrip],
    ["devices/bind", "van.manage", bindDevice],
    ["devices/unbind", "van.manage", unbindDevice],
    ["crew/pin", "van.manage", setCrewPin],
    ["loads/edit", "van.manage", editPlan],
    ["loads/copy", "van.manage", copyYesterday],
    ["loads/approve-plan", "van.manage", approvePlans],
    ["loads/amend", "van.manage", amendLoad],
    ["loads/pick", "inventory.write", pickLoad],
    ["loads/dispatch", "inventory.write", dispatchLoad],
    ["loads/recount", "inventory.write", recountLoad],
  ];
  // IP-VANDAY: the person on the phone takes over with their own PIN. The PIN is checked on the pool before the command's transaction.
  router.post("/api/v1/van/crew-sessions", async (/** @type {any} */ request) => {
    const body = request.body ?? {};
    const needsPin = body.office !== true;
    await requireCapability(request, "van.read"); // never let a stranger spend someone's PIN tries
    if (needsPin) {
      // IP-INT3FIX: own phone and the trip's phone first, so a wrong PIN from a stranger is never counted.
      await crewPinPrecheck(request.db, request.actor, body);
      await verifyCrewPinOnline(request.db, uuid(body.toProfileId), body.pin);
    }
    return command(request, ctx, "crew-sessions", "van.read", (db, actor, p) =>
      crewSessionCommand(db, actor, p, needsPin),
    );
  });
  for (const [action, cap, fn] of commands) {
    router.post(`/api/v1/van/${action}`, (/** @type {any} */ request) =>
      command(request, ctx, action, cap, fn),
    );
  }
  for (const kind of ["void", "cash", "stock"])
    router.post(
      `/api/v1/van/${kind}/approval-code`,
      (/** @type {any} */ request) =>
        command(
          request,
          ctx,
          `${kind}/approval-code`,
          `van.${kind}.approve`,
          (db, actor, p) => issueCode(db, actor, ctx.env, kind, p),
        ),
    );
}
