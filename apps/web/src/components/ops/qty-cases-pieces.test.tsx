import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CasesPiecesStepper,
  QtyCasesPieces,
  formatCasesPieces,
  normalizeCasesPieces,
  splitCasesPieces,
  stepCasesPieces,
  toBaseQty,
} from "./qty-cases-pieces";

describe("cases and pieces maths", () => {
  it("splits and joins on the case size", () => {
    expect(splitCasesPieces(30, 12)).toEqual({ cases: 2, pieces: 6 });
    expect(splitCasesPieces(-30, 12)).toEqual({ cases: -2, pieces: -6 });
    expect(toBaseQty({ cases: 2, pieces: 6 }, 12)).toBe(30);
    expect(splitCasesPieces(30, null)).toEqual({ cases: 0, pieces: 30 });
    expect(splitCasesPieces(30, 1)).toEqual({ cases: 0, pieces: 30 });
  });
  it("formats 2 cs 6 pc, dropping empty parts, pieces only without a case size", () => {
    expect(formatCasesPieces(30, 12)).toBe("2 cs 6 pc");
    expect(formatCasesPieces(24, 12)).toBe("2 cs");
    expect(formatCasesPieces(6, 12)).toBe("6 pc");
    expect(formatCasesPieces(0, 12)).toBe("0 pc");
    expect(formatCasesPieces(30)).toBe("30 pc");
    expect(formatCasesPieces(30, null)).toBe("30 pc");
    expect(formatCasesPieces(-30, 12)).toBe("-2 cs -6 pc");
  });
  it("steps with carry and never below zero", () => {
    expect(stepCasesPieces({ cases: 1, pieces: 11 }, "pieces", 1, 12)).toEqual({
      cases: 2,
      pieces: 0,
    });
    expect(stepCasesPieces({ cases: 1, pieces: 0 }, "pieces", -1, 12)).toEqual({
      cases: 0,
      pieces: 11,
    });
    expect(stepCasesPieces({ cases: 0, pieces: 0 }, "cases", -1, 12)).toEqual({
      cases: 0,
      pieces: 0,
    });
    expect(stepCasesPieces({ cases: 0, pieces: 3 }, "pieces", 1, null)).toEqual(
      { cases: 0, pieces: 4 },
    );
    expect(normalizeCasesPieces({ cases: 1, pieces: 30 }, 12)).toEqual({
      cases: 3,
      pieces: 6,
    });
  });
});

describe("QtyCasesPieces", () => {
  it("renders the display text, right-aligned", () => {
    const html = renderToStaticMarkup(
      createElement(QtyCasesPieces, { base: 30, basePerCase: 12 }),
    );
    expect(html).toContain("2 cs 6 pc");
    expect(html).toContain("tabular-nums");
    expect(
      renderToStaticMarkup(createElement(QtyCasesPieces, { base: 30 })),
    ).toContain("30 pc");
    expect(
      renderToStaticMarkup(createElement(QtyCasesPieces, { base: null })),
    ).toContain("—");
  });
});

describe("CasesPiecesStepper", () => {
  it("shows two big steppers with 48px targets when the product has a case size", () => {
    const html = renderToStaticMarkup(
      createElement(CasesPiecesStepper, {
        value: { cases: 2, pieces: 6 },
        basePerCase: 12,
        onChange: vi.fn(),
      }),
    );
    expect(html).toContain('aria-label="Cases"');
    expect(html).toContain('aria-label="Pieces"');
    expect(html).toContain('aria-label="More cases"');
    expect(html).toContain('aria-label="Less pieces"');
    expect(html.match(/min-h-12 min-w-12/g)?.length).toBe(4);
    expect(html).toContain("1 case = 12 pieces. Total: 2 cs 6 pc");
  });
  it("shows only pieces when there is no case size", () => {
    const html = renderToStaticMarkup(
      createElement(CasesPiecesStepper, {
        value: { cases: 0, pieces: 5 },
        onChange: vi.fn(),
      }),
    );
    expect(html).not.toContain('aria-label="Cases"');
    expect(html).toContain('aria-label="Pieces"');
    expect(html).toContain("no case size");
  });
  it("disables minus at zero and everything when disabled", () => {
    const zero = renderToStaticMarkup(
      createElement(CasesPiecesStepper, {
        value: { cases: 0, pieces: 0 },
        basePerCase: 12,
        onChange: vi.fn(),
      }),
    );
    expect(zero.match(/disabled=""/g)?.length).toBe(2);
    const off = renderToStaticMarkup(
      createElement(CasesPiecesStepper, {
        value: { cases: 1, pieces: 1 },
        basePerCase: 12,
        disabled: true,
        onChange: vi.fn(),
      }),
    );
    expect(off.match(/disabled=""/g)?.length).toBe(6);
  });
  it("calls onChange with the carried value from the plus buttons", () => {
    const onChange = vi.fn();
    const tree = CasesPiecesStepper({
      value: { cases: 1, pieces: 11 },
      basePerCase: 12,
      onChange,
    });
    // Walk the element tree for the button with the label and press it.
    const press = (node: unknown, label: string): boolean => {
      if (!node || typeof node !== "object") return false;
      const el = node as { type?: unknown; props?: Record<string, unknown> };
      if (
        typeof el.type === "function" &&
        !(el.type as { prototype?: unknown }).prototype?.constructor
      )
        return false;
      if (Array.isArray(node)) return node.some((n) => press(n, label));
      const props = el.props ?? {};
      if (
        props["aria-label"] === label &&
        typeof props.onClick === "function"
      ) {
        (props.onClick as () => void)();
        return true;
      }
      if (typeof el.type === "function") {
        const out = (el.type as (p: unknown) => unknown)(props);
        return press(out, label);
      }
      return press(props.children, label);
    };
    expect(press(tree, "More pieces")).toBe(true);
    expect(onChange).toHaveBeenCalledWith({ cases: 2, pieces: 0 });
  });
});
