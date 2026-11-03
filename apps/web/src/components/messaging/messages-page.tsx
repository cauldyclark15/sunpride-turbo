"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useSession, usePermissions } from "../../lib/auth/session";
import { canAccessWebModule } from "../../lib/module-access";
import {
  useConversation,
  useConversations,
  useMessagingLive,
} from "../../lib/messaging/hooks";
import type { Conversation, Message, SearchHit, UserLite } from "../../lib/messaging/types";
import { useMessagingActions } from "./actions";
import { ConversationSidebar, type StartMode } from "./conversation-sidebar";
import { ConversationView, ThreadPanel } from "./conversation-view";
import { BrowseChannelsDialog, NewConversationDialog } from "./new-conversation";
import { DetailsPanel, SearchPanel } from "./side-panels";

export type RightPanel =
  | { kind: "thread"; parent: Message }
  | { kind: "details" }
  | { kind: "search" }
  | null;

/** The person signed in, as the chat sees them (`users.id` is the profile subject). */
export function chatSelf(
  profile: { subject: string; name: string } | null | undefined,
): UserLite | null {
  if (!profile) return null;
  return {
    id: profile.subject,
    display_name: profile.name || "You",
    avatar_url: null,
    is_agent: false,
  };
}

/** Which pane a phone shows: the list, the conversation, or the side panel. */
export function phonePane(activeId: string | null, panel: RightPanel) {
  if (panel && (activeId || panel.kind === "search")) return "panel" as const;
  return activeId ? ("conversation" as const) : ("list" as const);
}

const MODERATOR_ROLES = new Set(["super_admin", "admin"]);

/**
 * Fills the shell's content area down to the viewport bottom (above the
 * phone tab bar), whatever banners sit above the page.
 */
