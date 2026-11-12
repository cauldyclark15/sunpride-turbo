// SP-0170: the Android field app ports the customer rules to Kotlin. This builds the parity
// fixture it tests against (apps/field-android CustomerMasterParityTest): the field list in
// sheet order with the client's labels, and the JS answers for a set of validation, address
// and label cases over the client's real reference lists. test/android-parity.test.js fails
// when the committed fixture drifts from the JS package.
// Regenerate: bun packages/customer-master/scripts/android-parity.js
import {
  ADP_CHANNEL,
  FIELDS,
  SECTIONS,
  applicability,
  formatAddress,
  optionLabel,
  referenceIndex,
  validateCustomer,
} from "../src/index.js";
import { referenceRows } from "../../db/src/customer-reference.js";

export const FIXTURE = new URL(
  "../fixtures/android-parity.json",
  import.meta.url,
);

const cebu = {
  region: { code: "0700000000", name: "Region VII (Central Visayas)" },
  province: { code: "0702200000", name: "Cebu", regionCode: "0700000000" },
  municipality: {
    code: "0730600000",
    name: "City of Cebu",
    provinceCode: "0702200000",
    regionCode: "0700000000",
  },
  barangay: {
    code: "0730600003",
    name: "Apas",
    municipalityCode: "0730600000",
  },
  postalCodes: ["6000"],
};
const good = {
  customerName: "Aling Rosa Store",
  mobileNo: "0917 123 4567",
  regionCode: "0700000000",
  provinceCode: "0702200000",
  municipalityCode: "0730600000",
  barangayCode: "0730600003",
  postalCode: "6000",
  latitude: 10.3312,
  longitude: 123.9056,
  salesOrgCode: "1000",
  distributionChannelCode: "41",
  customerGroup1Code: "RSF",
  customerGroup2Code: "RSS",
  customerGroupCode: "74",
  typeOfBusiness: "Sole Proprietor",
};
/** @type {[string, Record<string, any>, any, ("draft"|"complete")][]} */
const CASES = [
  ["ok draft", good, cebu, "draft"],
  ["blank name", { ...good, customerName: " " }, cebu, "draft"],
  ["empty draft", {}, null, "draft"],
  [
    "formats",
    {
      ...good,
      mobileNo: "12345",
      tin: "12-34",
      email: "nope",
      telNo: "x".repeat(41),
      registeredName: "r".repeat(201),
    },
    cebu,
    "draft",
  ],
  [
    "normalized",
    {
      ...good,
      mobileNo: "+639171234567",
      tin: "123456789012",
      email: "A@B.PH",
    },
    cebu,
    "draft",
  ],
  [
    "channel not for ARI",
    {
      ...good,
      salesOrgCode: "2000",
      distributionChannelCode: "30",
      customerGroup1Code: null,
      customerGroup2Code: null,
    },
    cebu,
    "draft",
  ],
  ["channel without org", { ...good, salesOrgCode: "" }, cebu, "draft"],
  [
    "unknown channel",
    { ...good, distributionChannelCode: "99" },
    cebu,
    "draft",
  ],
  [
    "grp1 not for channel",
    { ...good, customerGroup1Code: "NOPE", customerGroup2Code: null },
    cebu,
    "draft",
  ],
  [
    "grp1 not applicable (Services 50)",
    { ...good, distributionChannelCode: "50", customerGroup2Code: null },
    cebu,
    "draft",
  ],
  ["grp2 not for grp1", { ...good, customerGroup2Code: "ZZZ" }, cebu, "draft"],
  ["grp2 without grp1", { ...good, customerGroup1Code: null }, cebu, "draft"],
  [
    "food service has no grp2",
    {
      ...good,
      distributionChannelCode: "20",
      customerGroup1Code: null,
      customerGroup2Code: null,
    },
    cebu,
    "complete",
  ],
  [
    "services complete",
    {
      ...good,
      distributionChannelCode: "50",
      customerGroup1Code: null,
      customerGroup2Code: null,
    },
    cebu,
    "complete",
  ],
  [
    "route sales complete missing grp",
    { ...good, customerGroup1Code: null, customerGroup2Code: null },
    cebu,
    "complete",
  ],
  [
    "distributive trade needs ADP",
    {
      ...good,
      distributionChannelCode: "40",
      customerGroup1Code: null,
      customerGroup2Code: null,
    },
    cebu,
    "complete",
  ],
  [
    "bad type of business",
    { ...good, typeOfBusiness: "Pirate", customerGroupCode: "nope" },
    cebu,
    "draft",
  ],
  [
    "province in another region",
    { ...good },
    { ...cebu, province: { ...cebu.province, regionCode: "1300000000" } },
    "draft",
  ],
  [
    "barangay elsewhere",
    { ...good },
    { ...cebu, barangay: { ...cebu.barangay, municipalityCode: "0731100000" } },
    "draft",
  ],
  [
    "unknown municipality",
    { ...good },
    { ...cebu, municipality: null },
    "draft",
  ],
  ["postal mismatch", { ...good, postalCode: "6014" }, cebu, "draft"],
  ["postal not 4 digits", { ...good, postalCode: "60" }, cebu, "draft"],
  ["postal without geography", { ...good, postalCode: "6a00" }, null, "draft"],
  ["region missing for province", { ...good, regionCode: "" }, cebu, "draft"],
  ["coordinates 0,0", { ...good, latitude: 0, longitude: 0 }, cebu, "draft"],
  ["coordinates half", { ...good, longitude: null }, cebu, "draft"],
  ["coordinates out of range", { ...good, latitude: 91 }, cebu, "draft"],
  [
    "complete without coordinates",
    { ...good, latitude: null, longitude: null },
    cebu,
    "complete",
  ],
];

