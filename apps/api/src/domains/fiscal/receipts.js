/**
 * IP-BIR routes: receipt print model + reprint, e-journal, tax summary, SC/PWD book, and the three small settings
 * (privilege-discount switch per till/route, BIR identifiers on a registration, buyer billing profile).
 *
 * Reads follow `GET /api/v1/fiscal/register`: van.read + the caller's org-unit scope; a seller sees only their own range.
 * Writes run in one transaction with the actor set for the audit trigger, record a change and publish "fiscal".
 */
import { tx } from "@sunpride/db/client";
import { forbidden } from "../../core/errors.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { recordChange } from "../../core/sync.js";
import { currentActor } from "../van/access.js";
import { scopeFilterForActor } from "../org/scope.js";
import { uuid, refuse, text, choice, date } from "../van/model.js";
import { documentEvent } from "./series.js";
import { loadPrintModel } from "./print-model.js";
import {
  prepareLegalSale,
  privilegeLabel,
  normalizeClaim,
} from "./legal-sale.js";
import {
  CAP_TYPES,
  DEFAULT_NOTE,
  capSetting,
  idKey,
  manilaWeekStart,
  manilaWeekEndsAt,
  usedThisWeek,
  weeklyLimitText,
} from "./privilege-cap.js";

const NONE = "00000000-0000-0000-0000-000000000000";

/** Which org units may this caller read? @param {any} db @param {any} actor @param {string|null} unitId */
async function readScope(db, actor, unitId) {
  await requireCapability({ db, actor }, "van.read");
  const scope = await scopeFilterForActor(db, actor);
  if (unitId) {
    await requireCapability({ db, actor }, "van.read", uuid(unitId));
    return { all: false, ids: [unitId] };
  }
  return {
    all: scope.unitIds === null,
    ids: scope.unitIds?.length ? scope.unitIds : [NONE],
  };
}

/** @param {any} v @param {string} what */
function day(v, what) {
  if (v === null || v === undefined || v === "") return null;
  return date(v) ?? refuse(`Choose a valid ${what} date`);
}

