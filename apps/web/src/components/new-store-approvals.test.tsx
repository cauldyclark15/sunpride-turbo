import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "@sunpride/backend/data-model";
import { decideNewStore, NewStoreApprovals } from "./new-store-approvals";

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  queries: [] as { name: string; args: unknown }[],
  target: null as unknown,
}));
vi.mock("convex/react", () => ({
  useQuery: (reference: unknown, args: unknown) => {
    const name = getFunctionName(reference as never);
    state.queries.push({ name, args });
    return args === "skip" ? undefined : state.values[name];
  },
  useMutation: () => vi.fn(),
}));
vi.mock("next/image", () => ({
  default: (props: { src: string; alt: string }) =>
    createElement("img", { src: props.src, alt: props.alt }),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (initial === null && state.target) return [state.target, vi.fn()];
      return [
        typeof initial === "function" ? (initial as () => unknown)() : initial,
        vi.fn(),
      ];
    },
  };
});

const enrolmentId = "enrol-1" as Id<"outletEnrolments">;
const row = {
  enrolment: {
    _id: enrolmentId,
    status: "pending",
    proposedAt: Date.parse("2026-10-04T01:00:00Z"),
    proposedBy: "issuer|dsp",
    proposedByProfileId: "dsp-profile",
  },
  outlet: {
    _id: "outlet-1",
    name: "Aling Nena Store",
    code: "PROV-000001",
    channel: "Sari-sari",
    address: "12 Rizal St",
    contacts: [{ name: "Nena", phone: "0917" }],
  },
  pin: { latitude: 14.65, longitude: 121.03 },
  proposerName: "Juan DSP",
  cisUrl: "https://files.test/cis.pdf",
  photoUrls: ["https://files.test/photo.jpg"],
};
const render = () => renderToStaticMarkup(createElement(NewStoreApprovals));

beforeEach(() => {
  state.queries = [];
  state.target = null;
  state.values = {
    "lib/capabilities:currentPermissions": {
      capabilities: ["outlet.read", "outlet.enrol.approve"],
    },
    "domains/profiles:current": {
      _id: "manager-profile",
      authSubject: "issuer|manager",
    },
    "outlets/enrolment:pending": {
      page: [row],
      isDone: true,
      continueCursor: "",
    },
    "outlets/enrolment:mine": { page: [], isDone: true, continueCursor: "" },
    "outlets/enrolment:notifications": [
      {
        _id: "event-1",
        kind: "proposed",
        outletName: "Aling Nena Store",
        outletCode: "PROV-000001",
        actorName: "Juan DSP",
        createdAt: Date.parse("2026-10-04T01:00:00Z"),
      },
    ],
    "outlets/enrolment:codeFormat": {
      prefix: "SP",
      digits: 6,
      example: "SP000001",
    },
  };
});

describe("New store approvals", () => {
  it("lists pending stores with photo, CIS, GPS and approve/reject for approvers", () => {
    const view = render();
    expect(view).toContain("New stores to approve");
    expect(view).toContain("Aling Nena Store");
    expect(view).toContain("Provisional");
    expect(view).toContain("Juan DSP");
    expect(view).toContain('src="https://files.test/photo.jpg"');
    expect(view).toContain('href="https://files.test/cis.pdf"');
    expect(view).toContain("GPS 14.65000, 121.03000");
    expect(view).toContain("e.g. SP000001");
    expect(view).toMatch(/>Approve<\/button>/);
    expect(view).toMatch(/>Reject<\/button>/);
    expect(view).toContain("PROV-000001) proposed by Juan DSP");
    expect(state.queries).toContainEqual({
      name: "outlets/enrolment:mine",
      args: "skip",
    });
  });

  it("disables the proposer's own decision", () => {
    state.values["domains/profiles:current"] = {
      _id: "dsp-profile",
      authSubject: "issuer|dsp",
    };
    const view = render();
    expect(view).toContain("Another approver must decide your own proposal.");
    expect(view).toMatch(/disabled=""[^>]*>Approve/);
  });

  it("shows the reason form for the chosen decision", () => {
    state.target = { id: enrolmentId, decision: "rejected" };
    const view = render();
    expect(view).toContain("Rejection reason");
    expect(view).toContain("Reject store");
  });

  it("shows salespeople only their own stores, read-only", () => {
    state.values["lib/capabilities:currentPermissions"] = {
      capabilities: ["outlet.read", "outlet.enrol.propose"],
    };
    state.values["outlets/enrolment:mine"] = {
      page: [
        {
          ...row,
          enrolment: {
            ...row.enrolment,
            status: "approved",
            decisionReason: "CIS checked",
          },
          outlet: { ...row.outlet, code: "SP000001" },
        },
      ],
      isDone: true,
      continueCursor: "",
    };
    const view = render();
    expect(view).toContain("My new stores");
    expect(view).toContain("Approved");
    expect(view).toContain("Decision: CIS checked");
    expect(view).not.toMatch(/>Approve<\/button>/);
    expect(state.queries).toContainEqual({
      name: "outlets/enrolment:pending",
      args: "skip",
    });
  });

  it("renders nothing without outlet access", () => {
    state.values["lib/capabilities:currentPermissions"] = { capabilities: [] };
    expect(render()).toBe("");
  });

  it("requires a reason before deciding", async () => {
    const decide = vi.fn().mockResolvedValue({ code: "SP000001" });
    const form = (reason: string) =>
      ({ get: () => reason }) as unknown as Pick<FormData, "get">;
    await expect(
      decideNewStore(decide, enrolmentId, "approved", form("  ")),
    ).rejects.toThrow(/Reason required/);
    await decideNewStore(decide, enrolmentId, "approved", form(" CIS ok "));
    expect(decide).toHaveBeenCalledWith({
      enrolmentId,
      decision: "approved",
      reason: "CIS ok",
    });
  });
});
