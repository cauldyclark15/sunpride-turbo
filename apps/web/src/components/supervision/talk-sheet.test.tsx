import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TOPIC_LABELS as SERVER_TOPICS } from "../../../../../packages/backend/convex/supervision/talk_sheet_model";
import {
  MyTalkSheetsView,
  TalkSheetEditorView,
  TalkSheetRegisterView,
} from "./talk-sheet";
import { daysLabel, itemTone, TOPIC_LABELS, TOPICS } from "./talk-sheet-model";

const register = {
  today: "2026-09-30",
  truncated: false,
  chains: [
    {
      latestSheetId: "s1",
      partnerName: "Ace Trading",
      orgUnitId: "u1",
      unitName: "Region A",
      ownerName: "Rex",
      lastMeetingDate: "2026-08-25",
      nextContactDate: "2026-09-08",
      contactOverdue: true,
      draftSheetId: null,
      openCount: 2,
      overdueCount: 1,
      rootCauseCount: 1,
    },
  ],
  openItems: [
    {
      itemId: "i1",
      sheetId: "s1",
      partnerName: "Ace Trading",
      ownerName: "Rex",
      topic: "buying_accounts",
      gap: "Ten accounts stopped buying",
      responsible: "ADP owner",
      timeline: "2026-09-10",
      status: "overdue",
      openedOn: "2026-08-25",
      daysOpen: 36,
      rootCauseDue: true,
      rootCause: null,
    },
    {
      itemId: "i2",
      sheetId: "s1",
      partnerName: "Ace Trading",
      ownerName: "Rex",
      topic: "siv_stt",
      gap: "SIV below plan",
      responsible: "Rex",
      timeline: "2026-10-10",
      status: "on_going",
      openedOn: "2026-09-20",
      daysOpen: 10,
      rootCauseDue: false,
      rootCause: null,
    },
  ],
};

const item = (overrides: Record<string, unknown>) => ({
  _id: "i1",
  _creationTime: 1,
  organizationId: "sunpride",
  sheetId: "s2",
  position: 0,
  topic: "buying_accounts",
  gap: "Ten accounts stopped buying",
  agreement: "Revisit lapsed accounts",
  correctiveAction: "Weekly call list",
  responsible: "ADP owner",
  timeline: "2026-09-10",
  status: "overdue",
  openedOn: "2026-08-25",
  ...overrides,
});

const detail = {
  sheet: {
    _id: "s2",
    _creationTime: 1,
    organizationId: "sunpride",
    orgUnitId: "u1",
    partnerName: "Ace Trading",
    partnerKey: "ace trading",
    ownerProfileId: "p1",
    meetingDate: "2026-09-30",
    status: "draft",
    previousSheetId: "s1",
    createdBy: "x",
    createdAt: 1,
    updatedBy: "x",
    updatedAt: 1,
  },
  ownerName: "Rex",
  previousMeetingDate: "2026-08-25",
  items: [
    {
      item: item({ carriedFromItemId: "i0", originItemId: "i0" }),
      effectiveStatus: "overdue",
      carried: true,
      daysOpen: 36,
      rootCauseDue: true,
    },
    {
      item: item({
        _id: "i3",
        topic: "inventory_days",
        gap: "Inventory at 45 days",
        status: "on_going",
        timeline: "2026-10-15",
        openedOn: "2026-09-30",
      }),
      effectiveStatus: "on_going",
      carried: false,
      daysOpen: 0,
      rootCauseDue: false,
    },
  ],
  gaps: [
    {
      code: "root_cause",
      label: "Write the root-cause review for lines open over a month",
    },
  ],
  canEdit: true,
};

describe("talk sheet view rules", () => {
  it("mirrors the server's Annex E issue lines", () => {
    expect(TOPIC_LABELS).toEqual(SERVER_TOPICS);
    expect(TOPICS.map(([code]) => code)).toEqual(Object.keys(SERVER_TOPICS));
  });

  it("tones statuses and labels ages", () => {
    expect(itemTone("completed")).toBe("success");
    expect(itemTone("overdue")).toBe("danger");
    expect(itemTone("on_going")).toBe("warning");
    expect(daysLabel(1)).toBe("1 day");
    expect(daysLabel(36)).toBe("36 days");
  });
});

describe("talk sheet screens", () => {
  it("shows supervisors open, overdue and root-cause lines per partner", () => {
    const html = renderToStaticMarkup(
      <TalkSheetRegisterView data={register as never} onOpen={vi.fn()} />,
    );
    expect(html).toContain("carry to the next Talk Sheet");
    expect(html).toContain("Ace Trading");
    expect(html).toContain("Rex · Region A");
    expect(html).toContain("8 Sep · missed");
    expect(html).toContain("36 days · root cause");
    expect(html).toContain("10 days");
    expect(html).toContain("Buying Accounts");
    expect(html).toContain("Overdue");
    expect(html).toContain("On-going");
    expect(html).toContain("Open Talk Sheet with Ace Trading");
  });

  it("locks a carried line's issue, offers no removal and asks for its root cause", () => {
    const html = renderToStaticMarkup(
      <TalkSheetEditorView
        detail={detail as never}
        save={vi.fn()}
        finalize={vi.fn()}
        discard={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain("Talk Sheet · Ace Trading · 30 Sep");
    expect(html).toContain("Carried from 25 Aug");
    expect(html).toContain("Still needed to sign off");
    expect(html).toContain("Carried · raised 25 Aug · open 36 days");
    expect(html).toContain("Root-cause review");
    expect(html).toContain('aria-label="Line 1 root-cause review"');
    expect(html).not.toContain('aria-label="Remove line 1"');
    expect(html).toContain('aria-label="Remove line 2"');
    expect(html).not.toContain('aria-label="Line 2 root-cause review"');
    expect(html).toMatch(/aria-label="Line 1 gap or issue"[^>]*disabled/);
    expect(html).toContain("Acknowledged and committed by");
    expect(html).toContain("Save and sign off");
  });

  it("shows a signed-off sheet read-only", () => {
    const html = renderToStaticMarkup(
      <TalkSheetEditorView
        detail={
          {
            ...detail,
            canEdit: false,
            gaps: [],
            sheet: { ...detail.sheet, status: "final" },
          } as never
        }
        save={vi.fn()}
        finalize={vi.fn()}
        discard={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain("Signed off");
    expect(html).not.toContain("Save and sign off");
    expect(html).not.toContain("Add gap or issue");
    expect(html).not.toContain("Remove line");
  });

  it("lists the author's sheets with where each carried from", () => {
    const html = renderToStaticMarkup(
      <MyTalkSheetsView
        mine={
          {
            sheets: [
              {
                sheetId: "s2",
                partnerName: "Ace Trading",
                meetingDate: "2026-09-30",
                nextContactDate: null,
                status: "draft",
                carriedFrom: "2026-08-25",
              },
            ],
            partners: ["Ace Trading"],
          } as never
        }
        create={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(html).toContain("My Talk Sheets");
    expect(html).toContain("Start Talk Sheet");
    expect(html).toContain('<option value="Ace Trading">');
    expect(html).toContain("25 Aug");
    expect(html).toContain("Open Talk Sheet with Ace Trading on 2026-09-30");
  });
});
