"use client";

import { useRef } from "react";
import { apiFetch, mutate, useApi, useLive, useApiStore } from "../../lib/api";
import type { QueryValue } from "../../lib/api/fetch";
import type { CommandArgs, CommandMap, CommandResult, ReadMap } from "./model";

// Explicit route catalogue. Group names preserve the editors' public form helpers, not
// a Convex client: every value is a Bun HTTP route and every DTO is locally owned.
export const api = {
  lib: { capabilities: { currentPermissions: "org/permissions" } },
  domains: {
    profiles: {
      current: "people/current",
      listInvitations: "people/invitations/list",
      invite: "people/invite",
      revoke: "people/revoke",
    },
    masterData: { customers: "catalog/customers/list" },
  },
  org: {
    queries: { tree: "org/tree", types: "org/types" },
    mutations: {
      create: "org/create",
      edit: "org/edit",
      reparent: "org/reparent",
      deactivate: "org/deactivate",
    },
  },
  people: {
    queries: {
      list: "people/list",
      history: "people/history",
      supervisorOptions: "people/supervisor-options",
    },
    mutations: { assign: "people/assign" },
  },
  teams: {
    queries: {
      list: "org/teams/list",
      detail: "org/teams/detail",
      memberHistory: "org/teams/member-history",
    },
    mutations: {
      create: "org/teams/create",
      addMember: "org/teams/addMember",
      removeMember: "org/teams/removeMember",
      deactivate: "org/teams/deactivate",
    },
  },
  territories: {
    queries: {
      list: "territories/list",
      detail: "territories/detail",
      ownershipHistory: "territories/ownership-history",
      salespeopleAt: "territories/salespeople-at",
    },
    mutations: {
      create: "territories/create",
      edit: "territories/edit",
      transferOwner: "territories/transferOwner",
      assignSalesperson: "territories/assignSalesperson",
      endSalespersonAssignment: "territories/endSalespersonAssignment",
      deactivate: "territories/deactivate",
    },
    routes: {
      list: "territories/routes/list",
      detail: "territories/routes/detail",
      history: "territories/routes/history",
      create: "territories/routes/create",
      edit: "territories/routes/edit",
      move: "territories/routes/move",
      duplicateTemplate: "territories/routes/duplicateTemplate",
      assignSalesperson: "territories/routes/assignSalesperson",
      endSalespersonAssignment: "territories/routes/endSalespersonAssignment",
      deactivate: "territories/routes/deactivate",
    },
  },
  outlets: {
    queries: {
      list: "outlets/list",
      detail: "outlets/detail",
      customerHistory: "outlets/customer-history",
      pinHistory: "outlets/pin-history",
    },
    mutations: {
      create: "outlets/create",
      edit: "outlets/edit",
      changeCustomerLink: "outlets/changeCustomerLink",
      deactivate: "outlets/deactivate",
    },
    verification: {
      propose: "outlets/pins/propose",
      decide: "outlets/pins/decide",
    },
    assignments: {
      assign: "outlets/assignments/assign",
      batchAssign: "outlets/assignments/batchAssign",
      reorder: "outlets/assignments/reorder",
      history: "outlets/assignments/history",
      routeStops: "outlets/assignments/route-stops",
      territoryRoster: "outlets/assignments/territory-roster",
      unassigned: "outlets/unassigned",
    },
    enrolment: {
      pending: "outlets/enrolment/pending",
      mine: "outlets/enrolment/mine",
      notifications: "outlets/enrolment/notifications",
      codeFormat: "outlets/enrolment/code-format",
      decide: "outlets/enrolment/decide",
    },
  },
  sfa: {
    positions: { list: "catalog/positions" },
    standards: { current: "catalog/standards" },
  },
  mobile: {
    devices: {
      list: "people/devices/list",
      lostDeviceReport: "people/devices/report",
      suspend: "people/devices/suspend",
      revoke: "people/devices/revoke",
      reinstate: "people/devices/reinstate",
    },
  },
} as const;
export type FunctionArgs<P extends keyof CommandMap> = CommandArgs<P>;
export { useOrgQuery as useQuery, useOrgMutation as useMutation };

/** All setup reads are keyed by their complete inputs; nested page options are JSON on the wire. */
export function orgQueryParams(input: Record<string, unknown>) {
  const query: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    query[key] =
      typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  return query;
}

export function useOrgQuery<P extends keyof ReadMap>(
  path: P,
  args: Record<string, unknown> | "skip",
): ReadMap[P] | undefined {
  const result = useApi<ReadMap[P]>(
    args === "skip" ? null : ["setup", path, args],
    ({ signal }) =>
      apiFetch(`/api/v1/${path}`, {
        query: orgQueryParams(args === "skip" ? {} : args),
        signal,
      }),
  );
  const topic =
    path === "people/current"
      ? "org"
      : path.startsWith("people/")
        ? "people"
        : path.startsWith("outlets/")
          ? "outlets"
          : path.startsWith("catalog/")
            ? "catalog"
            : "org";
  useLive(args === "skip" ? [] : [topic], [["setup"]]);
  if (result.error) throw result.error;
  return result.data;
}

/** Reuse a request key for the same failed intent, rotate only after confirmed success. */
export function useOrgMutation<P extends keyof CommandMap>(path: P) {
  const store = useApiStore();
  const intent = useRef<{ body: string; key: string } | null>(null);
  return async (body: CommandArgs<P>): Promise<CommandResult<P>> => {
    const serialized = JSON.stringify(body);
    if (!intent.current || intent.current.body !== serialized)
      intent.current = { body: serialized, key: crypto.randomUUID() };
    const result = await mutate<CommandResult<P>>(`/api/v1/${path}`, body, {
      idempotencyKey: intent.current.key,
      invalidate: [["setup"]],
      store,
    });
    intent.current = null;
    return result;
  };
}
