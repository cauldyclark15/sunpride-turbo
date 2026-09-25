import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../schemas/mobile-v1.schema.json";
import baseline from "./mobile-v1-baseline.json";
import {
  decodeResponseEnum,
  isMobileV1Envelope,
  parseMobileV1Request,
  parseMobileV1Response,
} from "../src/index";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const fixtureDir = new URL("../fixtures/mobile-v1/", import.meta.url);
const read = async (name: string): Promise<unknown> =>
  Bun.file(new URL(name, fixtureDir)).json();
const jsonFiles = (
  await Array.fromAsync(
    new Bun.Glob("*.json").scan({ cwd: fixtureDir.pathname }),
  )
).sort();

function inventory(
  node: unknown,
  path: string,
  fields: string[],
  enums: string[],
) {
  if (!node || typeof node !== "object") return;
  const entry = node as Record<string, unknown>;
  if (entry.properties && typeof entry.properties === "object") {
    for (const [key, value] of Object.entries(entry.properties)) {
      const childPath = `${path}.${key}`;
      fields.push(`schema-field: ${childPath}`);
      inventory(value, childPath, fields, enums);
    }
  }
  if (entry.items) inventory(entry.items, `${path}[]`, fields, enums);
  for (const variant of ["anyOf", "oneOf"]) {
    if (Array.isArray(entry[variant]))
      entry[variant].forEach((child, index) =>
        inventory(child, `${path}#${index}`, fields, enums),
      );
  }
  const values =
    entry.enum ?? (entry.const === undefined ? undefined : [entry.const]);
  if (
    Array.isArray(values) &&
    values.every((value) => typeof value === "string")
  ) {
    enums.push(`schema-enum: ${path}`);
    for (const value of values)
      enums.push(`schema-enum-value: ${path} = ${value}`);
  }
}

describe("mobile v1 compatibility artifacts", () => {
  for (const name of jsonFiles) {
    test(`schema and runtime ${name}`, async () => {
      const data = await read(name);
      const valid = name !== "unknown-response-enum.json";
      expect(validate(data), JSON.stringify(validate.errors)).toBe(valid);
      expect(isMobileV1Envelope(data)).toBe(valid);
      if (valid) {
        const envelope = data as { type: string };
        expect(
          envelope.type.endsWith(".request")
            ? parseMobileV1Request(data)
            : parseMobileV1Response(data),
        ).toEqual(data as ReturnType<typeof parseMobileV1Response>);
      }
    });
  }

  test("Swift and Kotlin contract text enumerate every schema path and string enum value", async () => {
    const fields: string[] = [];
    const enums: string[] = [];
    for (const [key, value] of Object.entries(schema.$defs))
      inventory(value, key, fields, enums);
    for (const file of ["SwiftModels.swift", "KotlinModels.kt"]) {
      const text = await Bun.file(new URL(file, fixtureDir)).text();
      expect(text).toContain("OpenEnum");
      expect(text).toContain("OptionalField");
      for (const marker of [...fields, ...enums])
        expect(text).toContain(marker);
    }
  });

  test("frozen v1 required fields and enum values cannot change in place", () => {
    const requiredPaths: string[] = [];
    const enumValues: string[] = [];
    function visit(node: unknown, path: string) {
      if (!node || typeof node !== "object") return;
      const entry = node as Record<string, unknown>;
      if (Array.isArray(entry.required))
        for (const key of entry.required) requiredPaths.push(`${path}.${key}`);
      if (Array.isArray(entry.enum))
        for (const value of entry.enum) enumValues.push(`${path}=${value}`);
      if (entry.const !== undefined) enumValues.push(`${path}=${entry.const}`);
      if (entry.properties && typeof entry.properties === "object")
        for (const [key, child] of Object.entries(entry.properties))
          visit(child, `${path}.${key}`);
      if (entry.items) visit(entry.items, `${path}[]`);
      for (const variant of ["oneOf", "anyOf"])
        if (Array.isArray(entry[variant]))
          entry[variant].forEach((child, index) =>
            visit(child, `${path}#${index}`),
          );
    }
    for (const [key, value] of Object.entries(schema.$defs)) visit(value, key);
    expect(requiredPaths.sort()).toEqual(baseline.requiredPaths);
    expect(enumValues.sort()).toEqual(baseline.enumValues);
  });

  test("new response enum values remain unknown, never mapped to a known transition", async () => {
    const unknown = (await read("unknown-response-enum.json")) as {
      results: [{ status: string }];
    };
    expect(
      decodeResponseEnum(unknown.results[0].status, [
        "accepted",
        "rejected",
        "conflict",
      ] as const),
    ).toEqual({ unknown: "future_pending" });
    expect(
      decodeResponseEnum("accepted", ["accepted", "rejected"] as const),
    ).toBe("accepted");
    expect(() => parseMobileV1Response(unknown)).toThrow();
  });

  test("every required property removal or rename fails old v1 fixtures", async () => {
    for (const name of jsonFiles.filter(
      (name) => name !== "unknown-response-enum.json",
    )) {
      const data = (await read(name)) as Record<string, unknown>;
      const key = Object.keys(data).find(
        (candidate) => !["type", "contractVersion"].includes(candidate),
      );
      expect(key).toBeDefined();
      const removed = { ...data };
      delete removed[key!];
      expect(validate(removed), name).toBe(false);
      expect(
        validate({ ...removed, [`renamed_${key}`]: data[key!] }),
        name,
      ).toBe(false);
    }
    const bootstrap = (await read("bootstrap-response.json")) as Record<
      string,
      unknown
    >;
    const changed = structuredClone(bootstrap);
    delete (changed.employee as Record<string, unknown>).orgUnitId;
    expect(validate(changed)).toBe(false);
    const push = (await read("push-request.json")) as {
      operations: Array<{ payload: Record<string, unknown> }>;
    };
    const changedPush = structuredClone(push);
    delete changedPush.operations[0]!.payload.plannedVisitId;
    expect(validate(changedPush)).toBe(false);
  });

  test("omitted optionals and explicit null remain different; unknown requests fail closed", async () => {
    const bootstrap = (await read("bootstrap-response.json")) as Record<
      string,
      unknown
    >;
    expect(validate({ ...bootstrap, syncCursor: undefined })).toBe(false);
    expect(validate({ ...bootstrap, syncCursor: null })).toBe(true);
    const push = (await read("push-request.json")) as Record<string, unknown>;
    expect(
      validate({
        ...push,
        operations: [{ kind: "order.create", payload: {} }],
      }),
    ).toBe(false);
    expect(validate({ ...push, invented: true })).toBe(false);
    expect(validate({ ...push, contractVersion: 2 })).toBe(false);
  });
});
