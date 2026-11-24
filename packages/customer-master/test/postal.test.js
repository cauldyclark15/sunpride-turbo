import { expect, test } from "bun:test";
import { suggestPostalCode } from "../src/index.js";

export const POSTAL_CASES = [
  { name: "town with no codes", options: [], barangay: "Apas", expected: null },
  {
    name: "town with one code",
    options: [{ code: "6000" }],
    barangay: "Apas",
    expected: "6000",
  },
  {
    name: "exact area with case, accents and prefix",
    options: [
      { code: "1001", area: " Brgy. Santo Niño " },
      { code: "1002", area: "Other" },
    ],
    barangay: "SANTO NINO",
    expected: "1001",
  },
  {
    name: "explicit shared areas",
    options: [
      { code: "1001", area: "Kaybiga/Deparo" },
      { code: "1002", area: "Other" },
    ],
    barangay: "Deparo",
    expected: "1001",
  },
  {
    name: "hyphenated area",
    options: [{ code: "1001", area: "Bagumbong/Pag-asa" }, { code: "1002" }],
    barangay: "Pag Asa",
    expected: "1001",
  },
  {
    name: "no area known",
    options: [{ code: "1001" }, { code: "1002" }],
    barangay: "Apas",
    expected: null,
  },
  {
    name: "no substring guessing",
    options: [
      { code: "1001", area: "San Jose East" },
      { code: "1002", area: "San Jose West" },
    ],
    barangay: "San Jose",
    expected: null,
  },
  {
    name: "conflicting mappings",
    options: [
      { code: "1001", area: "Apas" },
      { code: "1002", area: "Apas" },
    ],
    barangay: "Apas",
    expected: null,
  },
  {
    name: "invalid suggestions ignored",
    options: [{ code: "bad", area: "Apas" }],
    barangay: "Apas",
    expected: null,
  },
];
for (const c of POSTAL_CASES)
  test(`SP-0246 ${c.name}`, () => {
    expect(suggestPostalCode(c.options, c.barangay)).toBe(c.expected);
  });
