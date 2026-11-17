import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/** SP-0188 web: the office list of phone saves and the "Incomplete — from field app" note. */

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  error: undefined as unknown,
}));
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  useApi: () => ({
    data: state.data,
    error: state.error,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { PhoneSavesAdmin, plainKey, readableValues } from "./phone-saves";
import {
  FieldIncompleteNote,
  fieldMissingLabels,
  typedValue,
} from "../customers/field-incomplete";

const html = (el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(el).replace(/<!-- -->/g, "");

describe("Phone saves for the office", () => {
  it("lists date, salesman, app, what and why in plain words with a Done action", () => {
    state.data = {
      rows: [
        {
          id: "a",
          createdAt: Date.UTC(2026, 10, 17, 2, 0),
          salesman: "Ana Reyes",
          app: "Field app",
          what: "New customer",
          why: "This store or work is not assigned to this salesman",
          resolvedAt: null,
          resolvedBy: null,
          note: null,
        },
      ],
    };
    const view = html(createElement(PhoneSavesAdmin));
    expect(view).toContain("Phone saves for the office");
    for (const text of [
      "Ana Reyes",
      "Field app",
      "New customer",
      "This store or work is not assigned to this salesman",
      ">Done<",
      ">Details<",
    ])
      expect(view).toContain(text);
    for (const raw of ["census.capture", "out_of_scope", "invalid_request"])
      expect(view).not.toContain(raw);
  });
  it("says there is nothing to do when the list is empty", () => {
    state.data = { rows: [] };
    expect(html(createElement(PhoneSavesAdmin))).toContain("Nothing to do");
  });
  it("shows saved values as a readable list, never the raw photo", () => {
    expect(plainKey("ownerPhone")).toBe("Mobile no.");
    expect(plainKey("customerGroup1Code")).toBe("Customer group1 code");
    const lines = readableValues({
      name: "Aling Nena Store",
      photoJpegBase64: "/9j/AAAA",
      customer: { tradeName: "Nena's", shipTos: [{ contactPerson: "Nena" }] },
      blank: "",
      location: { fixTime: Date.UTC(2026, 10, 17, 2, 0) },
    });
    expect(lines.find(([l]) => l === "Location · Location time")?.[1]).toMatch(
      /2026/,
    );
    expect(lines).toContainEqual(["Store name", "Aling Nena Store"]);
    expect(lines).toContainEqual(["Photo", "Photo attached"]);
    expect(lines).toContainEqual(["Customer · Trade name", "Nena's"]);
    expect(lines).toContainEqual([
      "Customer · Ship tos 1 · Contact person",
      "Nena",
    ]);
    expect(lines.some(([, v]) => v.includes("/9j/"))).toBe(false);
  });
});

describe("Incomplete — from field app", () => {
  const missing = [
    { field: "mobileNo", label: "Mobile No.", message: "x" },
    { field: "regionCode", label: "Region", message: "x" },
    { field: "shipTos[0].mobileNo", label: "Mobile No.", message: "x" },
  ];
  it("names the missing fields and what the salesman typed", () => {
    expect(fieldMissingLabels(missing)).toEqual([
      "Mobile No.",
      "Region",
      "Delivery: Mobile No.",
    ]);
    const submitted = {
      mobileNo: "12345",
      shipTos: [{ mobileNo: "not a phone" }],
    };
    expect(typedValue(submitted, "shipTos[0].mobileNo")).toBe("not a phone");
    const view = html(
      createElement(FieldIncompleteNote, { missing, submitted }),
    );
    expect(view).toContain("Incomplete — from field app");
    expect(view).toContain("the salesman typed");
    expect(view).toContain("12345");
    expect(view).toContain("Region");
    expect(view).toContain("left blank");
  });
  it("renders nothing when nothing is missing", () => {
    expect(
      html(createElement(FieldIncompleteNote, { missing: null })),
    ).toBe("");
  });
});
