import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Peso, formatPeso } from "./peso";

describe("Peso", () => {
  it("formats centavos as pesos with grouping and two decimals", () => {
    expect(formatPeso(125000)).toBe("₱1,250.00");
    expect(formatPeso(2786)).toBe("₱27.86");
    expect(formatPeso(0)).toBe("₱0.00");
    expect(formatPeso(-5000)).toBe("-₱50.00");
    expect(formatPeso(null)).toBe("—");
    expect(formatPeso(undefined)).toBe("—");
    expect(formatPeso(Number.NaN)).toBe("—");
  });
  it("right-aligns with tabular digits and flags a negative amount", () => {
    const html = renderToStaticMarkup(
      createElement(Peso, { centavos: 125000 }),
    );
    expect(html).toContain("₱1,250.00");
    expect(html).toContain("text-right");
    expect(html).toContain("tabular-nums");
    expect(html).not.toContain("text-danger");
    expect(
      renderToStaticMarkup(createElement(Peso, { centavos: -100 })),
    ).toContain("text-danger");
  });
});
