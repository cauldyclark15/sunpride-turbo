import { parseArgs } from "node:util";
import { invalid } from "../../apps/api/src/core/errors.js";
import * as C from "../../apps/api/src/domains/issues/constants.js";
import { text } from "../../apps/api/src/domains/issues/service.js";

const OPTIONS = {
  list: ["status", "updated-since", "limit"],
  show: [],
  comments: ["since", "status"],
  create: [
    "title",
    "area",
    "priority",
    "description",
    "steps",
    "expected",
    "actual",
    "ref",
    "milestone",
    "status",
  ],
  move: ["status", "comment"],
  comment: ["body"],
};

/** Require a timestamp with an explicit timezone, not Date.parse's local-time guesses.
 * @param {string|undefined} value @param {string} flag */
function instant(value, flag) {
  if (value === undefined) return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  const date = m && new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (
    !m ||
    !date ||
    date.getUTCMonth() + 1 !== Number(m[2]) ||
    date.getUTCDate() !== Number(m[3]) ||
    Number(m[4]) > 23 ||
    Number(m[5]) > 59 ||
    Number(m[6]) > 59 ||
    (m[7] !== "Z" &&
      (Number(m[7].slice(1, 3)) > 23 || Number(m[7].slice(4)) > 59)) ||
    !Number.isFinite(Date.parse(value))
  )
    throw invalid(`--${flag} must be an ISO timestamp with a timezone`);
  return value;
}

/** @param {string} value @param {readonly string[]} allowed @param {string} flag */
function choice(value, allowed, flag) {
  if (!allowed.includes(value)) throw invalid(`Invalid --${flag}: ${value}`);
  return value;
}

/** @param {string[]} args */
export function parseCommand(args) {
  const [command, ...rest] = args;
  if (!Object.hasOwn(OPTIONS, command ?? ""))
    throw invalid("Use list, show, comments, create, move or comment");
  /** @type {Record<string,string>} */
  const values = {};
  /** @type {string[]} */
  let positionals;
  try {
    const parsed = parseArgs({
      args: rest,
      options: Object.fromEntries(
        OPTIONS[/** @type {keyof typeof OPTIONS} */ (command)].map((name) => [
          name,
          { type: "string", multiple: true },
        ]),
      ),
      strict: true,
      allowPositionals: true,
    });
    positionals = parsed.positionals;
    for (const [name, entries] of Object.entries(parsed.values)) {
      if (!Array.isArray(entries) || entries.length !== 1)
        throw invalid(`Use --${name} once`);
      values[name] = /** @type {string} */ (entries[0]);
    }
  } catch (e) {
    throw invalid(e instanceof Error ? e.message : "Invalid arguments");
  }
  const keyed = ["show", "move", "comment"].includes(command);
  if (positionals.length !== (keyed ? 1 : 0))
    throw invalid(
      keyed ? "Exactly one issue key is required" : "Unexpected argument",
    );
  const key = keyed ? positionals[0] : null;
  if (
    key &&
    (!/^SP-\d+$/.test(key) ||
      !C.parseIssueKey(key) ||
      Number(key.slice(3)) > 2147483647)
  )
    throw invalid("Use an issue key such as SP-0001");
  const required =
    command === "create"
      ? ["title", "area", "priority"]
      : command === "move"
        ? ["status"]
        : command === "comment"
          ? ["body"]
          : command === "comments"
            ? ["since"]
            : [];
  for (const name of required)
    if (!values[name]?.trim()) throw invalid(`--${name} is required`);
  // Validate before opening a database, including when --ref would replay a create.
  for (const name of [
    "description",
    "steps",
    "expected",
    "actual",
    "comment",
    "body",
  ])
    if (values[name] !== undefined) text(values[name]);
  for (const name of ["ref", "milestone"])
    if (values[name] !== undefined) text(values[name], C.MAX_SHORT_LENGTH);
  if (command === "create") {
    text(values.title.replace(/\s+/g, " "), C.MAX_TITLE_LENGTH);
    choice(values.area, C.ISSUE_AREAS, "area");
    choice(values.priority, C.ISSUE_PRIORITIES, "priority");
  }
  const statuses = values.status?.split(",") ?? null;
  if (statuses) {
    if (!["list", "comments"].includes(command) && statuses.length !== 1)
      throw invalid("Specify one --status");
    for (const status of statuses) choice(status, C.ISSUE_STATUSES, "status");
  }
  let limit = null;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!/^[1-9]\d*$/.test(values.limit) || !Number.isSafeInteger(limit))
      throw invalid("--limit must be a positive integer");
  }
  return {
    command,
    key,
    values,
    statuses,
    limit,
    updatedSince: instant(values["updated-since"], "updated-since"),
    since: instant(values.since, "since"),
  };
}
