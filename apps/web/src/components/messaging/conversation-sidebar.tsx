"use client";

import { WorkspaceIcon } from "@sunpride/ui";
import { useState } from "react";
import { useEscape } from "../../lib/messaging/escape";
import {
  SIDEBAR_SECTIONS,
  conversationTitle,
  groupConversations,
  otherMembers,
  shortTimeLabel,
  type SidebarSectionId,
} from "../../lib/messaging/format";
import { plainText } from "../../lib/messaging/tokens";
import type { Conversation, UserLite } from "../../lib/messaging/types";
import { AiBadge, Avatar, CountBadge, IconButton } from "./primitives";

export type StartMode = "dm" | "group" | "channel" | "browse";

const START_LABELS: { mode: StartMode; label: string }[] = [
  { mode: "dm", label: "New direct message" },
  { mode: "group", label: "New group" },
  { mode: "channel", label: "New channel" },
  { mode: "browse", label: "Browse channels" },
];

const SECTION_START: Record<SidebarSectionId, StartMode> = {
  channels: "channel",
  dms: "dm",
  groups: "group",
  agents: "dm",
};

function StartMenu({
  onStart,
  onClose,
}: {
  onStart: (mode: StartMode) => void;
  onClose: () => void;
}) {
  useEscape(onClose);
  return (
    <div
      role="menu"
      aria-label="Start a conversation"
      data-panel="start-menu"
      className="absolute right-2 top-12 z-40 w-56 rounded-xl border border-border bg-surface p-1 shadow-lg"
    >
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-xs font-medium text-muted">Start</span>
        <IconButton label="Close start menu" icon="close" className="size-6" onClick={onClose} />
      </div>
      {START_LABELS.map((item) => (
        <button
          key={item.mode}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onStart(item.mode);
          }}
          className="block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-default-soft"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function ConversationRow({
  conversation,
  me,
  active,
  onOpen,
}: {
  conversation: Conversation;
  me: UserLite;
  active: boolean;
  onOpen: () => void;
}) {
  const title = conversationTitle(conversation, me.id);
  const others = otherMembers(conversation, me.id);
  const unread = conversation.unread_count > 0 && !conversation.muted;
  // MessageLite carries no refs or attachments: names come from the members
  // preview, and an empty body means the message was files only.
  const preview = conversation.last_message
    ? plainText(conversation.last_message.body, {
        user: (id) =>
          [...conversation.members_preview, conversation.last_message!.author].find(
            (member) => member.id === id,
          )?.display_name,
        ref: () => undefined,
      }).trim() || "Sent an attachment"
    : "";
  const lead =
    conversation.last_message && conversation.kind !== "dm"
      ? `${conversation.last_message.author.id === me.id ? "You" : conversation.last_message.author.display_name.split(" ")[0]}: `
      : conversation.last_message?.author.id === me.id
        ? "You: "
        : "";
  return (
    <li>
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={onOpen}
        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${active ? "bg-default-soft" : "hover:bg-surface-secondary"}`}
      >
        {conversation.kind === "channel" ? (
          <span aria-hidden className="inline-flex size-6 shrink-0 items-center justify-center text-muted">
            {conversation.is_private ? "🔒" : "#"}
          </span>
        ) : others[0] ? (
          <Avatar user={others[0]} size="sm" />
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className={`truncate text-sm ${unread ? "font-semibold" : ""}`}>{title}</span>
            {conversation.kind === "dm" && others.some((m) => m.is_agent) ? <AiBadge /> : null}
            {conversation.muted ? <span className="text-[10px] text-muted">Muted</span> : null}
          </span>
          {conversation.last_message ? (
            <span className="block truncate text-xs text-muted">
              {conversation.last_message.deleted ? "Message deleted" : `${lead}${preview}`}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          {conversation.last_message ? (
            <span className="text-[10px] text-muted">
              {shortTimeLabel(conversation.last_message.created_at)}
            </span>
          ) : null}
          <span className="flex gap-1">
            {conversation.mention_count > 0 ? (
              <CountBadge
                count={conversation.mention_count}
                mention
                label={`${conversation.mention_count} ${conversation.mention_count === 1 ? "mention" : "mentions"}`}
              />
            ) : null}
            {unread ? (
              <CountBadge
                count={conversation.unread_count}
                label={`${conversation.unread_count} unread`}
              />
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}

export function ConversationSidebar({
  conversations,
  me,
  activeId,
  loading,
  error,
  canLoadMore,
  onLoadMore,
  onOpen,
  onStart,
  onSearch,
}: {
  conversations: readonly Conversation[];
  me: UserLite;
  activeId: string | null;
  loading: boolean;
  error?: string;
  canLoadMore: boolean;
  onLoadMore: () => void;
  onOpen: (conversation: Conversation) => void;
  onStart: (mode: StartMode) => void;
  onSearch: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<SidebarSectionId>>(new Set());
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? conversations.filter((conversation) =>
        conversationTitle(conversation, me.id).toLowerCase().includes(needle),
      )
    : conversations;
  const groups = groupConversations(visible, me.id);

  return (
    <nav
      aria-label="Conversations"
      className="relative flex h-full min-h-0 w-full flex-col border-border bg-surface md:w-72 md:shrink-0 md:border-r"
    >
      <header className="flex min-h-14 items-center gap-1 border-b border-separator px-3">
        <h1 className="flex-1 text-base font-semibold">Messages</h1>
        <IconButton label="Search messages" icon="search" onClick={onSearch} />
        <IconButton label="Start a conversation" icon="plus" onClick={() => setMenu((value) => !value)} pressed={menu} />
      </header>
      {menu ? <StartMenu onStart={onStart} onClose={() => setMenu(false)} /> : null}
      <div className="px-3 pt-2">
        <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-2 py-1">
          <WorkspaceIcon name="search" className="size-3.5 text-muted" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a conversation"
            aria-label="Find a conversation"
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none outline-none ring-0 placeholder:text-muted focus:ring-0"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-4">
        {loading ? <p className="p-3 text-sm text-muted">Loading conversations…</p> : null}
        {error ? <p role="alert" className="p-3 text-sm text-danger">{error}</p> : null}
        {SIDEBAR_SECTIONS.map((section) => {
          const items = groups[section.id];
          const isCollapsed = collapsed.has(section.id);
          const unread = items.reduce((sum, item) => sum + (item.muted ? 0 : item.unread_count), 0);
          const mentions = items.reduce((sum, item) => sum + item.mention_count, 0);
          if (section.id === "agents" && !items.length) return null;
          return (
            <section key={section.id} aria-label={section.label} className="mt-3">
              <div className="flex items-center gap-1 px-1.5">
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(section.id)) next.delete(section.id);
                      else next.add(section.id);
                      return next;
                    })
                  }
                  className="flex flex-1 items-center gap-1 text-left text-xs font-semibold uppercase tracking-wide text-muted"
                >
                  <span aria-hidden>{isCollapsed ? "▸" : "▾"}</span>
                  {section.label}
                </button>
                {isCollapsed ? (
                  <>
                    <CountBadge count={mentions} mention label={`${mentions} mentions in ${section.label}`} />
                    <CountBadge count={unread} label={`${unread} unread in ${section.label}`} />
                  </>
                ) : null}
                {section.id !== "agents" ? (
                  <IconButton
                    label={START_LABELS.find((item) => item.mode === SECTION_START[section.id])!.label}
                    icon="plus"
                    className="size-6"
                    onClick={() => onStart(SECTION_START[section.id])}
                  />
                ) : null}
              </div>
              {!isCollapsed ? (
                <ul className="mt-1 flex flex-col gap-px">
                  {items.map((conversation) => (
                    <ConversationRow
                      key={conversation.id}
                      conversation={conversation}
                      me={me}
                      active={conversation.id === activeId}
                      onOpen={() => onOpen(conversation)}
                    />
                  ))}
                  {!items.length && !loading ? (
                    <li className="px-2 py-1 text-xs text-muted">
                      {section.id === "channels" ? (
                        <button type="button" className="underline" onClick={() => onStart("browse")}>
                          Browse channels
                        </button>
                      ) : needle ? (
                        "No matches"
                      ) : (
                        "None yet"
                      )}
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </section>
          );
        })}
        {canLoadMore ? (
          <button type="button" onClick={onLoadMore} className="mt-3 w-full rounded-md py-1 text-xs text-muted hover:bg-default-soft">
            Show more conversations
          </button>
        ) : null}
      </div>
    </nav>
  );
}
