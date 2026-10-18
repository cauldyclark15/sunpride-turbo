# Web data layer (Bun API)

Convex is gone from the web's root. Feature code reads and writes the Bun API (`docs/architecture/BACKEND_V2.md` §3–4) through `apps/web/src/lib/api` and `apps/web/src/lib/auth`. The layer is in-house, built on React context and `useSyncExternalStore`, with no swr or react-query.

## The pieces

| Import | Use |
|---|---|
| `useApi(key, fetcher)` from `@/lib/api` | A keyed read. A `null` key skips the read. `data` is `undefined` while loading or skipped, and otherwise exactly what the server sent, so `null` and `[]` stay distinct. Equal keys share one request. |
| `useApiPages(key, fetchPage, { all? })` | Cursor pages, with `loadMore`, `reset`, `status`, `isComplete` and `truncated`. Use `all: true` for complete aggregates (the old `useQueries` fan-outs). |
| `useLive(topics, keys)` | Keeps `keys` fresh. The app has one shared `/ws`. A server `invalidate` refetches the matching keys, coalesced. A reconnect resyncs. |
| `mutate(path, body, { invalidate, idempotencyKey })` | One command. It throws `ApiError`, and invalidates keys only after success. `useMutate()` gives the same call with `pending` and `error`. |
| `apiFetch(path, opts)` | A raw same-origin JSON call (cookie `sp_session`) that throws `ApiError`. |
| `serverApi(path)` from `@/lib/api/server` | Server components only. It forwards the incoming cookie. |
| `useSession()` / `usePermissions()` from `@/lib/auth` | The signed-in person from `GET /api/me`: `status`, `profile`, `can("cap.name")` (a UI hint only), and `signIn`, `signUp`, `signOut`. |
| `getServerSession()` from `@/lib/auth/server` | The same session for server components and layouts. |

Errors are always `ApiError { code, message, retryable, status }`, taken from the API envelope `{"error":{code,message,retryable}}`. Branch on `code`. Show `message` to the person.

## Keys

A key is an array of JSON values. Put every input in the key: the domain, the view, ids, filters, and the month. Keys match by prefix: invalidating `["issues"]` refetches `["issues", "board", {...}]` and `["issues", "assignees"]`. Sign-in, sign-out and an account change clear every key, and responses still in flight for the old identity are dropped.

## Before → after (issues board)

Before (Convex):

```tsx
const result = useQuery(
  api.issues.queries.board,
  canRead ? { archived: filters.archived, search: search || undefined } : "skip",
);
const move = useMutation(api.issues.mutations.move);
await move(input);
```

After:

```tsx
import { apiFetch, mutate, useApi, useLive } from "@/lib/api";

const params = { archived: filters.archived, search: search || undefined };
const result = useApi(
  canRead ? ["issues", "board", params] : null, // null = "skip"
  ({ signal }) =>
    apiFetch<IssueBoard>("/api/v1/issues/board", { query: params, signal }),
);
useLive(["issues"], [["issues"]]); // other people's moves show up live

await mutate("/api/v1/issues/move", input, { invalidate: [["issues"]] });
```

`result.data` is `undefined` while loading, exactly like `useQuery`. Read `result.error` and `result.status` instead of relying on a thrown error. For a plain GET, pass the path itself as the fetcher: `useApi(["issues", "assignees"], "/api/v1/issues/assignees")`.

## Rules for feature lanes

- Take DTO types from your own `model/` files. Never derive them from `@sunpride/backend` (`FunctionReturnType`, `Doc`, `Id`): IDs are plain strings and instants are epoch-ms.
- Every command that someone might retry gets an `idempotencyKey`. Create it once per user intent and reuse it when the person retries. Never retry a command automatically, and never write optimistically.
- Topics are proposals until the API grants them (web inventory §8.3). The server decides what a subscriber may hear, and the client never widens it. The session subscribes to the topic `me`.
- Hiding a button with `can()` is not authorization. The API checks every request.
- Tests: the store (`ApiStore`) and the socket client (`LiveClient`) are plain classes, so you can test them without a DOM. For components, render with `<ApiProvider store={store}>` around a pre-seeded `store.setData(key, data)`, or stub `fetch`. See `src/lib/api/*.test.ts`.
