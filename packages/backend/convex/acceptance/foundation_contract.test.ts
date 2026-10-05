import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { modules } from "../test.setup";

/**
 * SFD-019 contract compatibility for the shared foundation (SP-0050).
 *
 * `packages/backend/contracts/foundation-v1.baseline.json` freezes the argument
 * and return validators of every public function the web import workspace,
 * inventory screens and van POS call. Shipped clients (web bundles in open
 * tabs, installed phones) keep sending the frozen shapes, so a change must stay
 * backward compatible:
 *
 * - arguments: the new validator accepts every value the frozen one accepted
 *   (new arguments must be optional; nothing may be removed or narrowed);
 * - returns: every value the new validator can return is still readable by a
 *   client built against the frozen one (fields may be added, never removed,
 *   made optional or retyped).
 *
 * A deliberate break gets a new function (or v2 baseline), not an edit of v1.
 */
type V = { type: string; [key: string]: unknown };
type Field = { fieldType: V; optional: boolean };
type Signature = { kind: "query" | "mutation"; args: V; returns: V };

const baselinePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../contracts/foundation-v1.baseline.json",
);

async function signature(path: string): Promise<Signature | null> {
  const [file, name] = path.split(":");
  const load = modules[`./${file}.ts`];
  if (!load || !name) return null;
  const fn = ((await load()) as Record<string, unknown>)[name] as
    | {
        isPublic?: boolean;
        isQuery?: boolean;
        isMutation?: boolean;
        exportArgs?: () => string;
        exportReturns?: () => string | null;
      }
    | undefined;
  if (!fn?.isPublic || !fn.exportArgs) return null;
  const returns = fn.exportReturns?.();
  return {
    kind: fn.isQuery ? "query" : "mutation",
    args: JSON.parse(fn.exportArgs()) as V,
    returns: returns ? (JSON.parse(returns) as V) : { type: "any" },
  };
}

const PRIMITIVE_OF_LITERAL: Record<string, string> = {
  string: "string",
  number: "number",
  boolean: "boolean",
  bigint: "bigint",
};

/**
 * Lists why `wide` does not accept every value `narrow` accepts. For returns
 * (`extraFields`), object fields present only in `narrow` are tolerated because
 * a reader ignores unknown fields; argument validators reject them.
 */
function incompatibilities(
  wide: V,
  narrow: V,
  extraFields: boolean,
  at = "$",
): string[] {
  if (wide.type === "any") return [];
  if (narrow.type === "union")
    return (narrow.value as V[]).flatMap((member, i) =>
      incompatibilities(wide, member, extraFields, `${at}|${i}`),
    );
  if (wide.type === "union") {
    const members = wide.value as V[];
    return members.some(
      (member) =>
        incompatibilities(member, narrow, extraFields, at).length === 0,
    )
      ? []
      : [`${at}: ${narrow.type} not accepted by any union member`];
  }
  if (narrow.type === "literal" && wide.type !== "literal") {
    const literalType = PRIMITIVE_OF_LITERAL[typeof narrow.value];
    const wideType =
      wide.type === "float64"
        ? "number"
        : wide.type === "int64"
          ? "bigint"
          : wide.type;
    return literalType === wideType
      ? []
      : [`${at}: literal ${String(narrow.value)} not accepted by ${wide.type}`];
  }
  if (wide.type !== narrow.type)
    return [`${at}: ${narrow.type} not accepted by ${wide.type}`];
  switch (wide.type) {
    case "literal":
      return wide.value === narrow.value
        ? []
        : [
            `${at}: literal ${String(narrow.value)} not accepted by literal ${String(wide.value)}`,
          ];
    case "id":
      return wide.tableName === narrow.tableName
        ? []
        : [
            `${at}: id<${String(narrow.tableName)}> not accepted by id<${String(wide.tableName)}>`,
          ];
    case "array":
      return incompatibilities(
        wide.value as V,
        narrow.value as V,
        extraFields,
        `${at}[]`,
      );
    case "record": {
      const w = wide as unknown as { keys: V; values: Field };
      const n = narrow as unknown as { keys: V; values: Field };
      return [
        ...incompatibilities(w.keys, n.keys, extraFields, `${at}{key}`),
        ...incompatibilities(
          w.values.fieldType,
          n.values.fieldType,
          extraFields,
          `${at}{value}`,
        ),
      ];
    }
    case "object": {
      const w = wide.value as Record<string, Field>;
      const n = narrow.value as Record<string, Field>;
      const problems: string[] = [];
      for (const [key, field] of Object.entries(w))
        if (!field.optional && (!n[key] || n[key].optional))
          problems.push(
            extraFields
              ? `${at}.${key}: no longer always returned`
              : `${at}.${key}: new required field`,
          );
      for (const [key, field] of Object.entries(n)) {
        if (!w[key]) {
          if (!extraFields) problems.push(`${at}.${key}: no longer accepted`);
          continue;
        }
        problems.push(
          ...incompatibilities(
            w[key].fieldType,
            field.fieldType,
            extraFields,
            `${at}.${key}`,
          ),
        );
      }
      return problems;
    }
    default:
      return [];
  }
}