function useFillHeight(ready: boolean): RefObject<HTMLDivElement | null> {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || typeof window === "undefined") return;
    const fit = () => {
      const scroller = document.getElementById("workspace-scroll");
      const top = node.getBoundingClientRect().top + (scroller?.scrollTop ?? 0);
      const tabs = document.querySelector<HTMLElement>("[data-phone-tabs]");
      const bottom =
        tabs && getComputedStyle(tabs).display !== "none"
          ? tabs.getBoundingClientRect().height
          : 0;
      node.style.height = `${Math.max(420, window.innerHeight - top - bottom)}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
    if (node.parentElement) observer?.observe(node.parentElement);
    return () => {
      window.removeEventListener("resize", fit);
      observer?.disconnect();
    };
  }, [ready]);
  return element;
}

export function MessagesPage({
  initialConversationId = null,
  initialMessageId = null,
}: {
  initialConversationId?: string | null;
  initialMessageId?: string | null;
}) {
  const session = useSession();
  const permissions = usePermissions();
  const me = chatSelf(session.profile);
  const allowed = canAccessWebModule("messages", session.profile?.role);
  const canModerate =
    permissions.can("messaging.admin") ||
    MODERATOR_ROLES.has(session.profile?.role ?? "");

  const [activeId, setActiveId] = useState<string | null>(initialConversationId);
  const [focusId, setFocusId] = useState<string | null>(initialMessageId);
  const [panel, setPanel] = useState<RightPanel>(null);
  const [dialog, setDialog] = useState<StartMode | null>(null);

  const root = useFillHeight(Boolean(me && allowed));
  const list = useConversations(Boolean(me && allowed));
  const actions = useMessagingActions();
  useMessagingLive(allowed ? me?.id : null, allowed ? activeId : null);

  const listed = useMemo(
    () => list.items?.find((item) => item.id === activeId),
    [list.items, activeId],
  );
  // A linked conversation beyond the first page still opens from its detail.
  const fetched = useConversation(allowed && activeId && !listed ? activeId : null).data;
  const active: Conversation | undefined = listed ?? fetched;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = activeId
      ? `/messages?c=${encodeURIComponent(activeId)}${focusId ? `&m=${encodeURIComponent(focusId)}` : ""}`
      : "/messages";
    if (`${window.location.pathname}${window.location.search}` !== url)
      window.history.replaceState(null, "", url);
  }, [activeId, focusId]);

  if (!session.profile) return <p className="p-6 text-sm text-muted">Loading…</p>;
  if (!allowed || !me)
    return (
      <p className="p-6 text-sm text-muted">
        Messages are for Sunpride staff. Ask an administrator if you need access.
      </p>
    );

  function open(conversation: Conversation, messageId: string | null = null) {
    setActiveId(conversation.id);
    setFocusId(messageId);
    setPanel((current) => (current?.kind === "search" ? current : null));
  }

  function openHit(hit: SearchHit) {
    setActiveId(hit.conversation.id);
    setFocusId(hit.parent_message_id ?? hit.id);
    setPanel(null);
  }

  const pane = phonePane(activeId, panel);
  const threadParent =
    panel?.kind === "thread" ? panel.parent : null;

  return (
    <div
      ref={root}
      className="relative -mx-6 -mb-5 -mt-5 flex h-[calc(100svh-8rem)] min-h-[420px] overflow-hidden border-t border-separator bg-background max-sm:-mx-4 max-sm:-mt-4"
    >
      <div className={`${pane === "list" ? "flex" : "hidden"} min-h-0 w-full md:flex md:w-auto`}>
        <ConversationSidebar
          conversations={list.items ?? []}
          me={me}
          activeId={activeId}
          loading={list.status === "loading"}
          error={list.error ? `Conversations could not be loaded. ${list.error.message}` : undefined}
          canLoadMore={list.status === "canLoadMore"}
          onLoadMore={() => void list.loadMore()}
          onOpen={(conversation) => open(conversation)}
          onStart={setDialog}
          onSearch={() => setPanel({ kind: "search" })}
        />
      </div>
      <div className={`${pane === "conversation" ? "flex" : "hidden"} relative min-h-0 min-w-0 flex-1 md:flex`}>
        {active ? (
          <ConversationView
            key={active.id}
            conversation={active}
            me={me}
            canModerate={canModerate}
            actions={actions}
            focusMessageId={focusId}
            onBack={() => {
              setActiveId(null);
              setPanel(null);
            }}
            onOpenThread={(message) => setPanel({ kind: "thread", parent: message })}
            onOpenDetails={() => setPanel({ kind: "details" })}
            onOpenSearch={() => setPanel({ kind: "search" })}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm font-medium">
              {activeId ? "Opening conversation…" : "Pick a conversation"}
            </p>
            <p className="max-w-xs text-xs text-muted">
              Message a colleague or an AI user, start a group, or join a channel.
            </p>
            <button
              type="button"
              onClick={() => setDialog("dm")}
              className="mt-2 rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background"
            >
              New message
            </button>
          </div>
        )}
      </div>
      {panel ? (
        <div className={`${pane === "panel" ? "flex" : "hidden"} min-h-0 w-full md:absolute md:inset-y-0 md:right-0 md:z-20 md:flex md:w-[380px] md:shadow-xl lg:static lg:shadow-none`}>
          {panel.kind === "thread" && active && threadParent ? (
            <ThreadPanel
              key={threadParent.id}
              conversation={active}
              parent={threadParent}
              me={me}
              canModerate={canModerate}
              actions={actions}
              onClose={() => setPanel(null)}
            />
          ) : panel.kind === "details" && active ? (
            <DetailsPanel
              conversation={active}
              me={me}
              isAdmin={canModerate}
              actions={actions}
              onClose={() => setPanel(null)}
              onLeft={() => {
                setPanel(null);
                setActiveId(null);
              }}
            />
          ) : panel.kind === "search" ? (
            <SearchPanel me={me} onClose={() => setPanel(null)} onOpenHit={openHit} />
          ) : null}
        </div>
      ) : null}
      {dialog === "browse" ? (
        <BrowseChannelsDialog
          actions={actions}
          onClose={() => setDialog(null)}
          onJoined={(conversation) => {
            setDialog(null);
            open(conversation);
          }}
        />
      ) : dialog ? (
        <NewConversationDialog
          mode={dialog}
          meId={me.id}
          actions={actions}
          onClose={() => setDialog(null)}
          onCreated={(conversation) => {
            setDialog(null);
            open(conversation);
          }}
        />
      ) : null}
    </div>
  );
}
