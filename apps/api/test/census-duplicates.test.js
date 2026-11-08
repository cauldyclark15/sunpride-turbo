import { expect, test } from "bun:test";
import {
  nameTokens,
  nameSimilarity,
  phoneKey,
  evaluatePair,
  rankCandidates,
  STOPWORDS,
} from "../src/domains/masters/duplicates.js";

const fixture = await Bun.file(
  new URL(
    "../../../packages/domain-contracts/fixtures/mobile-v1/census-duplicates.json",
    import.meta.url,
  ),
).json();

test("SP-0162 stopwords equal the shared fixture", () => {
  expect([...STOPWORDS].sort()).toEqual([...fixture.rules.stopwords].sort());
});

test("SP-0162 every name token vector matches the shared fixture", () => {
  for (const v of fixture.nameTokenVectors)
    expect(nameTokens(v.name)).toEqual([...v.tokens].sort());
});

test("SP-0162 every phone key vector matches the shared fixture", () => {
  for (const v of fixture.phoneKeyVectors)
    expect(phoneKey(v.phone)).toBe(v.key);
});

test("SP-0162 every pair vector matches the shared fixture", () => {
  expect(fixture.pairVectors.length).toBeGreaterThan(0);
  for (const v of fixture.pairVectors) {
    const got = evaluatePair(v.query, v.existing);
    expect({ label: v.label, isCandidate: got.isCandidate }).toEqual({
      label: v.label,
      isCandidate: v.expect.isCandidate,
    });
    expect(got.reasons).toEqual(v.expect.reasons);
    expect(got.distanceMeters).toBe(v.expect.distanceMeters);
    expect(got.nameSimilarity).toBe(v.expect.nameSimilarity);
    expect(nameSimilarity(v.query.name, v.existing.name)).toBe(
      v.expect.nameSimilarity,
    );
  }
});

test("SP-0162 score and sort follow the fixture rules", () => {
  const q = {
    name: "Aling Nena",
    phone: "09171234567",
    latitude: 10,
    longitude: 120,
    placeId: "P",
  };
  const all = evaluatePair(q, {
    name: "Aling Nena",
    phone: "+63 917 123 4567",
    latitude: 10,
    longitude: 120,
    placeId: "P",
  });
  expect(all.reasons).toEqual(["place", "phone", "nearby", "name"]);
  expect(all.score).toBe(100 + 90 + 80 + 30);
  const near60 = evaluatePair(q, {
    name: "Other",
    latitude: 10.0005,
    longitude: 120,
  });
  expect(near60.reasons).toEqual(["nearby"]);
  expect(near60.score).toBe(60);
  const ranked = rankCandidates([
    { name: "B", score: 60, distanceMeters: null },
    { name: "A", score: 60, distanceMeters: null },
    { name: "C", score: 60, distanceMeters: 10 },
    { name: "D", score: 90, distanceMeters: 500 },
    ...Array.from({ length: 9 }, (_, i) => ({
      name: `Z${i}`,
      score: 1,
      distanceMeters: 1,
    })),
  ]);
  expect(ranked.candidates.slice(0, 4).map((c) => c.name)).toEqual([
    "D",
    "C",
    "A",
    "B",
  ]);
  expect(ranked.candidates.length).toBe(10);
  expect(ranked.truncated).toBe(true);
});
