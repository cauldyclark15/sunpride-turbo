import { test, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { encode } from "jpeg-js";
import { startHarness, createUser } from "./harness.js";
import { install as tpm } from "../src/domains/tpm/index.js";
import { install as org } from "../src/domains/org/index.js";
import { ensureRoot } from "../src/domains/org/identity.js";
import { sha256Hex } from "../src/core/util.js";
import { provenClaimValue } from "../src/domains/tpm/claim-matching.js";

test("F-506 monetary proof matches an exact SKU, captured unit and prorated quantity; pictures never certify money", () => {
  const source = {
    kind: "secondary_sale",
    productId: "sample-sku",
    uom: "EA",
    unitsPerUom: 1,
    quantityBase: "10",
    amountCentavos: 1000,
  };
  const claim = { product_id: "sample-sku", uom: "EA", quantity_units: 2 };
  expect(provenClaimValue([source], claim)).toBe(200n);
  expect(provenClaimValue([source], { ...claim, uom: "CASE" })).toBeNull();
  expect(
    provenClaimValue([source], { ...claim, quantity_units: 11 }),
  ).toBeNull();
  expect(
    provenClaimValue([{ kind: "photo", amountCentavos: 9999 }], {}),
  ).toBeNull();
});

test("F-506 office previews sources, independently excepts missing execution only, refreshes immutable revisions and blocks changed/withdrawn proof", async () => {
  const h = await startHarness({ installers: [org, tpm] });
  try {
    const unit = await ensureRoot(h.db),
      day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    /** @param {string} name @param {string} role */
    async function person(name, role) {
      const email = `sample-claim-evidence-${name}@example.com`,
        user = await createUser(h, email, "Fixture-only-claim-evidence");
      const [p] =
        await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id)values(${user},${user},${"Sample " + name},${email},${role},'active',${unit})returning id`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason)values(${p.id},${unit},${role},now()-interval '1 day',${user},'Sample fixture')`;
      const token = "sps_" + crypto.randomUUID().replaceAll("-", "");
      await h.db`insert into sessions(user_id,token_hash,app,expires_at)values(${user},${sha256Hex(token)},'web',now()+interval '1 day')`;
      return { user, profileId: p.id, cookie: "sp_session=" + token };
    }
    const clerk = await person("clerk", "super_admin"),
      finance = await person("finance", "super_admin"),
      other = await person("other-finance", "super_admin"),
      field = await person("field", "sales");
    /** @param {any} who @param {string} path @param {any} [body] */
    async function api(who, path, body) {
      const response = await h.fetch("/api/v1/tpm/" + path, {
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
      return {
        status: response.status,
        body: /** @type {any} */ (await response.json()),
      };
    }
    const [party] =
      await h.db`insert into distributors(code,name,org_unit_id,status,source,effective_from)values('SAMPLE-CLAIM-0586','Sample claim company',${unit},'accredited','sample',now()-interval '1 day')returning id`;
    const [outlet] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by)values('sunpride','SAMPLE-CLAIM-STORE','Sample claim store','active',${unit},${clerk.user})returning id`;
    const [sku] =
      await h.db`insert into products(code,name,category,uom,unit_price,active,organization_id)values('SAMPLE-CLAIM-SKU','Sample claim product','Sample','EA',10,true,'sunpride')returning id`;
    const [location] =
      await h.db`insert into distributor_locations(distributor_id,code,name,kind)values(${party.id},'SAMPLE-DEPOT','Sample depot','warehouse')returning id`;
    const [sale] =
      await h.db`insert into distributor_secondary_lines(distributor_id,invoice_number,line_key,revision,source_key,payload_hash,sale_date,kind,outlet_id,product_id,location_id,batch,uom,quantity_base,amount_centavos,units_per_uom)values(${party.id},'SAMPLE-INV-0586','1',1,'sample-sale',${sha256Hex("sample original")},${day},'sale',${outlet.id},${sku.id},${location.id},'SAMPLE','EA',10,1000,1)returning id`;
    const policy = await api(clerk, "policies/save", {
      kind: "claim_type",
      code: "SAMPLE-SKU-0586",
      effectiveFrom: Date.now() - 86400_000,
      effectiveTo: Date.now() + 86400_000,
      requiredEvidence: ["secondary_sale", "photo"],
      allowExecutionOverride: true,
    });
    expect(policy.status).toBe(200);
    expect(
      (
        await api(clerk, "policies/save", {
          kind: "approval",
          name: "Sample independent Finance",
          partyType: "all",
          minCentavos: 0,
          maxCentavos: 5000,
          approverRoles: ["super_admin"],
          effectiveFrom: Date.now() - 86400_000,
          effectiveTo: Date.now() + 86400_000,
        })
      ).status,
    ).toBe(200);
    const packet = {
      partyType: "distributor",
      partyId: party.id,
      partyName: "Not the canonical name",
      typeId: policy.body.id,
      periodFrom: day,
      periodTo: day,
      outletId: outlet.id,
      productId: sku.id,
      uom: "EA",
      quantityUnits: 2,
      amountCentavos: 200,
    };
    const made = await api(clerk, "claims/submit", {
      ...packet,
      reference: "SAMPLE-CLAIM-0586",
    });
    expect(made.status).toBe(200);
    const id = made.body.id;
    const sources = await api(clerk, `claims/evidence-options?id=${id}`);
    expect(sources.status).toBe(200);
    expect(
      sources.body.rows.some(
        (/** @type {any} */ r) =>
          r.kind === "secondary_sale" && r.id === sale.id,
      ),
    ).toBe(true);
    expect(
      (
        await api(clerk, "claims/evidence", {
          id,
          kind: "secondary_sale",
          sourceId: sale.id,
        })
      ).status,
    ).toBe(200);
    const checked = await api(clerk, "claims/validate", { id });
    expect(checked.body.reasons).toEqual(["Missing verified photo"]);
    expect(checked.body.exceptionEligible).toBe(true);
    const exception = {
      id,
      baseHash: checked.body.baseHash,
      reason: "Sample supervised source inspection",
      evidenceReference: "SAMPLE-REVIEW-0586",
    };
    expect(
      (await api(clerk, "claims/execution-override", exception)).status,
    ).not.toBe(200);
    expect(
      (await api(finance, "claims/execution-override", exception)).status,
    ).toBe(200);
    expect((await api(finance, "claims/approve", { id })).status).toBe(200);
    const before = await api(clerk, `claims/detail?id=${id}`);
    expect(before.body.partyName).toBe("Sample claim company");
    const original = before.body.evidence[0].snapshot;
    const [revision] =
      await h.db`insert into distributor_secondary_lines(distributor_id,invoice_number,line_key,revision,source_key,payload_hash,sale_date,kind,outlet_id,product_id,location_id,batch,uom,quantity_base,amount_centavos,units_per_uom,supersedes_id)values(${party.id},'SAMPLE-INV-0586','1',2,'sample-sale-correction',${sha256Hex("sample correction")},${day},'sale',${outlet.id},${sku.id},${location.id},'SAMPLE','EA',10,500,1,${sale.id})returning id`;
    expect(
      (
        await api(other, "claims/settle", {
          id,
          amountCentavos: 200,
          method: "credit_memo",
        })
      ).status,
    ).not.toBe(200);
    expect(
      (
        await api(clerk, "claims/refresh-evidence", {
          id,
          kind: "secondary_sale",
          sourceId: sale.id,
          reason: "Sample authoritative invoice correction",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(clerk, "claims/amend", {
          id,
          amountCentavos: 100,
          quantityUnits: 2,
          reason: "Match corrected source value",
        })
      ).status,
    ).toBe(200);
    const rechecked = await api(clerk, "claims/validate", { id });
    expect(rechecked.body.reasons).toEqual(["Missing verified photo"]);
    expect(
      (await api(finance, "claims/execution-override", exception)).status,
    ).not.toBe(200);
    expect(
      (
        await api(finance, "claims/execution-override", {
          ...exception,
          baseHash: rechecked.body.baseHash,
        })
      ).status,
    ).toBe(200);
    expect((await api(finance, "claims/approve", { id })).status).toBe(200);
    await h.db`update profiles set status='disabled' where id=${finance.profileId}`;
    expect(
      (
        await api(other, "claims/settle", {
          id,
          amountCentavos: 100,
          method: "credit_memo",
        })
      ).status,
    ).not.toBe(200);
    expect(
      Number(
        (
          await h.db`select count(*) as n from claim_settlements where claim_id=${id}`
        )[0].n,
      ),
    ).toBe(0);
    await h.db`update profiles set status='active' where id=${finance.profileId}`;
    const originalProof =
      await h.db`select snapshot from claim_evidence where claim_id=${id}`;
    expect(originalProof[0].snapshot).toEqual(original);
    expect(
      Number(
        (
          await h.db`select count(*) as n from claim_evidence_revisions v join claim_evidence e on e.id=v.evidence_id where e.claim_id=${id}`
        )[0].n,
      ),
    ).toBe(1);
    const duplicate = await api(clerk, "claims/submit", {
      ...packet,
      amountCentavos: 100,
      reference: "SAMPLE-CLAIM-DUP-0586",
    });
    expect(duplicate.status).toBe(200);
    expect(
      (
        await api(clerk, "claims/evidence", {
          id: duplicate.body.id,
          kind: "secondary_sale",
          sourceId: revision.id,
        })
      ).status,
    ).not.toBe(200);
    const visit = crypto.randomUUID(),
      jpg = encode(
        { width: 1, height: 1, data: new Uint8Array([20, 40, 60, 255]) },
        80,
      ).data,
      hash = sha256Hex(jpg),
      path = `${hash.slice(0, 2)}/${hash}`;
    await mkdir(join(h.filesDir, hash.slice(0, 2)), { recursive: true });
    await Bun.write(join(h.filesDir, path), jpg);
    await h.db`insert into visit_executions(id,organization_id,client_visit_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,intents,state,productivity,last_server_time,checked_in_at,started_at)values(${visit},'sunpride',${crypto.randomUUID()},${field.profileId},${outlet.id},${unit},${day},'unplanned',array['merchandise'],'checked-in','pending',now(),now(),now())`;
    const [file] =
      await h.db`insert into files(owner_id,purpose,sha256,mime,size,path,status,created_by)values(${visit},'visit_evidence',${hash},'image/jpeg',${jpg.length},${path},'stored',${field.user})returning id`;
    const [photo] =
      await h.db`insert into field_evidence_files(organization_id,org_unit_id,storage_id,visit_id,owner_profile_id,outlet_id,mime,size_bytes,checksum,captured_at,uploaded_at,status)values('sunpride',${unit},${file.id},${visit},${field.profileId},${outlet.id},'image/jpeg',${jpg.length},${hash},now(),now(),'verified')returning id`;
    const image = await h.fetch(
      `/api/v1/tpm/claims/photo?id=${id}&sourceId=${photo.id}`,
      { headers: { cookie: clerk.cookie } },
    );
    expect(image.status).toBe(200);
    expect(sha256Hex(await image.arrayBuffer())).toBe(hash);
    expect(
      (
        await h.fetch(
          `/api/v1/tpm/claims/photo?id=${id}&sourceId=${photo.id}`,
          { headers: { cookie: field.cookie } },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api(clerk, "claims/amend", {
          id,
          amountCentavos: 100,
          reason: "Replace missing-photo exception with original proof",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(clerk, "claims/evidence", {
          id,
          kind: "photo",
          sourceId: photo.id,
        })
      ).status,
    ).toBe(200);
    expect((await api(clerk, "claims/validate", { id })).body.passed).toBe(
      true,
    );
    const docPolicy = await api(clerk, "policies/save", {
      kind: "claim_type",
      code: "SAMPLE-DOC-0586",
      effectiveFrom: Date.now() - 86400_000,
      effectiveTo: Date.now() + 86400_000,
      requiredEvidence: ["source_document"],
      allowExecutionOverride: true,
    });
    const documentClaim = await api(clerk, "claims/submit", {
      partyType: "distributor",
      partyId: party.id,
      typeId: docPolicy.body.id,
      reference: "SAMPLE-DOCUMENT-0586",
      periodFrom: day,
      periodTo: day,
      amountCentavos: 100,
    });
    expect(documentClaim.status).toBe(200);
    const content = new TextEncoder().encode(
      "Sample original claim attachment; not a certified monetary ledger.",
    );
    const [doc] =
      await h.db`insert into distributor_documents(distributor_id,kind,title,version,mime,sha256,content,published,uploaded_by)values(${party.id},'claim','Sample claim document',1,'text/plain',${sha256Hex(content)},${content},true,${clerk.profileId})returning id`;
    expect(
      (
        await api(clerk, "claims/evidence", {
          id: documentClaim.body.id,
          kind: "source_document",
          sourceId: doc.id,
        })
      ).status,
    ).toBe(200);
    const docCheck = await api(clerk, "claims/validate", {
      id: documentClaim.body.id,
    });
    expect(docCheck.body.passed).toBe(false);
    expect(docCheck.body.exceptionEligible).toBe(false);
    const download = await h.fetch(
      `/api/v1/tpm/claims/source-file?id=${documentClaim.body.id}&sourceId=${doc.id}`,
      { headers: { cookie: clerk.cookie } },
    );
    expect(download.status).toBe(200);
    expect(sha256Hex(await download.arrayBuffer())).toBe(sha256Hex(content));
  } finally {
    await h.close();
  }
});
