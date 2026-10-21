import { test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, createUser } from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { actorFor } from "../src/core/context.js";
import { enforceDsrOp } from "../src/domains/distributors/dsr.js";
import { validateDsrProducts } from "../src/domains/distributors/dsr-context.js";

test("F-407 granted selling units are literal and cannot become another pack or foreign product", () => {
  const catalog = [{ productId: "SAMPLE-A", uom: "CS" }];
  expect(() =>
    validateDsrProducts(catalog, {
      lines: [{ productId: "SAMPLE-A", uom: "CS" }],
    }),
  ).not.toThrow();
  expect(() =>
    validateDsrProducts(catalog, {
      lines: [{ productId: "SAMPLE-A", uom: "EA" }],
    }),
  ).toThrow();
  expect(() =>
    validateDsrProducts(catalog, {
      lines: [{ productId: "SAMPLE-A", uom: "cs" }],
    }),
  ).toThrow();
  expect(() =>
    validateDsrProducts(catalog, { productId: "SAMPLE-FOREIGN" }),
  ).toThrow();
});
test("F-407 withdrawn store is denied in the guard that precedes even a stored CORE receipt", async () => {
  const h = await startHarness({ installers: [org] });
  try {
    const root = crypto.randomUUID(),
      unit = crypto.randomUUID(),
      party = crypto.randomUUID(),
      outlet = crypto.randomUUID();
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${root},'sunpride','SUNPRIDE','SAMPLE','national','active','2020-01-01'),(${unit},'sunpride','SAMPLE-CHILD','SAMPLE devices','region','active','2020-01-01')`;
    await h.db`update org_units set parent_id=${root} where id=${unit}`;
    const uid = await createUser(
      h,
      "sample-boundary@example.test",
      "test-only-dsr-boundary-password",
    );
    const [p] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${uid},${uid},'SAMPLE DSR','sample-boundary@example.test','distributor','active',${unit}) returning id`;
    await h.db`insert into distributors(id,code,name,org_unit_id,device_org_unit_id,status,source,effective_from) values(${party},'SAMPLE-D','SAMPLE partner',${root},${unit},'accredited','sample','2020-01-01')`;
    await h.db`insert into distributor_users(distributor_id,profile_id,grants,effective_from) values(${party},${p.id},ARRAY['dsr']::text[],'2020-01-01')`;
    const [m] =
      await h.db`insert into distributor_master_versions(distributor_id,source,source_key,version,payload_hash,payload,effective_from) values(${party},'sample','SAMPLE',1,'SAMPLE',${{}},'2020-01-01') returning id`;
    await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,created_by) values(${outlet},'sunpride','SAMPLE-O','SAMPLE shared store','active',${root},'SAMPLE')`;
    await h.db`insert into distributor_outlets(distributor_id,outlet_id,master_version_id,effective_from) values(${party},${outlet},${m.id},'2020-01-01')`;
    const actor = await actorFor(h.db, uid),
      op = {
        opType: "dsr.visit.checkIn",
        clientTime: Date.now(),
        payload: { distributorId: party, outletId: outlet },
      };
    expect((await tx(h.db, (db) => enforceDsrOp(db, actor, op))).id).toBe(
      party,
    );
    await h.db`update distributor_outlets set effective_to=now() where distributor_id=${party}`;
    await expect(
      tx(h.db, (db) => enforceDsrOp(db, actor, op)),
    ).rejects.toBeDefined();
  } finally {
    await h.close();
  }
}, 30000);
