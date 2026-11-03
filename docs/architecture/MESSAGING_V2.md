# Messaging (internal chat) — v2 contract

Lead-owned. Lanes read it first, never rename anything in it, and report deviations instead of editing it.

## Goal

Slack-style internal chat for Sunpride staff, our developers, and AI users (Phantasm agents). It ships on:

- the web app (`apps/web`, route `/messages`)
- the field Android app
- the van Android app

iOS is out of scope.

People can:

- send direct messages, group chats and channels
- reply in threads
- @-mention users and #-tag any module object (store, item, issue, order, …), shown as a chip with a small thumbnail
- send images, documents and links (with a link preview)
- react, edit and delete messages
- see unread counts and get realtime updates
- search messages

AI users are ordinary chat members. People talk to them exactly as they talk to a person.

## Who may chat

- **Capability `messaging.use`:** every internal role (all of `ROLES` except partner/external identities). Partners never see messaging.
- **Capability `messaging.admin`:** `super_admin` and `admin`. They can create and remove AI users, archive any channel, and delete any message.
- **Membership is the read boundary.** Every conversation read, message read, attachment download, search hit and realtime topic requires a current member row. A non-member gets a 404 (`not_found`), never a 403, so ids don't leak.
- **AI users** (`chat_agents`) authenticate with `Authorization: Bearer spa_<token>` on the same `/api/v1/messaging/*` routes, as the agent's own user. They have `messaging.use` only.

## Data (migrations 0600–0609, API lane only)

- **`chat_agents`:** `user_id` pk → users, `handle` unique citext, `display_name`, `avatar_blob_id?`, `created_by`, `token_hash` (sha256), `disabled_at`.
  - Agent users get a `users` row (unusable `password_hash`) plus a profile that the directory shows with `is_agent=true`.
- **`chat_conversations`:**
  - `id uuid`, `kind` (`dm` | `group` | `channel`), `title?`, `topic?`, `is_private` bool (channels only)
  - `dm_key` text unique: the sorted user ids joined by `:`, so a DM is created once
  - `created_by`, `created_at`, `archived_at?`, `last_seq bigint`
- **`chat_members`:** (`conversation_id`, `user_id`) pk, `role` (`owner` | `member`), `joined_at`, `last_read_seq bigint default 0`, `muted` bool, `left_at?`.
- **`chat_messages`:**
  - `id uuid`, `conversation_id`, `seq bigint` (per conversation, unique, gap-free, assigned in the insert tx via `chat_conversations.last_seq`), `author_user_id`
  - `body text` (≤ 4000 chars), `client_msg_id text` (unique per author: replaying a send returns the original), `parent_message_id?` (thread)
  - `reply_count`, `last_reply_at`, `edited_at?`, `deleted_at?`, `created_at`
  - Full-text index on `body`.
- **`chat_mentions`:** `message_id`, `kind` (`user` | `object`), `user_id?`, `ref_type?`, `ref_id?`.
- **`chat_attachments`:**
  - `id`, `message_id?` (null until sent), `uploader_user_id`, `blob_id`, `role` (`file` | `thumb`), `of_attachment_id?`
  - `name`, `mime`, `bytes`, `sha256`, `width?`, `height?`, `created_at`
- **`chat_reactions`:** (`message_id`, `user_id`, `emoji`) pk.
- **`chat_link_previews`:** `url_hash` pk, `url`, `title?`, `description?`, `image_url?`, `site_name?`, `fetched_at`, `status`.
- **`chat_message_links`:** `message_id`, `url_hash`, `position`.

## Message body tokens (canonical, stored as-is)

- **User mention:** `<@user:UUID>`.
- **Object tag:** `<#TYPE:ID>`, where `TYPE` is one of the ref types below.
- **`@channel`:** a literal `<!channel>` notifies every member.
- The server parses tokens on send and edit, writes `chat_mentions`, and refuses unknown types or malformed tokens with `invalid` (422).
- The server only checks that the token is well formed and that the object exists. Whether a reader may see the object is decided at read time.
- Clients render tokens as chips and never show raw tokens.

## Object references (`ref_type`)

Each type has its own module file `apps/api/src/domains/messaging/refs/<type>.js` with this shape:

```js
export const type = "outlet";
// returns one entry per requested id
export async function resolve(db, actor, ids) {
  // → [{ type, id, title, subtitle, thumb_url|null, href, access: "ok"|"restricted"|"missing" }]
}
export async function search(db, actor, q, limit) {
  // → same entries; restricted rows are never returned by search
}
```

