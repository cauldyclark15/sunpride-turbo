import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMe } from "@/lib/auth/client";
import { rememberSession } from "@/lib/auth/offline-session";
import { filterSummary } from "./kit/period-scope-bar";
import { PHONE_CARD_FIGURES, phoneExtra } from "./kit/drill-table";

afterEach(() => vi.unstubAllGlobals());

describe("phone Filters button", () => {
  const today = "2026-10-19";
  it("says the current choice in words", () => {
    expect(
      filterSummary(new URLSearchParams(), today, { mode: "day" }).text,
    ).toBe("Today · Everything I can see");
    expect(
      filterSummary(new URLSearchParams("date=2026-10-18"), today, {
        mode: "day",
        scopeLabel: "Cebu North",
      }).text,
    ).toBe("Yesterday · Cebu North");
    const range = filterSummary(
      new URLSearchParams("unitId=u1&channel=gt"),
      today,
      { unitLabel: "Mandaue" },
    );
    expect(range.area).toBe("Mandaue · General trade");
  });
});

describe("phone table cards", () => {
  it("keep the name, 4 figures and the last column; fold the rest", () => {
    const count = 9;
    const shown = Array.from({ length: count }, (_, i) => i).filter(
      (i) => !phoneExtra(i, count),
    );
    expect(shown).toEqual([0, 1, 2, 3, 4, 8]);
    expect(PHONE_CARD_FIGURES).toBe(4);
  });
});

describe("offline opening", () => {
  it("uses the last signed-in person only when /api/me cannot be reached", async () => {
    const local = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => local.get(k) ?? null,
        setItem: (k: string, v: string) => void local.set(k, v),
        removeItem: (k: string) => void local.delete(k),
      },
    });
    rememberSession({
      profile: {
        id: "p",
        subject: "s",
        name: "Ana",
        role: "admin",
        orgUnitId: null,
        active: true,
      },
      scope: null,
      permissions: [],
    });
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect((await fetchMe(undefined, offline))?.profile.name).toBe("Ana");
    const expired = vi.fn(async () => new Response("{}", { status: 401 }));
    expect(await fetchMe(undefined, expired)).toBeNull();
    await expect(fetchMe(undefined, offline)).rejects.toMatchObject({
      code: "network_error",
    });
  });
});
