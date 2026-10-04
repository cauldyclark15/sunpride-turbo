"use client";

import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  DataTable,
  ListRow,
  Notice,
  Pager,
  StatusPill,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useState, type FormEvent } from "react";
import { AdminSelectField } from "./org-admin";

export type DeviceAction = "suspend" | "revoke" | "reinstate";
type DeviceStatus = "active" | "suspended" | "revoked";
type DeviceMutations = {
  suspend: (
    args: FunctionArgs<typeof api.mobile.devices.suspend>,
  ) => Promise<unknown>;
  revoke: (
    args: FunctionArgs<typeof api.mobile.devices.revoke>,
  ) => Promise<unknown>;
  reinstate: (
    args: FunctionArgs<typeof api.mobile.devices.reinstate>,
  ) => Promise<unknown>;
};

/** Reason codes mirror `convex/mobile/devices.ts`; the server stays authoritative. */
export const deviceReasons: Record<
  DeviceAction,
  { id: string; label: string }[]
> = {
  suspend: [
    { id: "lost", label: "Lost" },
    { id: "stolen", label: "Stolen" },
    { id: "suspected_compromise", label: "Suspected compromise" },
    { id: "other", label: "Other" },
  ],
  revoke: [
    { id: "lost", label: "Lost" },
    { id: "stolen", label: "Stolen" },
    { id: "suspected_compromise", label: "Suspected compromise" },
    { id: "replacement", label: "Replaced by a new phone" },
    { id: "transfer", label: "Employee transferred" },
    { id: "decommissioned", label: "Retired" },
    { id: "other", label: "Other" },
  ],
  reinstate: [
    { id: "found", label: "Found" },
    { id: "other", label: "Other" },
  ],
};

const actionLabel: Record<DeviceAction, string> = {
  suspend: "Suspend phone",
  revoke: "Revoke phone",
  reinstate: "Reinstate phone",
};

export function deviceActionsFor(status: DeviceStatus): DeviceAction[] {
  if (status === "active") return ["suspend", "revoke"];
  if (status === "suspended") return ["reinstate", "revoke"];
  return [];
}

export async function performDeviceAction(
  action: DeviceAction,
  deviceId: Id<"registeredDevices">,
  reason: string,
  mutations: DeviceMutations,
) {
  if (!deviceReasons[action].some((option) => option.id === reason))
    throw new Error("Choose a reason");
  if (action === "suspend") return mutations.suspend({ deviceId, reason });
  if (action === "revoke") return mutations.revoke({ deviceId, reason });
  return mutations.reinstate({ deviceId, reason });
}

