#!/usr/bin/env bun
/**
 * Issue tracker CLI for coding agents — no browser needed.
 *
 *   bun scripts/issues.ts list [--status dev_work_ongoing] [--area Coverage] [--milestone "05 · Coverage"] [--search text] [--archived] [--limit 50] [--json]
 *   bun scripts/issues.ts get SP-0012 [--json]
 *   bun scripts/issues.ts create --title "..." [--description ...] [--steps ...] [--actual ...] [--expected ...]
 *                                [--area ...] [--priority high] [--assignee email] [--ref "#123"] [--milestone ...]
 *   bun scripts/issues.ts bulk issues.json          (JSON array of create fields; idempotent on "externalRef")
 *   bun scripts/issues.ts update SP-0012 [--status ...] [--priority ...] [--assignee email|none] [--title ...] [--milestone ...|none] [--ref ...|none] [--comment "..."]
 *   bun scripts/issues.ts claim SP-0012 --assignee you@example.com [--comment "..."]   (assign + In progress)
 *   bun scripts/issues.ts comment SP-0012 "Fixed in abc123"
 *   bun scripts/issues.ts close SP-0012 [--comment "..."]                              (Ready for retest; --done for Done)
 *
 * Every write is attributed to --actor (default "Agent"). Calls the v2 HTTP API.
 * SUNPRIDE_API_URL defaults to http://127.0.0.1:4310. The optional bearer is read
 * from ~/.sunpride-keys/v2-issues-token; the Bun API authorizes each request.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const STATUSES = [
  "draft",
  "ongoing_test",
  "need_to_rectify",
  "awaiting_client_response",
  "dev_work_ongoing",
  "for_retest",
  "completed",
] as const;
const STATUS_LABELS: Record<string, string> = {
  draft: "Backlog",
  ongoing_test: "In QA",
  need_to_rectify: "Needs fix",
  awaiting_client_response: "Awaiting client response",
  dev_work_ongoing: "In progress",
  for_retest: "Ready for retest",
  completed: "Done",
};
const BOOLEAN_FLAGS = new Set(["archived", "json", "done"]);

const apiBase = (
  process.env.SUNPRIDE_API_URL ?? "http://127.0.0.1:4310"
).replace(/\/$/, "");
const tokenFile = join(homedir(), ".sunpride-keys", "v2-issues-token");

type Flags = Record<string, string | true>;

function parse(argv: string[]) {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) fail(`--${name} needs a value`);
    flags[name] = value;
    index += 1;
  }
  return { positional, flags };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function text(flags: Flags, name: string) {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

/** "none" clears an optional field. */
function clearable(flags: Flags, name: string) {
  const value = text(flags, name);
  if (value === undefined) return undefined;
  return value.toLowerCase() === "none" ? null : value;
}

function status(value: string | undefined) {
  if (value === undefined) return undefined;
  const match = STATUSES.find(
    (candidate) =>
      candidate === value ||
      STATUS_LABELS[candidate]!.toLowerCase() === value.toLowerCase(),
  );
  if (!match)
    fail(
      `Unknown status "${value}". Use one of: ${STATUSES.map((s) => `${s} (${STATUS_LABELS[s]})`).join(", ")}`,
    );
  return match;
}

function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

async function run(fn: string, args: Record<string, unknown>) {
  const read = fn === "list" || fn === "get";
  const url = new URL(`${apiBase}/api/v1/issues/agent/${fn}`);
  const data = compact(args);
  if (read)
    for (const [key, value] of Object.entries(data))
      url.searchParams.set(key, String(value));
  const token = existsSync(tokenFile)
    ? readFileSync(tokenFile, "utf8").trim()
    : "";
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (!read) headers["idempotency-key"] = crypto.randomUUID();
  try {
    const res = await fetch(url, {
      method: read ? "GET" : "POST",
      headers,
      ...(!read ? { body: JSON.stringify(data) } : {}),
    });
    const result = (await res.json()) as {
      error?: { message?: string; code?: string };
    };
    if (!res.ok)
      fail(
        result.error?.message ??
          result.error?.code ??
          `API returned ${res.status}`,
      );
    return result as unknown;
  } catch (error) {
    fail(error instanceof Error ? error.message : "API request failed");
  }
}

type Card = {
  key: string;
  title: string;
  status: string;
  priority: string;
  area: string;
  assigneeName?: string;
  milestone?: string;
  externalRef?: string;
};

function printList(issues: Card[], truncated: boolean) {
  for (const issue of issues)
    console.log(
      [
        issue.key,
        STATUS_LABELS[issue.status] ?? issue.status,
        issue.priority,
        issue.area,
        issue.assigneeName ?? "Unassigned",
        issue.externalRef ?? "",
        issue.title,
      ].join("\t"),
    );
  console.log(`${issues.length} issue(s)${truncated ? " (truncated)" : ""}`);
}

