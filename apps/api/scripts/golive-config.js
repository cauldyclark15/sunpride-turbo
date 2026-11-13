#!/usr/bin/env bun
// SP-0173: go-live configuration clean-up on a Sunpride database (live or a restored copy).
//
//   DATABASE_URL=... bun apps/api/scripts/golive-config.js            # dry run (rolls back)
//   DATABASE_URL=... bun apps/api/scripts/golive-config.js --apply    # commit
//
// What it does (idempotent: a second --apply changes nothing):
//  1. Channel / subchannel masters = the client's template (customer_reference_values):
//     one channel per Distribution Channel, one subchannel per Customer Grp 1 under it.
//     The 14 seeded channel/subchannel masters (MT, GT, HORECA ...) are retired (new inactive
//     version; nothing is deleted). class_policy POTENTIAL keeps its bands, label loses "Sample".
//  2. master_channel_aliases point the old keys at the template values (same mapping as the
//     SP-0170 sample migration, docs/runbooks/CUSTOMER_MASTER.md) and the template codes whose
//     channel has exactly one Customer Grp 1 get their own alias (e.g. 41 -> 41 / RSF).
//  3. Call-flow bindings: gt_presell / MERCH (sample keys) are closed; Route Sales channel 41
//     is bound to field_selling (field app) and van_selling (van app).
//  4. "Sample" / "provisional" removed from user-visible labels, values unchanged: call flow
//     definitions, presell policy, claim type, claim approval rule. The unused sample incentive
//     plan is end-dated. No-order reasons are already plain and stay.
//  5. org_unit_types national/region/territory labels -> National/Region/Territory. The upper-case
//     NATIONAL/REGION/AREA/TERRITORY/PARTNER types stay (code in org/identity.js and
//     distributors/identity-seam.js inserts and looks them up).
//
// Writes go through the app's own route handlers (masters definitions/save, callflow publish,
// presell publishPolicy, tpm policies save/end) so they write the same audit + receipt rows the
// office web does, acting as --actor (default jcing.jc@gmail.com; read only, never modified).
// Things without a command (aliases, binding close, org type labels) are SQL + audit_logs rows.
// Everything runs in ONE transaction; the dry run rolls it back. Output: JSON, no secrets.
import { createDb } from "@sunpride/db/client";
import { createApp } from "../src/core/app.js";
import { actorFor } from "../src/core/context.js";
import { recordChange } from "../src/core/sync.js";
import { publish } from "../src/core/realtime.js";
import { writeAudit } from "../src/domains/org/audit.js";
import { saveDefinition } from "../src/domains/masters/definitions.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const ACTOR_EMAIL = opt("--actor", "jcing.jc@gmail.com").toLowerCase();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
const TAG = "SP-0173 go-live config";
const REASON =
  "SP-0173 go-live: replace seeded sample values with Sunpride's template";
const SALES_ORG = "1000"; // SFI; ARI 2000 repeats a subset of the same codes
const SEEDED_CHANNELS = ["MT", "GT", "HORECA", "FOOD_SERVICE", "INSTITUTIONAL"];
const SEEDED_SUBCHANNELS = [
  "CATERING",
  "GROCERY",
  "HOTEL",
  "INSTITUTION",
  "MT_GROCERY",
  "RESTAURANT",
  "SARI_SARI",
  "SUPERMARKET",
  "WET_MARKET",
];
// Old keys -> template (runbook CUSTOMER_MASTER.md "Sample migration (0823)").
const LEGACY_ALIASES = {
  kas: ["10", "KAS2"],
  mt: ["10", "KAS2"],
  supermarket: ["30", "KAS3"],
  gt: ["41", "RSF"],
  pmot: ["41", "RSF"],
  food_service: ["20", "FRT"],
  horeca: ["20", "FRT"],
  institutional: ["70", "OSD"],
};
const FLOW_LABELS = {
  distributor_rep: "Distributor representative",
  field_selling: "Field selling",
  van_selling: "Van selling",
  merchandiser: "Merchandising call",
  pre_sell: "Pre-sell",
  driver_delivery: "Driver delivery",
};
const BINDINGS = [
  { app: "field-android", channelCode: "41", channelProfile: "field_selling" },
  { app: "van-android", channelCode: "41", channelProfile: "van_selling" },
];
const OLD_BINDING_CODES = ["gt_presell", "MERCH"];
const ORG_TYPE_LABELS = {
  national: "National",
  region: "Region",
  territory: "Territory",
};
const SAMPLE_CLAIM_TYPE = "Sample promotion claim";
const NEW_CLAIM_TYPE = "Promotion claim";
const SAMPLE_RULE = "Sample Finance band — provisional";
const NEW_RULE = "Finance approval band";
const PRESELL_LABEL = "Next-day delivery";
const POTENTIAL_LABEL = "Monthly revenue potential";
const isSample = (s) => /sample|provisional/i.test(String(s ?? ""));

