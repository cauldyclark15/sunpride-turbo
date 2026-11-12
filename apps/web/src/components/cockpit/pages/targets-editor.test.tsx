import { describe, expect, it } from "vitest";
import { levelEditable, parseTargetsCsv, withServerErrors } from "./targets-editor";

describe("targets editor level access (WEB-035)", () => {
  it("offers cells only when the server says this level is writable for the scope", () => {
    expect(levelEditable(true, { editable: false })).toBe(false);
    expect(levelEditable(true, { editable: true })).toBe(true);
    expect(levelEditable(false, { editable: true })).toBe(false);
    // Older responses without the flag keep the previous behaviour.
    expect(levelEditable(true, {})).toBe(true);
    expect(levelEditable(true, undefined)).toBe(true);
  });
});

describe("WEB-036 import preview uses the server's check and CSV line numbers", () => {
  it("rows the server refuses are not counted ready and keep their CSV line", () => {
    const parsed = parseTargetsCsv(
      "level,key,amount_php\nterritory,SMP-T1,2100000\nterritory,NOPE-XX,1\n",
    );
    expect(parsed.rows).toHaveLength(2);
    const checked = withServerErrors(parsed, [
      { row: 2, message: 'Unknown territory "NOPE-XX".' },
    ]);
    expect(checked.rows.map((r) => r.key)).toEqual(["SMP-T1"]);
    expect(checked.errors).toEqual([
      { row: 3, message: 'Unknown territory "NOPE-XX".' },
    ]);
    expect(withServerErrors(parsed, [])).toBe(parsed);
  });
});
