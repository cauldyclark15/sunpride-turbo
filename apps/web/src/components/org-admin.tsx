"use client";

import { Button, Input, ListBox, Select } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Doc, Id } from "@sunpride/backend/data-model";
import {
  Card,
  DataTable,
  EmptyPanel,
  FormField,
  StatusPill,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useState, type FormEvent } from "react";
import {
  formatManilaDate,
  futureManilaDateToUtcMs,
  manilaDateToUtcMs,
} from "../lib/manila-date";

type Unit = Doc<"orgUnits">;
type Action = "create" | "edit" | "reparent" | "deactivate";
const typeLabel = (code: string) =>
  code
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (c) => c.toUpperCase());

/** Select keeps the submitted form value while using the HeroUI popover. */
export function AdminSelectField({
  name,
  label,
  value,
  defaultValue = "",
  onChange,
  options,
  required = false,
}: {
  name?: string;
  label: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  options: { id: string; label: string }[];
  required?: boolean;
}) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const selected = value ?? internalValue;
  return (
    <FormField label={label}>
      {name ? <input type="hidden" name={name} value={selected} /> : null}
      <Select
        aria-label={label}
        selectedKey={selected || "__none"}
        isRequired={required}
        onSelectionChange={(key) => {
          const next = key === "__none" ? "" : String(key ?? "");
          setInternalValue(next);
          onChange?.(next);
        }}
      >
        <Select.Trigger className="h-10 min-h-10 rounded-[10px] !border !border-border bg-surface px-3 text-sm shadow-none">
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {options.map((option) => (
              <ListBox.Item
                key={option.id || "__none"}
                id={option.id || "__none"}
                textValue={option.label}
              >
                {option.label}
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </FormField>
  );
}

type OrgActions = {
  create: (
    args: FunctionArgs<typeof api.org.mutations.create>,
  ) => Promise<unknown>;
  edit: (args: FunctionArgs<typeof api.org.mutations.edit>) => Promise<unknown>;
  reparent: (
    args: FunctionArgs<typeof api.org.mutations.reparent>,
  ) => Promise<unknown>;
  deactivate: (
    args: FunctionArgs<typeof api.org.mutations.deactivate>,
  ) => Promise<unknown>;
};

/** Keep mutation arguments and date interpretation in one testable boundary. */
export async function performOrgAction(
  choice: { unit: Unit; action: Action },
  data: Pick<FormData, "get">,
  actions: OrgActions,
) {
  const reason = String(data.get("reason") ?? "").trim();
  if (!reason) throw new Error("Reason required");
  const unitId = choice.unit._id;
  if (choice.action === "create") {
    return actions.create({
      parentId: unitId,
      code: String(data.get("code") ?? "").trim(),
      name: String(data.get("name") ?? "").trim(),
      typeCode: String(data.get("typeCode") ?? ""),
      effectiveFrom: futureManilaDateToUtcMs(
        String(data.get("effectiveDate") ?? ""),
      ),
      reason,
    });
  }
  if (choice.action === "edit")
    return actions.edit({
      unitId,
      name: String(data.get("name") ?? "").trim(),
      reason,
    });
  if (choice.action === "reparent")
    return actions.reparent({
      unitId,
      parentId: String(data.get("parentId")) as Id<"orgUnits">,
      effectiveFrom: futureManilaDateToUtcMs(
        String(data.get("effectiveDate") ?? ""),
      ),
      reason,
    });
  return actions.deactivate({
    unitId,
    effectiveTo: futureManilaDateToUtcMs(
      String(data.get("effectiveDate") ?? ""),
    ),
    reason,
  });
}

export function OrgAdmin() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const canManage = permissions?.capabilities.includes("admin.manage") ?? false;
  const [asOf, setAsOf] = useState(() => Date.now());
  const [previewDate, setPreviewDate] = useState("");
  const units = useQuery(api.org.queries.tree, { asOf });
  const unitTypes = useQuery(api.org.queries.types, {});
  const create = useMutation(api.org.mutations.create);
  const edit = useMutation(api.org.mutations.edit);
  const reparent = useMutation(api.org.mutations.reparent);
  const deactivate = useMutation(api.org.mutations.deactivate);
  const [choice, setChoice] = useState<{ unit: Unit; action: Action } | null>(
    null,
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!choice || !canManage || pending) return;
    setError("");
    setNotice("");
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    try {
      await performOrgAction(choice, data, {
        create,
        edit,
        reparent,
        deactivate,
      });
      setChoice(null);
      setAsOf(previewDate ? manilaDateToUtcMs(previewDate) : Date.now());
      setNotice("Organization saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  const levelOf = (code: string) =>
    unitTypes?.find((type) => type.code === code)?.level;
  const [typeCode, setTypeCode] = useState("");
  const [parentId, setParentId] = useState("");
  const depthOf = (unit: Unit): number => {
    if (!unit.parentId) return 0;
    const parent = units?.find((candidate) => candidate._id === unit.parentId);
    return parent ? 1 + depthOf(parent) : 0;
  };
  const createParent = (units ?? []).find(
    (unit) =>
      unit.status === "active" &&
      (permissions?.scopeUnitIds.includes(unit._id) ?? false) &&
      (unitTypes ?? []).some(
        (type) =>
          levelOf(unit.typeCode) !== undefined &&
          type.level > levelOf(unit.typeCode)!,
      ),
  );
  const orderedUnits = (parentId?: Id<"orgUnits">): Unit[] =>
    (units ?? [])
      .filter((unit) => unit.parentId === parentId)
      .flatMap((unit) => [unit, ...orderedUnits(unit._id)]);
  const rows = orderedUnits().map((unit) => ({
    ...unit,
    id: unit._id,
    depth: depthOf(unit),
  }));
  const columns: DataColumn<Unit & { id: string; depth: number }>[] = [
    {
      key: "name",
      label: "Unit",
      render: (row) => (
        <div
          data-depth={row.depth}
          style={{ paddingLeft: `${Math.min(row.depth, 8) * 16}px` }}
        >
          <span className="block text-sm font-medium">{row.name}</span>
          <span className="block font-mono text-xs text-muted">
            {row.code} · {typeLabel(row.typeCode)}
          </span>
        </div>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (row) => (
        <StatusPill tone={row.status === "active" ? "success" : "neutral"}>
          {row.status}
        </StatusPill>
      ),
    },
    {
      key: "effective",
      label: "Effective",
      render: (row) => (
        <span className="whitespace-nowrap text-xs text-muted">
          {formatManilaDate(row.effectiveFrom)}
          {row.effectiveTo !== undefined
            ? ` – ${formatManilaDate(row.effectiveTo)}`
            : " onward"}
        </span>
      ),
    },
    {
      key: "actions",
      label: "Actions",
      align: "right",
      render: (row) => (
        <div className="flex flex-nowrap justify-end gap-2">
          {(["create", "edit", "reparent", "deactivate"] as const).map(
            (action) => (
              <Button
                key={action}
                size="sm"
                variant={action === "deactivate" ? "danger-soft" : "outline"}
                isDisabled={
                  !canManage ||
                  !!previewDate ||
                  !(permissions?.scopeUnitIds.includes(row._id) ?? false) ||
                  row.status !== "active" ||
                  (action === "create" &&
                    !(unitTypes ?? []).some(
                      (type) =>
                        levelOf(row.typeCode) !== undefined &&
                        type.level > levelOf(row.typeCode)!,
                    )) ||
                  ((action === "reparent" || action === "deactivate") &&
                    row.code === "SUNPRIDE")
                }
                onPress={() => {
                  setChoice({ unit: row, action });
                  setTypeCode("");
                  setParentId("");
                  setError("");
                  setNotice("");
                }}
              >
                {action === "create"
                  ? "Create child"
                  : action === "edit"
                    ? "Edit name"
                    : action === "reparent"
                      ? "Reparent"
                      : "Deactivate"}
              </Button>
            ),
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="grid gap-4">
      <Card
        label="Organization"
        icon={<WorkspaceIcon name="admin" />}
        count={units?.length}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-muted">As of</span>
            <input
              type="date"
              aria-label="Preview date"
              value={previewDate}
              onChange={(event) => {
                const value = event.target.value;
                setPreviewDate(value);
                setAsOf(value ? manilaDateToUtcMs(value) : Date.now());
              }}
            />
            <Button
              variant="primary"
              isDisabled={!canManage || !!previewDate || !createParent}
              onPress={() => {
                if (!createParent) return;
                setChoice({ unit: createParent, action: "create" });
                setTypeCode("");
                setError("");
                setNotice("");
              }}
            >
              New unit
            </Button>
          </div>
        }
        flush
      >
        {units === undefined ? (
          <p className="p-4 text-sm text-muted">Loading organization…</p>
        ) : (
          <DataTable
            bare
            rows={rows}
            columns={columns}
            empty={<EmptyPanel title="No units" />}
          />
        )}
      </Card>
      {choice ? (
        <Card
          label={`${choice.action === "create" ? "New unit" : choice.action === "edit" ? "Edit unit" : choice.action === "reparent" ? "Move unit" : "Deactivate unit"} · ${choice.unit.name}`}
        >
          <form
            onSubmit={submit}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            {choice.action === "create" ? (
              <>
                <FormField label="Code">
                  <Input name="code" required />
                </FormField>
                <FormField label="Name">
                  <Input name="name" required />
                </FormField>
                <AdminSelectField
                  name="typeCode"
                  label="Unit type"
                  value={typeCode}
                  onChange={setTypeCode}
                  required
                  options={[
                    { id: "", label: "Select a type" },
                    ...(unitTypes ?? [])
                      .filter(
                        (type) =>
                          levelOf(choice.unit.typeCode) !== undefined &&
                          type.level > levelOf(choice.unit.typeCode)!,
                      )
                      .map((type) => ({ id: type.code, label: type.label })),
                  ]}
                />
              </>
            ) : choice.action === "edit" ? (
              <FormField label="Name">
                <Input name="name" defaultValue={choice.unit.name} required />
              </FormField>
            ) : choice.action === "reparent" ? (
              <AdminSelectField
                name="parentId"
                label="New parent"
                value={parentId}
                onChange={setParentId}
                required
                options={[
                  { id: "", label: "Select a unit" },
                  ...(units ?? [])
                    .filter(
                      (unit) =>
                        unit._id !== choice.unit._id &&
                        unit._id !== choice.unit.parentId &&
                        unit.status === "active" &&
                        levelOf(unit.typeCode) !== undefined &&
                        levelOf(choice.unit.typeCode) !== undefined &&
                        levelOf(unit.typeCode)! <
                          levelOf(choice.unit.typeCode)!,
                    )
                    .map((unit) => ({
                      id: unit._id,
                      label: `${unit.code} · ${unit.name}`,
                    })),
                ]}
              />
            ) : null}
            {choice.action !== "edit" ? (
              <FormField label="Effective date">
                <input type="date" name="effectiveDate" required />
              </FormField>
            ) : null}
            <FormField label="Reason">
              <textarea
                className="min-h-20 rounded-[10px] border border-border bg-surface p-3 text-sm"
                name="reason"
                required
                rows={2}
              />
            </FormField>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="primary"
                isDisabled={!canManage}
                isPending={pending}
                className="h-10"
              >
                Save change
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="h-10"
                onPress={() => setChoice(null)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
      {error && !choice ? (
        <Card label="Error">
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        </Card>
      ) : null}
      {notice ? (
        <Card label="Status">
          <p role="status" className="text-sm text-success">
            {notice}
          </p>
        </Card>
      ) : null}
    </div>
  );
}
