import { expect, test } from "bun:test";
import {
  customerTemplateCsv,
  parseCustomerCsv,
  enrollmentHeader,
  mapHeader,
  CUSTOMER_HEADERS,
  rowToCustomer,
  writerInput,
  EXAMPLE,
} from "../src/customers.js";
import { referenceIndex } from "@sunpride/customer-master";
import {
  buildCustomerTemplateWorkbook,
  customerTemplateXlsx,
} from "../src/customers-xlsx.js";
const f = {
  key: `cf_${"a".repeat(32)}`,
  label: "Counter, name",
  kind: "text",
  choices: [],
  requiredChannels: [],
  requiredTypes: [],
};
test("SP-0229 CSV and Excel include ordered stable custom columns, accept renamed labels, reject duplicate identities", async () => {
  const csv = customerTemplateCsv([f]);
  expect(parseCustomerCsv(csv).header.at(-1)).toBe(enrollmentHeader(f));
  expect(
    mapHeader([
      ...CUSTOMER_HEADERS,
      enrollmentHeader({ ...f, label: "Renamed" }),
    ]).ids.at(-1),
  ).toBe(`customFields.${f.key}`);
  expect(
    mapHeader([...CUSTOMER_HEADERS, enrollmentHeader(f), enrollmentHeader(f)])
      .unknown,
  ).toHaveLength(1);
  const wb = buildCustomerTemplateWorkbook([], [f]);
  expect(
    wb.getWorksheet("Customers")?.getCell(1, CUSTOMER_HEADERS.length + 1).value,
  ).toBe(enrollmentHeader(f));
  expect((await customerTemplateXlsx([], [f])).length).toBeGreaterThan(1000);
});
test("SP-0229 upload maps custom cells to the canonical customer writer, blank updates preserve stored answers", () => {
  const row = {
    rowNumber: 2,
    values: { ...EXAMPLE, [`customFields.${f.key}`]: "Desk" },
  };
  const index = referenceIndex([]);
  const item = rowToCustomer(row, index);
  expect(item.customer.customFields).toEqual({ [f.key]: "Desk" });
  expect(
    writerInput(item, row, index, { customFields: { other: "Kept" } })
      .customFields,
  ).toEqual({ other: "Kept", [f.key]: "Desk" });
  const blank = {
    ...row,
    values: { ...row.values, [`customFields.${f.key}`]: "" },
  };
  expect(
    writerInput(rowToCustomer(blank, index), blank, index, {
      customFields: { [f.key]: "Kept" },
    }).customFields,
  ).toBeUndefined();
});
