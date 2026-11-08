import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  addressLine,
  candidatePoints,
  coverageLine,
  formatDistance,
  mergeCandidates,
  reasonWords,
  sourceBadge,
  type Candidate,
  type Capture,
} from "./model";
import { CandidateList, CaptureDetail, CaptureRow } from "./review";
import { AddressSuggestions, DuplicatePanel } from "./add-store";
import { LocationCoverageView } from "./location-coverage";

const outlet: Candidate = {
  kind: "outlet",
  id: "11111111-1111-4111-8111-111111111111",
  code: "SP000123",
  name: "Aling Nena Store",
  address: "Lahug, Cebu City",
  latitude: 10.33,
  longitude: 123.9,
  distanceMeters: 17.6,
  reasons: ["nearby", "name"],
  score: 110,
};
const pending: Candidate = {
  ...outlet,
  kind: "capture",
  id: "22222222-2222-4222-8222-222222222222",
  code: null,
  name: "Nena Mini Mart",
  distanceMeters: null,
  reasons: ["phone"],
  score: 90,
  latitude: null,
  longitude: null,
};
const capture: Capture = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Aling Nena Sari-Sari",
  address: "Purok 3, Lahug",
  accuracy_meters: 12.4,
  captured_at: new Date(Date.now() - 5 * 60000).toISOString(),
  owner_name: "Nena Cruz",
  owner_phone: "0917 555 0101",
  estimated_class: "C",
  agent: "Rhea Santos",
  batch: "Ongoing store gathering",
  latitude: 10.3301,
  longitude: 123.8981,
  location_source: "gps",
  formatted_address: null,
  address_components: { barangay: "Lahug", city: "Cebu City" },
  landmark: "beside the chapel",
  duplicate_flag: true,
  duplicate_candidates: [outlet],
  acknowledged_duplicate_ids: [],
  channel: "General trade",
  subchannel: "Sari-sari",
};
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(el);
const noIds = (markup: string) => {
  const text = markup.replace(/<[^>]+>/g, " ");
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
};

describe("store gathering model", () => {
  it("says reasons, distances and sources in plain words", () => {
    expect(reasonWords(["place", "phone", "nearby", "name"])).toBe(
      "Same place on Google · Same phone number · Very close by · Same name nearby",
    );
    expect(formatDistance(null)).toBe("Distance unknown");
    expect(formatDistance(0)).toBe("Same spot");
    expect(formatDistance(17.6)).toBe("18 m away");
    expect(formatDistance(1479.5)).toBe("1.5 km away");
    expect(sourceBadge(capture)).toBe("GPS ±12 m");
    expect(
      sourceBadge({ location_source: "places", accuracy_meters: null }),
    ).toBe("Address search");
    expect(
      addressLine({ street: "Gorordo Ave", barangay: "Lahug", city: null }),
    ).toBe("Gorordo Ave, Lahug");
    expect(coverageLine(212, 300)).toBe(
      "212 of 300 stores have a verified location (71%)",
    );
    expect(coverageLine(0, 0)).toBe("No stores yet");
  });
  it("merges stored and live candidates by id and keeps the rule order", () => {
    const live = { ...outlet, distanceMeters: 15, score: 110 };
    const merged = mergeCandidates([outlet, pending], [live]);
    expect(merged.map((c) => c.id)).toEqual([outlet.id, pending.id]);
    expect(merged[0]!.distanceMeters).toBe(15);
    expect(candidatePoints(merged).map((p) => p.id)).toEqual([outlet.id]);
  });
});

describe("store gathering review views", () => {
  it("list row shows photo, agent, badge and the duplicate flag", () => {
    const m = html(
      createElement(CaptureRow, { capture, selected: false, onOpen: () => {} }),
    );
    expect(m).toContain(`/api/v1/masters/census/${capture.id}/photo`);
    expect(m).toContain("Rhea Santos");
    expect(m).toContain("GPS ±12 m");
    expect(m).toContain("Maybe already listed");
    noIds(m);
  });
  it("candidate list explains each match and offers Same store only for stores", () => {
    const onSame = vi.fn();
    const m = html(
      createElement(CandidateList, { candidates: [outlet, pending], onSame }),
    );
    expect(m).toContain("Very close by · Same name nearby");
    expect(m).toContain("18 m away");
    expect(m).toContain("also waiting for review");
    expect(m.match(/Same store/g)?.length).toBe(1);
    noIds(m);
    expect(html(createElement(CandidateList, { candidates: [] }))).toContain(
      "No similar stores found",
    );
  });
  it("detail shows address parts, landmark, owner and the three decisions", () => {
    const m = html(
      createElement(CaptureDetail, {
        capture,
        candidates: [outlet],
        decision: "accept",
        survivor: null,
        onDecision: () => {},
        onSurvivor: () => {},
        onSubmit: () => {},
        onClose: () => {},
      }),
    );
    for (const words of [
      "Approve as new store",
      "Same as existing store",
      "Reject",
      "Lahug, Cebu City",
      "Landmark: beside the chapel",
      "Nena Cruz",
      "leave blank to number it automatically",
      "This might already be in the list",
      "accurate to about 12 m",
    ])
      expect(m).toContain(words);
    noIds(m);
    const dup = html(
      createElement(CaptureDetail, {
        capture: {
          ...capture,
          location_source: "places",
          accuracy_meters: null,
        },
        candidates: [outlet],
        decision: "duplicate",
        survivor: outlet,
        onDecision: () => {},
        onSurvivor: () => {},
        onSubmit: () => {},
        onClose: () => {},
      }),
    );
    expect(dup).toContain("Link to existing store");
    expect(dup).toContain("Pin from the address the agent searched");
    expect(dup).not.toContain('name="code"');
  });
});

describe("office Add store and location coverage views", () => {
  it("address suggestions show primary and secondary lines", () => {
    const m = html(
      createElement(AddressSuggestions, {
        predictions: [
          {
            placeId: "ChIJ-1",
            primary: "SM Seaside",
            secondary: "Cebu City",
            description: "SM Seaside, Cebu City",
          },
        ],
        onPick: () => {},
      }),
    );
    expect(m).toContain("SM Seaside");
    expect(m).toContain("Cebu City");
    expect(m).not.toContain("ChIJ-1");
    expect(
      html(
        createElement(AddressSuggestions, {
          predictions: [],
          onPick: () => {},
        }),
      ),
    ).toBe("");
  });
  it("duplicate panel asks to confirm a different store", () => {
    const m = html(
      createElement(DuplicatePanel, {
        candidates: [outlet],
        acknowledged: false,
        onAcknowledge: () => {},
      }),
    );
    expect(m).toContain("This might already be in the list");
    expect(m).toContain("It&#x27;s a different store");
    expect(
      html(
        createElement(DuplicatePanel, {
          candidates: [],
          acknowledged: false,
          onAcknowledge: () => {},
        }),
      ),
    ).toContain("No similar store found yet");
  });
  it("coverage shows N of M and the No location yet filter", () => {
    const m = html(
      createElement(LocationCoverageView, {
        data: {
          total: 300,
          located: 212,
          truncated: false,
          rows: [
            {
              id: outlet.id,
              code: "SP000123",
              name: "Aling Nena Store",
              address: "Lahug",
              located: false,
            },
          ],
        },
        missingOnly: true,
        onMissingOnly: () => {},
      }),
    );
    expect(m).toContain("212 of 300 stores have a verified location");
    expect(m).toContain("No location yet (88)");
    expect(m).toContain('aria-valuenow="71"');
    noIds(m);
  });
});
