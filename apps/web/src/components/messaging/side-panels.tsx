"use client";

import { useState } from "react";
import { useApi } from "../../lib/api";
import { messagingClient } from "../../lib/messaging/client";
import {
  conversationTitle,
  dayLabel,
  timeLabel,
} from "../../lib/messaging/format";
import { useConversation } from "../../lib/messaging/hooks";
import type {
  Conversation,
  DirectoryUser,
  SearchHit,
  SearchPage,
  UserLite,
} from "../../lib/messaging/types";
import type { MessagingActions } from "./actions";
import { buildLookup } from "./conversation-view";
import { MessageBody } from "./message-body";
import { PeopleSearch } from "./new-conversation";
import { DeveloperBadge, Avatar, SidePanel, Spinner } from "./primitives";

export function DetailsPanel({
  conversation,
  me,
  isAdmin,
  actions,
  onClose,
  onLeft,
}: {
  conversation: Conversation;
  me: UserLite;
  isAdmin: boolean;
  actions: MessagingActions;
  onClose: () => void;
  onLeft: () => void;
}) {
  const detail = useConversation(conversation.id);
  const members = detail.data?.members ?? [];
  const myRole = members.find((member) => member.id === me.id)?.role;
  const canEdit =
    conversation.kind === "group" || myRole === "owner" || isAdmin;
  const canRemove = myRole === "owner" || isAdmin;
  const [adding, setAdding] = useState(false);
  const [toAdd, setToAdd] = useState<DirectoryUser[]>([]);
  const [topic, setTopic] = useState<string | null>(null);
  const [error, setError] = useState("");
  const fail = (text: string) => () => setError(text);
  const title = conversationTitle(conversation, me.id);

  return (
    <SidePanel
      title="Details"
      subtitle={title}
      onClose={onClose}
      testId="details"
    >
      <div className="flex flex-col gap-5 p-4">
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            About
          </h3>
          <p className="text-sm font-medium">
            {conversation.kind === "channel" ? `# ${title}` : title}
          </p>
          <p className="text-xs text-muted">
            {conversation.kind === "channel"
              ? conversation.is_private
                ? "Private channel"
                : "Public channel"
              : conversation.kind === "group"
                ? "Group"
                : "Direct message"}
          </p>
          {conversation.kind !== "dm" ? (
            topic === null ? (
              <div className="flex items-start gap-2">
                <p className="flex-1 text-sm">
                  {conversation.topic || (
                    <span className="text-muted">No topic</span>
                  )}
                </p>
                {canEdit ? (
                  <button
                    type="button"
                    className="text-xs underline"
                    onClick={() => setTopic(conversation.topic ?? "")}
                  >
                    Edit topic
                  </button>
                ) : null}
              </div>
            ) : (
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  actions
                    .update(conversation.id, { topic: topic.trim() })
                    .then(
                      () => setTopic(null),
                      fail("Could not save the topic."),
                    );
                }}
              >
                <input
                  autoFocus
                  value={topic}
                  aria-label="Topic"
                  onChange={(event) => setTopic(event.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-sm"
                />
                <button
                  type="submit"
                  className="rounded-md bg-foreground px-2 text-xs font-medium text-background"
                >
                  Save
                </button>
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => setTopic(null)}
                >
                  Cancel
                </button>
              </form>
            )
          ) : null}
        </section>
        <section className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={conversation.muted}
              onChange={(event) =>
                actions
                  .update(conversation.id, { muted: event.target.checked })
                  .catch(fail("Could not change notifications."))
              }
            />
            Mute this conversation
          </label>
        </section>
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Members · {conversation.member_count}
            </h3>
            {conversation.kind !== "dm" ? (
              <button
                type="button"
                className="text-xs underline"
                onClick={() => setAdding((value) => !value)}
              >
                {adding ? "Cancel" : "Add people"}
              </button>
            ) : null}
          </div>
          {adding ? (
            <div className="flex flex-col gap-2 rounded-xl border border-border p-2">
              <PeopleSearch
                meId={me.id}
                multiple
                selected={toAdd}
                onToggle={(person) =>
                  setToAdd((list) =>
                    list.some((item) => item.id === person.id)
                      ? list.filter((item) => item.id !== person.id)
                      : [...list, person],
                  )
                }
              />
              <button
                type="button"
                disabled={!toAdd.length}
                className="rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
                onClick={() =>
                  actions
                    .addMembers(
                      conversation.id,
                      toAdd.map((person) => person.id),
                    )
                    .then(() => {
                      setToAdd([]);
                      setAdding(false);
                    }, fail("Could not add those people."))
                }
              >
                Add {toAdd.length || ""}
              </button>
            </div>
          ) : null}
          {detail.isLoading ? <Spinner label="Loading members…" /> : null}
          <ul className="flex flex-col gap-1">
            {members.map((member) => (
              <li key={member.id} className="flex items-center gap-2">
                <Avatar user={member} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {member.display_name}
                  {member.id === me.id ? (
                    <span className="text-muted"> (you)</span>
                  ) : null}
                </span>
                {member.is_agent ? <DeveloperBadge /> : null}
                {member.role === "owner" ? (
                  <span className="text-xs text-muted">Owner</span>
                ) : null}
                {canRemove &&
                member.id !== me.id &&
                conversation.kind !== "dm" ? (
                  <button
                    type="button"
                    className="text-xs text-muted underline"
                    onClick={() =>
                      actions
                        .removeMember(conversation.id, member.id)
                        .catch(fail("Could not remove that person."))
                    }
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
        {conversation.kind !== "dm" ? (
          <button
            type="button"
            className="self-start rounded-md border border-border px-3 py-1.5 text-sm text-danger hover:bg-default-soft"
            onClick={() =>
              actions
                .removeMember(conversation.id, me.id)
                .then(onLeft, fail("Could not leave."))
            }
          >
            Leave {conversation.kind === "channel" ? "channel" : "group"}
          </button>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </SidePanel>
  );
}

export function SearchPanel({
  me,
  onClose,
  onOpenHit,
}: {
  me: UserLite;
  onClose: () => void;
  onOpenHit: (hit: SearchHit) => void;
}) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const result = useApi<SearchPage>(
    query ? ["messaging", "search", query] : null,
    ({ signal }) => messagingClient({ signal }).search(query),
  );
  const hits = result.data?.items ?? [];
  return (
    <SidePanel title="Search" onClose={onClose} testId="search">
      <form
        className="sticky top-0 border-b border-separator bg-surface p-3"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draft.trim());
        }}
      >
        <input
          autoFocus
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Search your conversations"
          aria-label="Search messages"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-foreground/40"
        />
      </form>
      <div className="flex flex-col">
        {result.isLoading ? <Spinner label="Searching…" /> : null}
        {result.error ? (
          <p role="alert" className="p-4 text-sm text-danger">
            Search failed. {result.error.message}
          </p>
        ) : null}
        {query && !result.isLoading && !hits.length && !result.error ? (
          <p className="p-4 text-sm text-muted">No messages match “{query}”.</p>
        ) : null}
        {hits.map((hit) => (
          <button
            key={hit.id}
            type="button"
            onClick={() => onOpenHit(hit)}
            className="flex flex-col gap-1 border-b border-separator px-4 py-3 text-left hover:bg-surface-secondary"
          >
            <span className="flex items-center gap-2 text-xs text-muted">
              <span className="font-medium text-foreground">
                {hit.conversation.kind === "channel" ? "# " : ""}
                {hit.conversation.title ?? "Direct message"}
              </span>
              <span>
                {dayLabel(hit.created_at)} · {timeLabel(hit.created_at)}
              </span>
            </span>
            <span className="flex items-center gap-2">
              <Avatar user={hit.author} size="sm" />
              <span className="text-sm font-medium">
                {hit.author.display_name}
              </span>
            </span>
            <span className="line-clamp-3 text-sm">
              <MessageBody
                body={hit.body}
                refs={hit.refs}
                lookup={buildLookup(undefined, [hit])}
                meId={me.id}
              />
            </span>
          </button>
        ))}
      </div>
    </SidePanel>
  );
}
