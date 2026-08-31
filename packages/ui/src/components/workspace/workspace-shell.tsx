"use client";

import { Button } from "@heroui/react/button";
import { Dropdown } from "@heroui/react/dropdown";
import { Label } from "@heroui/react/label";
import { Sidebar } from "@heroui-pro/react/sidebar";
import type { CSSProperties, ReactNode } from "react";
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
  status?: ReactNode;
  user?: WorkspaceUser;
};

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
  return groups.map((group) => (
    <Sidebar.Group key={group.id}>
      {group.label ? (
        <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
      ) : null}
      <Sidebar.Menu aria-label={group.label ?? "Workspace navigation"}>
        {group.items.map((item) => (
          <Sidebar.MenuItem
            key={item.id}
            id={item.id}
            href={item.href}
            isCurrent={activePrimaryId === item.id}
            textValue={item.label}
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
  status,
}: {
  user?: WorkspaceUser;
  onSignOut: () => void | Promise<void>;
  status?: ReactNode;
}) {
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
            className="h-auto min-h-0 justify-start gap-3 px-2 py-2 text-left"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-secondary text-sm font-semibold text-foreground">
              {user.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0" data-sidebar="label">
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
              }}
            >
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
  status,
  user,
}: WorkspaceShellProps) {
  return (
    <Sidebar.Provider
      className="!block min-h-svh bg-background"
      collapsible="icon"
      navigate={onNavigate}
      toggleShortcut={false}
    >
      <a
        href="#workspace-content"
        className="fixed left-4 top-3 z-[100] -translate-y-20 rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background focus:translate-y-0"
      >
        Skip to content
      </a>
      <div className="flex min-h-svh">
        <Sidebar
          className="!sticky !top-0 !h-svh border-r border-separator bg-background"
          style={
            {
              "--sidebar-width": "var(--workspace-sidebar-width)",
            } as CSSProperties
          }
        >
          <Sidebar.Header className="!px-4 !pb-4 !pt-5">
            <Brand brand={brand} />
          </Sidebar.Header>
          <Sidebar.Content className="!px-2.5">
            <NavGroups groups={navGroups} activePrimaryId={activePrimaryId} />
          </Sidebar.Content>
          <UserFooter user={user} onSignOut={onSignOut} status={status} />
        </Sidebar>

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
          <UserFooter user={user} onSignOut={onSignOut} status={status} />
        </Sidebar.Mobile>

        <Sidebar.Main className="!min-h-svh min-w-0 bg-surface">
          <div className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-separator bg-surface/95 px-4 backdrop-blur md:hidden">
            <Brand brand={brand} />
            <Sidebar.Trigger
              aria-label="Open workspace navigation"
              isIconOnly
              variant="ghost"
            />
          </div>
          <main
            id="workspace-content"
            className={`w-full px-4 pb-24 pt-7 sm:px-7 md:pb-10 md:pt-8 lg:px-10 ${
              contentWidth === "full" ? "max-w-none" : "mx-auto max-w-[1440px]"
            }`}
          >
            {children}
          </main>
        </Sidebar.Main>
      </div>

      {mobilePrimaryItems.length ? (
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