/** Commands that go through the shared `POST /api/v1/fiscal/<name>` wrapper in index.js. */
export const birCommands = {
  /** Switch statutory discounts on/off for a till or van route. @param {any} db @param {any} actor @param {any} p */
  "privilege/settings": async (db, actor, p) => {
    actor = await currentActor(db, actor);
    const orgUnitId = uuid(p.orgUnitId);
    await requireCapability({ db, actor }, "admin.manage", orgUnitId);
    const surface = choice(p.surface, ["store", "van"]);
    if (typeof p.enabled !== "boolean") refuse("Choose on or off");
    const routeId = p.routeId ? uuid(p.routeId) : null;
    const [row] =
      await db`insert into privilege_discount_settings(org_unit_id,surface,route_id,enabled,set_by) values(${orgUnitId},${surface},${routeId},${p.enabled},${actor.profileId}) returning id`;
    return { id: row.id };
  },
  /**
   * IP-SCPWD-CAP: set the weekly purchase limit on the senior / PWD discount (office, `admin.manage`). Append-only: every
   * change is a new row with who and when. `accountantConfirmed` is the office's record that Sunpride's accountant confirmed
   * the figure; until then the screens call the amount a default.
   * @param {any} db @param {any} actor @param {any} p
   */
  "privilege/cap": async (db, actor, p) => {
    actor = await currentActor(db, actor);
    await requireCapability({ db, actor }, "admin.manage");
    if (typeof p.enabled !== "boolean") refuse("Choose whether the weekly limit is on");
    const pesos = typeof p.capPesos === "number" ? p.capPesos : NaN;
    const centavos =
      p.capCentavos !== undefined
        ? p.capCentavos
        : Number.isFinite(pesos)
          ? Math.round(pesos * 100)
          : undefined;
    if (
      !Number.isSafeInteger(centavos) ||
      centavos <= 0 ||
      centavos > 100000000
    )
      refuse("Enter the weekly limit in pesos, for example 2500 (more than 0, up to 1,000,000).");
    if (p.accountantConfirmed !== undefined && typeof p.accountantConfirmed !== "boolean")
      refuse("Say whether the accountant confirmed this amount");
    const [row] =
      await db`insert into privilege_cap_settings(enabled,cap_centavos,accountant_confirmed,note,set_by) values(${p.enabled},${String(centavos)},${p.accountantConfirmed === true},${text(p.note, 300)},${actor.profileId}) returning id`;
    return { id: row.id };
  },
  /**
   * IP-INT5FIX: set the refund amount above which a supervisor must approve (office, `admin.manage`). The amount counts what
   * the sale has already had refunded, so it cannot be split around. One row per organization, `updated_by` says who last set it.
   * @param {any} db @param {any} actor @param {any} p
   */
  "refunds/policy": async (db, actor, p) => {
    actor = await currentActor(db, actor);
    await requireCapability({ db, actor }, "admin.manage");
    const pesos = typeof p.supervisorOverPesos === "number" ? p.supervisorOverPesos : NaN;
    const centavos =
      p.supervisorOverCentavos !== undefined
        ? p.supervisorOverCentavos
        : Number.isFinite(pesos)
          ? Math.round(pesos * 100)
          : undefined;
    if (
      !Number.isSafeInteger(centavos) ||
      centavos < 0 ||
      centavos > 100000000
    )
      refuse("Enter the refund amount in pesos, for example 500 (0 means every refund needs a supervisor; up to 1,000,000).");
    await db`insert into refund_policies(organization_id,supervisor_over_centavos,updated_by) values('sunpride',${String(centavos)},${actor.profileId})
      on conflict(organization_id) do update set supervisor_over_centavos=excluded.supervisor_over_centavos,updated_by=excluded.updated_by,updated_at=now()`;
    return { supervisorOverCentavos: centavos };
  },
  /** PTU / MIN / serial / accreditation / POS provider for a registration. @param {any} db @param {any} actor @param {any} p */
  "registrations/identifiers": async (db, actor, p) => {
    actor = await currentActor(db, actor);
    const [r] =
      await db`select * from fiscal_registrations where id=${uuid(p.registrationId)} for update`;
    if (!r) refuse("Choose a registration");
    await requireCapability({ db, actor }, "admin.manage", r.org_unit_id);
    const pick = (
      /** @type {string} */ k,
      /** @type {any} */ cur,
      /** @type {number} */ max,
    ) => (p[k] === undefined ? cur : text(p[k], max));
    const provider =
      p.posProvider === undefined ? r.pos_provider : p.posProvider;
    if (
      provider !== null &&
      (typeof provider !== "object" || Array.isArray(provider))
    )
      refuse("Enter the POS provider as name, address, TIN and accreditation");
    const prov = provider
      ? {
          name: text(provider.name, 150),
          address: text(provider.address, 300),
          tin: text(provider.tin, 25),
          accreditationNumber: text(provider.accreditationNumber, 80),
          accreditationDate: provider.accreditationDate
            ? date(provider.accreditationDate)
            : null,
        }
      : {};
    await db`update fiscal_registrations set
      ptu_number=${pick("ptuNumber", r.ptu_number, 80)},
      ptu_issued_on=${p.ptuIssuedOn === undefined ? r.ptu_issued_on : p.ptuIssuedOn ? date(p.ptuIssuedOn) : null},
      min_number=${pick("minNumber", r.min_number, 80)},
      machine_serial=${pick("machineSerial", r.machine_serial, 80)},
      accreditation_number=${pick("accreditationNumber", r.accreditation_number, 80)},
      accreditation_date=${p.accreditationDate === undefined ? r.accreditation_date : p.accreditationDate ? date(p.accreditationDate) : null},
      pos_provider=${prov},
      updated_at=now()
      where id=${r.id}`;
    return { id: r.id };
  },
  /** Buyer name / TIN / address kept on the store record for invoices. @param {any} db @param {any} actor @param {any} p */
  "buyers/save": async (db, actor, p) => {
    actor = await currentActor(db, actor);
    const outletId = uuid(p.outletId);
    const [o] =
      await db`select custodian_org_unit_id from outlets where id=${outletId} and deleted_at is null`;
    if (!o) refuse("Choose a store");
    await requireCapability(
      { db, actor },
      "admin.manage",
      o.custodian_org_unit_id,
    );
    const tin = text(p.tin, 25);
    if (tin && !/^[0-9][0-9\- ]{8,23}$/.test(tin))
      refuse("Enter the TIN as digits, for example 123-456-789-000.");
    await db`insert into outlet_billing_profiles(outlet_id,registered_name,tin,address,updated_by) values(${outletId},${text(p.registeredName, 150)},${tin},${text(p.address, 400)},${actor.profileId})
      on conflict(outlet_id) do update set registered_name=excluded.registered_name,tin=excluded.tin,address=excluded.address,updated_by=excluded.updated_by,updated_at=now()`;
    return { outletId };
  },
};

