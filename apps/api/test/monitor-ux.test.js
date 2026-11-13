import { expect, test } from "bun:test";
import {
  fieldNumbers,
  fieldStatus,
  IDLE_AFTER_MS,
} from "../src/domains/fieldsync/field-day.js";
import {
  compactName,
  editDistance,
  evaluatePair,
  nearName,
  sameLocality,
  searchWordPatterns,
  withNearName,
} from "../src/domains/masters/duplicates.js";

// 2026-11-13 14:30 Manila
const NOW = Date.UTC(2026, 10, 13, 6, 30);
const TODAY = "2026-11-13";

test("SP-0175 lane case: 2 of 25 stops done and seen 24 min ago is Working, not Not started", () => {
  const joel = {
    planned: 25,
    visited: 2,
    planned_done: 2,
    in_progress: 0,
    productive: 1,
    last_seen_at: NOW - 24 * 60_000,
  };
  expect(fieldStatus(joel, TODAY, NOW)).toBe("working");
  // Today passes its own governed counts; the status agrees with the stops shown.
  expect(fieldStatus(joel, TODAY, NOW, { planned: 25, done: 2 })).toBe(
    "working",
  );
  expect(fieldNumbers(joel)).toEqual({
    planned: 25,
    visited: 2,
    checkIns: 2,
    productive: 1,
    lastSeenAt: NOW - 24 * 60_000,
  });
});

test("SP-0175 status rule: no plan, not started, in a call, idle, done, past day", () => {
  expect(fieldStatus(undefined, TODAY, NOW)).toBe("no_plan");
  expect(fieldStatus({ planned: 3 }, TODAY, NOW)).toBe("not_started");
  expect(
    fieldStatus(
      { planned: 3, visited: 1, in_progress: 1, last_seen_at: NOW },
      TODAY,
      NOW,
    ),
  ).toBe("in_call");
  expect(
    fieldStatus(
      {
        planned: 3,
        visited: 1,
        planned_done: 1,
        last_seen_at: NOW - IDLE_AFTER_MS - 1,
      },
      TODAY,
      NOW,
    ),
  ).toBe("idle");
  expect(
    fieldStatus({ planned: 2, visited: 2, planned_done: 2 }, TODAY, NOW),
  ).toBe("done");
  expect(
    fieldStatus(
      { planned: 5, visited: 1, planned_done: 1, day_ended_at: new Date(NOW) },
      TODAY,
      NOW,
    ),
  ).toBe("done");
  expect(
    fieldStatus({ planned: 5, visited: 1, planned_done: 1 }, "2026-11-12", NOW),
  ).toBe("done");
  // Unplanned calls only: working, never "no plan".
  expect(
    fieldStatus({ planned: 0, visited: 1, last_seen_at: NOW }, TODAY, NOW),
  ).toBe("working");
});

test("SP-0175 near-miss store names ignore case, spaces, punctuation and common words", () => {
  expect(compactName("Aling Nena's Sari-Sari Store")).toBe("alingnenas");
  expect(editDistance("nina", "nena")).toBe(1);
  for (const [a, b] of [
    ["Aling Nina Store", "Aling Nena Sari-sari"],
    ["alingnena", "Aling Nena"],
    ["sari sari 1", "Sari-sari 1"],
    ["ALING  NENA", "aling-nena mini mart"],
    ["Nena Aling", "Aling Nena"],
  ])
    expect([a, b, nearName(a, b)]).toEqual([a, b, true]);
  for (const [a, b] of [
    ["Aling Nena", "Mang Kanor"],
    ["Store 1", "Store 2"],
    ["Ana", "Ena"],
  ])
    expect([a, b, nearName(a, b)]).toEqual([a, b, false]);
});

test("SP-0175 near-miss names flag only in the same place (2 km, or same barangay/municipality)", () => {
  const q = { name: "Aling Nina Store" };
  const far = evaluatePair(
    { ...q, latitude: 10.3, longitude: 123.9 },
    { name: "Aling Nena", latitude: 10.6, longitude: 123.9 },
  );
  expect(withNearName(q, far, "Aling Nena", {}, {}).isCandidate).toBe(false);
  const unknown = evaluatePair(q, { name: "Aling Nena" });
  expect(unknown.isCandidate).toBe(false); // old rule missed it
  const got = withNearName(q, unknown, "Aling Nena", {}, {});
  expect(got.isCandidate).toBe(true);
  expect(got.reasons).toEqual(["name"]);
  expect(
    withNearName(
      q,
      unknown,
      "Aling Nena",
      { barangay: "Apas", municipality: "Cebu City" },
      { barangay: "Lahug", municipality: "Cebu City" },
    ).isCandidate,
  ).toBe(false);
  expect(
    sameLocality({ municipality: "Cebu City" }, { municipality: "cebu-city" }),
  ).toBe(true);
});

test("SP-0175 office search word patterns tolerate one typo per longer word", () => {
  const match = (/** @type {string} */ q, /** @type {string} */ name) => {
    const compact = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return searchWordPatterns(q).every((re) => new RegExp(re).test(compact));
  };
  expect(match("Aling Nina", "Aling Nena Sari-Sari Store")).toBe(true);
  expect(match("alingnena", "Aling Nena")).toBe(true);
  expect(match("sari sari 1", "Sari-sari 1")).toBe(true);
  expect(match("Mang Kanor", "Aling Nena")).toBe(false);
  expect(searchWordPatterns("  ")).toEqual([]);
});
