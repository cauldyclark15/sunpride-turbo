import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { date, text, uuid } from "../orders/validation.js";
import { bindingAccess, officeRead } from "./hierarchy.js";
import { command, audit, money } from "./common.js";
import { deductionFlow } from "./metrics.js";

/** @param {any} c @param {string} id @param {string} [cap] */
export async function deductionAccess(c, id, cap = "order.encode") {
  const [row] = await c.db`select * from mt_deductions where id=${uuid(id)}`;
  if (!row) throw new ApiError("not_found", 404, "Deduction not found");
  const binding = await bindingAccess(c, row.binding_id, cap);
  return { row, binding };
}
/** @param {any} c @param {string} id @param {string} [cap] */
async function ownerAccess(c, id, cap = "order.encode") {
  const [p] =
    await c.db`select id,org_unit_id from profiles where id=${uuid(id)} and status='active' and deleted_at is null`;
  if (!p || !p.org_unit_id)
    throw new ApiError(
      "invalid_request",
      400,
      "Choose an active owner with an assigned area",
    );
  await requireCapability(c, cap, p.org_unit_id);
  return p.id;
}
/** @param {any} c @param {any} r */
async function view(c, r) {
  const { binding } = await deductionAccess(c, r.id, "report.read");
  const [meta] =
    await c.db`select t.label as type_label,p.name as owner_name,m.reference,m.received_on,
    ((now() at time zone 'Asia/Manila')::date-m.received_on)::int as age_days,((now() at time zone 'Asia/Manila')::date-d.due_on)::int as overdue_days,i.invoice_number,
    f.status as financial_status,f.recovered_centavos as financial_recovered_centavos
    from mt_deductions d join mt_deduction_types t on t.id=d.type_id join profiles p on p.id=d.owner_profile_id
    join mt_remittances m on m.id=d.remittance_id left join mt_invoice_replicas i on i.id=d.invoice_id left join deductions f on f.id=d.financial_case_id where d.id=${r.id}`;
  return {
    ...r,
    ...meta,
    branchLabel: binding.label,
    amountCentavos: Number(r.amount_centavos),
    financialRecoveredCentavos:
      meta.financial_recovered_centavos == null
        ? null
        : Number(meta.financial_recovered_centavos),
    disputes:
      await c.db`select id,reference,message,status,response,created_at from mt_disputes where deduction_id=${r.id} order by created_at`,
    events:
      await c.db`select action,note,created_at from mt_deduction_events where deduction_id=${r.id} order by created_at,id`,
  };
}
/** @param {any} router */
export function installDeductions(router) {
  router.get("/api/v1/mt/deductions", async (/** @type {any} */ c) => {
    await officeRead(c);
    const all =
      await c.db`select * from mt_deductions order by (status<>'resolved') desc,due_on,id limit 1001`;
    if (all.length > 1000)
      throw new ApiError(
        "capacity",
        422,
        "Narrow the deduction archive before continuing",
      );
    const rows = [];
    for (const r of all)
      try {
        rows.push(await view(c, r));
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 403) throw e;
      }
    const open = rows.filter((r) => r.status !== "resolved");
    return {
      rows,
      summary: {
        openCentavos: open.reduce((n, r) => n + r.amountCentavos, 0),
        overdue: open.filter((r) => r.overdue_days > 0).length,
        unlinked: open.filter((r) => !r.claim_reference && !r.disputes.length)
          .length,
      },
      flow: deductionFlow(rows, c.now),
      freshness: Date.now(),
    };
  });
  router.post(
    "/api/v1/mt/remittances/capture",
    async (/** @type {any} */ c) => {
      const b = c.body ?? {};
      return command(
        c,
        "remittance.capture",
        b,
        (cc) => bindingAccess(cc, b.bindingId, "order.encode"),
        async (cc) => {
          const gross = money(b.grossCentavos),
            paid = money(b.paidCentavos),
            day = date(b.receivedOn);
          if (day > new Date(cc.now + 8 * 3600_000).toISOString().slice(0, 10))
            throw new ApiError(
              "invalid_request",
              400,
              "Remittance cannot be in the future",
            );
          if (
            !Array.isArray(b.deductions) ||
            !b.deductions.length ||
            b.deductions.length > 100
          )
            throw new ApiError("invalid_request", 400, "Add 1–100 deductions");
          const total = b.deductions.reduce(
            (/** @type {number} */ n, /** @type {any} */ l) =>
              n + money(l.amountCentavos),
            0,
          );
          if (!Number.isSafeInteger(total) || paid + total !== gross)
            throw new ApiError(
              "unbalanced_remittance",
              422,
              "Paid plus deductions must equal the gross remittance",
            );
          const [m] =
            await cc.db`insert into mt_remittances(binding_id,reference,received_on,gross_centavos,paid_centavos,created_by) values(${uuid(b.bindingId)},${text(b.reference, "Remittance reference", 120)},${day},${gross},${paid},${cc.user.id}) returning id`;
          for (const l of b.deductions) {
            const [type] =
              await cc.db`select * from mt_deduction_types where id=${uuid(l.typeId)} and effective_from<=${new Date(`${day}T23:59:59+08:00`)} and (effective_to is null or effective_to>${new Date(`${day}T00:00:00+08:00`)})`;
            if (!type || !l.amountCentavos)
              throw new ApiError(
                "invalid_request",
                400,
                "Choose an effective deduction type and positive amount",
              );
            if (l.invoiceId) {
              const [i] =
                await cc.db`select binding_id from mt_invoice_replicas where id=${uuid(l.invoiceId)}`;
              if (i?.binding_id !== b.bindingId)
                throw new ApiError(
                  "out_of_scope",
                  403,
                  "Invoice belongs to another account",
                );
            }
            const owner = await ownerAccess(
              cc,
              l.ownerProfileId ?? cc.actor.profileId,
            );
            const [d] =
              await cc.db`insert into mt_deductions(remittance_id,binding_id,invoice_id,type_id,amount_centavos,claim_reference,owner_profile_id,due_on)
          values(${m.id},${b.bindingId},${l.invoiceId ?? null},${type.id},${l.amountCentavos},${l.claimReference ? text(l.claimReference, "Claim reference", 160) : null},${owner},${day}::date+${type.sla_days}::int) returning id`;
            await cc.db`insert into mt_deduction_events(deduction_id,actor_user_id,action,note) values(${d.id},${cc.user.id},'captured','Captured from account remittance')`;
          }
          await audit(cc, "remittance.captured", m.id);
          return { id: m.id };
        },
      );
    },
  );
  router.post("/api/v1/mt/deductions/update", async (/** @type {any} */ c) => {
    const b = c.body ?? {};
    const cap = b.resolve ? "order.approve" : "order.encode";
    return command(
      c,
      "deduction.update",
      b,
      (cc) => deductionAccess(cc, b.id, cap),
      async (cc) => {
        const { row } = await deductionAccess(cc, b.id, cap);
        if (row.status === "resolved")
          throw new ApiError(
            "conflict",
            409,
            "This deduction is already resolved",
          );
        const owner = await ownerAccess(
          cc,
          b.ownerProfileId ?? row.owner_profile_id,
          cap,
        );
        const [type] =
          await cc.db`select * from mt_deduction_types where id=${uuid(b.typeId ?? row.type_id)} and effective_from<=statement_timestamp() and (effective_to is null or effective_to>statement_timestamp())`;
        if (!type)
          throw new ApiError(
            "invalid_request",
            400,
            "Choose a current deduction type",
          );
        const [m] =
          await cc.db`select received_on from mt_remittances where id=${row.remittance_id}`;
        const claim =
          b.claimReference !== undefined
            ? b.claimReference
              ? text(b.claimReference, "Claim reference", 160)
              : null
            : row.claim_reference;
        if (b.resolve) {
          await requireCapability(cc, "order.approve");
          const [open] =
            await cc.db`select id from mt_disputes where deduction_id=${row.id} and status='open'`;
          if (open)
            throw new ApiError(
              "open_dispute",
              422,
              "Respond to the open dispute before resolving",
            );
        }
        const note = text(b.note, "Work note", 1000);
        await cc.db`update mt_deductions set owner_profile_id=${owner},type_id=${type.id},claim_reference=${claim},due_on=${new Date(m.received_on).toISOString().slice(0, 10)}::date+${type.sla_days}::int,
        status=${b.resolve ? "resolved" : row.status},resolution=${b.resolve ? note : null},updated_at=now() where id=${row.id}`;
        await cc.db`insert into mt_deduction_events(deduction_id,actor_user_id,action,note) values(${row.id},${cc.user.id},${b.resolve ? "resolved" : "updated"},${note})`;
        await audit(cc, "deduction.updated", row.id);
        return { id: row.id };
      },
    );
  });
  router.post("/api/v1/mt/disputes/respond", async (/** @type {any} */ c) => {
    const b = c.body ?? {};
    return command(
      c,
      "dispute.respond",
      b,
      async (cc) => {
        await deductionAccess(cc, b.deductionId, "order.approve");
      },
      async (cc) => {
        const [d] =
          await cc.db`select * from mt_disputes where id=${uuid(b.id)} and deduction_id=${uuid(b.deductionId)} and status='open'`;
        if (!d) throw new ApiError("conflict", 409, "Open dispute not found");
        if (!["accepted", "rejected"].includes(b.status))
          throw new ApiError(
            "invalid_request",
            400,
            "Accept or reject the dispute",
          );
        const note = text(b.response, "Customer response", 1000);
        await cc.db`update mt_disputes set status=${b.status},response=${note},responded_by=${cc.user.id},responded_at=now(),updated_at=now() where id=${d.id}`;
        await cc.db`update mt_deductions set status=${b.status === "accepted" ? "disputed" : "open"},updated_at=now() where id=${d.deduction_id}`;
        await cc.db`insert into mt_deduction_events(deduction_id,actor_user_id,action,note) values(${d.deduction_id},${cc.user.id},'dispute.responded',${note})`;
        await audit(cc, "dispute.responded", d.id);
        return { id: d.id };
      },
    );
  });
}
