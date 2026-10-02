import { describe, expect, it } from "vitest";
import * as backend from "../../../../packages/backend/convex/issues/constants";
import * as client from "./issues";
describe("issue constants", () => {
  it("mirrors every backend status, label, priority, area and limit", () => {
    for (const key of Object.keys(backend) as (keyof typeof backend)[]) {
      if (typeof backend[key] !== "function")
        expect(client[key], key).toEqual(backend[key]);
    }
  });
  it.each([1, 12, 9999, 10000])(
    "formats issue %s with backend parity",
    (number) =>
      expect(client.formatIssueKey(number)).toBe(
        backend.formatIssueKey(number),
      ),
  );
  it.each([12, "12", "SP-12", "sp-0012", "invalid", "SP-0", 0, 1.5])(
    "parses %s with backend parity",
    (key) => expect(client.parseIssueKey(key)).toBe(backend.parseIssueKey(key)),
  );
});
describe("issue helpers", () => {
  it.each([
    [0, "just now"],
    [59_999, "just now"],
    [60_000, "1m ago"],
    [3_540_000, "59m ago"],
    [3_600_000, "1h ago"],
    [86_400_000, "1d ago"],
    [-60_000, "just now"],
  ])("formats relative age %s", (age, expected) =>
    expect(
      client.relativeTimestamp(100_000_000 - Number(age), 100_000_000),
    ).toBe(expected),
  );
  it("includes an absolute date and time", () =>
    expect(client.absoluteTimestamp(Date.UTC(2026, 9, 2, 12))).toMatch(/2026/));
  it.each([
    ...backend.ALLOWED_IMAGE_TYPES,
    ...backend.ALLOWED_VIDEO_TYPES,
    ...backend.ALLOWED_DOCUMENT_TYPES,
  ])("accepts %s at its limit and rejects larger files", (fileType) => {
    const kind = client.attachmentKind(fileType);
    expect(kind).toBe(backend.attachmentKind(fileType));
    const limit =
      kind === "image"
        ? client.MAX_IMAGE_BYTES
        : kind === "document"
          ? client.MAX_DOCUMENT_BYTES
          : client.DEFAULT_VIDEO_UPLOAD_BYTES;
    for (const fileSize of [limit, limit + 1]) {
      const input = {
        fileType,
        fileSize,
        maxVideoBytes: client.DEFAULT_VIDEO_UPLOAD_BYTES,
      };
      expect(client.validateAttachment(input)).toBe(
        backend.validateAttachment(input),
      );
      expect(Boolean(client.validateAttachment(input))).toBe(fileSize > limit);
    }
  });
  it("rejects unsupported types and uses the current video allowance", () => {
    expect(
      client.validateAttachment({
        fileType: "text/html",
        fileSize: 1,
        maxVideoBytes: 1,
      }),
    ).toContain("Use an image");
    expect(
      client.validateAttachment({
        fileType: "video/mp4",
        fileSize: client.SUPERADMIN_VIDEO_UPLOAD_BYTES,
        maxVideoBytes: client.SUPERADMIN_VIDEO_UPLOAD_BYTES,
      }),
    ).toBeUndefined();
  });
  it("formats file sizes", () => {
    expect(client.formatFileSize(100)).toBe("100 B");
    expect(client.formatFileSize(2048)).toBe("2 KB");
    expect(client.formatFileSize(1_048_576)).toBe("1.0 MB");
  });
  it("anchors moves before and after the destination card, omitting the dragged card", () => {
    const cards = [{ _id: "a" }, { _id: "b" }, { _id: "c" }];
    expect(client.dropNeighbors(cards, "c", "a")).toEqual({
      beforeId: undefined,
      afterId: "a",
    });
    expect(client.dropNeighbors(cards, "a", "b", true)).toEqual({
      beforeId: "b",
      afterId: "c",
    });
    expect(client.dropNeighbors(cards, "b")).toEqual({
      beforeId: "c",
      afterId: undefined,
    });
    expect(client.dropNeighbors([], "a")).toEqual({
      beforeId: undefined,
      afterId: undefined,
    });
  });
  it("writes human activity sentences", () => {
    expect(
      client.activityText({
        kind: "status_changed",
        fromStatus: "draft",
        toStatus: "ongoing_test",
      }),
    ).toBe("moved the issue from Backlog to In QA");
    expect(
      client.activityText({
        kind: "updated",
        changes: [{ field: "priority", from: "medium", to: "high" }],
      }),
    ).toBe("changed priority from medium to high");
    expect(client.activityText({ kind: "archived" })).toBe(
      "archived the issue",
    );
  });
});
describe("issue activity and errors", () => {
  it("names people and summarises long text instead of quoting it", () => {
    expect(
      client.activityText({
        kind: "updated",
        changes: [
          { field: "assignee", from: null, to: "Ana Cruz" },
          { field: "description", from: "old", to: "a very long new text" },
          { field: "priority", from: "medium", to: "high" },
        ],
      }),
    ).toBe(
      "changed assignee from empty to Ana Cruz · edited description · changed priority from medium to high",
    );
  });
  it("shows the server's message for a rejected mutation", async () => {
    const { ConvexError } = await import("convex/values");
    expect(
      client.errorMessage(new ConvexError("Unknown area: X"), "Save failed"),
    ).toBe("Unknown area: X");
    expect(client.errorMessage(new Error("network"), "Save failed")).toBe(
      "Save failed",
    );
  });
});
