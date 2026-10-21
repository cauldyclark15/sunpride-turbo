import { test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, createUser } from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as tpm } from "../src/domains/tpm/index.js";
import { install as analytics } from "../src/domains/analytics/index.js";
import { ensureRoot } from "../src/domains/org/identity.js";
import { sha256Hex } from "../src/core/util.js";
import { runDueJobs } from "../src/core/jobs.js";
import { sendNotificationMail } from "../src/core/notification-mail.js";
import { deliverClaimMail } from "../src/domains/tpm/notifications.js";

test("F-507 F-608 current recipients get local notices, independent escalations and configured-provider receipts without pretending email delivery", async () => {
  const h = await startHarness({
    installers: [org, tpm, analytics],
    env: { NOTIFICATION_EMAIL_PROVIDER: "dev_sink" },
  });
  /** @type {ReturnType<typeof Bun.serve>|null} */ let provider = null;
  try {
    const root = await ensureRoot(h.db),
      day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    /** @param {string} name @param {string} role @param {string} unit */
    async function person(name, role, unit) {
      const email = `sample-notification-${name}@example.com`,
        user = await createUser(h, email, "Fixture-only-notification");
      const [p] =
        await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id)values(${user},${user},${"Sample " + name},${email},${role},'active',${unit})returning id`;
      if (role !== "distributor")
        await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason)values(${p.id},${unit},${role},now()-interval '1 day',${user},'Sample fixture')`;
      const token = "sps_" + crypto.randomUUID().replaceAll("-", "");
      await h.db`insert into sessions(user_id,token_hash,app,expires_at)values(${user},${sha256Hex(token)},'web',now()+interval '1 day')`;
      return { user, profileId: p.id, email, cookie: "sp_session=" + token };
    }
    const clerk = await person("clerk", "super_admin", root),
      finance = await person("finance", "super_admin", root);
    const [privateUnit] =
      await h.db`insert into org_units(organization_id,code,name,type_code,status,parent_id,effective_from)values('sunpride','SAMPLE-NOTIFY-PRIVATE','Sample partner area','team','active',${root},now()-interval '1 day')returning id`;
    const partner = await person("partner", "distributor", privateUnit.id);
    const [company] =
      await h.db`insert into distributors(code,name,org_unit_id,device_org_unit_id,status,source,effective_from)values('SAMPLE-NOTIFY-0587','Sample notification company',${root},${privateUnit.id},'accredited','sample',now()-interval '1 day')returning id`;
    await h.db`insert into distributor_users(distributor_id,profile_id,grants,effective_from)values(${company.id},${partner.profileId},'{read,claim}'::text[],now()-interval '1 day')`;
    /** @param {any} who @param {string} path @param {any} [body] */
    async function api(who, path, body) {
      const r = await h.fetch(path, {
        method: body ? "POST" : "GET",
        headers: { cookie: who.cookie, "content-type": "application/json" },
        ...(body
          ? {
              body: JSON.stringify({
                idempotencyKey: crypto.randomUUID(),
                ...body,
              }),
            }
          : {}),
      });
      return { status: r.status, body: /** @type {any} */ (await r.json()) };
    }
    const policy = await api(clerk, "/api/v1/tpm/policies/save", {
      kind: "claim_type",
      code: "SAMPLE-NOTIFY-0587",
      requiredEvidence: ["source_document"],
      effectiveFrom: Date.now() - 86400_000,
      effectiveTo: Date.now() + 86400_000,
      escalationHours: 1,
      emailNotifications: true,
    });
    expect(policy.status).toBe(200);
    expect(
      (
        await api(clerk, "/api/v1/tpm/policies/save", {
          kind: "approval",
          name: "Sample independent approver",
          partyType: "all",
          minCentavos: 0,
          maxCentavos: 1000,
          approverRoles: ["super_admin"],
          effectiveFrom: Date.now() - 86400_000,
          effectiveTo: Date.now() + 86400_000,
        })
      ).status,
    ).toBe(200);
    const packet = {
      partyType: "distributor",
      partyId: company.id,
      typeId: policy.body.id,
      amountCentavos: 100,
      periodFrom: day,
      periodTo: day,
    };
    const created = await api(clerk, "/api/v1/tpm/claims/submit", {
      ...packet,
      reference: "SAMPLE-NOTICE-0587",
    });
    expect(created.status).toBe(200);
    await runDueJobs(h.db);
    let inbox = await api(partner, "/api/v1/partners/notifications");
    expect(inbox.status).toBe(200);
    expect(inbox.body.rows).toHaveLength(1);
    expect(inbox.body.mailMode).toBe("dev_sink");
    expect(
      (await h.db`select state from notification_email_deliveries`)[0].state,
    ).toBe("dev_sink");
    expect(
      (
        await api(partner, "/api/v1/partners/notifications/read", {
          id: inbox.body.rows[0].id,
          kind: "claim",
        })
      ).status,
    ).toBe(200);
    expect(
      (await api(partner, "/api/v1/partners/notifications")).body.rows[0].read,
    ).toBe(true);
    await h.db`update claims set updated_at=now()-interval '2 hours' where id=${created.body.id}`;
    const sweep = await api(
      finance,
      "/api/v1/tpm/claims/escalations/evaluate",
      {},
    );
    expect(sweep.status).toBe(200);
    expect(sweep.body.queued).toBe(1);
    await runDueJobs(h.db);
    const officeInbox = await api(finance, "/api/v1/account/claim-notices");
    expect(officeInbox.status).toBe(200);
    expect(officeInbox.body.rows).toHaveLength(1);
    expect(officeInbox.body.rows[0].kind).toBe("claim_escalation");
    expect(
      (await api(clerk, "/api/v1/account/claim-notices")).body.rows,
    ).toHaveLength(0);
    expect(
      (await api(finance, "/api/v1/tpm/claims/escalations/evaluate", {})).body
        .queued,
    ).toBe(0);
    await h.db`update distributor_users set grants='{read}'::text[] where profile_id=${partner.profileId}`;
    inbox = await api(partner, "/api/v1/partners/notifications");
    expect(inbox.body.rows).toHaveLength(0);
    expect(
      (
        await api(partner, "/api/v1/partners/notifications/read", {
          id: officeInbox.body.rows[0].id,
          kind: "claim_escalation",
        })
      ).status,
    ).not.toBe(200);
    expect(
      (
        await api(finance, "/api/v1/tpm/claims/reject", {
          id: created.body.id,
          reason: "Sample independent return for correction",
        })
      ).status,
    ).toBe(200);
    await runDueJobs(h.db);
    expect(
      (
        await h.db`select id from notification_email_deliveries where message_key like 'claim:%'`
      ).length,
    ).toBe(1);
    await h.db`update distributor_users set grants='{read,claim}'::text[] where profile_id=${partner.profileId}`;
    /** @type {Map<string,any>} */ const sent = new Map();
    let posts = 0,
      gets = 0,
      mismatch = false;
    provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/emails") {
          posts++;
          const key = req.headers.get("idempotency-key");
          if (!key) return new Response(null, { status: 400 });
          if (!sent.has(key))
            sent.set(key, {
              .../** @type {any} */ (await req.json()),
              id: crypto.randomUUID(),
            });
          return Response.json({ id: sent.get(key).id });
        }
        const entry = [...sent.values()].find(
          (e) => url.pathname === "/emails/" + e.id,
        );
        if (!entry) return new Response(null, { status: 404 });
        gets++;
        return Response.json({
          ...entry,
          subject: mismatch ? "Different message" : entry.subject,
        });
      },
    });
    Object.assign(h.env, {
      NOTIFICATION_EMAIL_PROVIDER: "resend",
      NOTIFICATION_EMAIL_FROM: "Sample Sunpride <sample-notices@example.com>",
      RESEND_API_KEY: "fixture-only-provider-key",
      NOTIFICATION_EMAIL_API_URL: `http://127.0.0.1:${provider.port}`,
    });
    const configured = await api(clerk, "/api/v1/tpm/claims/submit", {
      ...packet,
      reference: "SAMPLE-CONFIGURED-0587",
    });
    expect(configured.status).toBe(200);
    await runDueJobs(h.db);
    expect(posts).toBe(1);
    expect(gets).toBe(1);
    const [notice] =
      await h.db`select id from claim_notifications where claim_id=${configured.body.id}`;
    await deliverClaimMail(h.db, notice.id, h.env);
    expect(posts).toBe(1);
    const [receipt] =
      await h.db`select * from notification_email_deliveries where message_key=${`claim:${notice.id}:${partner.user}`}`;
    expect(receipt.state).toBe("accepted");
    expect(receipt.recipient).toBe(partner.email);
    expect(receipt.provider_id).toBe([...sent.values()][0].id);
    mismatch = true;
    const message = {
      key: "sample-mismatch-0587",
      to: partner.email,
      subject: "Sample protected receipt",
      body: "Sample test only",
      createdAt: Date.now(),
    };
    await expect(
      tx(h.db, (t) => sendNotificationMail(t, message, h.env)),
    ).rejects.toMatchObject({ code: "notification_retry" });
    expect(
      (
        await h.db`select id from notification_email_deliveries where message_key=${message.key}`
      ).length,
    ).toBe(0);
    mismatch = false;
    await tx(h.db, (t) => sendNotificationMail(t, message, h.env));
    expect(sent.size).toBe(2);
    // Existing threshold authority, one marked signal; only the NEW configured transport/inbox handoff is exercised.
    await h.db`insert into analytics_integrity_findings(org_unit_id,source_system,source_key,source_revision,source_type,rule_code,rule_version,severity,title,detail,status,occurred_at,evidence,review_href)values(${root},'fixture','sample-mail-signal','1','sample','sample','1','high','Sample threshold signal','Sample, not guilt','open',now(),${{ source: "sample" }},'/decide')`;
    expect(
      (
        await api(clerk, "/api/v1/alerts/subscribe", {
          unitId: root,
          metric: "integrity_open",
          threshold: 0,
          cooldownMinutes: 60,
          inApp: true,
          email: true,
          enabled: true,
        })
      ).status,
    ).toBe(200);
    expect((await api(clerk, "/api/v1/alerts/evaluate", {})).body.queued).toBe(
      1,
    );
    await runDueJobs(h.db);
    const alerts = await api(clerk, "/api/v1/alerts");
    expect(alerts.status).toBe(200);
    expect(alerts.body.rows).toHaveLength(1);
    expect(alerts.body.mailMode).toContain(
      "acceptance does not prove inbox delivery",
    );
    const [alertReceipt] =
      await h.db`select state from notification_email_deliveries where message_key=${"alert:" + alerts.body.rows[0].id}`;
    expect(alertReceipt.state).toBe("accepted");
  } finally {
    provider?.stop(true);
    await h.close();
  }
});
