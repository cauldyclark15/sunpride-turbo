import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { changeLine, isChange, type Capture } from "./model";
import { CaptureRow, ChangeDetail } from "./review";

/** Field "Edit store" on the web New stores tab: listed as "Change", old -> new, Approve/Reject. */
const change: Capture = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Renamed Sari-Sari",
  address: "Purok 9, Lahug",
  accuracy_meters: null,
  captured_at: new Date(Date.now() - 3 * 60000).toISOString(),
  owner_name: "New Owner",
  owner_phone: "0917 555 0199",
  estimated_class: "",
  agent: "Rhea Santos",
  batch: "Ongoing store gathering",
  latitude: 10.33,
  longitude: 123.9,
  location_source: "gps",
  location_status: "verified",
  formatted_address: null,
  address_components: null,
  landmark: null,
  duplicate_flag: false,
  duplicate_candidates: [],
  acknowledged_duplicate_ids: [],
  channel: null,
  subchannel: null,
  kind: "change",
  has_photo: false,
  target: {
    id: "55555555-5555-4555-8555-555555555555",
    code: "SMP-O0069",
    name: "Aling Nena Store",
  },
  changes: [
    {
      field: "name",
      label: "Store name",
      old: "Aling Nena Store",
      new: "Renamed Sari-Sari",
    },
    {
      field: "ownerPhone",
      label: "Owner phone",
      old: null,
      new: "0917 555 0199",
    },
  ],
};
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(el);
const props = {
  capture: change,
  decision: "accept" as const,
  onDecision: vi.fn(),
  onSubmit: vi.fn(),
  onClose: vi.fn(),
};

describe("store edit on the New stores tab", () => {
  it("labels a change request and keeps new stores unlabelled", () => {
    expect(isChange(change)).toBe(true);
    expect(isChange({ kind: "new" })).toBe(false);
    expect(isChange({})).toBe(false);
    const row = html(
      createElement(CaptureRow, {
        capture: change,
        selected: false,
        onOpen: vi.fn(),
      }),
    );
    expect(row).toContain("Change");
    expect(row).toContain('data-testid="capture-change-badge"');
    expect(row).not.toContain("/photo"); // no new photo: no broken image
    const plain = html(
      createElement(CaptureRow, {
        capture: { ...change, kind: "new", has_photo: true },
        selected: false,
        onOpen: vi.fn(),
      }),
    );
    expect(plain).not.toContain("capture-change-badge");
  });

  it("shows old -> new for each changed field", () => {
    expect(changeLine(change.changes![0]!)).toBe(
      "Aling Nena Store → Renamed Sari-Sari",
    );
    expect(changeLine(change.changes![1]!)).toBe("Not set → 0917 555 0199");
    const out = html(createElement(ChangeDetail, props));
    expect(out).toContain("Change to Aling Nena Store");
    expect(out).toContain("SMP-O0069");
    expect(out).toContain('data-testid="change-name"');
    expect(out).toContain("Store name: Aling Nena Store → Renamed Sari-Sari");
    expect(out).toContain("Owner phone: Not set → 0917 555 0199");
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("offers Approve change and Reject, never a new store or a link", () => {
    const out = html(createElement(ChangeDetail, props));
    expect(out).toContain("Approve change");
    expect(out).toContain("Reject");
    expect(out).not.toContain("Approve as new store");
    expect(out).not.toContain("Same as existing store");
    expect(out).not.toContain('name="code"');
    const rejecting = html(
      createElement(ChangeDetail, { ...props, decision: "reject" }),
    );
    expect(rejecting).toContain("Why is it rejected?");
    expect(rejecting).toContain("Reject change");
  });

  it("waits for the address check before approving a moved pin", () => {
    const moved: Capture = {
      ...change,
      location_status: "pending",
      changes: [
        ...change.changes!,
        {
          field: "location",
          label: "Location",
          old: "10.1, 123.1",
          new: "10.3, 123.9",
        },
      ],
    };
    const out = html(createElement(ChangeDetail, { ...props, capture: moved }));
    expect(out).toContain("Checking the address…");
    expect(out).toMatch(/<button type="submit"[^>]*disabled/);
  });
});
