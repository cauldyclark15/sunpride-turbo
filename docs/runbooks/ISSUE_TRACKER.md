# Issue tracker

The in-app issue tracker is a port of the CMS "Internal Issues" board: the same workflow,
layout and card structure, in Sunpride's own colours. People use it at `/issues` in the web
app; coding agents use it from a terminal without a browser.

## Where it lives

| Piece            | Path                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Tables           | `issues`, `issueComments`, `issueAttachments`, `issueActivity`, `issueCounters` in `packages/backend/convex/schema.ts` |
| Rules and limits | `packages/backend/convex/issues/constants.ts` (mirrored in `apps/web/src/lib/issues.ts`, parity-tested)                |
| Web API          | `issues/queries.ts`, `issues/mutations.ts` (signed-in people, capability-gated)                                        |
| Agent API        | `issues/agent.ts` (internal functions only — never reachable from a browser)                                           |
| Agent CLI        | `scripts/issues.ts`                                                                                                    |
| Web pages        | `apps/web/src/app/(dashboard)/issues/` and `apps/web/src/components/issues/`                                           |

## Workflow

Numbers run `SP-0001`, `SP-0002`, … from a transactional counter. Every new issue starts in
**Backlog**. Status values and labels:

| Value                      | Label                    |
| -------------------------- | ------------------------ |
| `draft`                    | Backlog                  |
| `ongoing_test`             | In QA                    |
| `need_to_rectify`          | Needs fix                |
| `awaiting_client_response` | Awaiting client response |
| `dev_work_ongoing`         | In progress              |
| `for_retest`               | Ready for retest         |
| `completed`                | Done                     |

Priority is `low`, `medium` (default), `high` or `critical`. Area is one of the catalog in
`constants.ts`; a blank area files the issue under **Others**. Two optional Sunpride fields:
`externalRef` (a GitHub `#123` or tracker ID such as `SOP-004`) and `milestone` (delivery
group text, e.g. `10 · Supervision and the memo's reports`).

Attachments ride on comments (an issue created with files gets a first comment, "Attachments
added when the issue was created."). At most five per comment; images (PNG, JPEG, WebP, GIF)
up to 10 MB, PDF and Word up to 25 MB, videos (MP4, M4V, WebM, QuickTime) up to 75 MB
(150 MB for the super admin). The server re-checks type and size from Convex storage
metadata and refuses a file that is already attached elsewhere.

Every change writes an `issueActivity` row (created, field edits with before/after,
status moves, comments, attachment removal, archive/restore). Assignee changes are logged by
name, never by profile ID.

## Who can do what

| Capability      | Roles                                                      | Grants                                           |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `issues.read`   | super_admin, admin, operations, manager, approver, analyst | See the board, list and issue pages              |
| `issues.write`  | super_admin, admin, operations, manager, approver          | Create, edit, move, comment, attach              |
| `issues.manage` | super_admin, admin                                         | Archive/restore, remove anyone's comment or file |

Field `sales` and `viewer` never see the tracker. `analyst` is cross-scope and therefore
read-only. Only a comment's author may edit it. An assignee must hold `issues.read`.

## Agent access (no browser)

Agents call the internal functions through the Convex CLI, which uses the deployment and
admin access configured in `packages/backend/.env.local` (DEV). Writes are attributed to an
`actor` label (default `Agent`), shown as the reporter or comment author.

The CLI wrapper, from the repo root:

```bash
bun scripts/issues.ts list                                   # open issues, tab-separated
bun scripts/issues.ts list --status "In progress" --milestone "05 · Coverage" --json
bun scripts/issues.ts get SP-0012                            # full issue with comments
bun scripts/issues.ts create --title "Pins drift on map" --area Coverage --priority high --ref "#123"
bun scripts/issues.ts bulk issues.json                       # JSON array; idempotent on externalRef
bun scripts/issues.ts claim SP-0012 --assignee dev@sunpride.local --actor "Agent · codex"
bun scripts/issues.ts comment SP-0012 "Root cause: stale cursor. Fix in abc123."
bun scripts/issues.ts close SP-0012 --comment "Fixed in abc123"   # Ready for retest
bun scripts/issues.ts close SP-0012 --done                         # Done
bun scripts/issues.ts update SP-0012 --status need_to_rectify --assignee none --milestone none
```

`--status` accepts a value or its label. `none` clears `--assignee`, `--ref` and
`--milestone`. `claim` assigns and moves to In progress; `close` moves to Ready for retest
(or Done with `--done`).

The same functions directly, from `packages/backend`:

```bash
bunx convex run issues/agent:list '{"status":"for_retest","area":"Coverage"}' --codegen disable
bunx convex run issues/agent:get '{"number":"SP-0012"}' --codegen disable
bunx convex run issues/agent:create '{"title":"…","milestone":"08 · Field apps","actor":"Agent"}' --codegen disable
bunx convex run issues/agent:bulkCreate '{"issues":[{"title":"…","externalRef":"SOP-004"}]}' --codegen disable
bunx convex run issues/agent:update '{"number":12,"status":"dev_work_ongoing","assigneeEmail":"dev@sunpride.local","comment":"Claimed"}' --codegen disable
bunx convex run issues/agent:comment '{"number":"SP-0012","body":"…"}' --codegen disable
```

`bulkCreate` takes at most 100 issues per call (the CLI splits larger files). An issue whose
`externalRef` already exists — active or archived — is returned with `created: false`
instead of being duplicated, so a tracker import can be re-run safely.

The functions exist on a deployment only after the lead pushes them (`convex dev --once`
on DEV). Before that, `convex run` answers "Could not find function".

## Limits

The board and list read at most 500 issues per view (newest activity first, or best search
match) and show a notice when the cap is hit; narrow the search or filters. Search covers the
number, title, description, steps, actual/expected behaviour, reference and milestone.