function breaks(frozen: Signature, current: Signature): string[] {
  return [
    ...(frozen.kind === current.kind
      ? []
      : [`kind ${frozen.kind} became ${current.kind}`]),
    ...incompatibilities(current.args, frozen.args, false).map(
      (p) => `args ${p}`,
    ),
    ...incompatibilities(frozen.returns, current.returns, true).map(
      (p) => `returns ${p}`,
    ),
  ];
}

describe("SFD-019 foundation contract compatibility", () => {
  it("keeps every frozen foundation function present and backward compatible", async () => {
    expect(existsSync(baselinePath)).toBe(true);
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<
      string,
      Signature
    >;
    expect(Object.keys(baseline).length).toBeGreaterThanOrEqual(25);
    const problems: string[] = [];
    for (const [path, frozen] of Object.entries(baseline)) {
      const current = await signature(path);
      if (!current) {
        problems.push(`${path}: removed or no longer public`);
        continue;
      }
      problems.push(...breaks(frozen, current).map((p) => `${path}: ${p}`));
    }
    expect(problems).toEqual([]);
  });

  it("detects breaking argument and return changes and allows additive ones", () => {
    const obj = (fields: Record<string, [V, boolean?]>): V => ({
      type: "object",
      value: Object.fromEntries(
        Object.entries(fields).map(([k, [fieldType, optional]]) => [
          k,
          { fieldType, optional: optional ?? false },
        ]),
      ),
    });
    const str: V = { type: "string" };
    const num: V = { type: "float64" };
    const lit = (value: string): V => ({ type: "literal", value });
    const union = (...value: V[]): V => ({ type: "union", value });
    const frozen: Signature = {
      kind: "mutation",
      args: obj({ runKey: [str], mode: [union(lit("a"), lit("b"))] }),
      returns: obj({ id: [str], count: [num], note: [str, true] }),
    };
    const same = (s: Partial<Signature>) => ({ ...frozen, ...s });
    // Additive: optional argument, widened union, extra and dropped-optional return fields.
    expect(
      breaks(
        frozen,
        same({
          args: obj({
            runKey: [str],
            mode: [union(lit("a"), lit("b"), lit("c"))],
            header: [{ type: "array", value: str }, true],
          }),
          returns: obj({ id: [str], count: [num], extra: [str] }),
        }),
      ),
    ).toEqual([]);
    expect(
      breaks(frozen, same({ args: obj({ runKey: [str], mode: [str] }) })),
    ).toEqual([]);
    // Breaking: new required argument, removed argument, narrowed union.
    expect(
      breaks(
        frozen,
        same({ args: obj({ runKey: [str], mode: [str], rowCount: [num] }) }),
      ),
    ).toEqual(["args $.rowCount: new required field"]);
    expect(breaks(frozen, same({ args: obj({ mode: [str] }) }))).toEqual([
      "args $.runKey: no longer accepted",
    ]);
    expect(
      breaks(frozen, same({ args: obj({ runKey: [str], mode: [lit("a")] }) })),
    ).toEqual(["args $.mode|1: literal b not accepted by literal a"]);
    // Breaking: removed, optionalised or retyped return field; kind change.
    expect(
      breaks(frozen, same({ returns: obj({ id: [str], note: [str, true] }) })),
    ).toEqual(["returns $.count: no longer always returned"]);
    expect(
      breaks(frozen, same({ returns: obj({ id: [str], count: [num, true] }) })),
    ).toEqual(["returns $.count: no longer always returned"]);
    expect(
      breaks(frozen, same({ returns: obj({ id: [num], count: [num] }) })),
    ).toEqual(["returns $.id: float64 not accepted by string"]);
    expect(breaks(frozen, same({ kind: "query" }))).toEqual([
      "kind mutation became query",
    ]);
  });
});
