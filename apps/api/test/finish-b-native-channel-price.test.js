import { test, expect } from "bun:test";
import { startHarness } from "./harness.js";
import { ensureRoot } from "../src/domains/org/identity.js";
import { resolvePrice } from "../src/domains/orders/pricing.js";
import { ingestMaster } from "../src/domains/integration/replicas.js";
import { configureSap } from "../src/domains/integration/transport.js";
import { sampleMaster } from "../../sap-mock/src/sample.js";

test("F-503 native and office prices use the persisted store channel, not an account or caller channel", async () => {
  const h = await startHarness({ installers: [] });
  try {
    configureSap(h.db, h.env);
    const unit = await ensureRoot(h.db),
      at = Date.now();
    const [product] =
      await h.db`insert into products(organization_id,code,name,category,uom,unit_price,active) values('sunpride','SAMPLE-CHANNEL-SKU','Sample channel product','Sample','EA',0,true) returning id`;
    const [outlet] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values('sunpride','SAMPLE-CHANNEL-STORE','Sample channel store','active',${unit},'GT','sample-fixture') returning id`;
    for (const [key, amount] of [
      ["gt", 100],
      ["mt", 200],
    ]) {
      const condition = sampleMaster("condition", "SAMPLE-CHANNEL-" + key, {
        productCode: "SAMPLE-CHANNEL-SKU",
        uom: "EA",
        customerCode: null,
        channelKey: key,
        currency: "PHP",
        unitPriceCentavos: amount,
        taxCode: "SAMPLE",
        taxBasisPoints: 0,
        taxInclusive: true,
        precedence: 10,
        priceListCode: "SAMPLE-" + key,
      });
      condition.effectiveFrom = at - 1000;
      await ingestMaster(h.db, condition);
    }
    const input = {
      organizationId: "sunpride",
      outletId: outlet.id,
      productId: product.id,
      uom: "EA",
      customerCode: null,
      channelKey: "mt",
      at,
    };
    expect((await resolvePrice(h.db, input)).unitPriceCentavos).toBe(100);
    await h.db`update outlets set channel='MT' where id=${outlet.id}`;
    expect(
      (await resolvePrice(h.db, { ...input, channelKey: "gt" }))
        .unitPriceCentavos,
    ).toBe(200);
    await h.db`update outlets set deleted_at=now() where id=${outlet.id}`;
    expect((await resolvePrice(h.db, input)).unitPriceCentavos).toBeNull();
  } finally {
    await h.close();
  }
}, 30000);