/** @param {Record<string, any>} o */
const dropUndefined = (o) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export async function buildParity() {
  const json = JSON.parse(
    await Bun.file(
      new URL(
        "../../db/reference/sunpride-customer-master-2026-11-10.json",
        import.meta.url,
      ),
    ).text(),
  );
  const lists = referenceRows(json).map((r) => ({
    list: r.list,
    salesOrgCode: r.salesOrgCode,
    channelCode: r.channelCode,
    group1Code: r.group1Code,
    code: r.code,
    name: r.name,
  }));
  const index = referenceIndex(lists);
  const cases = CASES.map(([name, input, geography, level]) => {
    const r = validateCustomer(input, { level, lists: index, geography });
    return {
      name,
      level,
      input,
      geography,
      expected: {
        ok: r.ok,
        errors: r.errors.map((e) => ({
          code: e.code,
          field: e.field,
          message: e.message,
        })),
        value: {
          mobileNo: r.value.mobileNo,
          tin: r.value.tin,
          email: r.value.email,
        },
      },
    };
  });
  const chains = [
    ["1000", "41", null],
    ["1000", "41", "RSF"],
    ["1000", "50", null],
    ["1000", "20", null],
    ["2000", "30", null],
    ["2000", "70", null],
    ["1000", "40", null],
  ].map(([salesOrgCode, distributionChannelCode, customerGroup1Code]) => ({
    input: { salesOrgCode, distributionChannelCode, customerGroup1Code },
    expected: applicability(index, {
      salesOrgCode,
      distributionChannelCode,
      customerGroup1Code,
    }),
  }));
  const addresses = [
    {},
    { street1: "Gorordo Ave" },
    {
      roomStallNo: "Stall 4",
      floor: "2F",
      houseNo: "12",
      street1: "Gorordo Ave",
      street2: "Lahug",
      barangayName: "Apas",
      municipalityName: "City of Cebu",
      provinceName: "Cebu",
      postalCode: "6000",
    },
    { houseNo: "12", barangayName: " Apas ", postalCode: "6000" },
  ].map((input) => ({ input, expected: formatAddress(input) }));
  const labels = [
    { code: "30", name: "General Trade" },
    { code: "Sole Proprietor", name: "Sole Proprietor" },
  ].map((r) => ({ ...r, expected: optionLabel(r) }));
  return {
    note: "Generated by packages/customer-master/scripts/android-parity.js (SP-0170). Do not edit.",
    sections: SECTIONS,
    adpChannel: ADP_CHANNEL,
    fields: FIELDS.map((f) =>
      dropUndefined({
        key: f.key,
        label: f.label,
        section: f.section,
        required: f.required,
        kind: f.kind,
        list: f.list,
        max: f.max,
        shipTo: f.shipTo === true,
        adp: f.adp === true,
      }),
    ),
    lists,
    cases,
    chains,
    addresses,
    labels,
  };
}

if (import.meta.main) {
  await Bun.write(FIXTURE, JSON.stringify(await buildParity(), null, 1) + "\n");
  console.log("wrote", FIXTURE.pathname);
}
