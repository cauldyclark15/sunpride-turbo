"use client";

import { Button } from "@heroui/react/button";
import { Dropdown } from "@heroui/react/dropdown";
import { Label } from "@heroui/react/label";
import { Sidebar, useSidebar } from "@heroui-pro/react/sidebar";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Heading } from "react-aria-components";
import { WorkspaceIcon } from "./workspace-icon";
import type {
  WorkspaceBrand,
  WorkspaceNavGroup,
  WorkspaceNavItem,
  WorkspaceUser,
} from "./types";

type WorkspaceShellProps = {
  activeHref: string;
  activePrimaryId: string;
  brand: WorkspaceBrand;
  children: ReactNode;
  contentWidth?: "contained" | "full";
  mobilePrimaryItems?: WorkspaceNavItem[];
  navGroups: WorkspaceNavGroup[];
  onNavigate: (href: string) => void;
  onSignOut: () => void | Promise<void>;
  /** Opens the signed-in person's account page (change password). */
  onAccount?: () => void;
  status?: ReactNode;
  user?: WorkspaceUser;
  /**
   * Phones and tablets (below `lg`): a fixed bottom tab bar with these pages
   * plus "More", and a top bar with {@link phoneTitle} and a slot
   * (`#workspace-phone-actions`) pages portal their filters into. When set,
   * it replaces the hamburger sheet. Desktop is unchanged.
   */
  phoneTabs?: WorkspaceNavItem[];
  /** The rest of the person's pages, listed in the "More" sheet. */
  phoneMoreItems?: WorkspaceNavItem[];
  phoneTitle?: string;
};

/** Pages portal phone-only controls (the Filters button) into this element. */
export const PHONE_ACTIONS_ID = "workspace-phone-actions";

