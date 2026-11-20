import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider, ApiStore } from "../lib/api";
import {
  TerritoryCoverageFields,
  TerritoryStores,
  readCoverageForm,
} from "./territory-coverage-fields";
import { CustomerGroupsAdmin } from "./customer-groups-admin";
import { performTerritoryAction } from "./territory-admin";
import type { ReadMap } from "./master-data/model";

const render = (store: ApiStore, node: React.ReactNode) =>
  renderToStaticMarkup(createElement(ApiProvider, { store }, node));
const page = (rows: unknown[]) => ({
  page: rows,
  isDone: true,
  continueCursor: "",
});
const initial: ReadMap["territories/detail"] = {
  territory: {
    _id: "t",
    code: "CEBU",
    name: "SAMPLE Cebu",
    territoryType: "location",
    effectiveFrom: 0,
    status: "active",
  },
  owner: null,
  coverage: [
    {
      _id: "c",
      municipalityCode: "0702217000",
      name: "City of Cebu",
      provinceName: "Cebu",
    },
    {
      _id: "b",
      barangayCode: "0702217025",
      name: "Guadalupe",
      municipalityName: "City of Cebu",
      provinceName: "Cebu",
    },
  ],
};
function setup(national = true) {
  const store = new ApiStore();
  store.setData(["setup", "org/permissions", {}], {
    national,
    capabilities: ["territory.read", "territory.manage"],
    scopeUnitIds: [],
    role: national ? "super_admin" : "admin",
  });
  return store;
}
describe("SP-0222 territory coverage", () => {
  it("preserves selected places in the submitted form and explains priority and manual overrides", () => {
    const html = render(setup(), <TerritoryCoverageFields initial={initial} />);
    expect(html).toContain("Territory type");
    expect(html).toContain("City / Municipality");
    expect(html).toContain("Barangay");
    expect(html).toContain("City of Cebu");
    expect(html).toContain("Guadalupe");
    expect(html).toContain("A manual store assignment wins");
    expect(html).toContain("Either type can serve Food Service");
    expect(html).toContain("0702217000");
    expect(html).toContain("0702217025");
    expect(html).toContain('name="coverage"');
    expect(html).not.toContain("GeoJSON");
  });
  it("shows customer-group choices, paging, selected group, and its master link instead of places", () => {
    const store = setup();
    store.setData(
      [
        "setup",
        "customer-groups/list",
        { q: "", paginationOpts: { numItems: 50, cursor: null } },
      ],
      {
        page: [{ _id: "group", code: "GAISANO", name: "SAMPLE Gaisano" }],
        isDone: false,
        continueCursor: "next",
      },
    );
    const html = render(
      store,
      <TerritoryCoverageFields
        initial={{
          ...initial,
          territory: { ...initial.territory, territoryType: "customer_group" },
          coverage: [
            { _id: "g", customerGroupId: "group", name: "SAMPLE Gaisano" },
          ],
        }}
      />,
    );
    expect(html).toContain("SAMPLE Gaisano");
    expect(html).toContain("Added");
    expect(html).toContain("Selected groups");
    expect(html).toContain('href="/admin?section=customer-groups"');
    expect(html).toContain("Coverage choices pages");
    expect(html).not.toContain("Search Philippine places");
  });
  it("sends explicit coverage arrays on create and edit, including empty arrays to clear coverage", async () => {
    const mutations = {
      create: vi.fn(),
      edit: vi.fn(),
      transferOwner: vi.fn(),
      assignSalesperson: vi.fn(),
      endSalespersonAssignment: vi.fn(),
      deactivate: vi.fn(),
    };
    const data = new FormData();
    data.set("reason", "Coverage");
    data.set("name", "SAMPLE Cebu");
    data.set("code", "CEBU");
    data.set("orgUnitId", "branch");
    const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    data.set("effectiveDate", date);
    const coverage = {
      territoryType: "location",
      municipalityCodes: ["0702217000"],
      barangayCodes: [],
      customerGroupIds: [],
    };
    data.set("coverage", JSON.stringify(coverage));
    expect(readCoverageForm(data)).toEqual(coverage);
    await performTerritoryAction("create", data, mutations);
    expect(mutations.create).toHaveBeenCalledWith(
      expect.objectContaining(coverage),
    );
    data.set(
      "coverage",
      JSON.stringify({ ...coverage, municipalityCodes: [] }),
    );
    await performTerritoryAction("edit", data, mutations, "territory");
    expect(mutations.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        territoryId: "territory",
        municipalityCodes: [],
        barangayCodes: [],
        customerGroupIds: [],
      }),
    );
    expect(readCoverageForm({ get: () => null })).toEqual({});
  });
  it("renders actual territory roster rows and customer drill links, not a fake count", () => {
    const store = setup();
    store.setData(
      [
        "setup",
        "outlets/list",
        {
          territoryId: "t",
          status: "active",
          paginationOpts: { numItems: 25, cursor: null },
        },
      ],
      {
        ...page([{ _id: "s", code: "SAMPLE-1", name: "SAMPLE Store" }]),
        isDone: false,
        continueCursor: "next",
      },
    );
    const html = render(store, <TerritoryStores territoryId="t" />);
    expect(html).toContain("SAMPLE Store");
    expect(html).toContain('href="/customers?edit=s"');
    expect(html).toContain("Territory stores pages");
  });
  it("offers the group master with searchable stores and does not confuse it with SAP classifications", () => {
    const store = setup();
    store.setData(
      [
        "setup",
        "customer-groups/list",
        { q: "", paginationOpts: { numItems: 25, cursor: null } },
      ],
      page([{ _id: "g", code: "GAISANO", name: "SAMPLE Gaisano" }]),
    );
    store.setData(
      [
        "setup",
        "outlets/list",
        {
          q: "",
          status: "active",
          paginationOpts: { numItems: 25, cursor: null },
        },
      ],
      page([
        {
          _id: "s",
          code: "SAMPLE-1",
          name: "SAMPLE Store",
          territoryName: "Cebu",
          customerGroupId: "g",
        },
      ]),
    );
    const html = render(store, <CustomerGroupsAdmin />);
    expect(html).toContain("Add customer group");
    expect(html).toContain("Manage stores");
    expect(html).toContain("SAMPLE Store");
    expect(html).toContain("Search stores");
    expect(html).toContain("Only stores without a place or customer group");
    expect(html).toContain("separate from the customer classification lists");
    expect(html).toContain("Remove selected stores from groups");
  });
  it("keeps the global group master read-only for a regional admin", () => {
    const html = render(setup(false), <CustomerGroupsAdmin />);
    expect(html).not.toContain("Add customer group");
    expect(html).not.toContain("Link selected stores");
    expect(html).toContain("A national administrator");
  });
});
