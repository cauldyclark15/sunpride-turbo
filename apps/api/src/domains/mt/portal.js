import { ApiError } from "../../core/errors.js";
import { text, uuid } from "../orders/validation.js";
import { bindings, within } from "./hierarchy.js";
import { audit, command } from "./common.js";
import { deliveryStatus } from "./delivery.js";

/** External customer identities get no employee profile/capabilities. Recheck membership
 * and session on every read/write, including receipt replay and hierarchy changes.
 * @param {any} c */
export async function portalAccess(c) {
  if (!c.user || !c.session)
    throw new ApiError(
      "unauthenticated",
      401,
      "Sign in to the customer portal",
    );
  // PostgreSQL now() is the transaction START, which can precede a long lock wait.
  // Use one fresh server-clock instant for session, membership and hierarchy grants.
  const [clock] = await c.db`select clock_timestamp() as at`;
  const checkedAt = new Date(clock.at).getTime(),
    at = new Date(checkedAt).toISOString();
  const [member] =
    await c.db`select m.* from mt_portal_memberships m join users u on u.id=m.user_id
    join sessions s on s.user_id=u.id and s.id=${c.session.id}
    where m.user_id=${c.user.id} and u.disabled_at is null and s.revoked_at is null and s.expires_at>${at} and s.app='web'
    and m.effective_from<=${at} and (m.effective_to is null or m.effective_to>${at})`;
  if (!member)
    throw new ApiError(
      "forbidden",
      403,
      "Customer portal access is not active",
    );
  const paths = await bindings(c.db, checkedAt);
  if (paths.length > 2000)
    throw new ApiError(
      "capacity",
      422,
      "Account hierarchy exceeds supported portal size",
    );
  const allowed = paths.filter((/** @type {any} */ b) =>
    within(b, member.scope_kind, member.scope_key),
  );
  return { member, allowed };
}
/** SEAM(CALLFLOW): delivery's canonical release/drop/ePOD projection will extend these
 * order milestones. Never fabricate delivery from an invoice or a PO receipt.
 * @param {any} db @param {any} p */