/** @param {any} router @param {any} ctx */
export function installBirRoutes(router, ctx) {
  /** A seller only reads their own range; offices read their scope. @param {any} db @param {any} actor @param {any} doc @param {string} orgUnitId */
  async function mayRead(db, actor, doc, orgUnitId) {
    await requireCapability({ db, actor }, "van.read", orgUnitId);
    if (actor.role === "sales") {
      const [a] =
        await db`select profile_id from fiscal_allocations where id=${doc.allocation_id}`;
      if (a?.profile_id !== actor.profileId)
        refuse("This receipt belongs to another seller", "out_of_scope");
    }
  }
  /** @param {any} db @param {string} documentId */
  const journalOf = (db, documentId) =>
    db`select seq,entry_kind,copy_number,reason,occurred_at,model_hash,hash_basis,print_outcome,
        (select p.name from profiles p where p.id=j.actor_profile_id) as actor_name
       from fiscal_ejournal j where document_id=${documentId} order by seq`;

  /** Recent receipts for the reprint screen: newest first, searchable by printed number or buyer. */
  router.get("/api/v1/fiscal/receipts", async (/** @type {any} */ c) =>
    tx(c.db, async (db) => {
      const actor = await currentActor(db, c.actor);
      const q = c.url.searchParams;
      const { all, ids } = await readScope(db, actor, q.get("unitId"));
      const dayFilter = day(q.get("day"), "day");
      const needle = (q.get("q") ?? "").trim().slice(0, 60);
      const like = `%${needle.replace(/[%_\\]/g, "")}%`;
      const limit = Math.min(
        Math.max(Number(q.get("limit") ?? 50) || 50, 1),
        200,
      );
      const sellerOnly = actor.role === "sales";
      const rows =
        await db`select d.id,d.source_id,d.source_type,d.document_number,r.document_type,d.issued_at,
          d.snapshot->>'totalMinor' as total_due,
          coalesce(d.snapshot->'buyer'->>'name',d.snapshot->'customer'->>'name') as buyer_name,
          d.snapshot->'discountClaim'->>'type' as privilege_type,
          exists(select 1 from fiscal_document_events e where e.document_id=d.id and e.kind='void') as voided,
          (select count(*)::int from fiscal_document_events e where e.document_id=d.id and e.kind='reprint') as reprints
        from fiscal_documents d join fiscal_series s on s.id=d.series_id join fiscal_registrations r on r.id=s.registration_id
          join fiscal_allocations a on a.id=d.allocation_id
        where d.source_type in ('store_sale','van_sale','van_collection')
          and (${all} or r.org_unit_id in ${db(ids)})
          and (${!sellerOnly} or a.profile_id=${actor.profileId})
          and (${dayFilter}::date is null or (d.issued_at at time zone 'Asia/Manila')::date=${dayFilter})
          and (${needle === ""} or d.document_number ilike ${like} or coalesce(d.snapshot->'buyer'->>'name',d.snapshot->'customer'->>'name','') ilike ${like})
        order by d.issued_at desc limit ${limit + 1}`;
      return {
        receipts: rows.slice(0, limit).map((/** @type {any} */ r) => ({
          id: r.id,
          saleId: r.source_id,
          sourceType: r.source_type,
          documentNumber: r.document_number,
          documentType: r.document_type,
          issuedAt: r.issued_at,
          totalDueMinor: r.total_due,
          buyerName: r.buyer_name,
          privilegeType: r.privilege_type,
          voided: r.voided,
          reprints: r.reprints,
        })),
        hasMore: rows.length > limit,
      };
    }),
  );

  router.get(
    "/api/v1/fiscal/receipts/:id/print-model",
    async (/** @type {any} */ c) =>
      tx(c.db, async (db) => {
        const actor = await currentActor(db, c.actor);
        const { model, doc, orgUnitId } = await loadPrintModel(db, c.params.id);
        await mayRead(db, actor, doc, orgUnitId);
        const journal = await journalOf(db, doc.id);
        return { model, journal };
      }),
  );

  router.post(
    "/api/v1/fiscal/receipts/:id/reprint",
    async (/** @type {any} */ c) => {
      const out = await tx(c.db, async (db) => {
        const actor = await currentActor(db, c.actor);
        await db`select set_config('sunpride.actor',${actor.userId},true)`;
        const { doc, orgUnitId } = await loadPrintModel(db, c.params.id);
        await mayRead(db, actor, doc, orgUnitId);
        const reason = text(c.body?.reason, 300, true);
        const result = await documentEvent(db, actor, {
          documentId: doc.id,
          kind: "reprint",
          reason,
          requestKey: c.body?.requestKey ?? crypto.randomUUID(),
          outcome: choice(c.body?.outcome ?? "printed", [
            "printed",
            "not_printed",
            "uncertain",
          ]),
        });
        await recordChange(db, {
          entity: "fiscal",
          entityId: actor.profileId,
          scopeKey: `profile:${actor.profileId}`,
          op: "upsert",
        });
        const { model } = await loadPrintModel(db, doc.id, {
          copy: {
            kind: "reprint",
            number: (
              await db`select count(*)::int as n from fiscal_document_events where document_id=${doc.id} and kind='reprint'`
            )[0].n,
          },
        });
        return {
          eventId: result.id,
          model,
          journal: await journalOf(db, doc.id),
        };
      });
      ctx.publish("fiscal");
      return out;
    },
  );

  router.get("/api/v1/fiscal/ejournal", async (/** @type {any} */ c) =>
    tx(c.db, async (db) => {
      const actor = await currentActor(db, c.actor);
      const q = c.url.searchParams;
      const { all, ids } = await readScope(db, actor, q.get("unitId"));
      const from = day(q.get("from"), "start"),
        to = day(q.get("to"), "end");
      const docId = q.get("documentId") ? uuid(q.get("documentId")) : null;
      const kind = q.get("kind")
        ? choice(q.get("kind"), ["printed", "reprinted", "voided", "spoiled"])
        : null;
      const limit = Math.min(
        Math.max(Number(q.get("limit") ?? 100) || 100, 1),
        500,
      );
      const sellerOnly = actor.role === "sales";
      const rows =
        await db`select j.seq,j.org_unit_id,j.document_id,j.document_number,j.document_type,j.entry_kind,j.copy_number,j.reason,j.occurred_at,j.model_hash,j.hash_basis,j.print_outcome,j.prev_hash,j.entry_hash,
          (select p.name from profiles p where p.id=j.actor_profile_id) as actor_name
        from fiscal_ejournal j join fiscal_documents d on d.id=j.document_id join fiscal_allocations a on a.id=d.allocation_id
        where (${all} or j.org_unit_id in ${db(ids)})
          and (${!sellerOnly} or a.profile_id=${actor.profileId})
          and (${docId}::uuid is null or j.document_id=${docId})
          and (${kind}::text is null or j.entry_kind=${kind})
          and (${from}::date is null or (j.occurred_at at time zone 'Asia/Manila')::date>=${from})
          and (${to}::date is null or (j.occurred_at at time zone 'Asia/Manila')::date<=${to})
        order by j.seq desc limit ${limit + 1}`;
      let broken = [];
      if (!all || q.get("unitId")) {
        for (const id of ids) {
          if (id === NONE) continue;
          broken.push(
            ...(await db`select fiscal_ejournal_broken(${id}) as seq`).map(
              (/** @type {any} */ r) => String(r.seq),
            ),
          );
        }
      }
      return {
        entries: rows.slice(0, limit),
        hasMore: rows.length > limit,
        chainBroken: broken,
      };
    }),
  );

  router.get("/api/v1/fiscal/tax-summary", async (/** @type {any} */ c) =>
    tx(c.db, async (db) => {
      const actor = await currentActor(db, c.actor);
      if (actor.role === "sales")
        refuse("The tax summary is for the office", "forbidden");
      const q = c.url.searchParams;
      const { all, ids } = await readScope(db, actor, q.get("unitId"));
      const from = day(q.get("from"), "start"),
        to = day(q.get("to"), "end");
      // IP-INT2FIX: a credit memo (refund) is a negative row of the same buckets as the sale it returns, so output VAT is not
      // overstated after a refund. Its tax facts are the frozen snapshot of the credit memo document.
      const promo = db`case when d.snapshot->'tax'->>'promoDiscountMinor' ~ '^[0-9]{1,15}$' then (d.snapshot->'tax'->>'promoDiscountMinor')::bigint else 0 end`;
      const priv = db`case when d.snapshot->'tax'->>'privilegeDiscountMinor' ~ '^[0-9]{1,15}$' then (d.snapshot->'tax'->>'privilegeDiscountMinor')::bigint else 0 end`;
      const removed = db`case when d.snapshot->'tax'->>'vatRemovedMinor' ~ '^[0-9]{1,15}$' then (d.snapshot->'tax'->>'vatRemovedMinor')::bigint else 0 end`;
      const base = db`from (
          select t.document_id,t.org_unit_id,t.business_date,t.gross_centavos,t.vatable_centavos,t.vat_centavos,t.vat_exempt_centavos,t.zero_rated_centavos,
            t.promo_discount_centavos,t.privilege_discount_centavos,t.vat_removed_centavos,t.privilege_type,t.total_due_centavos,false as credit
            from fiscal_document_tax t
          union all
          select d.id,r.org_unit_id,(d.issued_at at time zone 'Asia/Manila')::date,
            -(case when d.snapshot->'tax'->>'grossMinor' ~ '^[0-9]{1,15}$' then (d.snapshot->'tax'->>'grossMinor')::bigint else (d.snapshot->'tax'->>'totalMinor')::bigint end),
            -(d.snapshot->'tax'->>'vatableSalesMinor')::bigint,-(d.snapshot->'tax'->>'vatMinor')::bigint,
            -(d.snapshot->'tax'->>'vatExemptMinor')::bigint,-(d.snapshot->'tax'->>'zeroRatedMinor')::bigint,
            -(${promo}),-(${priv}),-(${removed}),
            case when ${priv}>0 or ${removed}>0 then d.snapshot->'tax'->>'privilegeType' end,
            -(d.snapshot->'tax'->>'totalMinor')::bigint,true
            from fiscal_documents d join fiscal_series s on s.id=d.series_id join fiscal_registrations r on r.id=s.registration_id
           where r.document_type='credit_memo'
             and d.snapshot->'tax'->>'totalMinor' ~ '^[0-9]{1,15}$' and d.snapshot->'tax'->>'vatableSalesMinor' ~ '^[0-9]{1,15}$'
             and d.snapshot->'tax'->>'vatMinor' ~ '^[0-9]{1,15}$' and d.snapshot->'tax'->>'vatExemptMinor' ~ '^[0-9]{1,15}$'
             and d.snapshot->'tax'->>'zeroRatedMinor' ~ '^[0-9]{1,15}$'
        ) t
        where (${all} or t.org_unit_id in ${db(ids)})
          and (${from}::date is null or t.business_date>=${from})
          and (${to}::date is null or t.business_date<=${to})
          and not exists(select 1 from fiscal_document_events e where e.document_id=t.document_id and e.kind='void')`;
      const days =
        await db`select t.business_date::text as date, (count(*) filter (where not t.credit))::int as documents,
          sum(t.gross_centavos)::text as gross, sum(t.vatable_centavos)::text as vatable, sum(t.vat_centavos)::text as vat,
          sum(t.vat_exempt_centavos)::text as vat_exempt, sum(t.zero_rated_centavos)::text as zero_rated,
          sum(t.promo_discount_centavos)::text as promo_discount, sum(t.privilege_discount_centavos)::text as privilege_discount,
          sum(t.vat_removed_centavos)::text as vat_removed, sum(t.total_due_centavos)::text as total_due ${base}
          group by t.business_date order by t.business_date desc limit 400`;
      const privilege =
        await db`select t.privilege_type as type, (count(*) filter (where not t.credit))::int as documents,
          sum(t.privilege_discount_centavos)::text as discount, sum(t.vat_removed_centavos)::text as vat_removed,
          sum(t.gross_centavos)::text as gross ${base} and t.privilege_type is not null
          group by t.privilege_type order by t.privilege_type`;
      const [totals] =
        await db`select (count(*) filter (where not t.credit))::int as documents,
          coalesce(sum(t.gross_centavos),0)::text as gross, coalesce(sum(t.vatable_centavos),0)::text as vatable, coalesce(sum(t.vat_centavos),0)::text as vat,
          coalesce(sum(t.vat_exempt_centavos),0)::text as vat_exempt, coalesce(sum(t.zero_rated_centavos),0)::text as zero_rated,
          coalesce(sum(t.promo_discount_centavos),0)::text as promo_discount, coalesce(sum(t.privilege_discount_centavos),0)::text as privilege_discount,
          coalesce(sum(t.vat_removed_centavos),0)::text as vat_removed, coalesce(sum(t.total_due_centavos),0)::text as total_due ${base}`;
      return {
        days,
        totals,
        privilege: privilege.map((/** @type {any} */ r) => ({
          ...r,
          label: privilegeLabel(r.type),
        })),
      };
    }),
  );

  /** The SC / PWD book: who got which statutory discount, on which invoice. */
  router.get("/api/v1/fiscal/privilege/claims", async (/** @type {any} */ c) =>
    tx(c.db, async (db) => {
      const actor = await currentActor(db, c.actor);
      if (actor.role === "sales")
        refuse("The discount book is for the office", "forbidden");
      const q = c.url.searchParams;
      const { all, ids } = await readScope(db, actor, q.get("unitId"));
      const from = day(q.get("from"), "start"),
        to = day(q.get("to"), "end");
      const type = q.get("type") || null;
      const rows =
        await db`select k.id,k.source_type,k.privilege_type,k.id_number,k.holder_name,k.applied,k.gross_centavos::text,k.privilege_discount_centavos::text,k.vat_removed_centavos::text,k.total_centavos::text,k.created_at,d.document_number
        from sale_discount_claims k left join fiscal_documents d on d.id=k.fiscal_document_id
        where (${all} or k.org_unit_id in ${db(ids)})
          and (${type}::text is null or k.privilege_type=${type})
          and (${from}::date is null or (k.created_at at time zone 'Asia/Manila')::date>=${from})
          and (${to}::date is null or (k.created_at at time zone 'Asia/Manila')::date<=${to})
        order by k.created_at desc limit 501`;
      return { claims: rows.slice(0, 500), truncated: rows.length > 500 };
    }),
  );

  /** Server recompute of a statutory discount for a basket (no sale is written). Web and handheld show these amounts. */
  router.post(
    "/api/v1/fiscal/discount-claims/preview",
    async (/** @type {any} */ c) =>
      tx(c.db, async (db) => {
        const actor = await currentActor(db, c.actor);
        const b = c.body ?? {};
        const orgUnitId = uuid(b.orgUnitId);
        await requireCapability({ db, actor }, "van.read", orgUnitId);
        if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100)
          refuse("Add 1 to 100 items to work out the discount");
        const money = (/** @type {any} */ v) => {
          if (!Number.isSafeInteger(v) || v < 0)
            refuse("Amounts are whole centavos");
          return v;
        };
        const legal = await prepareLegalSale(db, {
          surface: /** @type {"store"|"van"} */ (
            choice(b.surface, ["store", "van"])
          ),
          orgUnitId,
          routeId: b.routeId ? uuid(b.routeId) : null,
          payload: { discountClaim: b.discountClaim ?? null },
          at: Date.now(),
          capMode: "authority",
          lockCap: false,
          lines: b.lines.map((/** @type {any} */ l) => ({
            productId: uuid(l.productId),
            description: text(l.description, 150) ?? "Item",
            grossCentavos: money(l.grossCentavos),
            promoDiscountCentavos: money(l.promoDiscountCentavos ?? 0),
            taxTreatment: l.taxTreatment ?? null,
            taxBasisPoints: l.taxBasisPoints ?? null,
          })),
        });
        if (!legal.claim) refuse("Enter the discount type, ID number and name");
        return {
          label: privilegeLabel(legal.claim.type),
          lines: legal.results,
          totals: legal.totals,
          // IP-SCPWD-CAP: the server's own weekly-limit answer: what part gets the discount and what is left
          cap: legal.cap,
        };
      }),
  );

  router.get(
    "/api/v1/fiscal/privilege/settings",
    async (/** @type {any} */ c) =>
      tx(c.db, async (db) => {
        const actor = await currentActor(db, c.actor);
        const { all, ids } = await readScope(
          db,
          actor,
          c.url.searchParams.get("unitId"),
        );
        const rows =
          await db`select id,org_unit_id,surface,route_id,enabled,effective_from from privilege_discount_settings
        where (${all} or org_unit_id in ${db(ids)}) order by effective_from desc limit 200`;
        return {
          settings: rows,
          defaults: { store: true, van: false },
          canManage: roleHas(actor.role, "admin.manage"),
        };
      }),
  );

  /**
   * IP-SCPWD-CAP: the weekly limit in force, and (with `type` + `idNumber`) what one card has used this week across every
   * store and van. Read by the settings screen and the till's online lookup.
   */
  router.get("/api/v1/fiscal/privilege/cap", async (/** @type {any} */ c) =>
    tx(c.db, async (db) => {
      const actor = await currentActor(db, c.actor);
      await requireCapability({ db, actor }, "van.read");
      const q = c.url.searchParams;
      const now = Date.now();
      const setting = await capSetting(db, now);
      const history = await db`select s.enabled,s.cap_centavos::text,s.accountant_confirmed,s.note,s.effective_from,p.name as set_by_name
        from privilege_cap_settings s join profiles p on p.id=s.set_by order by s.effective_from desc,s.created_at desc limit 20`;
      /** @type {any} */ let card = null;
      const type = q.get("type"),
        idNumber = q.get("idNumber");
      if (type || idNumber) {
        // A card's use this week is a customer's purchase history: only roles that sell, approve or manage may look one up.
        if (
          !["van.operate", "van.cash.approve", "admin.manage"].some((cap) =>
            roleHas(actor.role, cap),
          )
        )
          throw forbidden("Looking up a card needs a seller, approver or admin role");
        const claim = normalizeClaim({
          type,
          idNumber,
          holderName: "Lookup",
        });
        if (claim && CAP_TYPES.includes(claim.type)) {
          const used = await usedThisWeek(
            db,
            idKey(claim.type, claim.idNumber),
            manilaWeekStart(now),
          );
          const left = setting.enabled
            ? Math.max(0, setting.capCentavos - used)
            : null;
          card = {
            type: claim.type,
            usedCentavos: used,
            leftCentavos: left,
            message: left === null ? null : weeklyLimitText(left),
          };
        }
      }
      return {
        setting: {
          enabled: setting.enabled,
          capCentavos: setting.capCentavos,
          accountantConfirmed: setting.accountantConfirmed,
          isDefault: setting.isDefault,
          note: setting.isDefault ? DEFAULT_NOTE : setting.note,
          effectiveFrom: setting.effectiveFrom,
        },
        week: {
          start: manilaWeekStart(now),
          endsAt: manilaWeekEndsAt(now),
          note: "Monday to Sunday, Manila time",
        },
        appliesTo: CAP_TYPES,
        history: history.map((/** @type {any} */ r) => ({
          enabled: r.enabled,
          capCentavos: Number(r.cap_centavos),
          accountantConfirmed: r.accountant_confirmed,
          note: r.note,
          effectiveFrom: new Date(r.effective_from).getTime(),
          setBy: r.set_by_name,
        })),
        card,
        canManage: roleHas(actor.role, "admin.manage"),
      };
    }),
  );

  /** The refund supervisor amount in force, for the office screen. Anyone who can read the van sees it; `canManage` says who can change it. */
  router.get("/api/v1/fiscal/refunds/policy", async (/** @type {any} */ c) =>
    tx(c.db, async (db) => {
      const actor = await currentActor(db, c.actor);
      await requireCapability({ db, actor }, "van.read");
      const [row] =
        await db`select p.supervisor_over_centavos::text as over,p.updated_at,p.updated_by,u.name as updated_by_name from refund_policies p left join profiles u on u.id::text=p.updated_by where p.organization_id='sunpride'`;
      return {
        supervisorOverCentavos: Number(row?.over ?? 50000),
        isDefault: !row || row.updated_by === "system:default",
        updatedAt: row ? new Date(row.updated_at).getTime() : null,
        updatedBy: row?.updated_by_name ?? null,
        canManage: roleHas(actor.role, "admin.manage"),
      };
    }),
  );

  router.get("/api/v1/fiscal/buyers", async (/** @type {any} */ c) =>
    tx(c.db, async (db) => {
      const actor = await currentActor(db, c.actor);
      await requireCapability({ db, actor }, "van.read");
      const outletId = uuid(c.url.searchParams.get("outletId"));
      const [o] =
        await db`select o.id,o.name,o.address,b.registered_name,b.tin,b.address as billing_address from outlets o left join outlet_billing_profiles b on b.outlet_id=o.id where o.id=${outletId} and o.deleted_at is null`;
      if (!o) refuse("Choose a store");
      return {
        outletId,
        name: o.registered_name ?? o.name,
        tin: o.tin ?? null,
        address: o.billing_address ?? o.address ?? null,
      };
    }),
  );
}
