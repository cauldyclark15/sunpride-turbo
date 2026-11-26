// SP-0220: exercise the web's actual edit payload against authenticated customer routes.
// One sample customer, one office user and one geography chain; no demo company seed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarness, createUser } from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as masters } from "../src/domains/masters/index.js";
import { readCustomer } from "../src/domains/masters/customers.js";
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

/** @param {string} method @param {string} path @param {any} [body] @param {string} [key] */
async function call(method, path, body, key = crypto.randomUUID()) {
  const response = await h.fetch(`/api/v1/customers${path}`, {
    method,
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": key,
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
        firstName: "Sample Address",
        lastName: "Store",
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

  test("SP-0220 an older custom Customer Address stays readable until the location changes", async () => {
    const opened = await call("GET", `/${customerId}`);
    expect(opened.body.addressCustom).toBe(true);
    const draft = setField(
      draftFromCustomer(opened.body),
      "tradeName",
      "Sample Trade",
    );
    const payload = toPayload(draft);
    expect(payload).not.toHaveProperty("customerAddress");
    const edited = await call("PUT", `/${customerId}`, { customer: payload });
    expect(edited.status).toBe(200);
    const reopened = await call("GET", `/${customerId}`);
    expect(reopened.body).toMatchObject({
      customerAddress: reportedAddress,
      addressCustom: true,
    });
  });

  test("edit, save and reopen preserve . , - # / in Street 1; Customer Address is built from it", async () => {
    // Street 1 starts as punctuationAddress, so the first edit changes the location.
    for (const address of [reportedAddress, punctuationAddress]) {
      const opened = await call("GET", `/${customerId}`);
      const draft = setField(
        draftFromCustomer(opened.body),
        "street1",
        address,
      );
      const payload = toPayload(draft);
      expect(payload).not.toHaveProperty("customerAddress");
      const edited = await call("PUT", `/${customerId}`, { customer: payload });
      expect(edited.status).toBe(200);
      const reopened = await call("GET", `/${customerId}`);
      expect(reopened.status).toBe(200);
      const expected = `${address}, Apas, City of Cebu, Cebu 6000`;
      expect(reopened.body).toMatchObject({
        customerAddress: expected,
        street1: address,
        addressCustom: false,
        completeness: "complete",
      });
      expect(reopened.body.shipTos[0].shipToAddress).toBe(expected);
    }
  });

  test("SP-0255 clearing Street 1 saves and reopens the same complete customer with its coordinates", async () => {
    for (const street1 of ["", " \t "]) {
      const opened = await call("GET", `/${customerId}`);
      const cleared = setField(
        draftFromCustomer(opened.body),
        "street1",
        street1,
      );
      const payload = toPayload(cleared);
      expect(payload.street1).toBeNull();
      expect(payload).not.toHaveProperty("customerAddress");
      const key = crypto.randomUUID();
      const saved = await call(
        "PUT",
        `/${customerId}`,
        { customer: payload },
        key,
      );
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(
        (await call("PUT", `/${customerId}`, { customer: payload }, key))
          .status,
      ).toBe(200);
      const reopened = await call("GET", `/${customerId}`);
      expect(reopened.body).toMatchObject({
        id: customerId,
        street1: null,
        customerAddress: "Apas, City of Cebu, Cebu 6000",
        completeness: "complete",
        latitude: 10.33,
        longitude: 123.9,
      });
      expect(reopened.body.missingFields).toEqual([]);
      expect(reopened.body.shipTos[0].shipToAddress).toBe(
        "Apas, City of Cebu, Cebu 6000",
      );
      const [stored] =
        await h.db`select cp.street1,o.address,c.name from customer_profiles cp
        join outlets o on o.id=cp.outlet_id join outlet_customer_links l on l.outlet_id=o.id and l.deleted_at is null
        join customers c on c.id=l.customer_id where o.id=${customerId} order by l.effective_from desc limit 1`;
      expect(stored).toMatchObject({
        street1: null,
        address: "Apas, City of Cebu, Cebu 6000",
      });
    }
  });

  test("SP-0255 older field captures no longer ask the office to fill optional Street 1", async () => {
    const obsolete = {
      field: "street1",
      label: "Street 1",
      message: "Street 1 is required.",
    };
    const stillNeeded = [
      {
        field: "registeredName",
        label: "Registered Name",
        message: "Registered Name is required.",
      },
      {
        field: "street1",
        label: "Street 1",
        message: "Street 1 must be 200 characters or fewer.",
      },
    ];
    for (const remaining of [stillNeeded, []]) {
      const stored = [obsolete, ...remaining];
      await h.db`update customer_profiles set field_missing=${JSON.stringify(stored)}::text::jsonb where outlet_id=${customerId}`;
      const canonical = await readCustomer(h.db, customerId);
      expect(canonical.fieldMissing).toEqual(
        remaining.length ? remaining : null,
      );
      const detail = await call("GET", `/${customerId}`);
      expect(detail.status).toBe(200);
      // The editable detail revalidates today's complete values, not the old capture's warnings.
      expect(detail.body.fieldMissing).toBeNull();
      expect(detail.body.missingFields).toEqual([]);
      const list = await call("GET", "");
      expect(list.status).toBe(200);
      expect(
        list.body.rows.find((/** @type {any} */ r) => r.id === customerId)
          ?.fieldMissing,
      ).toEqual(remaining.length ? remaining : null);
      // Reading current guidance must not rewrite the agent's original evidence.
      const [row] =
        await h.db`select field_missing from customer_profiles where outlet_id=${customerId}`;
      expect(row.field_missing).toEqual(stored);
    }
  });

  test("SP-0255 approving an older blank-street capture clears its obsolete incomplete flag", async () => {
    const approved = await call("POST", `/${customerId}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const reopened = await call("GET", `/${customerId}`);
    expect(reopened.body).toMatchObject({
      status: "active",
      completeness: "complete",
      fieldMissing: null,
      street1: null,
      latitude: 10.33,
      longitude: 123.9,
    });
    const [stored] =
      await h.db`select field_missing from customer_profiles where outlet_id=${customerId}`;
    expect(stored.field_missing).toBeNull();
  });

  test("SP-0255 create and approve accept all empty Street 1 representations", async () => {
    const opened = await call("GET", `/${customerId}`);
    for (const street1 of [undefined, null, "", " \t "]) {
      const input = { ...toPayload(draftFromCustomer(opened.body)), street1 };
      const created = await call("POST", "", {
        custodianOrgUnitId: unitId,
        customer: input,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const id = created.body.id;
      const approved = await call("POST", `/${id}/approve`, {});
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      const reopened = await call("GET", `/${id}`);
      expect(reopened.body).toMatchObject({
        street1: null,
        completeness: "complete",
        status: "active",
        customerAddress: "Apas, City of Cebu, Cebu 6000",
        latitude: 10.33,
        longitude: 123.9,
      });
      expect(reopened.body.missingFields).toEqual([]);
      expect(reopened.body.shipTos[0].shipToAddress).toBe(
        "Apas, City of Cebu, Cebu 6000",
      );
    }
  });
});
