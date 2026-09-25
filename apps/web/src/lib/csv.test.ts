import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashText, parseCsv, splitCsv } from "./csv";
import {
  OPENING_STOCK_HEADERS,
  PRODUCT_MASTER_HEADERS,
} from "./import-templates";

const PRODUCT_TEMPLATE = readFileSync(
  new URL("../../public/templates/product-master.csv", import.meta.url),
  "utf8",
);
const OPENING_TEMPLATE = readFileSync(
  new URL("../../public/templates/opening-stock.csv", import.meta.url),
  "utf8",
);

describe("csv splitting", () => {
  it("handles quoted separators, escaped quotes and both line endings", () => {
    expect(splitCsv('a,"b,1",c\r\n1,2,"say ""hi"""\n')).toEqual([
      ["a", "b,1", "c"],
      ["1", "2", 'say "hi"'],
    ]);
  });

  it("ignores a leading byte-order mark", () => {
    expect(splitCsv("\uFEFFa,b\n1,2\n")[0]).toEqual(["a", "b"]);
  });

  it("treats a quote inside an unquoted field literally", () => {
    expect(splitCsv('a,b"c\n')[0]).toEqual(["a", 'b"c']);
  });
});

describe("parseCsv", () => {
  const header = ["product_code", "quantity"];

  it("maps rows to records and numbers them like a spreadsheet", () => {
    const parsed = parseCsv(
      "product_code,quantity\nSP-A,10\nSP-B,20\n",
      header,
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      { rowNumber: 2, values: { product_code: "SP-A", quantity: "10" } },
      { rowNumber: 3, values: { product_code: "SP-B", quantity: "20" } },
    ]);
  });

  it("keeps spreadsheet line numbers when blank lines are skipped", () => {
    const parsed = parseCsv("product_code,quantity\n\nSP-A,10\n", header);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.rowNumber).toBe(3);
  });

  it("pads short rows instead of failing them", () => {
    const parsed = parseCsv("product_code,quantity\nSP-A\n", header);
    expect(parsed.rows[0]?.values).toEqual({
      product_code: "SP-A",
      quantity: "",
    });
    expect(parsed.errors).toEqual([]);
  });

  it("flags a row with too many columns", () => {
    const parsed = parseCsv("product_code,quantity\nSP-A,10,extra\n", header);
    expect(parsed.errors).toEqual([
      {
        rowNumber: 2,
        code: "column_count",
        message: "Expected 2 columns but found 3.",
      },
    ]);
  });

  it("flags missing, unknown and repeated header columns", () => {
    const parsed = parseCsv("product_code,warehouse,warehouse\nSP-A,WH,WH\n", [
      "product_code",
      "quantity",
    ]);
    expect(parsed.missingColumns).toEqual(["quantity"]);
    expect(parsed.unknownColumns).toEqual(["warehouse"]);
    expect(parsed.errors.map((error) => error.code)).toEqual([
      "missing_column",
      "unknown_column",
      "duplicate_column",
    ]);
  });

  it("reports an empty file", () => {
    const parsed = parseCsv("", header);
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors[0]?.code).toBe("empty_file");
    expect(parsed.missingColumns).toEqual(header);
  });
});

describe("templates", () => {
  it("keeps the product template header in step with the client contract", () => {
    expect(splitCsv(PRODUCT_TEMPLATE)[0]).toEqual(PRODUCT_MASTER_HEADERS);
  });

  it("keeps the opening-stock template header in step with the client contract", () => {
    expect(splitCsv(OPENING_TEMPLATE)[0]).toEqual(OPENING_STOCK_HEADERS);
  });

  it("parses its own templates cleanly", () => {
    expect(
      parseCsv(PRODUCT_TEMPLATE, PRODUCT_MASTER_HEADERS).rows,
    ).toHaveLength(1);
    expect(parseCsv(OPENING_TEMPLATE, OPENING_STOCK_HEADERS).rows).toHaveLength(
      1,
    );
  });
});

describe("hashText", () => {
  it("is stable for identical content and differs otherwise", () => {
    expect(hashText("SP-A,10")).toBe(hashText("SP-A,10"));
    expect(hashText("SP-A,10")).not.toBe(hashText("SP-A,11"));
    expect(hashText("SP-A,10")).toMatch(/^fnv1a-[0-9a-f]{8}$/);
  });
});
