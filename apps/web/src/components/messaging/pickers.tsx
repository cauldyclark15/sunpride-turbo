"use client";

import { useDeferredValue, useState, type ReactNode } from "react";
import { useApi } from "../../lib/api";
import { messagingClient } from "../../lib/messaging/client";
import { refTitle } from "../../lib/messaging/tokens";
import {
  REF_TYPES,
  type DirectoryUser,
  type RefEntry,
  type RefType,
} from "../../lib/messaging/types";
import {
  DeveloperBadge,
  Avatar,
  REF_TYPE_LABELS,
  RefTypeIcon,
} from "./primitives";

export function usePeopleSearch(query: string | null) {
  const q = useDeferredValue(query);
  return useApi<DirectoryUser[]>(
    q === null ? null : ["messaging", "users", q],
    ({ signal }) => messagingClient({ signal }).searchUsers(q ?? "", 20),
  );
}

export function useRefSearch(query: string | null) {
  const q = useDeferredValue(query);
  return useApi<RefEntry[]>(
    q === null ? null : ["messaging", "refs", q],
    ({ signal }) =>
      messagingClient({ signal }).searchRefs(q ?? "", undefined, 20),
  );
}

/** Ref results grouped by type in the contract's type order. */
export function groupRefs(entries: readonly RefEntry[]) {
  const groups = new Map<RefType, RefEntry[]>();
  for (const entry of entries) {
    if (entry.access !== "ok") continue;
    const list = groups.get(entry.type) ?? [];
    list.push(entry);
    groups.set(entry.type, list);
  }
  return REF_TYPES.filter((type) => groups.has(type)).map((type) => ({
    type,
    label: REF_TYPE_LABELS[type],
    items: groups.get(type)!,
  }));
}

/** Flattened pick order matching what the grouped list shows. */
export function orderedRefs(entries: readonly RefEntry[]) {
  return groupRefs(entries).flatMap((group) => group.items);
}

const listBox =
  "absolute bottom-full left-0 right-0 z-40 mb-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg";

export function PeopleList({
  people,
  activeIndex,
  onPick,
  loading,
  includeChannel,
}: {
  people: readonly DirectoryUser[];
  activeIndex: number;
  onPick: (person: DirectoryUser | "channel") => void;
  loading?: boolean;
  includeChannel?: boolean;
}) {
  return (
    <div
      role="listbox"
      aria-label="People"
      data-panel="people-picker"
      className={listBox}
    >
      {includeChannel ? (
        <PickRow
          active={activeIndex === people.length}
          onPick={() => onPick("channel")}
        >
          <span className="inline-flex size-6 items-center justify-center rounded-full bg-default-soft text-xs">
            @
          </span>
          <span className="flex-1 text-sm font-medium">channel</span>
          <span className="text-xs text-muted">Notify everyone here</span>
        </PickRow>
      ) : null}
      {people.map((person, index) => (
        <PickRow
          key={person.id}
          active={index === activeIndex}
          onPick={() => onPick(person)}
        >
          <Avatar user={person} size="sm" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {person.display_name}
          </span>
          {person.is_agent ? <DeveloperBadge /> : null}
          <span className="text-xs text-muted">{person.role_label}</span>
        </PickRow>
      ))}
      {!people.length && !includeChannel ? (
        <p className="p-2 text-sm text-muted">
          {loading ? "Searching…" : "No one matches that name."}
        </p>
      ) : null}
    </div>
  );
}

export function ObjectList({
  entries,
  activeIndex,
  onPick,
  loading,
}: {
  entries: readonly RefEntry[];
  activeIndex: number;
  onPick: (entry: RefEntry) => void;
  loading?: boolean;
}) {
  const groups = groupRefs(entries);
  const order = groups.flatMap((group) => group.items);
  return (
    <div
      role="listbox"
      aria-label="Tag an item"
      data-panel="object-picker"
      className={listBox}
    >
      {groups.map((group) => (
        <div key={group.type} role="group" aria-label={group.label}>
          <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
            {group.label}
          </p>
          {group.items.map((entry) => (
            <PickRow
              key={`${entry.type}:${entry.id}`}
              active={order.indexOf(entry) === activeIndex}
              onPick={() => onPick(entry)}
            >
              <PickThumb entry={entry} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {refTitle(entry)}
                </span>
                {entry.subtitle ? (
                  <span className="block truncate text-xs text-muted">
                    {entry.subtitle}
                  </span>
                ) : null}
              </span>
            </PickRow>
          ))}
        </div>
      ))}
      {!order.length ? (
        <p className="p-2 text-sm text-muted">
          {loading
            ? "Searching…"
            : "Nothing matches. Try a store, item, order or issue name."}
        </p>
      ) : null}
    </div>
  );
}

function PickThumb({ entry }: { entry: RefEntry }) {
  const [broken, setBroken] = useState(false);
  if (entry.thumb_url && !broken)
    return (
      // eslint-disable-next-line @next/next/no-img-element -- authenticated media URLs.
      <img
        src={entry.thumb_url}
        alt=""
        onError={() => setBroken(true)}
        className="size-7 shrink-0 rounded-md object-cover"
      />
    );
  return (
    <span
      aria-hidden
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-default-soft text-muted"
    >
      <RefTypeIcon type={entry.type} />
    </span>
  );
}

function PickRow({
  active,
  onPick,
  children,
}: {
  active: boolean;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      // Keep focus in the composer while picking.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPick}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${active ? "bg-default-soft" : "hover:bg-default-soft"}`}
    >
      {children}
    </button>
  );
}
