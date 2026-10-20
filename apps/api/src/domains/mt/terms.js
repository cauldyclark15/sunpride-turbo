import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { choice, text, uuid } from "../orders/validation.js";
import {
  scopeAccess,
  bindingAccess,
  bindings,
  officeRead,
} from "./hierarchy.js";
import { audit, command, instant, money } from "./common.js";
import { originalDocument } from "./documents.js";

/** @param {any} c @param {string} id @param {string} cap */
async function termAccess(c, id, cap) {
  if (cap === "report.read") await officeRead(c);
  else await requireCapability(c, cap);
  const [t] = await c.db`select * from mt_trade_terms where id=${uuid(id)}`;
  if (!t) throw new ApiError("not_found", 404, "Trade terms not found");
  await scopeAccess(c, t.scope_kind, t.scope_key, cap);
  return t;
}
/** @param {any} c @param {any} t */
async function view(c, t) {
  const path = await scopeAccess(c, t.scope_kind, t.scope_key, "report.read");
  return {
    ...t,
    attachment:
      (
        await c.db`select filename,sha256,created_at from mt_term_documents where term_id=${t.id}`
      )[0] ??
      (t.contract_document_id
        ? (
            await c.db`select filename,sha256,created_at from mt_po_documents where id=${t.contract_document_id}`
          )[0]
        : null),
    scopeLabel: t.scope_kind === "branch" ? path[0].label : t.scope_key,
    conditions:
      await c.db`select c.*,p.code as product_code,p.name as product_name from mt_term_conditions c left join products p on p.id=c.product_id where term_id=${t.id} order by ordinal`,
    events:
      await c.db`select e.action,e.note,e.created_at,p.name as actor_name from mt_term_events e left join profiles p on p.user_id=e.actor_user_id where term_id=${t.id} order by e.created_at,e.id`,
  };
}
/** @param {any} router */
export function installTerms(router) {
  router.get("/api/v1/mt/terms/document", async (/** @type {any} */ c) => {
    const term = await termAccess(
      c,
      c.url.searchParams.get("id"),
      "report.read",
    );
    const [original] =
      await c.db`select filename,sha256,content_base64 from mt_term_documents where term_id=${term.id}`;
    if (original) return original;
    if (term.contract_document_id) {
      const [legacy] =
        await c.db`select filename,sha256,content_base64 from mt_po_documents where id=${term.contract_document_id}`;
      if (legacy) return legacy;
    }
    throw new ApiError(
      "not_found",
      404,
      "This terms version has no source document",
    );
  });
  router.get("/api/v1/mt/terms", async (/** @type {any} */ c) => {
    await officeRead(c);
    const all =
      await c.db`select * from mt_trade_terms order by created_at desc limit 501`;
    if (all.length > 500)
      throw new ApiError(
        "capacity",
        422,
        "Narrow the terms archive before continuing",
      );
    const rows = [];
    for (const t of all)
      try {
        rows.push(await view(c, t));
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 403) throw e;
      }
    return { rows };
  });
  router.post("/api/v1/mt/terms/save", async (/** @type {any} */ c) => {
    const b = c.body ?? {},
      kind = choice(
        b.scopeKind,
        ["account", "banner", "branch"],
        "Account level",
      ),
      key = text(b.scopeKey, "Account scope", 120);
    return command(
      c,
      "terms.save",
      b,
      (cc) => scopeAccess(cc, kind, key, "masterdata.manage"),
      async (cc) => {
        const from = instant(b.effectiveFrom),
          to = b.effectiveTo ? instant(b.effectiveTo) : null;
        if (to && to <= from)
          throw new ApiError("invalid_request", 400, "End must be after start");
        if (
          !Array.isArray(b.conditions) ||
          !b.conditions.length ||
          b.conditions.length > 100
        )
          throw new ApiError("invalid_request", 400, "Add 1–100 conditions");
        const path = await scopeAccess(cc, kind, key, "masterdata.manage");
        if (b.attachment && b.contractDocumentId)
          throw new ApiError(
            "invalid_request",
            400,
            "Choose one source document",
          );
        if (b.contractDocumentId) {
          const [doc] =
            await cc.db`select binding_id from mt_po_documents where id=${uuid(b.contractDocumentId)}`;
          if (
            !doc ||
            !path.some((/** @type {any} */ p) => p.id === doc.binding_id)
          )
            throw new ApiError(
              "out_of_scope",
              403,
              "Contract document belongs to another account",
            );
        }
        // UI proposes a change. Only independent approval publishes mock SAP conditions.
        // SEAM(SAP): real SAP condition replication must populate provenance through the integration owner.
        const [t] =
          await cc.db`insert into mt_trade_terms(scope_kind,scope_key,name,source,sap_key,source_version,effective_from,effective_to,requested_by,contract_document_id)
        values(${kind},${key},${text(b.name, "Terms name", 160)},'sample',${`SAMPLE-${crypto.randomUUID()}`},'sample-v1',${from},${to},${cc.user.id},${b.contractDocumentId ?? null}) returning id`;
        if (b.attachment) {
          const original = originalDocument(b.attachment);
          await cc.db`insert into mt_term_documents(term_id,filename,sha256,content_base64,created_by) values(${t.id},${original.filename},${original.hash},${original.contentBase64},${cc.user.id})`;
        }
        const seen = new Set();
        for (const [i, l] of b.conditions.entries()) {
          const type = choice(
            l.kind,
            ["price", "listing_fee", "rebate", "logistics_allowance"],
            "Condition type",
          );
          const amount =
            l.amountCentavos != null ? money(l.amountCentavos) : null;
          const rate =
            l.rateBps != null ? money(l.rateBps, "Basis points") : null;
          if (
            (amount === null) === (rate === null) ||
            (rate !== null && rate > 10000)
          )
            throw new ApiError(
              "invalid_request",
              400,
              "Use either centavos or 0–10,000 basis points",
            );
          let productId = null,
            uom = null;
          if (type === "price") {
            const [p] =
              await cc.db`select * from products where code=${text(l.productCode, "Product code", 100)} and active and deleted_at is null and (organization_id is null or organization_id='sunpride')`;
            if (!p || amount === null)
              throw new ApiError(
                "invalid_request",
                400,
                "Price needs an active product and whole centavos",
              );
            productId = p.id;
            uom = text(l.uom, "Selling unit", 32);
            const k = `${productId}|${uom}`;
            if (seen.has(k))
              throw new ApiError(
                "invalid_request",
                400,
                "A product and unit may have one price",
              );
            seen.add(k);
          }
          await cc.db`insert into mt_term_conditions(term_id,ordinal,kind,product_id,uom,amount_centavos,rate_bps) values(${t.id},${i},${type},${productId},${uom},${amount},${rate})`;
        }
        await cc.db`insert into mt_term_events(term_id,actor_user_id,action,note) values(${t.id},${cc.user.id},'created','Sample SAP change request')`;
        await audit(cc, "terms.created", t.id);
        return { id: t.id };
      },
    );
  });
  for (const action of ["submit", "approve", "reject"])
    router.post(`/api/v1/mt/terms/${action}`, async (/** @type {any} */ c) => {
      const b = c.body ?? {},
        cap = action === "submit" ? "masterdata.manage" : "order.approve";
      return command(
        c,
        `terms.${action}`,
        b,
        (cc) => termAccess(cc, b.id, cap),
        async (cc) => {
          const t = await termAccess(cc, b.id, cap);
          if (t.status !== (action === "submit" ? "draft" : "submitted"))
            throw new ApiError(
              "conflict",
              409,
              "Trade terms are not at this review stage",
            );
          if (action !== "submit" && t.requested_by === cc.user.id)
            throw new ApiError(
              "self_approval",
              422,
              "A different person must review these terms",
            );
          const note = text(
            b.note ?? "Submitted for independent approval",
            "Review note",
            1000,
          );
          await cc.db`update mt_trade_terms set status=${action === "submit" ? "submitted" : action === "approve" ? "approved" : "rejected"},approved_by=${action === "approve" ? cc.user.id : null},updated_at=now() where id=${t.id}`;
          await cc.db`insert into mt_term_events(term_id,actor_user_id,action,note) values(${t.id},${cc.user.id},${action},${note})`;
          await audit(cc, `terms.${action}`, t.id, note);
          return { id: t.id };
        },
      );
    });
  router.post("/api/v1/mt/terms/end", async (/** @type {any} */ c) => {
    const b = c.body ?? {};
    return command(
      c,
      "terms.end",
      b,
      (cc) => termAccess(cc, b.id, "order.approve"),
      async (cc) => {
        const term = await termAccess(cc, b.id, "order.approve"),
          end = instant(b.effectiveTo);
        if (
          term.status !== "approved" ||
          term.source !== "sample" ||
          end.getTime() <= cc.now ||
          end <= new Date(term.effective_from) ||
          (term.effective_to && end > new Date(term.effective_to))
        )
          throw new ApiError(
            "invalid_request",
            400,
            "Only a future end for approved sample terms can be requested here",
          );
        if (term.requested_by === cc.user.id)
          throw new ApiError(
            "self_approval",
            422,
            "A different approver must close these conditions",
          );
        const note = text(b.note, "End-of-terms reason", 1000);
        await cc.db`update mt_trade_terms set effective_to=${end},updated_at=now() where id=${term.id}`;
        await cc.db`insert into mt_term_events(term_id,actor_user_id,action,note) values(${term.id},${cc.user.id},'ended',${note})`;
        await audit(cc, "terms.ended", term.id);
        return { id: term.id };
      },
    );
  });
  router.get("/api/v1/mt/options", async (/** @type {any} */ c) => {
    await officeRead(c);
    const rows = await bindings(c.db, c.now);
    /** @type {any[]} */ const visible = [];
    if (rows.length > 2000)
      throw new ApiError(
        "capacity",
        422,
        "Narrow the account hierarchy before continuing",
      );
    for (const r of rows)
      try {
        await bindingAccess(c, r.id);
        visible.push(r);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 403) throw e;
      }
    const products =
      await c.db`select code,name,uom from products where active and deleted_at is null and (organization_id is null or organization_id='sunpride') order by name limit 2001`;
    if (products.length > 2000)
      throw new ApiError("capacity", 422, "Narrow the product catalog");
    const types =
      await c.db`select * from mt_deduction_types where effective_from<=statement_timestamp() and (effective_to is null or effective_to>statement_timestamp()) order by label`;
    const people =
      await c.db`select id,name,org_unit_id from profiles where status='active' and deleted_at is null order by name limit 2001`;
    const owners = [];
    for (const p of people)
      try {
        await requireCapability(c, "report.read", p.org_unit_id);
        if (p.org_unit_id) owners.push({ id: p.id, name: p.name });
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 403) throw e;
      }
    const invoices =
      await c.db`select id,binding_id,invoice_number,amount_centavos from mt_invoice_replicas order by issued_on desc limit 2001`;
    return {
      bindings: visible,
      products,
      types,
      owners,
      invoices: invoices.filter((/** @type {any} */ i) =>
        visible.some((b) => b.id === i.binding_id),
      ),
    };
  });
}
