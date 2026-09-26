import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CoverageScopeSelect, selectedScopeId } from "./coverage-scope-filters";
vi.mock("convex/react", () => ({ useQuery: vi.fn() }));

const options = [
  { id: "ts70z603x3c01w", code: "DEMO-T1", name: "Demo North Metro Territory" },
  { id: "rs70z603x3c01w", code: "DEMO-R1", name: "Demo City Route" },
];
describe("plan-scoped filter picker", () => {
  it("renders code and name without putting raw IDs into markup", () => {
    const html = renderToStaticMarkup(
      <CoverageScopeSelect
        label="Territory"
        options={options}
        selected=""
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("DEMO-T1 · Demo North Metro Territory");
    expect(html).toContain("DEMO-R1 · Demo City Route");
    expect(html).not.toContain(options[0]!.id);
    expect(html).not.toContain(options[1]!.id);
    expect(html).not.toContain("Territory ID");
  });
  it("passes the selected database ID through to the query state, never an index", () => {
    const onSelect = vi.fn();
    const element = CoverageScopeSelect({
      label: "Route",
      options,
      selected: "",
      onSelect,
    });
    const select = element.props.children[1];
    select.props.onChange({ target: { value: "1" } });
    expect(onSelect).toHaveBeenCalledWith("rs70z603x3c01w");
    expect(selectedScopeId(options, "garbage")).toBe("");
  });
});