async function milestones(db, p) {
  const history = p.order_id
    ? await db`select action,to_status,created_at from order_history where order_id=${p.order_id} order by created_at,id`
    : [];
  return [
    { stage: "received", at: p.created_at },
    ...(p.confirmed_at ? [{ stage: "confirmed", at: p.confirmed_at }] : []),
    ...history
      .filter((/** @type {any} */ h) =>
        ["approved", "posted", "fulfilled", "rejected", "voided"].includes(
          h.to_status,
        ),
      )
      .map((/** @type {any} */ h) => ({
        stage: h.to_status,
        at: h.created_at,
      })),
  ];
}
/** @param {any} router */
export function installPortal(router) {
  router.get("/api/v1/portal/session", async (/** @type {any} */ c) => {
    const { member, allowed } = await portalAccess(c);
    return {
      userType: "external_customer",
      name: member.name,
      branches: allowed.map((/** @type {any} */ b) => ({
        id: b.id,
        label: b.label,
      })),
    };
  });
  router.get("/api/v1/portal/overview", async (/** @type {any} */ c) => {
    const { allowed } = await portalAccess(c),
      ids = allowed.map((/** @type {any} */ b) => b.id);
    if (!ids.length)
      return { purchaseOrders: [], invoices: [], deductions: [] };
    const po =
      await c.db`select p.id,p.po_number,p.status,p.order_id,p.created_at,p.confirmed_at,p.binding_id,o.order_number,o.status as order_status,o.total_centavos
      from inbound_purchase_orders p left join orders o on o.id=p.order_id and o.deleted_at is null where p.binding_id in ${c.db(ids)} order by p.created_at desc limit 501`;
    const invoices =
      await c.db`select id,binding_id,invoice_number,amount_centavos,issued_on,due_on,source,source_version,received_at from mt_invoice_replicas where binding_id in ${c.db(ids)} order by issued_on desc limit 501`;
    const deductions =
      await c.db`select d.id,d.binding_id,d.amount_centavos,d.status,d.claim_reference,d.due_on,t.label,m.reference,m.received_on,((now() at time zone 'Asia/Manila')::date-m.received_on)::int as age_days,i.invoice_number
      from mt_deductions d join mt_deduction_types t on t.id=d.type_id join mt_remittances m on m.id=d.remittance_id left join mt_invoice_replicas i on i.id=d.invoice_id where d.binding_id in ${c.db(ids)} order by d.due_on,d.id limit 501`;
    if (po.length > 500 || invoices.length > 500 || deductions.length > 500)
      throw new ApiError(
        "capacity",
        422,
        "Account archive exceeds this view. Ask the account team for an export",
      );
    const purchaseOrders = [];
    for (const p of po) {
      const delivery = await deliveryStatus(c.db, p.order_id);
      purchaseOrders.push({
        id: p.id,
        poNumber: p.po_number ?? "Awaiting review",
        branch: allowed.find((/** @type {any} */ b) => b.id === p.binding_id)
          ?.label,
        status: delivery.milestones.at(-1)?.stage ?? p.order_status ?? p.status,
        orderNumber: p.order_number ?? null,
        amountCentavos:
          p.total_centavos === null ? null : Number(p.total_centavos),
        milestones: [...(await milestones(c.db, p)), ...delivery.milestones],
        deliverySource: delivery.source,
      });
    }
    const safeDeductions = [];
    for (const d of deductions)
      safeDeductions.push({
        id: d.id,
        branch: allowed.find((/** @type {any} */ b) => b.id === d.binding_id)
          ?.label,
        amountCentavos: Number(d.amount_centavos),
        status: d.status,
        type: d.label,
        reference: d.reference,
        claimReference: d.claim_reference,
        dueOn: d.due_on,
        ageDays: d.age_days,
        invoiceNumber: d.invoice_number,
        disputes:
          await c.db`select id,reference,message,status,response,created_at from mt_disputes where deduction_id=${d.id} order by created_at,id`,
      });
    return {
      purchaseOrders,
      invoices: invoices.map((/** @type {any} */ i) => ({
        id: i.id,
        branch: allowed.find((/** @type {any} */ b) => b.id === i.binding_id)
          ?.label,
        invoiceNumber: i.invoice_number,
        amountCentavos: Number(i.amount_centavos),
        issuedOn: i.issued_on,
        dueOn: i.due_on,
        source: i.source,
        receivedAt: i.received_at,
      })),
      deductions: safeDeductions,
    };
  });
  router.post(
    "/api/v1/portal/disputes/submit",
    async (/** @type {any} */ c) => {
      const b = c.body ?? {};
      const authorize = async (/** @type {any} */ cc) => {
        const { allowed } = await portalAccess(cc);
        const [d] =
          await cc.db`select * from mt_deductions where id=${uuid(b.deductionId)}`;
        if (
          !d ||
          !allowed.some((/** @type {any} */ x) => x.id === d.binding_id)
        )
          throw new ApiError(
            "out_of_scope",
            403,
            "Deduction is not in your account",
          );
        return d;
      };
      return command(
        c,
        "portal.dispute",
        b,
        authorize,
        async (cc) => {
          const d = await authorize(cc);
          if (d.status === "resolved")
            throw new ApiError(
              "conflict",
              409,
              "This deduction is already resolved",
            );
          const [accepted] =
            await cc.db`select id from mt_disputes where deduction_id=${d.id} and status='accepted' limit 1`;
          if (accepted)
            throw new ApiError(
              "settlement_pending",
              422,
              "This dispute was accepted and is awaiting settlement review",
            );
          const message = text(b.message, "Dispute details", 2000),
            reference = text(b.reference, "Your reference", 160);
          const [r] =
            await cc.db`insert into mt_disputes(deduction_id,submitted_by,reference,message) values(${d.id},${cc.user.id},${reference},${message}) returning id`;
          await cc.db`update mt_deductions set status='disputed',updated_at=now() where id=${d.id}`;
          await cc.db`insert into mt_deduction_events(deduction_id,actor_user_id,action,note) values(${d.id},${cc.user.id},'customer.disputed','Customer submitted a dispute')`;
          await audit(cc, "customer.disputed", d.id);
          return { id: r.id };
        },
        true,
      );
    },
  );
}
