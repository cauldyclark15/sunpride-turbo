import type { GenericId } from "convex/values";
import type { TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import schema from "../schema";

/**
 * The full dependency closure check behind `beta/sample:reset`: before any sample row is
 * deleted, every document field anywhere in the schema that can hold an ID of a sample row's
 * table is searched for a row the seed did NOT create. Such a row (a receipt of a sample
 * product at a real warehouse, a real order line, a tester's profile, …) would be left
 * pointing at a deleted ID, so reset refuses instead. The reference list is derived from the
 * schema itself, so a table added later is covered without touching this file.
 *
 * Lookups use an index whose leading field is the reference (optionally after the single
 * organization ID); any other reference is checked by a bounded full scan of the table, and a
 * table too large to scan fails closed (it is reported as a blocker, never assumed clean).
 */

type JsonValidator =
  | { type: "id"; tableName: string }
  | { type: "object"; value: Record<string, { fieldType: JsonValidator }> }
  | { type: "array"; value: JsonValidator }
  | { type: "union"; value: JsonValidator[] }
  | {
      type: "record";
      keys: JsonValidator;
      values: { fieldType: JsonValidator };
    }
  | { type: string };

/** One place a document can hold an ID: `path` segments, `[]` = every array element. */
export type Reference = {
  table: TableNames;
  path: string[];
  target: TableNames;
  /** Index usable for an equality lookup on this reference, if any. */
  index?: { name: string; orgPrefix: boolean };
};

/** The dynamic slice of an index range builder this check needs. */
type IndexEq = { eq(field: string, value: unknown): IndexEq };

/** Largest table a reference without a usable index may be scanned through. */
export const SCAN_LIMIT = 4_000;

function walk(
  validator: JsonValidator,
  path: string[],
  out: { path: string[]; target: string }[],
) {
  switch (validator.type) {
    case "id":
      out.push({
        path,
        target: (validator as { tableName: string }).tableName,
      });
      return;
    case "object":
      for (const [field, spec] of Object.entries(
        (validator as { value: Record<string, { fieldType: JsonValidator }> })
          .value,
      ))
        walk(spec.fieldType, [...path, field], out);
      return;
    case "array":
      walk((validator as { value: JsonValidator }).value, [...path, "[]"], out);
      return;
    case "union":
      for (const member of (validator as { value: JsonValidator[] }).value)
        walk(member, path, out);
      return;
    case "record":
      walk(
        (validator as { values: { fieldType: JsonValidator } }).values
          .fieldType,
        [...path, "{}"],
        out,
      );
      return;
    default:
      return;
  }
}

let cached: Reference[] | undefined;

/** Every ID-holding field in the schema (deduplicated by table, path and target). */
export function schemaReferences(): Reference[] {
  if (cached) return cached;
  const references: Reference[] = [];
  const tables = schema.tables as unknown as Record<
    string,
    {
      validator: { json: JsonValidator };
      export(): { indexes: { indexDescriptor: string; fields: string[] }[] };
    }
  >;
  for (const [table, definition] of Object.entries(tables)) {
    const found: { path: string[]; target: string }[] = [];
    walk(definition.validator.json, [], found);
    const seen = new Set<string>();
    const indexes = definition.export().indexes;
    for (const { path, target } of found) {
      const key = `${path.join(".")}>${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let index: Reference["index"];
      if (path.length === 1) {
        const direct = indexes.find((i) => i.fields[0] === path[0]);
        const orgScoped = indexes.find(
          (i) => i.fields[0] === "organizationId" && i.fields[1] === path[0],
        );
        if (direct) index = { name: direct.indexDescriptor, orgPrefix: false };
        else if (orgScoped)
          index = { name: orgScoped.indexDescriptor, orgPrefix: true };
      }
      references.push({
        table: table as TableNames,
        path,
        target: target as TableNames,
        index,
      });
    }
  }
  cached = references;
  return references;
}

/** Every ID found at `path` in `value` (arrays and records expanded). */
export function valuesAt(value: unknown, path: string[]): unknown[] {
  if (path.length === 0) return [value];
  if (value === null || typeof value !== "object") return [];
  const [head, ...rest] = path;
  if (head === "[]")
    return Array.isArray(value) ? value.flatMap((v) => valuesAt(v, rest)) : [];
  if (head === "{}")
    return Object.values(value as Record<string, unknown>).flatMap((v) =>
      valuesAt(v, rest),
    );
  return valuesAt((value as Record<string, unknown>)[head!], rest);
}

/**
 * Rows outside `tracked` that reference any of `sampleIds` (table → IDs of rows reset would
 * delete). `ignore` skips references reset handles itself. Returns human-readable blockers.
 */
export async function externalReferences(
  ctx: MutationCtx,
  sampleIds: Map<string, Set<string>>,
  tracked: Set<string>,
  ignore: (reference: Reference) => boolean = () => false,
): Promise<string[]> {
  const blockers: string[] = [];
  const byTable = new Map<string, Reference[]>();
  for (const reference of schemaReferences()) {
    if (!sampleIds.get(reference.target)?.size || ignore(reference)) continue;
    const list = byTable.get(reference.table) ?? [];
    list.push(reference);
    byTable.set(reference.table, list);
  }
  const describe = (reference: Reference, id: string) =>
    `${reference.table}.${reference.path.join(".").replaceAll(".[]", "[]")} uses sample ${reference.target} ${id}`;

  for (const [table, references] of byTable) {
    const scanned = references.filter((r) => !r.index);
    for (const reference of references.filter((r) => r.index)) {
      const index = reference.index!;
      for (const id of sampleIds.get(reference.target)!) {
        // At most `tracked.size` sample rows can match; one more means an outside row.
        let seen = 0;
        const field = reference.path[0]!;
        const range = (q: IndexEq) =>
          index.orgPrefix
            ? q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq(field, id)
            : q.eq(field, id);
        // The index and field come from the schema at runtime, so the typed builder is bypassed.
        const query = ctx.db
          .query(table as TableNames)
          .withIndex(index.name as never, range as never);
        for await (const row of query) {
          if (!tracked.has(row._id)) {
            blockers.push(describe(reference, id));
            break;
          }
          if (++seen > tracked.size) break;
        }
      }
    }
    if (scanned.length === 0) continue;
    const rows = await ctx.db.query(table as TableNames).take(SCAN_LIMIT + 1);
    if (rows.length > SCAN_LIMIT) {
      blockers.push(
        `${table} is too large to check for sample references (over ${SCAN_LIMIT} rows)`,
      );
      continue;
    }
    for (const row of rows) {
      if (tracked.has(row._id)) continue;
      for (const reference of scanned) {
        const ids = sampleIds.get(reference.target)!;
        const hit = valuesAt(row, reference.path).find(
          (value) => typeof value === "string" && ids.has(value),
        );
        if (hit !== undefined)
          blockers.push(describe(reference, hit as string));
      }
    }
  }
  return blockers;
}

/** Narrow helper so callers can build `sampleIds` without casting. */
export function addSampleId(
  sampleIds: Map<string, Set<string>>,
  table: string,
  id: GenericId<string> | string,
) {
  const set = sampleIds.get(table) ?? new Set<string>();
  set.add(id);
  sampleIds.set(table, set);
}
