"use client";

import type { ReactNode } from "react";

/** Pieces in one case, or null when the product has no case size. */
export type CaseSize = number | null | undefined;
export type CasesPieces = { cases: number; pieces: number };

const hasCase = (basePerCase: CaseSize): basePerCase is number =>
  typeof basePerCase === "number" &&
  Number.isInteger(basePerCase) &&
  basePerCase > 1;

/** 26 pieces in cases of 12 -> {cases: 2, pieces: 2}. No case size: pieces only. */
export function splitCasesPieces(
  base: number,
  basePerCase?: CaseSize,
): CasesPieces {
  const sign = base < 0 ? -1 : 1;
  const n = Math.abs(Math.trunc(base));
  if (!hasCase(basePerCase)) return { cases: 0, pieces: sign * n };
  return {
    cases: sign * Math.floor(n / basePerCase),
    pieces: sign * (n % basePerCase),
  };
}

/** Inverse of `splitCasesPieces`. */
export function toBaseQty(
  { cases, pieces }: CasesPieces,
  basePerCase?: CaseSize,
): number {
  return (hasCase(basePerCase) ? cases * basePerCase : 0) + pieces;
}

/** "2 cs 6 pc"; "3 cs"; "6 pc"; "0 pc". Pieces only when the product has no case size. */
export function formatCasesPieces(
  base: number,
  basePerCase?: CaseSize,
): string {
  const { cases, pieces } = splitCasesPieces(base, basePerCase);
  const parts: string[] = [];
  if (cases) parts.push(`${cases} cs`);
  if (pieces || !parts.length) parts.push(`${pieces} pc`);
  return parts.join(" ");
}

export function QtyCasesPieces({
  base,
  basePerCase,
  className = "",
}: {
  /** Quantity in the smallest unit (pieces). */
  base: number | null | undefined;
  basePerCase?: CaseSize;
  className?: string;
}) {
  return (
    <span
      className={`inline-block whitespace-nowrap text-right tabular-nums ${className}`.trim()}
    >
      {base == null ? "—" : formatCasesPieces(base, basePerCase)}
    </span>
  );
}

/** Add or take away whole pieces (or cases), carrying pieces into cases and never going below zero. */
export function stepCasesPieces(
  value: CasesPieces,
  unit: "cases" | "pieces",
  delta: number,
  basePerCase?: CaseSize,
): CasesPieces {
  const base = Math.max(0, toBaseQty(value, basePerCase));
  if (!hasCase(basePerCase))
    return { cases: 0, pieces: Math.max(0, base + delta) };
  const next = Math.max(
    0,
    base + (unit === "cases" ? delta * basePerCase : delta),
  );
  return splitCasesPieces(next, basePerCase);
}

/** Carry whole cases out of the pieces, clamp at zero. */
export function normalizeCasesPieces(
  value: CasesPieces,
  basePerCase?: CaseSize,
): CasesPieces {
  return splitCasesPieces(
    Math.max(0, toBaseQty(value, basePerCase)),
    basePerCase,
  );
}

function Stepper({
  label,
  unit,
  value,
  disabled,
  onStep,
  onType,
}: {
  label: string;
  unit: string;
  value: number;
  disabled?: boolean;
  onStep: (delta: number) => void;
  onType: (n: number) => void;
}) {
  const button =
    "inline-flex min-h-12 min-w-12 items-center justify-center rounded-xl border border-border bg-surface text-2xl font-semibold disabled:opacity-40";
  return (
    <div className="grid justify-items-center gap-1">
      <span className="text-xs font-medium uppercase text-muted">{label}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={button}
          aria-label={`Less ${unit}`}
          disabled={disabled || value <= 0}
          onClick={() => onStep(-1)}
        >
          −
        </button>
        <input
          className="min-h-12 w-16 rounded-xl border border-field-border bg-field-background text-center text-xl font-semibold tabular-nums"
          inputMode="numeric"
          pattern="[0-9]*"
          aria-label={label}
          disabled={disabled}
          value={String(value)}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/\D/g, ""));
            onType(Number.isSafeInteger(n) ? n : 0);
          }}
        />
        <button
          type="button"
          className={button}
          aria-label={`More ${unit}`}
          disabled={disabled}
          onClick={() => onStep(1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

/**
 * Two big steppers, Cases and Pieces (pieces only when the product has no case size).
 * Controlled: `value` in, `onChange` out. Pieces over a full case carry into cases.
 */
export function CasesPiecesStepper({
  value,
  onChange,
  basePerCase,
  disabled,
  hint,
}: {
  value: CasesPieces;
  onChange: (next: CasesPieces) => void;
  basePerCase?: CaseSize;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  const caseSize = hasCase(basePerCase) ? basePerCase : null;
  const type = (unit: "cases" | "pieces", n: number) =>
    onChange(
      normalizeCasesPieces(
        unit === "cases"
          ? { cases: n, pieces: value.pieces }
          : { cases: value.cases, pieces: n },
        caseSize,
      ),
    );
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-end gap-4">
        {caseSize ? (
          <Stepper
            label="Cases"
            unit="cases"
            value={value.cases}
            disabled={disabled}
            onStep={(d) =>
              onChange(stepCasesPieces(value, "cases", d, caseSize))
            }
            onType={(n) => type("cases", n)}
          />
        ) : null}
        <Stepper
          label="Pieces"
          unit="pieces"
          value={value.pieces}
          disabled={disabled}
          onStep={(d) =>
            onChange(stepCasesPieces(value, "pieces", d, caseSize))
          }
          onType={(n) => type("pieces", n)}
        />
      </div>
      <p className="text-sm text-muted">
        {hint ??
          (caseSize
            ? `1 case = ${caseSize} pieces. Total: ${formatCasesPieces(toBaseQty(value, caseSize), caseSize)}`
            : "Enter pieces. This product has no case size.")}
      </p>
    </div>
  );
}