- **Types:** `user`, `outlet` (store), `product` (item), `customer`, `issue`, `order`, `visit`, `territory`, `route`, `van_trip`.
- **Thumbnails:** the product image, outlet photo or user avatar where one exists, otherwise null; clients then show a type icon.
- **Access:** a ref the reader cannot access in their scope resolves `access:"restricted"` with title `"Restricted item"` and no subtitle or thumb.
- **`href`:** a web path (e.g. `/stores/<id>`). Android opens it in-app where a screen exists; otherwise it shows the chip card only.

## HTTP API (all JSON; errors use the existing `errors.js` envelope)

Base path `/api/v1/messaging`. Cursors are opaque strings. Times are ISO-8601 UTC.

- **Conversations**
  - `GET /conversations?cursor=`
    - → `{items:[Conversation], next_cursor|null}`, sorted by last activity desc.
    - `Conversation = {id, kind, title, topic, is_private, members_preview:[UserLite] (≤5), member_count, unread_count, mention_count, last_message: MessageLite|null, muted, updated_at}`.
    - DM/group titles are derived from the members when null.
  - `POST /conversations`
    - Body: `{kind:"dm", user_ids:[uuid]}`, `{kind:"group", user_ids:[uuid,…], title?}` or `{kind:"channel", title, topic?, is_private?}`.
    - → `Conversation`. A DM is idempotent (same pair → same id). A group has 3–50 members.
  - `GET /conversations/:id` → `Conversation & {members:[Member]}`.
  - `PATCH /conversations/:id` `{title?, topic?, muted?}`: `muted` is per-member; title/topic require an owner, or any member for groups.
  - `POST /conversations/:id/members` `{user_ids}`: not allowed on a DM.
  - `DELETE /conversations/:id/members/:user_id`: leave, or remove (owner/admin).
  - `GET /channels/browse?q=` → public channels the caller may join; `POST /conversations/:id/join`.
- **Messages**
  - `GET /conversations/:id/messages?before_seq=&after_seq=&limit=50&thread=:message_id`
    - → `{items:[Message] ascending by seq, has_more}`.
    - Without `thread`, only top-level messages are returned.
  - `POST /conversations/:id/messages` `{client_msg_id, body, parent_message_id?, attachment_ids?:[uuid] (≤10)}` → `Message` (201, or 200 on replay).
  - `PATCH /messages/:id` `{body}`: author only. `DELETE /messages/:id`: author or `messaging.admin`. Delete is soft; the body becomes empty, attachments are hidden, and `deleted:true`.
  - `POST /messages/:id/reactions` `{emoji}`; `DELETE /messages/:id/reactions/:emoji`.
  - `POST /conversations/:id/read` `{seq}`: monotonic; a lower seq is ignored.
  - `Message = {id, conversation_id, seq, author: UserLite, body, parent_message_id, reply_count, last_reply_at, attachments:[Attachment], refs:[RefEntry] (resolved for the reader), mentions_me: bool, reactions:[{emoji, count, mine}], links:[LinkPreview], edited: bool, deleted: bool, created_at}`.
  - `UserLite = {id, display_name, avatar_url|null, is_agent}`.
  - `Member = UserLite & {role, last_read_seq}`.
- **Attachments**
  - `POST /attachments/claim` `{name, mime, bytes, sha256, role:"file"|"thumb", of_attachment_id?}` → `{attachment_id, upload_url, expires_at}`.
  - Then `PUT upload_url` with the raw bytes. This reuses the `core/media.js` blob store (add messaging purposes; do not fork it).
  - Allowed mimes:
    - images: jpeg, png, webp, gif
    - documents: pdf, docx, xlsx, pptx, csv, txt, zip
    - Anything else is refused (`invalid`).
  - Size limits: 25 MB per file, 1 MB per thumbnail.
  - **Thumbnails are made by the client:** a JPEG ≤ 320 px on the longest side, uploaded as `role:"thumb"` with `of_attachment_id`.
  - `GET /attachments/:id` streams the file to members of the message's conversation, or to the uploader before it is sent.
  - `GET /attachments/:id/thumb` returns the thumb, or 404.
  - `Attachment = {id, name, mime, bytes, width, height, url, thumb_url|null, kind:"image"|"file"}`.
