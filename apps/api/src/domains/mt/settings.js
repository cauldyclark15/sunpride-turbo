import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { outletContext } from "../orders/access.js";
import { choice, text, uuid } from "../orders/validation.js";
import { audit, command, instant } from "./common.js";
import { scopeAccess } from "./hierarchy.js";

/** @param {any} router */
export function installSettings(router) {
  router.get("/api/v1/mt/settings", async (/** @type {any} */ c) => {
    await requireCapability(c, "masterdata.manage");
    // Parser mappings are account-wide; scope-check before returning each mapping.
    const rows =
        await c.db`select * from mt_intake_profiles order by effective_from desc limit 501`,
      profiles = [];
    for (const r of rows)
      try {
        await scopeAccess(c, "account", r.account_key, "masterdata.manage");
        profiles.push(r);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 403) throw e;
      }
    const storeRows =
      await c.db`select o.id as outlet_id,o.name as outlet_name,o.code as outlet_code,l.customer_id,c.name as customer_name from outlets o join outlet_customer_links l on l.outlet_id=o.id join customers c on c.id=l.customer_id where o.deleted_at is null and o.status='active' and l.deleted_at is null and l.effective_from<=statement_timestamp() and (l.effective_to is null or l.effective_to>statement_timestamp()) and c.active and c.deleted_at is null order by o.name limit 2001`;
    if (storeRows.length > 2000)
      throw new ApiError("capacity", 422, "Narrow the branch mapping choices");
    const stores = [];
    for (const row of storeRows)
      try {
        await outletContext(c, row.outlet_id, "masterdata.manage");
        stores.push(row);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 403) throw e;
      }
    // WEB-143: offer every external identity the access endpoint accepts (no
    // employee profile, no pending invitation), not only people who already
    // have portal access — otherwise a first grant is impossible.
    const externalUsers = [];
    if (c.actor?.capabilities.has("admin.manage")) {
      const members =
        // WEB-143: the label shows the version in force now (else the next one), not the open-ended row.
        await c.db`select u.id as user_id,u.email,coalesce(m.name,u.email::text) as name,m.scope_kind,m.scope_key,m.effective_from,m.effective_to,m.effective_from<=now() as in_force
          from users u left join lateral (
            select * from mt_portal_memberships x where x.user_id=u.id and (x.effective_to is null or x.effective_to>now())
            order by (x.effective_from<=now()) desc, x.effective_from asc limit 1) m on true
          where u.disabled_at is null
            and not exists(select 1 from profiles p where p.user_id=u.id or lower(p.email)=lower(u.email))
            and not exists(select 1 from access_invitations a where lower(a.email)=lower(u.email) and a.status='pending')
          order by coalesce(m.name,u.email::text) limit 501`;
      if (members.length > 500)
        throw new ApiError("capacity", 422, "Narrow the portal access roster");
      for (const m of members)
        try {
          if (m.scope_kind)
            await scopeAccess(c, m.scope_kind, m.scope_key, "admin.manage");
          externalUsers.push({
            id: m.user_id,
            name: m.name,
            email: m.email,
            access: m.scope_kind
              ? {
                  kind: m.scope_kind,
                  key: m.scope_key,
                  current: Boolean(m.in_force),
                  from: new Date(m.effective_from).getTime(),
                  to: m.effective_to ? new Date(m.effective_to).getTime() : null,
                }
              : null,
          });
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 403) throw e;
        }
    }
    return {
      stores,
      externalUsers,
      profiles,
      types:
        await c.db`select * from mt_deduction_types order by code,effective_from desc limit 501`,
    };
  });
  for (const kind of ["parser", "deduction-type"])
    router.post(`/api/v1/mt/settings/${kind}`, async (/** @type {any} */ c) => {
      const b = c.body ?? {};
      return command(
        c,
        `settings.${kind}`,
        b,
        async (cc) => {
          await requireCapability(cc, "masterdata.manage");
          if (kind === "parser")
            await scopeAccess(
              cc,
              "account",
              text(b.accountKey, "Account key", 120),
              "masterdata.manage",
            );
        },
        async (cc) => {
          const from = instant(b.effectiveFrom),
            to = b.effectiveTo ? instant(b.effectiveTo) : null;
          if (to && to <= from)
            throw new ApiError(
              "invalid_request",
              400,
              "End must be after start",
            );
          let r;
          if (kind === "parser") {
            const format = choice(
              b.format,
              ["csv", "edi", "email", "ocr"],
              "Format",
            );
            if (
              !b.columns ||
              typeof b.columns !== "object" ||
              Array.isArray(b.columns) ||
              Object.entries(b.columns).some(
                ([k, v]) =>
                  ![
                    "po_number",
                    "delivery_date",
                    "sku",
                    "uom",
                    "quantity",
                    "price_centavos",
                  ].includes(k) ||
                  typeof v !== "string" ||
                  v.length > 80,
              )
            )
              throw new ApiError(
                "invalid_request",
                400,
                "Map the supported input column names to export headers",
              );
            await cc.db`update mt_intake_profiles set effective_to=${from},updated_at=now() where account_key=${b.accountKey} and format=${format} and effective_to is null and effective_from<${from}`;
            [r] =
              await cc.db`insert into mt_intake_profiles(account_key,format,columns,effective_from,effective_to) values(${b.accountKey},${format},${b.columns},${from},${to}) returning id`;
          } else {
            // SLA taxonomy is company-wide, not a per-region financial authority.
            const code = text(b.code, "Type code", 40),
              label = text(b.label, "Type label", 100);
            if (
              !Number.isInteger(b.slaDays) ||
              b.slaDays < 1 ||
              b.slaDays > 365
            )
              throw new ApiError(
                "invalid_request",
                400,
                "SLA must be 1–365 days",
              );
            await cc.db`update mt_deduction_types set effective_to=${from},updated_at=now() where code=${code} and effective_to is null and effective_from<${from}`;
            [r] =
              await cc.db`insert into mt_deduction_types(code,label,sla_days,effective_from,effective_to) values(${code},${label},${b.slaDays},${from},${to}) returning id`;
          }
          await audit(cc, `settings.${kind}`, r.id);
          return { id: r.id };
        },
      );
    });
  router.post("/api/v1/mt/bindings/save", async (/** @type {any} */ c) => {
    const b = c.body ?? {};
    return command(
      c,
      "bindings.save",
      b,
      async (cc) => {
        await requireCapability(cc, "masterdata.manage");
        await outletContext(cc, uuid(b.outletId), "masterdata.manage");
      },
      async (cc) => {
        const [link] =
          await cc.db`select customer_id from outlet_customer_links where outlet_id=${b.outletId} and effective_from<=statement_timestamp() and (effective_to is null or effective_to>statement_timestamp()) and deleted_at is null`;
        if (!link || link.customer_id !== uuid(b.customerId))
          throw new ApiError(
            "invalid_request",
            400,
            "Choose the accounting customer linked to this store",
          );
        const from = instant(b.effectiveFrom),
          to = b.effectiveTo ? instant(b.effectiveTo) : null;
        const [r] =
          await cc.db`insert into mt_account_bindings(customer_id,outlet_id,account_key,banner_key,branch_key,label,source,source_version,effective_from,effective_to)
        values(${b.customerId},${b.outletId},${text(b.accountKey, "Chain key", 120)},${text(b.bannerKey, "Banner key", 120)},${text(b.branchKey, "Branch key", 120)},${text(b.label, "Branch name", 160)},'sample','sample-v1',${from},${to}) returning id`;
        await audit(cc, "binding.created", r.id);
        return { id: r.id };
      },
    );
  });
  router.post("/api/v1/mt/portal/access", async (/** @type {any} */ c) => {
    const b = c.body ?? {},
      kind = choice(
        b.scopeKind,
        ["account", "banner", "branch"],
        "Account level",
      ),
      key = text(b.scopeKey, "Account key", 120);
    return command(
      c,
      "portal.access",
      b,
      async (cc) => {
        await requireCapability(cc, "admin.manage");
        await scopeAccess(cc, kind, key, "admin.manage");
      },
      async (cc) => {
        const [user] =
          await cc.db`select u.id from users u where u.id=${uuid(b.userId)} and u.disabled_at is null and not exists(select 1 from profiles p where p.user_id=u.id or lower(p.email)=lower(u.email)) and not exists(select 1 from access_invitations a where lower(a.email)=lower(u.email) and a.status='pending')`;
        if (!user)
          throw new ApiError(
            "invalid_request",
            400,
            "Choose an external identity without employee access",
          );
        const [old] =
          await cc.db`select * from mt_portal_memberships where user_id=${user.id} and effective_to is null`;
        if (old)
          await scopeAccess(cc, old.scope_kind, old.scope_key, "admin.manage");
        const from = instant(b.effectiveFrom);
        // WEB-143: a second version on the same start day is refused in plain words, not a bare 409.
        const [same] =
          await cc.db`select 1 from mt_portal_memberships where user_id=${user.id} and effective_from=${from}`;
        if (same)
          throw new ApiError(
            "access_overlap",
            409,
            "This login already has access starting that day. Choose a later start date to change it.",
          );
        await cc.db`update mt_portal_memberships set effective_to=${from},updated_at=now() where user_id=${user.id} and effective_to is null and effective_from<${from}`;
        const [r] =
          await cc.db`insert into mt_portal_memberships(user_id,name,scope_kind,scope_key,effective_from,effective_to) values(${user.id},${text(b.name, "Customer name", 160)},${kind},${key},${from},${b.effectiveTo ? instant(b.effectiveTo) : null}) returning id`;
        await audit(cc, "portal.access", r.id);
        return { id: r.id };
      },
    );
  });
}