const db = createDb(url, { max: 2 });
const app = createApp({ db, dbUrl: url, env: process.env });
const changes = [];
const note = (step, what, detail = {}) =>
  changes.push({ step, what, ...detail });
class Rollback extends Error {}

/** Invoke a real route handler inside the script transaction. */
async function call(t, actor, method, path, body, key) {
  const m = app.router.match(method, path);
  if (!m || !m.route) throw new Error(`No route ${method} ${path}`);
  const u = new URL(`http://golive.local${path}`);
  const ctx = {
    db: t,
    actor,
    req: new Request(u, { method, headers: { "idempotency-key": key } }),
    url: u,
    body,
    rawBody: null,
    now: Date.now(),
    params: m.params ?? {},
    user: { id: actor.userId },
    session: null,
    via: "script",
    device: null,
    v2: true,
    cookies: [],
    env: process.env,
    server: null,
    publish: async () => {},
    enqueue: async () => null,
    recordChange,
  };
  const out = await m.route.handler(ctx);
  return out?.body ?? out;
}
const iso = (ms) => new Date(ms).toISOString();

async function current(t, kind, code) {
  const [r] =
    await t`select d.id,d.code,v.version,v.label,v.status,v.data from master_definitions d join master_versions v on v.master_id=d.id
    where d.kind=${kind} and d.code=${code} order by v.version desc limit 1`;
  return r ?? null;
}

