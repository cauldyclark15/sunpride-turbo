"use client";

import { useState } from "react";
import { useApi } from "../../lib/api";
import { browseItems, messagingClient } from "../../lib/messaging/client";
import type { Conversation, DirectoryUser } from "../../lib/messaging/types";
import type { MessagingActions } from "./actions";
import { usePeopleSearch } from "./pickers";
import { AiBadge, Avatar, ModalFrame } from "./primitives";

const input =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-foreground/40";
const primary =
  "rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50";

/** Group size limits (MESSAGING_V2: a group has 3–50 members, you included). */
export const GROUP_MIN_OTHERS = 2;
export const GROUP_MAX_OTHERS = 49;

export function PeopleSearch({
  meId,
  selected,
  onToggle,
  multiple,
}: {
  meId: string;
  selected: readonly DirectoryUser[];
  onToggle: (person: DirectoryUser) => void;
  multiple?: boolean;
}) {
  const [query, setQuery] = useState("");
  const results = usePeopleSearch(query);
  const people = (results.data ?? []).filter((person) => person.id !== meId);
  return (
    <div className="flex flex-col gap-2">
      {multiple && selected.length ? (
        <ul aria-label="Selected people" className="flex flex-wrap gap-1">
          {selected.map((person) => (
            <li key={person.id}>
              <button
                type="button"
                onClick={() => onToggle(person)}
                aria-label={`Remove ${person.display_name}`}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs"
              >
                {person.display_name} <span aria-hidden>×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search people and AI users"
        aria-label="Search people and AI users"
        className={input}
      />
      <ul className="flex max-h-72 flex-col gap-px overflow-y-auto">
        {people.map((person) => {
          const isSelected = selected.some((item) => item.id === person.id);
          return (
            <li key={person.id}>
              <button
                type="button"
                aria-pressed={multiple ? isSelected : undefined}
                onClick={() => onToggle(person)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${isSelected ? "bg-default-soft" : "hover:bg-default-soft"}`}
              >
                <Avatar user={person} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm">{person.display_name}</span>
                {person.is_agent ? <AiBadge /> : null}
                <span className="text-xs text-muted">{person.role_label}</span>
                {multiple ? <span aria-hidden className="w-4 text-center">{isSelected ? "✓" : ""}</span> : null}
              </button>
            </li>
          );
        })}
        {!people.length ? (
          <li className="px-2 py-3 text-sm text-muted">
            {results.isLoading ? "Searching…" : "No one matches that name."}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export function NewConversationDialog({
  mode,
  meId,
  actions,
  onClose,
  onCreated,
}: {
  mode: "dm" | "group" | "channel";
  meId: string;
  actions: MessagingActions;
  onClose: () => void;
  onCreated: (conversation: Conversation) => void;
}) {
  const [selected, setSelected] = useState<DirectoryUser[]>([]);
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [isPrivate, setPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create(input: Parameters<MessagingActions["create"]>[0]) {
    setBusy(true);
    setError("");
    try {
      onCreated(await actions.create(input));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start the conversation.");
      setBusy(false);
    }
  }

  const heading =
    mode === "dm" ? "New direct message" : mode === "group" ? "New group" : "New channel";

  return (
    <ModalFrame title={heading} onClose={onClose} testId={`new-${mode}`}>
      <div className="flex flex-col gap-3 p-4">
        {mode === "dm" ? (
          <PeopleSearch
            meId={meId}
            selected={selected}
            onToggle={(person) => void create({ kind: "dm", user_ids: [person.id] })}
          />
        ) : null}
        {mode === "group" ? (
          <>
            <PeopleSearch
              meId={meId}
              multiple
              selected={selected}
              onToggle={(person) =>
                setSelected((list) =>
                  list.some((item) => item.id === person.id)
                    ? list.filter((item) => item.id !== person.id)
                    : list.length >= GROUP_MAX_OTHERS
                      ? list
                      : [...list, person],
                )
              }
            />
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Group name (optional)"
              aria-label="Group name"
              className={input}
            />
            <p className="text-xs text-muted">Pick at least two people. Groups hold up to 50.</p>
            <button
              type="button"
              className={primary}
              disabled={busy || selected.length < GROUP_MIN_OTHERS}
              onClick={() =>
                void create({
                  kind: "group",
                  user_ids: selected.map((person) => person.id),
                  ...(title.trim() ? { title: title.trim() } : {}),
                })
              }
            >
              Start group
            </button>
          </>
        ) : null}
        {mode === "channel" ? (
          <>
            <label className="flex flex-col gap-1 text-sm">
              Name
              <input
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="e.g. north-luzon-sales"
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Topic (optional)
              <input value={topic} onChange={(event) => setTopic(event.target.value)} className={input} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isPrivate} onChange={(event) => setPrivate(event.target.checked)} />
              Private: only people you add can find and join it
            </label>
            <button
              type="button"
              className={primary}
              disabled={busy || !title.trim()}
              onClick={() =>
                void create({
                  kind: "channel",
                  title: title.trim(),
                  ...(topic.trim() ? { topic: topic.trim() } : {}),
                  is_private: isPrivate,
                })
              }
            >
              Create channel
            </button>
          </>
        ) : null}
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      </div>
    </ModalFrame>
  );
}

export function BrowseChannelsDialog({
  actions,
  onClose,
  onJoined,
}: {
  actions: MessagingActions;
  onClose: () => void;
  onJoined: (conversation: Conversation) => void;
}) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const result = useApi<Conversation[] | { items: Conversation[] }>(
    ["messaging", "browse", query],
    ({ signal }) =>
    messagingClient({ signal }).browseChannels(query),
  );
  const channels = browseItems(result.data);
  return (
    <ModalFrame title="Browse channels" onClose={onClose} testId="browse">
      <div className="flex flex-col gap-3 p-4">
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search channels"
          aria-label="Search channels"
          className={input}
        />
        <ul className="flex flex-col gap-1">
          {channels.map((channel) => (
            <li key={channel.id} className="flex items-center gap-3 rounded-lg border border-border p-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium"># {channel.title}</span>
                <span className="block truncate text-xs text-muted">
                  {channel.topic ? `${channel.topic} · ` : ""}
                  {channel.member_count} {channel.member_count === 1 ? "member" : "members"}
                </span>
              </span>
              <button
                type="button"
                className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-default-soft"
                onClick={() =>
                  actions.join(channel.id).then(
                    (joined) => onJoined(joined ?? channel),
                    () => setError("Could not join that channel."),
                  )
                }
              >
                Join
              </button>
            </li>
          ))}
          {!channels.length ? (
            <li className="py-3 text-sm text-muted">
              {result.isLoading ? "Loading channels…" : "No channels to join."}
            </li>
          ) : null}
        </ul>
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      </div>
    </ModalFrame>
  );
}
