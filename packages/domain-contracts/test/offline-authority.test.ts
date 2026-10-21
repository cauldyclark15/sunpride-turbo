import { describe, expect, test } from "bun:test";
import mobile from "../schemas/mobile-v1.schema.json";
import van from "../schemas/van-v1.schema.json";
import {
  authorityRule,
  OFFLINE_AUTHORITY_MATRIX,
  OFFLINE_OUTCOMES,
  OFFLINE_POLICY,
  outcomeRule,
  type OfflineSurface,
} from "../src/offline-authority";

/**
 * SFD-008 / ADR-022. The matrix must classify every entity, operation kind and outcome code the
 * frozen wire schemas can carry, and the backend must not emit anything the matrix does not cover.
 */
type Json = Record<string, unknown>;
const defs = (schema: unknown) => (schema as { $defs: Json }).$defs;
const props = (node: unknown) =>
  Object.keys((node as { properties: Json }).properties);
const at = (node: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((value, key) => (value as Json)[key], node);
const enumOf = (node: unknown): string[] => {
  const n = node as { enum?: string[]; const?: string };
  return n.enum ?? (n.const ? [n.const] : []);
};
const ENVELOPE = new Set([
  "type",
  "contractVersion",
  "serverTime",
  "page",
  "nextPageCursor",
  "syncCursor",
]);
const backend = (path: string) =>
  Bun.file(
    new URL(`../../../apps/api/src/${path}`, import.meta.url).pathname,
  ).text();

const mobilePushKinds = (
  at(
    defs(mobile).pushRequest,
    "properties",
    "operations",
    "items",
    "oneOf",
  ) as Json[]
).flatMap((variant) => enumOf(at(variant, "properties", "kind")));
const vanPushKinds = enumOf(
  at(
    defs(van).pushResponse,
    "properties",
    "results",
    "items",
    "oneOf",
    "0",
    "properties",
    "kind",
  ),
);

describe("offline authority matrix coverage", () => {
  test("every row is unique per surface, channel and entity", () => {
    const keys = OFFLINE_AUTHORITY_MATRIX.map(
      (r) => `${r.surface}|${r.channel}|${r.entity}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("classifies every field and van bootstrap section", () => {
    const cases: [OfflineSurface, string[]][] = [
      ["mobile-v1", props(defs(mobile).bootstrapResponse)],
      ["van-v1", props(defs(van).bootstrapResponse)],
    ];
    for (const [surface, sections] of cases) {
      const data = sections.filter((s) => !ENVELOPE.has(s));
      const classified = OFFLINE_AUTHORITY_MATRIX.filter(
        (r) => r.surface === surface && r.channel === "bootstrap",
      ).map((r) => r.entity);
      expect(classified.sort()).toEqual(data.sort());
    }
  });

  test("classifies every push operation kind on both wires", () => {
    expect(mobilePushKinds.length).toBeGreaterThan(0);
    expect(vanPushKinds.length).toBeGreaterThan(0);
    const push = (surface: OfflineSurface) =>
      OFFLINE_AUTHORITY_MATRIX.filter(
        (r) => r.surface === surface && r.channel === "push",
      )
        .map((r) => r.entity)
        .sort();
    expect(push("mobile-v1")).toEqual([...mobilePushKinds].sort());
    expect(push("van-v1")).toEqual([...vanPushKinds].sort());
  });

  test("classifies the v2 field projection entities and retains every frozen v1 delta rule", async () => {
    const source = await backend("domains/fieldsync/projections.js");
    const block = /entities: \[([^\]]+)\]/.exec(source)?.[1];
    expect(block).toBeDefined();
    const entities = [...block!.matchAll(/"([a-z.]+)"/g)].map((m) => m[1]!);
    expect(entities).toEqual([
      "visit",
      "activity",
      "inventory",
      "field.manifest",
    ]);
    for (const entity of entities.filter((e) => e !== "field.manifest"))
      expect(authorityRule("mobile-v1", "pull", entity)?.writer).toBe("server");
    for (const entity of ["coveragePlan", "outletAssignment"])
      expect(authorityRule("mobile-v1", "pull", entity)?.stale).toBe(
        "rebootstrap",
      );
    expect(authorityRule("mobile-v1", "pull", "product")?.stale).toBe(
      "higher_revision_wins",
    );
    expect(source).toContain('entity === "field.manifest"');
  });

  test("every outcome code on both wires has exactly one remediation per level", () => {
    const required: [OfflineSurface, "result" | "error", string[]][] = [
      [
        "mobile-v1",
        "result",
        enumOf(
          at(
            defs(mobile).pushResponse,
            "properties",
            "results",
            "items",
            "properties",
            "status",
          ),
        ),
      ],
      [
        "mobile-v1",
        "result",
        enumOf(
          at(
            defs(mobile).pushResponse,
            "properties",
            "results",
            "items",
            "properties",
            "code",
          ),
        ),
      ],
      [
        "mobile-v1",
        "error",
        enumOf(
          at(
            defs(mobile).errorResponse,
            "properties",
            "error",
            "properties",
            "code",
          ),
        ),
      ],
      [
        "van-v1",
        "result",
        enumOf(
          at(
            defs(van).pushResponse,
            "properties",
            "results",
            "items",
            "oneOf",
            "1",
            "properties",
            "code",
          ),
        ),
      ],
      [
        "van-v1",
        "error",
        enumOf(at(defs(van).errorResponse, "properties", "code")),
      ],
    ];
    for (const [surface, level, codes] of required) {
      expect(codes.length).toBeGreaterThan(0);
      for (const code of codes) {
        // `rejected` is a status whose meaning lives in its code; it has no remediation of its own.
        if (code === "rejected") continue;
        const matches = OFFLINE_OUTCOMES.filter(
          (r) =>
            r.code === code &&
            r.level === level &&
            r.surfaces.includes(surface),
        );
        expect({ surface, level, code, n: matches.length }).toEqual({
          surface,
          level,
          code,
          n: 1,
        });
      }
    }
  });

  test("classifies every v2 business refusal using the frozen remediation semantics", async () => {
    const source = await backend("core/sync.js");
    const block = /OP_CODES = Object.freeze\(\[([^\]]+)\]/.exec(source)?.[1];
    expect(block).toBeDefined();
    const codes = [...block!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(codes).toEqual([
      "invalid_request",
      "invalid_plan",
      "out_of_scope",
      "dependency_missing",
      "invalid_transition",
      "call_open",
      "mcp_order",
      "wrong_date",
      "idempotency_conflict",
      "evidence_pending_review",
      "unsupported_operation",
      "load_not_posted",
      "stock_conflict",
      "mock_location_refused",
    ]);
    // Semantic equivalences, not a claim that v1 parses a v2 response envelope.
    const equivalents: Record<string, string> = {
      invalid_transition: "conflict",
      idempotency_conflict: "conflict",
      stock_conflict: "conflict",
      mock_location_refused: "evidence_pending_review",
    };
    for (const code of codes) {
      const frozen = equivalents[code] ?? code;
      expect(
        outcomeRule("mobile-v1", "result", frozen) ??
          outcomeRule("van-v1", "result", frozen) ??
          outcomeRule("mobile-v1", "reason", frozen),
      ).toBeDefined();
    }
    for (const reason of ["call_open", "mcp_order", "wrong_date"])
      expect(outcomeRule("mobile-v1", "reason", reason)).toBeDefined();
    expect(outcomeRule("mobile-v1", "result", "invalid_plan")).toBeDefined();
  });
});

describe("offline authority invariants", () => {
  test("server data is read-only on the device and replaced by revision or snapshot", () => {
    for (const rule of OFFLINE_AUTHORITY_MATRIX.filter(
      (r) => r.channel === "bootstrap" || r.channel === "pull",
    )) {
      expect(rule.writer).toBe("server");
      expect(["server_read_only", "server_workflow"]).toContain(rule.authority);
      expect([
        "snapshot_replace",
        "higher_revision_wins",
        "rebootstrap",
      ]).toContain(rule.stale);
    }
  });

  test("device-originated work is immutable once queued; drafts never leave the phone", () => {
    for (const rule of OFFLINE_AUTHORITY_MATRIX.filter(
      (r) => r.channel === "push" || r.channel === "evidence",
    )) {
      expect(rule.writer).toBe("device");
      expect(rule.stale).toBe("immutable_after_send");
      expect(rule.authority).not.toBe("device_draft");
      expect(rule.idempotency.length).toBeGreaterThan(20);
    }
    for (const rule of OFFLINE_AUTHORITY_MATRIX.filter(
      (r) => r.authority === "device_draft",
    )) {
      expect(rule.channel).toBe("local");
      expect(rule.stale).toBe("local_only");
    }
  });

  test("device clocks never decide business order", () => {
    for (const rule of OFFLINE_AUTHORITY_MATRIX) {
      expect([
        "server_sequence",
        "outbox_order_server_validated",
        "server_commit_order",
        "local_only",
      ]).toContain(rule.ordering);
      expect(["none", "evidence_only"]).toContain(rule.deviceClock);
    }
    expect(OFFLINE_POLICY.officialTime).toBe("server");
  });

  test("conflicts and scope problems are held for review, never auto-resolved or resent", () => {
    for (const code of OFFLINE_POLICY.neverAutoResolve) {
      for (const rule of OFFLINE_OUTCOMES.filter((r) => r.code === code))
        expect(rule.deviceAction).toBe("freeze_for_review");
    }
    for (const rule of OFFLINE_OUTCOMES.filter((r) => r.code === "conflict"))
      expect(rule.resendSameBytes).toBe("never");
    // Only a transport-level failure or a cursor reset retries automatically.
    const automaticRetry = OFFLINE_OUTCOMES.filter(
      (r) =>
        r.deviceAction === "retry_backoff" ||
        r.deviceAction === "rebootstrap_then_resume",
    ).map((r) => r.code);
    expect(new Set(automaticRetry)).toEqual(
      new Set([
        "temporarily_unavailable",
        "rebootstrap_required",
        "invalid_cursor",
        "scope_changed",
      ]),
    );
  });

  test("user messages are plain and every remediation names an action", () => {
    for (const rule of OFFLINE_OUTCOMES) {
      expect(rule.userMessage).not.toMatch(
        /[a-z]+_[a-z]+|HTTP|\b40\d\b|\b50\d\b/,
      );
      expect(rule.remediation.length).toBeGreaterThan(5);
    }
  });

  test("policy is marked as a Turbo default until Sunpride signs off", () => {
    expect(OFFLINE_POLICY.source).toBe("turbo-default");
    expect(OFFLINE_POLICY.retry.initialDelayMs).toBe(5_000);
    expect(OFFLINE_POLICY.retry.maxDelayMs).toBe(900_000);
    expect(OFFLINE_POLICY.retry.needsAttentionAfterAttempts).toBe(5);
    expect(authorityRule("mobile-v1", "push", "visit.checkIn")?.authority).toBe(
      "append_only_event",
    );
  });

  test("retains the frozen policy bounds and checks the independent v2 limits", async () => {
    const shared = await backend("domains/visits/shared.js");
    const commands = await backend("domains/visits/commands.js");
    const sync = await backend("core/sync.js");
    expect(OFFLINE_POLICY.maxDeviceClockAheadMs).toBe(24 * 60 * 60_000);
    expect(OFFLINE_POLICY.lateWindowDays).toBe(7);
    expect(shared).toContain("now + DAY");
    expect(commands).toContain("ctx.now - 7 * DAY");
    expect(sync).toContain(
      `MAX_DELTA_LIMIT = ${OFFLINE_POLICY.pull.maxChangesPerPage}`,
    );
    expect(sync).toContain(`MAX_OPS = ${OFFLINE_POLICY.push.maxDependsOn}`);
    // v2 location batches/dependencies have a separately bounded larger budget.
    expect(sync).toContain("MAX_LOCATION_OPS = 100");
    expect(sync).toContain("op.dependsOn.length <= MAX_LOCATION_OPS");
  });
});
