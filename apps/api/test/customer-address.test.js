// SP-0220: exercise the web's actual edit payload against authenticated customer routes.
// One sample customer, one office user and one geography chain; no demo company seed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarness, createUser } from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as masters } from "../src/domains/masters/index.js";
import {
  draftFromCustomer,
  setField,
  toPayload,
} from "../../web/src/components/customers/model";

/** @type {import('./harness.js').Harness} */ let h;
let cookie = "";
let unitId = "";
let customerId = "";
const reportedAddress = "Blk 5, Lot 3. Brgy. Guadalupe";
const punctuationAddress = "#5-A / Lot 3. Brgy. Guadalupe, Cebu";

/** @param {string} method @param {string} path @param {any} [body] */
async function call(method, path, body) {
  const response = await h.fetch(`/api/v1/customers${path}`, {
    method,
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      connection: "close",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: /** @type {any} */ (await response.json()),
  };
}

beforeAll(async () => {
  h = await startHarness({ installers: [org, masters] });
  const [unit] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from)
    values('sunpride','SUNPRIDE','Sample office','NATIONAL','active','2020-01-01') returning id`;
  unitId = unit.id;
  const userId = await createUser(
    h,
    "address@example.test",
    "sample-address-password",
  );
  const [profile] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id)
    values(${userId},${userId},'Sample office user','address@example.test','admin','active',${unitId}) returning id`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason)
    values(${profile.id},${unitId},'admin','2020-01-01',${userId},'SP-0220 sample')`;
  await h.db`insert into ph_regions(code,name) values('0700000000','Central Visayas')`;
  await h.db`insert into ph_provinces(code,region_code,name,kind) values('0702200000','0700000000','Cebu','province')`;
  await h.db`insert into ph_municipalities(code,province_code,region_code,name,kind)
    values('0730600000','0702200000','0700000000','City of Cebu','city')`;
  await h.db`insert into ph_barangays(code,municipality_code,name) values('0730600003','0730600000','Apas')`;
  await h.db`insert into ph_postal_codes(municipality_code,postal_code,source) values('0730600000','6000','SP-0220 sample')`;
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({
      email: "address@example.test",
      password: "sample-address-password",
    }),
  });
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
}, 120000);
afterAll(async () => {
  await h?.close();
});

describe("SP-0220 customer addresses", () => {
  test("create accepts normal punctuation in customer and street addresses", async () => {
    const created = await call("POST", "", {
      custodianOrgUnitId: unitId,
      customer: {
        registeredName: "Sample Address Store Inc.",
        customerName: "Sample Address Store",
        customerAddress: reportedAddress,
        mobileNo: "09171234567",
        taxClassificationCode: "1",
        regionCode: "0700000000",
        provinceCode: "0702200000",
        municipalityCode: "0730600000",
        barangayCode: "0730600003",
        street1: punctuationAddress,
        postalCode: "6000",
        latitude: 10.33,
        longitude: 123.9,
        salesOrgCode: "1000",
        salesOfficeCode: "100",
        distributionChannelCode: "50",
        customerGroupCode: "74",
        typeOfBusiness: "Sole Proprietor",
        paymentTermsCode: "0003",
        pricingProcedureCode: "2",
        deliveringPlantCode: "1000",
        shipTos: [{ sameAsCustomer: true, contactPerson: "Sample Contact" }],
      },
    });
    expect(created.status).toBe(200);
    customerId = created.body.id;
    const saved = await call("GET", `/${customerId}`);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      customerAddress: reportedAddress,
      street1: punctuationAddress,
      addressCustom: true,
    });
    expect(saved.body.shipTos[0].shipToAddress).toBe(reportedAddress);
  });

  test("edit, save and reopen preserve . , - # / in Customer Address and Street 1", async () => {
    for (const address of [punctuationAddress, reportedAddress]) {
      const opened = await call("GET", `/${customerId}`);
      let draft = draftFromCustomer(opened.body);
      draft = setField(draft, "street1", address);
      draft = setField(draft, "customerAddress", address);
      const edited = await call("PUT", `/${customerId}`, {
        customer: toPayload(draft),
      });
      expect(edited.status).toBe(200);
      const reopened = await call("GET", `/${customerId}`);
      expect(reopened.status).toBe(200);
      expect(reopened.body).toMatchObject({
        customerAddress: address,
        street1: address,
        addressCustom: true,
        completeness: "complete",
      });
      expect(reopened.body.shipTos[0].shipToAddress).toBe(address);
    }
  });

  test("editing Street 1 regenerates Customer Address and the copied delivery address", async () => {
    const opened = await call("GET", `/${customerId}`);
    let draft = setField(draftFromCustomer(opened.body), "customerAddress", "");
    draft = setField(draft, "street1", reportedAddress);
    const edited = await call("PUT", `/${customerId}`, {
      customer: toPayload(draft),
    });
    expect(edited.status).toBe(200);
    const reopened = await call("GET", `/${customerId}`);
    const expected = `${reportedAddress}, Apas, City of Cebu, Cebu 6000`;
    expect(reopened.body).toMatchObject({
      street1: reportedAddress,
      customerAddress: expected,
      addressCustom: false,
    });
    expect(reopened.body.shipTos[0].shipToAddress).toBe(expected);
  });

  test("a custom Customer Address cannot bypass blank Street 1 on create or edit", async () => {
    const opened = await call("GET", `/${customerId}`);
    for (const street1 of [null, "", " \t "]) {
      const input = {
        ...toPayload(draftFromCustomer(opened.body)),
        street1,
        customerAddress: reportedAddress,
      };
      for (const [method, path] of [
        ["POST", ""],
        ["PUT", `/${customerId}`],
      ]) {
        const result = await call(method, path, {
          custodianOrgUnitId: unitId,
          customer: input,
        });
        expect(result.status).toBe(422);
        expect(result.body.error.details.errors).toEqual([
          expect.objectContaining({
            field: "street1",
            message: "Street 1 is required.",
          }),
        ]);
      }
    }
    const reopened = await call("GET", `/${customerId}`);
    expect(reopened.body).toEqual(opened.body);
  });
});