const [command, ...rest] = process.argv.slice(2);
const { positional, flags } = parse(rest);
const actor = text(flags, "actor");

switch (command) {
  case "list": {
    const limit = text(flags, "limit");
    const result = (await run("list", {
      status: status(text(flags, "status")),
      area: text(flags, "area"),
      milestone: text(flags, "milestone"),
      priority: text(flags, "priority"),
      search: text(flags, "search"),
      archived: flags.archived === true ? true : undefined,
      limit: limit ? Number(limit) : undefined,
    })) as { issues: Card[]; truncated: boolean };
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printList(result.issues, result.truncated);
    break;
  }
  case "get": {
    const ref = positional[0] ?? fail("Usage: get SP-0012");
    const detail = (await run("get", { number: ref })) as {
      key: string;
      issue: Record<string, unknown> & { title: string; status: string };
      reporterName: string;
      assigneeName?: string;
      comments: { authorName: string; body: string; createdAt: number }[];
    };
    if (flags.json) {
      console.log(JSON.stringify(detail, null, 2));
      break;
    }
    const issue = detail.issue;
    console.log(`${detail.key} · ${issue.title}`);
    console.log(
      `${STATUS_LABELS[issue.status] ?? issue.status} · ${String(issue.priority)} · ${String(issue.area)} · reported by ${detail.reporterName} · ${detail.assigneeName ?? "Unassigned"}`,
    );
    for (const field of [
      "externalRef",
      "milestone",
      "description",
      "steps",
      "actual",
      "expected",
    ])
      if (issue[field]) console.log(`\n${field}:\n${String(issue[field])}`);
    for (const comment of detail.comments)
      console.log(
        `\n— ${comment.authorName}, ${new Date(comment.createdAt).toISOString()}\n${comment.body}`,
      );
    break;
  }
  case "create": {
    const title = text(flags, "title") ?? fail("--title is required");
    console.log(
      JSON.stringify(
        await run("create", {
          title,
          description: text(flags, "description"),
          steps: text(flags, "steps"),
          actual: text(flags, "actual"),
          expected: text(flags, "expected"),
          area: text(flags, "area"),
          priority: text(flags, "priority"),
          status: status(text(flags, "status")),
          assigneeEmail: text(flags, "assignee"),
          externalRef: text(flags, "ref"),
          milestone: text(flags, "milestone"),
          actor,
        }),
      ),
    );
    break;
  }
  case "bulk": {
    const file = positional[0] ?? fail("Usage: bulk issues.json");
    const issues = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(issues)) fail("The file must hold a JSON array");
    const results = [];
    for (let start = 0; start < issues.length;) {
      const batch: unknown[] = [];
      while (start < issues.length && batch.length < 100) {
        const candidate = [...batch, issues[start]];
        if (
          Buffer.byteLength(
            JSON.stringify(compact({ issues: candidate, actor })),
            "utf8",
          ) > 900_000
        ) {
          if (!batch.length)
            fail("One issue exceeds the API request size limit");
          break;
        }
        batch.push(issues[start++]);
      }
      results.push(
        ...((await run("bulkCreate", { issues: batch, actor })) as unknown[]),
      );
    }
    console.log(JSON.stringify(results, null, 2));
    break;
  }
  case "update":
  case "claim":
  case "close": {
    const ref = positional[0] ?? fail(`Usage: ${command} SP-0012`);
    const assignee = clearable(flags, "assignee");
    if (command === "claim" && !assignee) fail("claim needs --assignee email");
    const nextStatus =
      command === "claim"
        ? "dev_work_ongoing"
        : command === "close"
          ? flags.done
            ? "completed"
            : "for_retest"
          : status(text(flags, "status"));
    console.log(
      JSON.stringify(
        await run("update", {
          number: ref,
          status: nextStatus,
          priority: text(flags, "priority"),
          assigneeEmail: assignee,
          title: text(flags, "title"),
          area: text(flags, "area"),
          externalRef: clearable(flags, "ref"),
          milestone: clearable(flags, "milestone"),
          comment: text(flags, "comment"),
          actor,
        }),
      ),
    );
    break;
  }
  case "comment": {
    const ref = positional[0];
    const body = positional[1] ?? text(flags, "body");
    if (!ref || !body) fail('Usage: comment SP-0012 "text"');
    console.log(
      JSON.stringify(await run("comment", { number: ref, body, actor })),
    );
    break;
  }
  default:
    fail(
      "Commands: list, get, create, bulk, update, claim, comment, close. See the header of scripts/issues.ts.",
    );
}