- **Links**
  - On send, the server extracts up to 3 `http(s)` URLs, upserts `chat_link_previews` (`pending`), and a job fetches each one.
  - **SSRF rules for the fetch:**
    - public addresses only, re-checked after DNS resolution and on every redirect
    - at most 3 redirects, a 5 s timeout and 1 MB read
    - reads OpenGraph / `<title>` tags only
  - When a preview is ready, the job publishes `messaging.conv:<id>` and clients refetch.
  - `LinkPreview = {url, title, description, image_url, site_name, status}`.
- **Directory and refs**
  - `GET /users/search?q=&limit=20` → `[UserLite & {role_label}]`: active internal users plus agents.
  - `GET /refs/search?q=&types=outlet,product&limit=20` → `[RefEntry]`, scope-filtered.
  - `POST /refs/resolve` `{refs:[{type,id}] (≤100)}` → `[RefEntry]`.
- **Unread and search**
  - `GET /unread` → `{total, mentions, conversations:[{id, unread_count, mention_count}]}`.
  - `GET /search?q=&cursor=` → `{items:[Message & {conversation:{id,title,kind}}], next_cursor}`, from member conversations only.
- **AI users (Phantasm prep)**
  - `POST /agents` (`messaging.admin`) `{handle, display_name}` → `{agent: UserLite & {handle}, token}`. The token is shown once and only its hash is stored.
  - `GET /agents`; `DELETE /agents/:user_id` disables the agent and revokes its token.
  - `GET /events?after=<cursor>&wait=25`: long-poll for the caller (built for agents, works for any user).
    - → `{events:[{type:"message.created"|"message.edited"|"message.deleted"|"member.added", conversation_id, message: Message|null, at}], cursor}`.
    - It returns immediately when events exist, otherwise after at most `wait` s with an empty list.
    - Delivery is at-least-once; consumers dedupe by `message.id`.
- **Rate limits:** sends are capped at 30 per minute per user, using `core/rate.js`.

## Realtime

The realtime hub sends invalidation messages only (`core/realtime.js`), and clients refetch.

Topics are registered with `registerTopic` in `hooks.js`:

- **`messaging.user:<user_id>`:** fires when any conversation in the user's list changes (new message, membership, read state). Only that user may subscribe.
- **`messaging.conv:<conversation_id>`:** fires when the conversation's messages, reactions, edits or previews change. Only current members may subscribe, and membership is re-checked at delivery (the existing `allowed()` does this through `canSubscribe`).

Publishing happens after the transaction commits.

## Notifications

- The web shows unread and mention badges in the nav. Web browser notifications are optional, behind a toggle.
- Android has:
  - a Messages entry with an unread badge
  - realtime updates while the app is in the foreground
  - a WorkManager poll of `/unread` every 15 min in the background, which posts a local notification for new mentions or DMs
- There is no FCM yet.

## Clients

- **Web** (`apps/web`, module slug `messages`):
  - Three-pane Slack layout: the conversation sidebar (Channels, Direct messages, Groups, AI users), the message pane, and a thread or details side panel.
  - The composer handles `@` people, `#` objects, emoji reactions, drag-drop and paste of files and images, and Enter to send (Shift+Enter for a new line).
  - Also: link previews, ref chips with thumbnails, an image lightbox, file cards, unread dividers, "new messages" jump, search, and starting a DM, group or channel.
  - Phone width uses the existing shell's phone layout. Every panel closes with a close button and with Escape.
- **Android:**
  - The shared Kotlin/Compose module `packages/chat-native` is included by both apps with the same `sourceSets srcDir` pattern as `packages/callflow-native`.
  - Screens: conversation list, conversation, thread, new chat, user and object picker, image viewer, file open (via a `FileProvider` intent), camera or gallery and document picker.
  - Pending sends go to an outbox keyed by `client_msg_id`, so they survive offline and are retried. The last 50 messages per conversation are cached for an offline read.
  - Auth uses the app's existing v2 bearer/session path.
  - Each app adds one entry point (a nav item with a badge). Nothing else in the apps changes.

## Testing

- Security tests, all required:
  - a non-member gets 404 on every read path, the attachment download and realtime subscribe
  - a partner gets 403
  - the agent token works, and a disabled agent gets 401
  - a ref outside the reader's scope resolves `restricted`
  - a `client_msg_id` replay creates no duplicate
  - the SSRF guard refuses `127.0.0.1`, `10.x`, `169.254.169.254` and redirects to them
- The web is tested against contract fixtures (mocked API).
- Android uses JVM unit tests for the token parser, outbox and repository against a fake HTTP server.