async function run(t) {
  t.__inTx = true;
  const [u] = await t`select id from users where lower(email)=${ACTOR_EMAIL}`;
  if (!u) throw new Error("actor not found");
  const actor = await actorFor(t, u.id);
  if (!actor || actor.role !== "super_admin")
    throw new Error("actor is not an active super admin");
  // The masters command wrapper re-checks the actor's single employee assignment (van/access
  // currentActor); the bootstrap super admin has none, so call the same writer it wraps
  // (saveDefinition: capability + national-scope gate, version row, audit_logs) and record the
  // same change-feed row the wrapper writes.
  const masters = async (body) => {
    const ctx = {
      db: t,
      actor,
      now: Date.now(),
      publish: async () => {},
      recordChange,
    };
    const r = await saveDefinition(ctx, body);
    await recordChange(t, {
      entity: "org.reference",
      entityId: r.id,
      scopeKey: "global",
      op: "upsert",
    });
    return r;
  };

  // ---- 1. channel / subchannel masters ----------------------------------------------
  const channels =
    await t`select code,name from customer_reference_values where list='distribution_channel' and sales_org_code=${SALES_ORG} and active order by sort_order`;
  const groups =
    await t`select channel_code,code,name from customer_reference_values where list='customer_group_1' and sales_org_code=${SALES_ORG} and active order by channel_code,sort_order`;
  const channelIds = {};
  for (const c of channels) {
    const cur = await current(t, "channel", c.code);
    if (!cur || cur.label !== c.name || cur.status !== "active") {
      const r = await masters(
        {
          kind: "channel",
          code: c.code,
          label: c.name,
          status: "active",
          data: {},
          reason: REASON,
          baseVersion: cur?.version ?? 0,
        },
        `channel:${c.code}:${cur?.version ?? 0}`,
      );
      note("channel-masters", cur ? "relabel" : "create", {
        kind: "channel",
        code: c.code,
        label: c.name,
      });
      channelIds[c.code] = r.id;
    } else channelIds[c.code] = cur.id;
  }
  const subIds = {};
  for (const g of groups) {
    const parent = channelIds[g.channel_code];
    if (!parent)
      throw new Error(`Grp 1 ${g.code} has no channel ${g.channel_code}`);
    const cur = await current(t, "subchannel", g.code);
    if (cur && cur.data?.channelId && cur.data.channelId !== parent)
      throw new Error(`Grp 1 code ${g.code} is under two channels`);
    if (
      !cur ||
      cur.label !== g.name ||
      cur.status !== "active" ||
      cur.data?.channelId !== parent
    ) {
      const r = await masters(
        {
          kind: "subchannel",
          code: g.code,
          label: g.name,
          status: "active",
          data: { channelId: parent },
          reason: REASON,
          baseVersion: cur?.version ?? 0,
        },
        `subchannel:${g.code}:${cur?.version ?? 0}`,
      );
      note("channel-masters", cur ? "relabel" : "create", {
        kind: "subchannel",
        code: g.code,
        channel: g.channel_code,
        label: g.name,
      });
      subIds[g.code] = r.id;
    } else subIds[g.code] = cur.id;
  }

  // ---- 2. aliases (before retiring, so nothing points at a retired master) ------------
  const byChannel = {};
  for (const g of groups) (byChannel[g.channel_code] ??= []).push(g.code);
  const wanted = { ...LEGACY_ALIASES };
  for (const [ch, list] of Object.entries(byChannel))
    if (list.length === 1) wanted[ch] = [ch, list[0]];
  for (const [key, [ch, sub]] of Object.entries(wanted)) {
    const channelId = channelIds[ch],
      subchannelId = subIds[sub];
    if (!channelId || !subchannelId)
      throw new Error(`alias ${key}: missing ${ch}/${sub}`);
    const [a] =
      await t`select * from master_channel_aliases where legacy_key=${key}`;
    if (a && a.channel_id === channelId && a.subchannel_id === subchannelId)
      continue;
    if (a)
      await t`update master_channel_aliases set channel_id=${channelId},subchannel_id=${subchannelId},updated_at=now() where id=${a.id}`;
    else
      await t`insert into master_channel_aliases(legacy_key,channel_id,subchannel_id) values(${key},${channelId},${subchannelId})`;
    await writeAudit(t, {
      actor,
      action: "masters.channel_alias.saved",
      entityType: "master_channel_alias",
      entityId: key,
      details: {
        tag: TAG,
        before: a
          ? { channelId: a.channel_id, subchannelId: a.subchannel_id }
          : null,
        after: { channel: ch, subchannel: sub },
      },
    });
    await recordChange(t, {
      entity: "org.reference",
      entityId: actor.profileId,
      scopeKey: "global",
      op: "upsert",
    });
    note("channel-aliases", a ? "remap" : "create", {
      legacyKey: key,
      channel: ch,
      subchannel: sub,
    });
  }

  // ---- 1b. retire seeded masters (subchannels first) -----------------------------------
  for (const [kind, codes] of [
    ["subchannel", SEEDED_SUBCHANNELS],
    ["channel", SEEDED_CHANNELS],
  ])
    for (const code of codes) {
      const cur = await current(t, kind, code);
      if (!cur || cur.status === "inactive") continue;
      await masters(
        {
          kind,
          code,
          label: cur.label.replace(/^Sample\s+/i, ""),
          status: "inactive",
          data: cur.data,
          reason: `${REASON} (retired seeded value)`,
          baseVersion: cur.version,
        },
        `retire:${kind}:${code}:${cur.version}`,
      );
      note("channel-masters", "retire", { kind, code });
    }
  {
    const cur = await current(t, "class_policy", "POTENTIAL");
    if (cur && cur.status === "active" && isSample(cur.label)) {
      await masters(
        {
          kind: "class_policy",
          code: "POTENTIAL",
          label: POTENTIAL_LABEL,
          status: "active",
          data: cur.data,
          reason: `${REASON} (label only; bands unchanged)`,
          baseVersion: cur.version,
        },
        `relabel:class_policy:POTENTIAL:${cur.version}`,
      );
      note("labels", "relabel", {
        item: "class_policy POTENTIAL",
        from: cur.label,
        to: POTENTIAL_LABEL,
      });
    }
  }

  // ---- 3. call flow definitions relabel (same steps) -----------------------------------
  for (const [profile, label] of Object.entries(FLOW_LABELS)) {
    const [d] =
      await t`select * from call_flow_definitions where channel_profile=${profile} and effective_from<=now() and (effective_to is null or effective_to>now()) order by version desc limit 1`;
    if (!d || d.label === label) continue;
    await call(
      t,
      actor,
      "POST",
      "/api/v1/callflow/definition/publish",
      {
        channelProfile: profile,
        label,
        steps: d.steps,
        effectiveFrom: Date.now() + 2000,
      },
      `sp0173:flow:${profile}:${d.version}`,
    );
    note("call-flows", "relabel", { profile, from: d.label, to: label });
  }

  // ---- 3b. bindings ----------------------------------------------------------------------
  for (const b of BINDINGS) {
    const [cur] =
      await t`select * from call_flow_channel_bindings where app=${b.app} and channel_code=${b.channelCode} and outlet_class='*' and effective_from<=now() and (effective_to is null or effective_to>now())`;
    if (cur?.channel_profile === b.channelProfile) continue;
    await call(
      t,
      actor,
      "POST",
      "/api/v1/callflow/binding/publish",
      { ...b, outletClass: "*", effectiveFrom: Date.now() + 2000 },
      `sp0173:binding:${b.app}:${b.channelCode}`,
    );
    note("call-flow-bindings", "publish", b);
  }
  const old =
    await t`select * from call_flow_channel_bindings where channel_code in ${t(OLD_BINDING_CODES)} and (effective_to is null or effective_to>now())`;
  for (const r of old) {
    await t`update call_flow_channel_bindings set effective_to=now(),updated_at=now() where id=${r.id}`;
    await writeAudit(t, {
      actor,
      action: "callflow.binding.retired",
      entityType: "callflow",
      entityId: r.id,
      details: {
        tag: TAG,
        app: r.app,
        channel: r.channel_code,
        profile: r.channel_profile,
        version: r.version,
      },
    });
    await recordChange(t, {
      entity: "field.manifest",
      entityId: r.id,
      scopeKey: "field:reference",
    });
    note("call-flow-bindings", "close", {
      app: r.app,
      channel: r.channel_code,
      profile: r.channel_profile,
    });
  }

  // ---- 4. presell policy relabel ---------------------------------------------------------
  {
    const [p] =
      await t`select * from presell_policies where effective_from<=now() and (effective_to is null or effective_to>now()) order by effective_from desc limit 1`;
    if (p && isSample(p.label))
      await call(
        t,
        actor,
        "POST",
        "/api/v1/presell/publishPolicy",
        {
          idempotencyKey: `sp0173:presell:${p.version}`,
          label: PRESELL_LABEL,
          cutoffMinute: p.cutoff_minute,
          leadDays: p.lead_days,
          horizonDays: p.horizon_days,
          slaDays: p.sla_days,
          epodTargetPercent: p.epod_target_percent,
          varianceReasons: p.variance_reasons,
          effectiveFrom: iso(Date.now() + 1000),
        },
        "unused",
      ).then(() =>
        note("labels", "relabel", {
          item: "presell policy",
          from: p.label,
          to: PRESELL_LABEL,
        }),
      );
  }

  // ---- 4b. claim type, approval rule, incentive plan -------------------------------------
  const tpm = (path, body) => call(t, actor, "POST", path, body, "unused");
  const at = Date.now() + 60000; // prospective switch-over instant
  {
    const [ct] =
      await t`select * from claim_types where code=${SAMPLE_CLAIM_TYPE} and effective_to>now()+interval '5 minutes'`;
    if (ct) {
      const to = new Date(Math.max(at, +ct.effective_from + 1000));
      await tpm("/api/v1/tpm/policies/end", {
        idempotencyKey: `sp0173:end:claim_type:${ct.id}`,
        kind: "claim_type",
        id: ct.id,
        effectiveTo: to.toISOString(),
      });
      await tpm("/api/v1/tpm/policies/save", {
        idempotencyKey: `sp0173:save:claim_type:${ct.id}`,
        kind: "claim_type",
        code: NEW_CLAIM_TYPE,
        effectiveFrom: to.toISOString(),
        effectiveTo: new Date(ct.effective_to).toISOString(),
        requiredEvidence: ct.required_evidence,
        allowExecutionOverride: ct.allow_execution_override,
        escalationHours: ct.escalation_hours,
        emailNotifications: ct.email_notifications,
      });
      note("labels", "replace", {
        item: "claim type",
        from: ct.code,
        to: NEW_CLAIM_TYPE,
        switchAt: to.toISOString(),
      });
    }
    const [rule] =
      await t`select * from claim_approval_rules where name=${SAMPLE_RULE} and effective_to>now()+interval '5 minutes'`;
    if (rule) {
      const to = new Date(Math.max(at, +rule.effective_from + 1000));
      await tpm("/api/v1/tpm/policies/end", {
        idempotencyKey: `sp0173:end:approval:${rule.id}`,
        kind: "approval",
        id: rule.id,
        effectiveTo: to.toISOString(),
      });
      await tpm("/api/v1/tpm/policies/save", {
        idempotencyKey: `sp0173:save:approval:${rule.id}`,
        kind: "approval",
        name: NEW_RULE,
        partyType: rule.party_type,
        minCentavos: Number(rule.min_centavos),
        maxCentavos: Number(rule.max_centavos),
        approverRoles: rule.approver_roles,
        effectiveFrom: to.toISOString(),
        effectiveTo: new Date(rule.effective_to).toISOString(),
      });
      note("labels", "replace", {
        item: "claim approval rule",
        from: rule.name,
        to: NEW_RULE,
        switchAt: to.toISOString(),
      });
    }
    const plans =
      await t`select p.* from incentive_plans p where effective_to>now()+interval '5 minutes' and (code ilike 'SAMPLE%' or name ilike '%sample%' or name ilike '%provisional%')`;
    for (const p of plans) {
      const [{ n }] =
        await t`select count(*)::int n from incentive_statements where plan_id=${p.id}`;
      if (n > 0)
        throw new Error(
          `incentive plan ${p.code} has statements; relabel instead`,
        );
      const to = new Date(Math.max(at, +p.effective_from + 1000));
      await tpm("/api/v1/tpm/policies/end", {
        idempotencyKey: `sp0173:end:incentive:${p.id}`,
        kind: "incentive",
        id: p.id,
        effectiveTo: to.toISOString(),
      });
      note("incentive", "end-date", {
        code: p.code,
        effectiveTo: to.toISOString(),
      });
    }
  }

  // ---- 5. org unit type labels -----------------------------------------------------------
  for (const [code, label] of Object.entries(ORG_TYPE_LABELS)) {
    const [r] =
      await t`select * from org_unit_types where organization_id='sunpride' and code=${code}`;
    if (!r || r.label === label) continue;
    await t`update org_unit_types set label=${label},updated_at=now() where id=${r.id}`;
    await writeAudit(t, {
      actor,
      action: "org.unit_type.relabelled",
      entityType: "org_unit_type",
      entityId: r.id,
      details: { tag: TAG, code, before: r.label, after: label },
    });
    await recordChange(t, {
      entity: "org.reference",
      entityId: r.id,
      scopeKey: "global",
      op: "upsert",
    });
    note("org-types", "relabel", { code, from: r.label, to: label });
  }
  if (!APPLY) throw new Rollback();
}

let committed = false;
try {
  await db.begin(run);
  committed = true;
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(
      JSON.stringify(
        { ok: false, error: String(e?.message ?? e), code: e?.code, changes },
        null,
        1,
      ),
    );
    process.exit(1);
  }
}
if (committed && changes.length)
  for (const topic of ["masters", "org", "callflow", "delivery", "tpm"])
    await publish(db, topic).catch(() => {});
console.log(
  JSON.stringify(
    {
      ok: true,
      mode: APPLY ? "apply" : "dry-run",
      committed,
      changeCount: changes.length,
      changes,
    },
    null,
    1,
  ),
);
await db.close();
process.exit(0);
