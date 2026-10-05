import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  carriesOver,
  effectiveStatus,
  finalizeGaps,
  oneMonthAfter,
  partnerKey,
  rootCauseDue,
  type TalkSheetDraft,
} from "./talk_sheet_model";

type T = TestConvex<typeof schema>;
const HOUR = 3_600_000;
const ISSUER = "https://auth.test";
const subject = (name: string) => `${ISSUER}|${name}`;
/** 15:00 Manila on the date. */
const at = (date: string) => Date.parse(`${date}T07:00:00Z`);

afterEach(() => {
  vi.useRealTimers();
});

const line = {
  topic: "siv_stt" as const,
  gap: "SIV below plan",
  agreement: "Re-stock fast movers",
  correctiveAction: "Weekly PO review",
  responsible: "ADP owner",
  timeline: "2026-09-20",
  status: "on_going" as const,
};

describe("talk sheet rules", () => {
  it("keys partners case- and space-insensitively", () => {
    expect(partnerKey("  Ace   Trading ")).toBe(partnerKey("ace trading"));
  });

  it("adds a calendar month, clamped to the month end", () => {
    expect(oneMonthAfter("2026-09-15")).toBe("2026-10-15");
    expect(oneMonthAfter("2026-01-31")).toBe("2026-02-28");
    expect(oneMonthAfter("2026-12-31")).toBe("2027-01-31");
    expect(() => oneMonthAfter("2026-02-30")).toThrow();
  });

  it("turns a line past its timeline Overdue unless Completed", () => {
    expect(effectiveStatus(line, "2026-09-20")).toBe("on_going");
    expect(effectiveStatus(line, "2026-09-21")).toBe("overdue");
    expect(
      effectiveStatus({ ...line, status: "completed" }, "2026-12-01"),
    ).toBe("completed");
    expect(effectiveStatus({ ...line, status: "overdue" }, "2026-09-01")).toBe(
      "overdue",
    );
  });

  it("carries On-going and Overdue only", () => {
    expect(carriesOver("on_going")).toBe(true);
    expect(carriesOver("overdue")).toBe(true);
    expect(carriesOver("completed")).toBe(false);
  });

  it("flags an open line for root-cause review one month after it was raised", () => {
    const open = { status: "on_going" as const, openedOn: "2026-09-15" };
    expect(rootCauseDue(open, "2026-10-14")).toBe(false);
    expect(rootCauseDue(open, "2026-10-15")).toBe(true);
    expect(rootCauseDue({ ...open, status: "completed" }, "2026-12-01")).toBe(
      false,
    );
  });

  it("lists what is missing before sign-off", () => {
    const draft: TalkSheetDraft = {
      meetingDate: "2026-10-20",
      items: [],
    };
    expect(finalizeGaps(draft)).toEqual([
      "acknowledged_by",
      "next_contact",
      "no_items",
    ]);
    const item = { ...line, openedOn: "2026-09-10", timeline: "" };
    expect(
      finalizeGaps({
        ...draft,
        acknowledgedByName: "Lito (ADP)",
        nextContactDate: "2026-10-20",
        items: [{ ...item, agreement: " ", responsible: "" }],
      }),
    ).toEqual([
      "next_contact",
      "item_agreement",
      "item_responsible",
      "item_timeline",
      "root_cause",
    ]);
    expect(
      finalizeGaps({
        ...draft,
        acknowledgedByName: "Lito (ADP)",
        nextContactDate: "2026-10-27",
        items: [
          { ...item, timeline: "2026-10-25", rootCause: "Late collections" },
        ],
      }),
    ).toEqual([]);
  });
});

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(at("2026-08-25"));
  const t: T = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const since = at("2026-06-01");
    const unit = (code: string, parentId?: Id<"orgUnits">) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: parentId ? "REGION" : "NATIONAL",
        ...(parentId ? { parentId } : {}),
        status: "active",
        effectiveFrom: since,
        createdAt: since,
        updatedAt: since,
      });
    const root = await unit("SUNPRIDE");
    const regionA = await unit("A", root);
    const regionB = await unit("B", root);
    const person = async (
      name: string,
      role: "sales" | "manager" | "viewer",
      orgUnitId: Id<"orgUnits">,
    ) => {
      const id = await ctx.db.insert("profiles", {
        authSubject: subject(name),
        name,
        email: `${name}@test.local`,
        role,
        status: "active",
        orgUnitId,
        updatedAt: since,
      });
      await ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId,
        role,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      return id;
    };
    return {
      regionA,
      regionB,
      rex: await person("Rex", "sales", regionA),
      sol: await person("Sol", "sales", regionA),
      bea: await person("Bea", "sales", regionB),
      managerA: await person("managerA", "manager", regionA),
      managerB: await person("managerB", "manager", regionB),
    };
  });
  const as = (name: string) =>
    t.withIdentity({
      issuer: ISSUER,
      subject: name,
      email: `${name}@test.local`,
    });
  return { t, ids, as };
}

