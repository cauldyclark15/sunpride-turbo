import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CompareTable,
  boundaryMessage,
  boundaryRings,
} from "./territory-scenarios";
const actual = JSON.parse(
  readFileSync(
    new URL("./fixtures/territory-planning-v2.json", import.meta.url),
    "utf8",
  ),
) as {
  simulation: {
    territories: Parameters<typeof CompareTable>[0]["territories"];
  };
  book: {
    scenarios: {
      plan: Parameters<typeof boundaryMessage>[0];
      boundaryJobStatus: string | null;
    }[];
  };
};
it("F-224 actual API boundary simulation renders its geometry and truthful SAMPLE travel provenance", () => {
  const html = renderToStaticMarkup(
    createElement(CompareTable, { territories: actual.simulation.territories }),
  );
  expect(html).toContain("SAMPLE geometric estimate");
  expect(html).toContain("<path");
  expect(html).toContain("Not recorded");
  expect(html).not.toContain("NaN");
  expect(
    boundaryRings(actual.simulation.territories[0]!.boundary),
  ).toHaveLength(1);
});
it("F-224 applied versus scheduled or failed shapes never imply an early geometry or employee transfer", () => {
  const p = actual.book.scenarios[0]!.plan;
  expect(boundaryMessage(p, "pending")).toContain(
    "applied on the effective day",
  );
  expect(
    boundaryMessage({ ...p, boundaryStatus: "scheduled" }, "pending"),
  ).toContain("People assignments do not move automatically");
  expect(
    boundaryMessage({ ...p, boundaryStatus: "scheduled" }, "failed"),
  ).toContain("Existing shapes remain");
});
