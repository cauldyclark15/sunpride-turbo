import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import {
  StoreWorkAdmin,
  StopWorkPlanner,
  changeStopWork,
  type StoreWorkCatalog,
} from "./store-work";
import { DailyPlanRoutes } from "./monthly-plan-routes";
import type { Detail, SlotInput } from "./coverage-model";

const state = vi.hoisted(() => ({
  data: undefined as StoreWorkCatalog | undefined,
}));
vi.mock("../lib/api", () => ({
  useApi: () => ({ data: state.data }),
  useLive: vi.fn(),
  useMutate: () => ({ mutate: vi.fn() }),
  apiFetch: vi.fn(),
}));
const catalog: StoreWorkCatalog = {
  canManage: true,
  activities: [
    { activityId: "collection", name: "Collection", active: true },
    { activityId: "countering", name: "Countering", active: true },
    { activityId: "count", name: "Count stock", active: true },
  ],
  routines: [
    {
      routineId: "routine",
      name: "Weekly follow-up",
      activityIds: ["collection", "countering"],
      active: true,
    },
  ],
};
const slot: SlotInput = {
  slotKey: "stop",
  serviceDate: "2030-11-11",
  kind: "outlet_visit",
  outletId: "store",
  sequence: 1,
  expectedDurationMinutes: 20,
  intents: [],
  requiredObjectives: [],
};
beforeEach(() => {
  state.data = structuredClone(catalog);
});
it("office can maintain the list and examples are explicitly not supplied client masters", () => {
  const html = renderToStaticMarkup(<StoreWorkAdmin />);
  expect(html).toContain("Activities and routines");
  expect(html).toContain("Add activity");
  expect(html).toContain("Add routine");
  expect(html).toContain("Weekly follow-up");
  expect(html).toContain("Collection, Countering");
  expect(html).toContain("examples, not a supplied master list");
  expect(html).toContain("does not replace a collection receipt");
});
it("read-only roles see the list without editing controls; an empty list explains the next step", () => {
  state.data = { ...catalog, canManage: false };
  const html = renderToStaticMarkup(<StoreWorkAdmin />);
  expect(html).not.toContain("Add activity");
  expect(html).not.toContain("Edit routine");
  state.data = { ...catalog, activities: [], routines: [] };
  expect(renderToStaticMarkup(<StoreWorkAdmin />)).toContain(
    "No activities yet",
  );
});
it("a stop can combine a routine and individual activities without duplicating shared tasks", () => {
  const changed = changeStopWork(slot, catalog, "routine", [
    "count",
    "collection",
  ]);
  expect(changed.storeWork?.activities.map((a) => a.name)).toEqual([
    "Collection",
    "Countering",
    "Count stock",
  ]);
  const html = renderToStaticMarkup(
    <StopWorkPlanner
      slots={[changed]}
      onChange={() => {}}
      readOnly={false}
      nameFor={() => "Sample store"}
    />,
  );
  expect(html).toContain("2030-11-11");
  expect(html).toContain("Sample store");
  expect(html).toContain("3 activities");
  expect(html).toContain("From routine");
  expect(
    changeStopWork(changed, catalog, undefined, [
      "countering",
    ]).storeWork?.activities.map((a) => a.name),
  ).toEqual(["Countering"]);
});
it("approved stops use frozen names and cannot edit activities", () => {
  const work = changeStopWork(slot, catalog, "routine", []);
  state.data = {
    ...catalog,
    activities: catalog.activities.map((a) => ({
      ...a,
      name: "Changed live name",
    })),
  };
  const html = renderToStaticMarkup(
    <StopWorkPlanner
      slots={[work]}
      onChange={() => {}}
      readOnly
      nameFor={() => "Sample store"}
    />,
  );
  expect(html).toContain("Weekly follow-up");
  expect(html).toContain("Collection");
  expect(html).not.toContain("Changed live name");
  expect(html).not.toContain("<select");
});
it("office compares the agreed activity with the salesman's synced tick, not a fabricated verified result", () => {
  const s = changeStopWork(slot, catalog, "routine", []);
  const detail = {
    dailyRoutes: [{ _id: "route", code: "001", serviceDate: s.serviceDate }],
    slots: [
      {
        ...s,
        _id: "slot",
        approvedSnapshot: {
          outletName: "Frozen store",
          storeWork: s.storeWork,
        },
      },
    ],
    storeWorkResults: [
      { slotId: "slot", activityId: "collection", done: true, recordedAt: 1 },
    ],
  } as Detail;
  const html = renderToStaticMarkup(<DailyPlanRoutes detail={detail} />);
  expect(html).toContain("Collection · Marked done by salesman");
  expect(html).toContain("Countering · Not marked done");
  expect(html).not.toContain("Verified");
});