const talk = api.supervision.talk_sheet;

describe("talk sheets", () => {
  it("carries On-going and Overdue lines forward and closes a line only at Completed", async () => {
    const { t, as } = await fixture();
    const rex = as("Rex");
    // Sheet 1 — 25 Aug.
    const first = await rex.mutation(talk.create, {
      partnerName: "Ace Trading",
      meetingDate: "2026-08-25",
    });
    await expect(
      rex.mutation(talk.finalize, { sheetId: first }),
    ).rejects.toThrow("Name who acknowledged");
    await rex.mutation(talk.save, {
      sheetId: first,
      acknowledgedByName: "Lito Cruz (ADP)",
      nextContactDate: "2026-09-08",
      items: [
        { ...line, timeline: "2026-09-30" }, // stays On-going
        {
          ...line,
          topic: "buying_accounts",
          gap: "Ten accounts stopped buying",
          timeline: "2026-09-05", // will be Overdue by the next sheet
        },
        {
          ...line,
          topic: "report_submission",
          gap: "Late STT report",
          timeline: "2026-08-30",
          status: "completed",
        },
      ],
    });
    await rex.mutation(talk.finalize, { sheetId: first });
    await expect(
      rex.mutation(talk.save, { sheetId: first, acknowledgedByName: "x" }),
    ).rejects.toThrow("already signed off");

    // Sheet 2 — 8 Sep: two open lines carry, the completed one does not.
    vi.setSystemTime(at("2026-09-08"));
    await expect(
      rex.mutation(talk.create, {
        partnerName: "ace  trading",
        meetingDate: "2026-08-25",
      }),
    ).rejects.toThrow("dated after 2026-08-25");
    const second = await rex.mutation(talk.create, {
      partnerName: "ace  trading",
      meetingDate: "2026-09-08",
    });
    await expect(
      rex.mutation(talk.create, {
        partnerName: "Ace Trading",
        meetingDate: "2026-09-09",
      }),
    ).rejects.toThrow("Sign off the open Talk Sheet");
    const view = await rex.query(talk.detail, { sheetId: second });
    expect(view.previousMeetingDate).toBe("2026-08-25");
    expect(
      view.items.map((row) => [row.item.gap, row.effectiveStatus]),
    ).toEqual([
      ["SIV below plan", "on_going"],
      ["Ten accounts stopped buying", "overdue"],
    ]);
    expect(view.items.every((row) => row.carried)).toBe(true);
    expect(view.items.every((row) => row.item.openedOn === "2026-08-25")).toBe(
      true,
    );
    const [siv, accounts] = view.items.map((row) => row.item);

    // A carried line cannot be dropped, and its issue text is fixed.
    await expect(
      rex.mutation(talk.save, {
        sheetId: second,
        items: [{ ...line, itemId: siv!._id, timeline: siv!.timeline }],
      }),
    ).rejects.toThrow("closes only at Completed");
    await rex.mutation(talk.save, {
      sheetId: second,
      acknowledgedByName: "Lito Cruz (ADP)",
      nextContactDate: "2026-09-22",
      items: [
        {
          ...line,
          itemId: siv!._id,
          gap: "renamed",
          timeline: "2026-09-30",
          status: "completed",
        },
        {
          ...line,
          itemId: accounts!._id,
          topic: "buying_accounts",
          gap: accounts!.gap,
          timeline: "2026-09-15",
        },
        {
          ...line,
          topic: "inventory_days",
          gap: "Inventory at 45 days",
          timeline: "2026-09-20",
        },
      ],
    });
    const saved = await rex.query(talk.detail, { sheetId: second });
    expect(saved.items[0]!.item.gap).toBe("SIV below plan");
    expect(saved.items[0]!.item.originItemId).toBe(siv!.originItemId);
    expect(saved.items[2]!.item.openedOn).toBe("2026-09-08");
    await rex.mutation(talk.finalize, { sheetId: second });

    // Sheet 3 — the completed SIV line has closed; the others carry again.
    vi.setSystemTime(at("2026-09-22"));
    const third = await rex.mutation(talk.create, {
      partnerName: "Ace Trading",
      meetingDate: "2026-09-22",
    });
    const view3 = await rex.query(talk.detail, { sheetId: third });
    expect(
      view3.items.map((row) => [
        row.item.gap,
        row.effectiveStatus,
        row.item.openedOn,
      ]),
    ).toEqual([
      ["Ten accounts stopped buying", "overdue", "2026-08-25"],
      ["Inventory at 45 days", "overdue", "2026-09-08"],
    ]);
    const rows = await t.run((ctx) => ctx.db.query("talkSheetItems").collect());
    const origin = rows.find(
      (row) => row.gap === "Ten accounts stopped buying" && !row.originItemId,
    );
    expect(rows.filter((row) => row.originItemId === origin!._id).length).toBe(
      2,
    );
  });

  it("requires a root-cause review for a line open a month, and shows it to supervisors", async () => {
    const { ids, as } = await fixture();
    const rex = as("Rex");
    const first = await rex.mutation(talk.create, {
      partnerName: "Ace Trading",
      meetingDate: "2026-08-25",
    });
    await rex.mutation(talk.save, {
      sheetId: first,
      acknowledgedByName: "Lito Cruz (ADP)",
      nextContactDate: "2026-09-08",
      items: [{ ...line, timeline: "2026-09-10" }],
    });
    await rex.mutation(talk.finalize, { sheetId: first });

    vi.setSystemTime(at("2026-09-30"));
    const register = await as("managerA").query(talk.register, {
      serviceDate: "2026-09-30",
    });
    expect(register.chains).toHaveLength(1);
    expect(register.chains[0]).toMatchObject({
      partnerName: "Ace Trading",
      ownerName: "Rex",
      lastMeetingDate: "2026-08-25",
      contactOverdue: true,
      openCount: 1,
      overdueCount: 1,
      rootCauseCount: 1,
      draftSheetId: null,
    });
    expect(register.openItems[0]).toMatchObject({
      status: "overdue",
      daysOpen: 36,
      rootCauseDue: true,
    });
    expect(
      (await as("managerB").query(talk.register, { serviceDate: "2026-09-30" }))
        .chains,
    ).toEqual([]);

    const second = await rex.mutation(talk.create, {
      partnerName: "Ace Trading",
      meetingDate: "2026-09-30",
    });
    const view = await rex.query(talk.detail, { sheetId: second });
    expect(view.items[0]).toMatchObject({ rootCauseDue: true, daysOpen: 36 });
    const item = view.items[0]!.item;
    await rex.mutation(talk.save, {
      sheetId: second,
      acknowledgedByName: "Lito Cruz (ADP)",
      nextContactDate: "2026-10-14",
      items: [{ ...line, itemId: item._id, timeline: "2026-10-10" }],
    });
    await expect(
      rex.mutation(talk.finalize, { sheetId: second }),
    ).rejects.toThrow("root-cause review");
    await rex.mutation(talk.save, {
      sheetId: second,
      items: [
        {
          ...line,
          itemId: item._id,
          timeline: "2026-10-10",
          rootCause: "ADP short on delivery trucks",
        },
      ],
    });
    // While the draft is open the chain shows it and no missed contact.
    const during = await as("managerA").query(talk.register, {
      serviceDate: "2026-09-30",
      orgUnitId: ids.regionA,
    });
    expect(during.chains[0]).toMatchObject({
      draftSheetId: second,
      contactOverdue: false,
    });
    await rex.mutation(talk.finalize, { sheetId: second });
    const after = await as("managerA").query(talk.register, {
      serviceDate: "2026-09-30",
    });
    expect(after.chains[0]!.lastMeetingDate).toBe("2026-09-30");
    expect(after.openItems[0]!.rootCause).toBe("ADP short on delivery trucks");
  });

  it("keeps sheets inside the author's scope and editable only by the author", async () => {
    const { ids, as } = await fixture();
    const rex = as("Rex");
    const sheet = await rex.mutation(talk.create, {
      partnerName: "Ace Trading",
      meetingDate: "2026-08-25",
    });
    await expect(
      rex.mutation(talk.create, {
        partnerName: "Far Future",
        meetingDate: "2026-12-01",
      }),
    ).rejects.toThrow("within 31 days");
    await expect(
      rex.mutation(talk.create, {
        partnerName: "  ",
        meetingDate: "2026-08-25",
      }),
    ).rejects.toThrow("Name the partner");
    await expect(
      as("Sol").mutation(talk.save, {
        sheetId: sheet,
        acknowledgedByName: "x",
      }),
    ).rejects.toThrow("Talk Sheet not found");
    await expect(
      as("Bea").query(talk.detail, { sheetId: sheet }),
    ).rejects.toThrow();
    await expect(
      as("managerB").query(talk.detail, { sheetId: sheet }),
    ).rejects.toThrow();
    const asManager = await as("managerA").query(talk.detail, {
      sheetId: sheet,
    });
    expect(asManager.canEdit).toBe(false);
    await expect(
      as("Rex").query(talk.register, { serviceDate: "2026-08-25" }),
    ).rejects.toThrow("Insufficient permission");
    await expect(
      as("managerA").query(talk.register, {
        serviceDate: "2026-08-25",
        orgUnitId: ids.regionB,
      }),
    ).rejects.toThrow("outside your organizational scope");
    // Bea's chain with the same partner name in region B is a separate chain.
    await as("Bea").mutation(talk.create, {
      partnerName: "Ace Trading",
      meetingDate: "2026-08-25",
    });
    const mine = await rex.query(talk.mine, {});
    expect(mine.sheets).toHaveLength(1);
    expect(mine.partners).toEqual(["Ace Trading"]);
    // Discarding the draft leaves the chain free for a new sheet.
    await rex.mutation(talk.discard, { sheetId: sheet });
    expect((await rex.query(talk.mine, {})).sheets).toEqual([]);
    await rex.mutation(talk.create, {
      partnerName: "Ace Trading",
      meetingDate: "2026-08-25",
    });
  });

  it("refuses sign-off before the meeting and a line with a bad date", async () => {
    const { as } = await fixture();
    const rex = as("Rex");
    const sheet = await rex.mutation(talk.create, {
      partnerName: "Ace Trading",
      meetingDate: "2026-08-28",
    });
    await expect(
      rex.mutation(talk.save, {
        sheetId: sheet,
        items: [{ ...line, timeline: "2026-02-30" }],
      }),
    ).rejects.toThrow("Timeline must be a date");
    await rex.mutation(talk.save, {
      sheetId: sheet,
      acknowledgedByName: "Lito",
      nextContactDate: "2026-09-10",
      items: [{ ...line, timeline: "2026-09-05" }],
    });
    await expect(
      rex.mutation(talk.finalize, { sheetId: sheet }),
    ).rejects.toThrow("before its meeting");
    vi.setSystemTime(at("2026-08-28") + HOUR);
    await rex.mutation(talk.finalize, { sheetId: sheet });
  });
});