function Brand({
  brand,
  compact = false,
}: {
  brand: WorkspaceBrand;
  compact?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-[7px] bg-accent">
        {brand.logo}
      </div>
      {!compact ? (
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold tracking-tight text-foreground">
            {brand.name}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted">
            {brand.descriptor}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function NavGroups({
  groups,
  activePrimaryId,
}: {
  groups: WorkspaceNavGroup[];
  activePrimaryId: string;
}) {
  return groups.map((group, index) => (
    <Sidebar.Group
      key={group.id}
      className={index ? "border-t border-separator pt-3" : ""}
    >
      {group.label ? (
        <Sidebar.GroupLabel className="text-[11px] font-medium uppercase tracking-wide text-muted">
          {group.label}
        </Sidebar.GroupLabel>
      ) : null}
      <Sidebar.Menu aria-label={group.label ?? "Workspace navigation"}>
        {group.items.map((item) => (
          <Sidebar.MenuItem
            key={item.id}
            id={item.id}
            href={item.href}
            isCurrent={activePrimaryId === item.id}
            textValue={item.label}
            className="min-h-9 text-sm [&_svg]:size-[18px]"
          >
            <Sidebar.MenuIcon>
              <WorkspaceIcon name={item.icon} />
            </Sidebar.MenuIcon>
            <Sidebar.MenuLabel>{item.label}</Sidebar.MenuLabel>
            {item.badge ? (
              <Sidebar.MenuChip>{item.badge}</Sidebar.MenuChip>
            ) : null}
          </Sidebar.MenuItem>
        ))}
      </Sidebar.Menu>
    </Sidebar.Group>
  ));
}

function UserFooter({
  user,
  onSignOut,
  onAccount,
  status,
}: {
  user?: WorkspaceUser;
  onSignOut: () => void | Promise<void>;
  onAccount?: () => void;
  status?: ReactNode;
}) {
  const { isOpen, isMobile } = useSidebar();
  const compact = !isOpen && !isMobile;
  return (
    <Sidebar.Footer>
      {status ? (
        <div className="mb-1 flex items-center px-2" data-sidebar="label">
          {status}
        </div>
      ) : null}
      {user ? (
        <Dropdown>
          <Button
            fullWidth
            variant="ghost"
            aria-label="Open account menu"
            className={`h-auto min-h-0 gap-3 py-2 text-left ${compact ? "justify-center gap-0 px-0" : "justify-start px-2"}`}
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-secondary text-sm font-semibold text-foreground">
              {user.name.trim().slice(0, 1).toUpperCase()}
            </span>
            <span
              className={compact ? "hidden" : "min-w-0"}
              data-sidebar="label"
            >
              <span className="block truncate text-sm font-medium text-foreground">
                {user.name}
              </span>
              <span className="block truncate text-xs capitalize text-muted">
                {user.role.replaceAll("_", " ")}
              </span>
            </span>
          </Button>
          <Dropdown.Popover placement="top start" className="min-w-48">
            <Dropdown.Menu
              aria-label="Account actions"
              onAction={(key: string | number) => {
                if (key === "sign-out") void onSignOut();
                if (key === "account") onAccount?.();
              }}
            >
              {onAccount ? (
                <Dropdown.Item id="account" textValue="Account">
                  <WorkspaceIcon name="user" />
                  <Label>Account · change password</Label>
                </Dropdown.Item>
              ) : null}
              <Dropdown.Item
                id="sign-out"
                textValue="Sign out"
                variant="danger"
              >
                <WorkspaceIcon name="logout" />
                <Label>Sign out</Label>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : null}
    </Sidebar.Footer>
  );
}

const COLLAPSE_KEY = "sp.sidebar.open";

/** Desktop sidebar header: brand plus the collapse/expand control. */
function DesktopHeader({ brand }: { brand: WorkspaceBrand }) {
  const { isOpen: open, toggleSidebar } = useSidebar();
  return (
    <Sidebar.Header
      className={`!pb-4 !pt-5 flex gap-2 ${open ? "!flex-row !px-4 items-center" : "!flex-col !px-2 items-center"}`}
    >
      <div className={open ? "min-w-0 flex-1" : ""}>
        <Brand brand={brand} compact={!open} />
      </div>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
        aria-expanded={open}
        onPress={toggleSidebar}
        className={`shrink-0 text-muted transition-transform duration-300 ${open ? "" : "rotate-180"}`}
      >
        <WorkspaceIcon name="back" className="size-4" />
      </Button>
    </Sidebar.Header>
  );
}

function PhoneTopBar({
  brand,
  title,
}: {
  brand: WorkspaceBrand;
  title?: string;
}) {
  return (
    <div
      data-phone-topbar=""
      className="sticky top-0 z-20 border-b border-separator bg-surface/95 pt-[env(safe-area-inset-top)] backdrop-blur lg:hidden"
    >
      <div className="flex h-14 items-center gap-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]">
        <div className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-[7px] bg-accent">
          {brand.logo}
        </div>
        <p className="min-w-0 flex-1 truncate text-[16px] font-semibold tracking-tight text-foreground">
          {title ?? brand.name}
        </p>
        <div id={PHONE_ACTIONS_ID} className="flex shrink-0 items-center" />
      </div>
    </div>
  );
}

function PhoneTabBar({
  tabs,
  activePrimaryId,
  moreOpen,
  moreActive,
  onNavigate,
  onMore,
}: {
  tabs: WorkspaceNavItem[];
  activePrimaryId: string;
  moreOpen: boolean;
  moreActive: boolean;
  onNavigate: (href: string) => void;
  onMore: () => void;
}) {
  const cell =
    "flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 text-[11px] font-medium leading-tight";
  return (
    <nav
      aria-label="Main pages"
      data-phone-tabs=""
      className="ck-noprint fixed inset-x-0 bottom-0 z-40 border-t border-separator bg-surface/95 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur lg:hidden"
    >
      <ul className="mx-auto grid max-w-xl grid-cols-5 gap-0.5 px-1 py-0.5">
        {tabs.map((item) => {
          const active = activePrimaryId === item.id;
          return (
            <li key={item.id} className="min-w-0">
              <a
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(item.href);
                }}
                className={`${cell} ${active ? "text-foreground" : "text-muted"}`}
              >
                <span
                  className={`grid h-7 w-12 place-items-center rounded-full ${active ? "bg-default" : ""}`}
                >
                  <WorkspaceIcon name={item.icon} className="size-[20px]" />
                </span>
                <span className="w-full truncate text-center">
                  {item.label}
                </span>
              </a>
            </li>
          );
        })}
        <li className="min-w-0">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={onMore}
            className={`${cell} w-full ${moreActive || moreOpen ? "text-foreground" : "text-muted"}`}
          >
            <span
              className={`grid h-7 w-12 place-items-center rounded-full ${moreActive ? "bg-default" : ""}`}
            >
              <WorkspaceIcon name="more" className="size-[20px]" />
            </span>
            <span>More</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}

function MoreSheet({
  items,
  activePrimaryId,
  user,
  onClose,
  onNavigate,
  onAccount,
  onSignOut,
}: {
  items: WorkspaceNavItem[];
  activePrimaryId: string;
  user?: WorkspaceUser;
  onClose: () => void;
  onNavigate: (href: string) => void;
  onAccount?: () => void;
  onSignOut: () => void | Promise<void>;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
  const row =
    "flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] font-medium text-foreground hover:bg-default-soft";
  return (
    <div className="ck-noprint fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        className="absolute inset-0 bg-black/25"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="More pages"
        className="absolute inset-x-0 bottom-0 flex max-h-[85svh] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-separator px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold text-foreground">
              {user?.name ?? "More"}
            </p>
            {user ? (
              <p className="truncate text-[12px] capitalize text-muted">
                {user.role.replaceAll("_", " ")}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="min-h-11 rounded-lg border border-border px-4 text-[14px] font-medium text-foreground"
          >
            Close
          </button>
        </div>
        <ul className="overflow-y-auto overscroll-contain px-2 py-2">
          {items.map((item) => (
            <li key={item.id}>
              <a
                href={item.href}
                aria-current={activePrimaryId === item.id ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  onClose();
                  onNavigate(item.href);
                }}
                className={`${row} ${activePrimaryId === item.id ? "bg-default" : ""}`}
              >
                <WorkspaceIcon name={item.icon} className="size-5 text-muted" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.badge ? (
                  <span className="text-[12px] text-muted">{item.badge}</span>
                ) : null}
              </a>
            </li>
          ))}
          <li className="mt-1 border-t border-separator pt-1">
            {onAccount ? (
              <button
                type="button"
                className={row}
                onClick={() => {
                  onClose();
                  onAccount();
                }}
              >
                <WorkspaceIcon name="user" className="size-5 text-muted" />
                Account · change password
              </button>
            ) : null}
            <button
              type="button"
              className={`${row} !text-danger`}
              onClick={() => {
                onClose();
                void onSignOut();
              }}
            >
              <WorkspaceIcon name="logout" className="size-5" />
              Sign out
            </button>
          </li>
        </ul>
      </div>
    </div>
  );
}

export function WorkspaceShell({
  activeHref,
  activePrimaryId,
  brand,
  children,
  contentWidth = "contained",
  mobilePrimaryItems = [],
  navGroups,
  onNavigate,
  onSignOut,
  onAccount,
  status,
  user,
  phoneTabs,
  phoneMoreItems = [],
  phoneTitle,
}: WorkspaceShellProps) {
  const phone = Boolean(phoneTabs?.length);
  const [moreOpen, setMoreOpen] = useState(false);
  // Collapsed/expanded survives reloads; read after mount so server and client render alike.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (window.localStorage.getItem(COLLAPSE_KEY) === "0") setOpen(false);
  }, []);
  function changeOpen(next: boolean) {
    setOpen(next);
    window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
  }
  return (
    <Sidebar.Provider
      className={`!block h-svh overflow-hidden bg-surface ${phone ? "max-lg:[--phone-tabbar-height:calc(3.75rem+env(safe-area-inset-bottom))]" : ""}`}
      collapsible="icon"
      navigate={onNavigate}
      open={open}
      onOpenChange={changeOpen}
      toggleShortcut={false}
    >
      <a
        href="#workspace-content"
        className="fixed left-4 top-3 z-[100] -translate-y-20 rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background focus:translate-y-0"
      >
        Skip to content
      </a>
      {/* Full-height app frame: the sidebar never scrolls; only the page area does. */}
      <div className="flex h-svh w-full overflow-hidden bg-surface">
        <Sidebar
          className={`!static !h-svh shrink-0 border-r border-separator bg-surface transition-[width] duration-300 ease-out ${phone ? "max-lg:!hidden" : ""}`}
          style={
            {
              "--sidebar-width": "var(--workspace-sidebar-width)",
            } as CSSProperties
          }
        >
          <DesktopHeader brand={brand} />
          <Sidebar.Content className="!px-2.5">
            <NavGroups groups={navGroups} activePrimaryId={activePrimaryId} />
          </Sidebar.Content>
          <UserFooter
            user={user}
            onSignOut={onSignOut}
            onAccount={onAccount}
            status={status}
          />
        </Sidebar>

        {phone ? null : (
          <Sidebar.Mobile backdrop="blur">
            <Heading slot="title" className="sr-only">
              Workspace navigation
            </Heading>
            <Sidebar.Header>
              <Brand brand={brand} />
            </Sidebar.Header>
            <Sidebar.Content>
              <NavGroups groups={navGroups} activePrimaryId={activePrimaryId} />
            </Sidebar.Content>
            <UserFooter
              user={user}
              onSignOut={onSignOut}
              onAccount={onAccount}
              status={status}
            />
          </Sidebar.Mobile>
        )}

        <Sidebar.Main
          id="workspace-scroll"
          className="!h-svh !min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-surface"
        >
          {phone ? (
            <PhoneTopBar brand={brand} title={phoneTitle} />
          ) : (
            <div className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-separator bg-surface/95 px-4 backdrop-blur md:hidden">
              <Brand brand={brand} />
              <Sidebar.Trigger
                aria-label="Open workspace navigation"
                isIconOnly
                variant="ghost"
              />
            </div>
          )}
          <main
            id="workspace-content"
            className={`w-full px-6 pt-5 ${
              phone
                ? "max-lg:pb-[calc(5rem+env(safe-area-inset-bottom))] max-sm:px-4 max-sm:pt-4 lg:pb-5 max-lg:pl-[max(1rem,env(safe-area-inset-left))] max-lg:pr-[max(1rem,env(safe-area-inset-right))]"
                : "pb-24 md:pb-5"
            } ${
              contentWidth === "full" ? "max-w-none" : "mx-auto max-w-[1440px]"
            }`}
          >
            {children}
          </main>
        </Sidebar.Main>
      </div>

      {phone ? (
        <PhoneTabBar
          tabs={phoneTabs ?? []}
          activePrimaryId={activePrimaryId}
          moreOpen={moreOpen}
          moreActive={phoneMoreItems.some(
            (item) => item.id === activePrimaryId,
          )}
          onNavigate={onNavigate}
          onMore={() => setMoreOpen(true)}
        />
      ) : null}
      {phone && moreOpen ? (
        <MoreSheet
          items={phoneMoreItems}
          activePrimaryId={activePrimaryId}
          user={user}
          onClose={() => setMoreOpen(false)}
          onNavigate={onNavigate}
          onAccount={onAccount}
          onSignOut={onSignOut}
        />
      ) : null}

      {!phone && mobilePrimaryItems.length ? (
        <nav
          aria-label="Primary field actions"
          className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-30 grid grid-cols-3 gap-1 rounded-lg border border-border bg-overlay/95 p-1.5 shadow-overlay backdrop-blur md:hidden"
        >
          {mobilePrimaryItems.slice(0, 3).map((item) => {
            const active = activeHref === item.href;
            return (
              <Button
                key={item.id}
                variant="ghost"
                className={`min-h-12 flex-col gap-1 px-2 text-xs ${active ? "bg-default text-foreground" : "text-muted"}`}
                onPress={() => onNavigate(item.href)}
              >
                <WorkspaceIcon name={item.icon} className="size-5" />
                {item.label}
              </Button>
            );
          })}
        </nav>
      ) : null}
    </Sidebar.Provider>
  );
}