export function formatManilaDateTime(value: number | null): string {
  if (value === null) return "Never";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

const statusTone = (status: DeviceStatus) =>
  status === "active"
    ? ("success" as const)
    : status === "suspended"
      ? ("warning" as const)
      : ("danger" as const);

const historyLabel: Record<string, string> = {
  "device.registered": "Registered",
  "device.bound": "Signed in on phone",
  "device.suspended": "Suspended",
  "device.reinstated": "Reinstated",
  "device.revoked": "Revoked",
};

const operationLabel: Record<string, string> = {
  "visit.checkIn": "Check-in",
  "visit.activity": "Visit activity",
  "visit.checkOut": "Check-out",
  "task.complete": "Task completed",
  "collection.record": "Collection",
};

export function DevicesAdmin() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const canManage = permissions?.capabilities.includes("admin.manage") ?? false;
  const [statusFilter, setStatusFilter] = useState<DeviceStatus | "all">("all");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const devices = useQuery(
    api.mobile.devices.list,
    canManage
      ? {
          paginationOpts: {
            numItems: 25,
            cursor: cursors[cursors.length - 1] ?? null,
          },
          ...(statusFilter === "all" ? {} : { status: statusFilter }),
        }
      : "skip",
  );
  const [selectedId, setSelectedId] = useState<Id<"registeredDevices"> | null>(
    null,
  );
  const report = useQuery(
    api.mobile.devices.lostDeviceReport,
    canManage && selectedId ? { deviceId: selectedId } : "skip",
  );
  const suspend = useMutation(api.mobile.devices.suspend);
  const revoke = useMutation(api.mobile.devices.revoke);
  const reinstate = useMutation(api.mobile.devices.reinstate);
  const [action, setAction] = useState<DeviceAction | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);

  if (permissions === undefined)
    return <Card label="Phones">Loading access…</Card>;
  if (!canManage)
    return (
      <Card label="Phones">
        <Notice title="Administrator access required" tone="warning" />
      </Card>
    );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || !selectedId || pending) return;
    setError("");
    setNotice("");
    setPending(true);
    try {
      await performDeviceAction(action, selectedId, reason, {
        suspend,
        revoke,
        reinstate,
      });
      setNotice(
        action === "reinstate"
          ? "Phone reinstated"
          : action === "suspend"
            ? "Phone suspended"
            : "Phone revoked",
      );
      setAction(null);
      setReason("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  const rows = (devices?.page ?? []).map((device) => ({
    ...device,
    id: device.deviceId,
  }));
  const columns: DataColumn<(typeof rows)[number]>[] = [
    {
      key: "phone",
      label: "Phone",
      render: (row) => (
        <span className="block">
          <span className="block font-mono text-sm">{row.inventoryTag}</span>
          <span className="block text-xs text-muted">
            {row.platform} · {row.model}
          </span>
        </span>
      ),
    },
    {
      key: "person",
      label: "Person",
      render: (row) => row.employeeName ?? "Unassigned",
    },
    {
      key: "status",
      label: "Status",
      render: (row) => (
        <span className="whitespace-nowrap">
          <StatusPill tone={statusTone(row.status)}>{row.status}</StatusPill>
        </span>
      ),
    },
    {
      key: "lastSeen",
      label: "Last contact",
      render: (row) => formatManilaDateTime(row.lastSeenAt),
    },
    {
      key: "actions",
      label: "Actions",
      align: "right",
      render: (row) => (
        <Button
          size="sm"
          variant="outline"
          className="h-8 whitespace-nowrap"
          onPress={() => {
            setSelectedId(row.deviceId);
            setAction(null);
            setReason("");
            setError("");
            setNotice("");
          }}
        >
          View phone
        </Button>
      ),
    },
  ];

  const device = report?.device;
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
      <Card
        label="Phones"
        icon={<WorkspaceIcon name="mobile" />}
        count={devices?.page.length}
        flush
      >
        <div className="border-b border-separator p-4">
          <AdminSelectField
            label="Status"
            value={statusFilter}
            onChange={(value) => {
              setStatusFilter((value || "all") as DeviceStatus | "all");
              setCursors([null]);
            }}
            options={[
              { id: "all", label: "All phones" },
              { id: "active", label: "Active" },
              { id: "suspended", label: "Suspended" },
              { id: "revoked", label: "Revoked" },
            ]}
          />
        </div>
        {devices === undefined ? (
          <p className="p-4 text-sm text-muted">Loading phones…</p>
        ) : (
          <DataTable
            bare
            rows={rows}
            columns={columns}
            empty={
              <p className="p-4 text-sm text-muted">
                {devices.isDone
                  ? "No phones"
                  : "No phones on this page. Try the next page."}
              </p>
            }
          />
        )}
        <Pager
          label="Phone pages"
          page={cursors.length}
          canPrevious={cursors.length > 1}
          canNext={!!devices && !devices.isDone}
          onPrevious={() => setCursors((old) => old.slice(0, -1))}
          onNext={() => {
            if (devices && !devices.isDone)
              setCursors((old) => [...old, devices.continueCursor]);
          }}
        />
      </Card>
      {selectedId ? (
        report === undefined || !device ? (
          <Card label="Phone">Loading phone…</Card>
        ) : (
          <Card label={`Phone ${device.inventoryTag}`}>
            <aside aria-label="Phone detail" className="grid gap-4">
              <p className="text-[13px] text-muted">
                {device.employeeName ?? "Unassigned"} · {device.platform}{" "}
                {device.osVersion} · app {device.appVersion}
              </p>
              <div className="flex items-center gap-2">
                <StatusPill tone={statusTone(device.status)}>
                  {device.status}
                </StatusPill>
                {device.statusReason && device.status !== "active" ? (
                  <span className="text-[13px] text-muted">
                    {device.statusReason.replaceAll("_", " ")} ·{" "}
                    {formatManilaDateTime(device.statusAt)}
                  </span>
                ) : null}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
                <dt className="text-muted">Last contact</dt>
                <dd>{formatManilaDateTime(device.lastSeenAt)}</dd>
                <dt className="text-muted">Last upload received</dt>
                <dd>{formatManilaDateTime(report.lastAcknowledgedAt)}</dd>
                <dt className="text-muted">Offline access until</dt>
                <dd>{formatManilaDateTime(device.offlineLeaseExpiresAt)}</dd>
              </dl>
              {device.status !== "active" ? (
                <p className="rounded-xl bg-warning-soft p-3 text-[13px] text-warning-soft-foreground">
                  The server now refuses this phone. Anything recorded on it
                  after {formatManilaDateTime(device.lastSeenAt)} has not
                  reached the server and cannot be recovered from here. Record
                  missing visits through the supervisor process.
                </p>
              ) : null}
              <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted">
                Received from this phone
              </h4>
              {report.acknowledged.length === 0 ? (
                <p className="text-sm text-muted">Nothing received yet</p>
              ) : (
                <div className="-mx-4 border-y border-separator">
                  {report.acknowledged.map((ack) => (
                    <ListRow
                      key={`${ack.kind}:${ack.clientRequestId}`}
                      icon={<WorkspaceIcon name="sync" />}
                      title={operationLabel[ack.kind] ?? ack.kind}
                      meta={formatManilaDateTime(ack.serverAt)}
                    />
                  ))}
                  {report.acknowledgedMore ? (
                    <p className="p-3 text-xs text-muted">
                      Showing the latest {report.acknowledged.length}
                    </p>
                  ) : null}
                </div>
              )}
              <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted">
                History
              </h4>
              <div className="-mx-4 border-y border-separator">
                {report.history.map((entry) => (
                  <ListRow
                    key={`${entry.action}:${entry.at}`}
                    icon={<WorkspaceIcon name="queue" />}
                    title={historyLabel[entry.action] ?? entry.action}
                    meta={[
                      formatManilaDateTime(entry.at),
                      entry.actorName ?? "Former user",
                      ...(entry.reason &&
                      !["registered", "bound"].includes(entry.reason)
                        ? [entry.reason.replaceAll("_", " ")]
                        : []),
                    ].join(" · ")}
                  />
                ))}
              </div>
              {deviceActionsFor(device.status).length ? (
                <div className="flex flex-wrap gap-2">
                  {deviceActionsFor(device.status).map((next) => (
                    <Button
                      key={next}
                      variant="outline"
                      onPress={() => {
                        setAction(next);
                        setReason("");
                        setError("");
                      }}
                    >
                      {actionLabel[next]}
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="text-[13px] text-muted">
                  A revoked phone stays revoked. Enroll a replacement.
                </p>
              )}
              {action ? (
                <form
                  aria-label={actionLabel[action]}
                  onSubmit={submit}
                  className="grid gap-3"
                >
                  <AdminSelectField
                    label="Reason"
                    value={reason}
                    onChange={setReason}
                    options={[
                      { id: "", label: "Choose a reason" },
                      ...deviceReasons[action],
                    ]}
                  />
                  {action === "revoke" ? (
                    <p className="text-[13px] text-muted">
                      Revoking is permanent. Suspend instead if the phone may
                      turn up.
                    </p>
                  ) : null}
                  <div className="flex gap-2">
                    <Button type="submit" variant="primary" isPending={pending}>
                      {actionLabel[action]}
                    </Button>
                    <Button variant="outline" onPress={() => setAction(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : null}
              {error ? (
                <p
                  role="alert"
                  className="rounded-xl bg-danger-soft p-3 text-sm text-danger-soft-foreground"
                >
                  {error}
                </p>
              ) : null}
              {notice ? (
                <p
                  role="status"
                  className="rounded-xl bg-success-soft p-3 text-sm text-success-soft-foreground"
                >
                  {notice}
                </p>
              ) : null}
            </aside>
          </Card>
        )
      ) : null}
    </div>
  );
}
