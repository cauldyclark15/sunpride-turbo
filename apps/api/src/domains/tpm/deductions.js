import { bounded, changed, command, office } from "./common.js";
import {
  choice,
  date,
  fail,
  integer,
  text,
  uuid,
} from "../orders/validation.js";
/** F-509 owned shared object for MT F-309 to call, never another channel deduction ledger.
 * @param {any} c @param {any} b */
export async function captureDeduction(c, b) {
  await office(c, "order.encode");
  const sourceKey = text(b.sourceKey, "Source key", 160),
    from = date(b.openedOn),
    due = date(b.dueOn);
  if (due < from || !integer(b.amountCentavos))
    fail("Set a positive deduction and a valid due date");
  const [owner] =
    await c.db`select id from profiles where id=${uuid(b.ownerProfileId)} and status='active' and deleted_at is null`;
  if (!owner) fail("Choose an active case owner");
  if (
    b.claimId &&
    !(await c.db`select 1 from claims where id=${uuid(b.claimId)}`).length
  )
    fail("Claim not found");
  const [r] =
    await c.db`insert into deductions(source_key,account_key,classification,invoice_reference,remittance_reference,claim_id,amount_centavos,owner_profile_id,opened_on,due_on,created_by)
    values(${sourceKey},${text(b.accountKey, "Account", 160)},${text(b.classification, "Classification", 80)},${text(b.invoiceReference, "Invoice reference", 160)},${text(b.remittanceReference, "Remittance reference", 160)},${b.claimId ?? null},${b.amountCentavos},${owner.id},${from},${due},${c.actor.subject}) returning id`;
  await changed(c, "deduction.captured", r.id);
  return { id: r.id };
}
/** @param {any} router */
export function installDeductions(router) {
  router.get("/api/v1/tpm/deductions", async (/** @type {any} */ c) => {
    await office(c);
    const rows = bounded(
      await c.db`select d.*,p.name as owner_name,((${new Date(c.now)} at time zone 'Asia/Manila')::date-d.opened_on)::integer as age_days from deductions d join profiles p on p.id=d.owner_profile_id order by d.status,d.due_on limit 501`,
    );
    return {
      rows: rows.map((d) => ({
        id: d.id,
        accountKey: d.account_key,
        classification: d.classification,
        invoiceReference: d.invoice_reference,
        remittanceReference: d.remittance_reference,
        claimId: d.claim_id,
        ownerName: d.owner_name,
        amountCentavos: Number(d.amount_centavos),
        recoveredCentavos: Number(d.recovered_centavos),
        ageDays: d.age_days,
        status: d.status,
        dueOn: String(
          d.due_on instanceof Date ? d.due_on.toISOString() : d.due_on,
        ).slice(0, 10),
      })),
    };
  });
  router.post("/api/v1/tpm/deductions/capture", (/** @type {any} */ c) =>
    command(
      c,
      "deduction.capture",
      c.body,
      (cc) => office(cc, "order.encode"),
      (cc) => captureDeduction(cc, c.body),
    ),
  );
  router.post("/api/v1/tpm/deductions/decide", (/** @type {any} */ c) =>
    command(
      c,
      "deduction.decide",
      c.body,
      (cc) => office(cc, "order.approve"),
      async (cc) => {
        const b = c.body,
          [r] =
            await cc.db`select * from deductions where id=${uuid(b.id)} for update`;
        if (!r || r.status === "resolved")
          fail("Deduction is closed or missing");
        const action = choice(
            b.action,
            ["assign", "dispute", "recover", "resolve"],
            "Case action",
          ),
          reason = text(b.reason, "Reason");
        let recovery = 0;
        if (action === "assign") {
          const [owner] =
            await cc.db`select id from profiles where id=${uuid(b.ownerProfileId)} and status='active' and deleted_at is null`;
          if (!owner) fail("Choose an active case owner");
          await cc.db`update deductions set owner_profile_id=${owner.id},updated_at=now() where id=${r.id}`;
        } else if (action === "dispute")
          await cc.db`update deductions set status='disputed',updated_at=now() where id=${r.id}`;
        else if (action === "recover") {
          recovery = integer(b.amountCentavos);
          if (
            !recovery ||
            BigInt(recovery) + BigInt(r.recovered_centavos) >
              BigInt(r.amount_centavos)
          )
            fail("Recovery exceeds outstanding deduction");
          await cc.db`update deductions set recovered_centavos=recovered_centavos+${recovery},updated_at=now() where id=${r.id}`;
        } else {
          if (Number(r.recovered_centavos) !== Number(r.amount_centavos))
            fail(
              "Record recovery before closing; SAP write-off decisions need a posting adapter",
            );
          await cc.db`update deductions set status='resolved',updated_at=now() where id=${r.id}`;
        }
        await cc.db`insert into deduction_events(deduction_id,action,actor_subject,reason,recovered_centavos) values(${r.id},${action},${cc.actor.subject},${reason},${recovery})`;
        await changed(cc, "deduction." + action, r.id);
        return { id: r.id };
      },
    ),
  );
}
