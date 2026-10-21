import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TraceQuantity } from "./retail-trace-quantity";
it("F-614 uses frozen delivery scale without inventing old pack conversions", () => {
  const known = renderToStaticMarkup(
    <TraceQuantity quantity={120} scale={10} uom="CS" />,
  );
  expect(known).toContain("12");
  expect(known).toContain("Frozen base-unit scale 10");
  expect(known).toContain("original selling unit CS");
  const retained = renderToStaticMarkup(<TraceQuantity quantity={120} />);
  expect(retained).toContain("120");
  expect(retained).toContain("no conversion to current packs is assumed");
});
