"use client";

import { useState } from "react";
import { DataTable, FormField, type DataColumn } from "@sunpride/ui";
import { apiFetch, useApi } from "../../lib/api";
import { useSession } from "../../lib/auth/session";
import { formatDate, formatStatus, formatTime } from "../../lib/format";
import { downloadCsv } from "../../lib/import-csv-export";
import {
  activityLabel,
  REPORT_ROLES,
  SIGN_IN_APPS,
  SIGN_IN_ROLES,
  signInsCsv,
  type SignInPerson,
  type SignInsReport,
} from "./sign-ins-model";

type TablePerson = SignInPerson & { id: string };

export function SignInsView({ data }: { data: SignInsReport }) {
  const columns: DataColumn<TablePerson>[] = [
    { key: "name", label: "Name", render: (p) => p.name },
    { key: "role", label: "Role", render: (p) => formatStatus(p.role) },
    { key: "branch", label: "Branch", render: (p) => p.branch },
    {
      key: "apps",
      label: "Apps used",
      render: (p) =>
        p.apps.map((app) => SIGN_IN_APPS[app] ?? app).join(", ") || "—",
    },
    {
      key: "first",
      label: "First sign-in",
      render: (p) => formatTime(p.firstSignInAt),
    },
    { key: "last", label: "Last activity", render: activityLabel },
    {
      key: "count",
      label: "Sign-ins",
      align: "right",
      render: (p) => p.signIns,
    },
  ];
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {data.signedIn.length} people signed in · {data.didNotSignIn.length}{" "}
          active sales people did not sign in
        </p>
        <button
          type="button"
          className="h-10 rounded-lg border border-border px-4 text-sm disabled:opacity-50"
          onClick={() =>
            downloadCsv(`sign-ins-${data.date}.csv`, signInsCsv(data))
          }
        >
          Export CSV
        </button>
      </div>
      <section className="grid gap-3" aria-label="Signed in">
        <h2 className="text-base font-medium">
          Signed in · {formatDate(data.date)}
        </h2>
        <DataTable
          columns={columns}
          rows={data.signedIn.map((p) => ({ ...p, id: p.profileId }))}
          empty={
            <p className="text-sm text-muted">
              No sign-ins on this date. Try a different date or clear a filter.
            </p>
          }
        />
      </section>
      <section className="grid gap-3" aria-label="Did not sign in">
        <h2 className="text-base font-medium">Did not sign in</h2>
        <p className="text-sm text-muted">
          Active sales people with no new sign-in
          {data.app ? ` to ${SIGN_IN_APPS[data.app]}` : ""} on this date. People
          may still be signed in from an earlier day; this is not an attendance
          or online-status report.
        </p>
        <DataTable
          columns={columns.filter((c) =>
            ["name", "role", "branch", "last"].includes(c.key),
          )}
          rows={data.didNotSignIn.map((p) => ({ ...p, id: p.profileId }))}
          empty={
            <p className="text-sm text-muted">
              No active sales people without a sign-in match these filters.
            </p>
          }
        />
      </section>
      <p className="text-xs text-muted">
        All times are Manila time. Names, roles and branches reflect current
        assignments. Activity is the most recent online request, updated about
        once a minute, not time spent working. Older daily activity is not
        retained when a session is used on a later day; unavailable times are
        labelled, never estimated. Website records start October 19, 2026; Field
        records start November 14, 2026.
      </p>
    </div>
  );
}

export function SignIns({ date }: { date: string }) {
  const { profile, me } = useSession();
  const [orgUnitId, setUnit] = useState("");
  const [role, setRole] = useState("");
  const [app, setApp] = useState("");
  const allowed = SIGN_IN_ROLES.includes(profile?.role ?? "");
  const query = { date, orgUnitId, role, app };
  const result = useApi<SignInsReport>(
    allowed ? ["sign-ins", profile?.id, me?.scope?.fingerprint, query] : null,
    ({ signal }) => apiFetch("/api/v1/people/sign-ins", { query, signal }),
  );
  if (!allowed) return <p>Sign-ins are for administrators and managers.</p>;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <FormField label="Branch">
          <select
            aria-label="Sign-ins branch"
            value={orgUnitId}
            onChange={(e) => setUnit(e.target.value)}
          >
            <option value="">All branches in my access</option>
            {(result.error ? [] : result.data?.units)?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Role">
          <select
            aria-label="Sign-ins role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="">All roles</option>
            {REPORT_ROLES.map((r) => (
              <option key={r} value={r}>
                {formatStatus(r)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="App">
          <select
            aria-label="Sign-ins app"
            value={app}
            onChange={(e) => setApp(e.target.value)}
          >
            <option value="">All apps</option>
            {Object.entries(SIGN_IN_APPS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </FormField>
        <button
          type="button"
          className="h-10 rounded-lg border border-border px-4 text-sm disabled:opacity-50"
          onClick={() => void result.refetch()}
          disabled={result.isFetching}
        >
          Refresh
        </button>
      </div>
      {result.error ? (
        <p role="alert">{result.error.message}</p>
      ) : result.data ? (
        <SignInsView data={result.data} />
      ) : (
        <p role="status">Loading sign-ins…</p>
      )}
    </div>
  );
}
