import { describe, expect, it } from "vitest";
import { AGENT, ANA, CONVERSATIONS, ME, MESSAGES, message } from "./fixtures";
import {
  buildTimeline,
  conversationTitle,
  dayLabel,
  formatBytes,
  groupConversations,
} from "./format";
import { unreadBadgeText } from "./nav-badge";

const now = new Date("2026-11-03T04:00:00.000Z"); // noon in Manila

describe("timeline", () => {
  it("adds day separators, groups an author's run and marks New", () => {
    const items = buildTimeline(MESSAGES, { lastReadSeq: 3, meId: ME.id, now });
    expect(items.map((item) => (item.kind === "message" ? item.message.seq : item.kind))).toEqual([
      "day", 1, "day", 2, 3, 4, "new", 5,
    ]);
    const days = items.filter((item) => item.kind === "day");
    expect(days.map((day) => day.kind === "day" && day.label)).toEqual(["Yesterday", "Today"]);
    const grouped = Object.fromEntries(
      items.flatMap((item) => (item.kind === "message" ? [[item.message.seq, item.grouped]] : [])),
    );
    // seq 3 follows seq 2 by the same author within five minutes.
    expect(grouped).toEqual({ 1: false, 2: false, 3: true, 4: false, 5: false });
  });

  it("puts no New divider before your own messages or when all is read", () => {
    const mine = [message({ seq: 4, author: ME })];
    expect(buildTimeline(mine, { lastReadSeq: 3, meId: ME.id, now }).some((i) => i.kind === "new")).toBe(false);
    expect(buildTimeline(MESSAGES, { lastReadSeq: 5, meId: ME.id, now }).some((i) => i.kind === "new")).toBe(false);
  });

  it("labels days in Manila time", () => {
    // 16:30 UTC on 2 Nov is 00:30 on 3 Nov in Manila.
    expect(dayLabel("2026-11-02T16:30:00.000Z", now)).toBe("Today");
    expect(dayLabel("2026-10-20T03:00:00.000Z", now)).toMatch(/Tuesday.*20.*October|Tuesday.*October.*20/);
  });
});

describe("sidebar", () => {
  it("sorts conversations into Channels, Direct messages, Groups and AI users", () => {
    const groups = groupConversations(CONVERSATIONS, ME.id);
    expect(groups.channels.map((c) => c.title)).toEqual(["general"]);
    expect(groups.dms.map((c) => conversationTitle(c, ME.id))).toEqual([ANA.display_name]);
    expect(groups.groups).toHaveLength(1);
    expect(groups.agents.map((c) => conversationTitle(c, ME.id))).toEqual([AGENT.display_name]);
  });

  it("derives DM and group titles from the other members", () => {
    expect(conversationTitle(CONVERSATIONS[2]!, ME.id)).toBe("Ana Cruz, Ben Reyes");
    expect(
      conversationTitle({ ...CONVERSATIONS[2]!, member_count: 6 }, ME.id),
    ).toBe("Ana Cruz, Ben Reyes and 3 more");
  });

  it("formats sizes and the nav badge", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2_621_440)).toBe("2.5 MB");
    expect(unreadBadgeText({ me: { id: ME.id, display_name: ME.display_name }, total: 0, mentions: 0, conversations: [] })).toBeUndefined();
    expect(unreadBadgeText({ me: { id: ME.id, display_name: ME.display_name }, total: 4, mentions: 0, conversations: [] })).toBe("4");
    expect(unreadBadgeText({ me: { id: ME.id, display_name: ME.display_name }, total: 140, mentions: 2, conversations: [] })).toBe("@ 99+");
  });
});
