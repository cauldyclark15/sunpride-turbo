"use client";

import { Button, Input } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Doc, Id } from "@sunpride/backend/data-model";
import { EmptyPanel, StatusPill } from "@sunpride/ui";
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
const unitTypes = ["NATIONAL", "REGION", "AREA", "TERRITORY"];
const typeLabel = (code: string) =>
  code
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (c) => c.toUpperCase());
const fieldClass =
  "h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground";

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
    });
  }
  if (choice.action === "edit")
    return actions.edit({
      unitId,
      name: String(data.get("name") ?? "").trim(),
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
      setNotice(
        "Organization change saved. Future changes appear on their effective date.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  const children = (parentId?: Id<"orgUnits">) =>
    (units ?? []).filter((unit) => unit.parentId === parentId);
  function renderBranch(unit: Unit, depth: number) {
    return (
      <li key={unit._id} className="list-none">
        <div
          className="rounded-md border border-border bg-surface p-3"
          style={{ marginLeft: `${Math.min(depth, 8) * 16}px` }}
          data-depth={depth}
        >
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-sm text-foreground">{unit.name}</strong>
            <span className="text-xs text-muted">
              {unit.code} · {typeLabel(unit.typeCode)}
            </span>
            <StatusPill tone={unit.status === "active" ? "success" : "neutral"}>
              {unit.status}
            </StatusPill>
          </div>
          <p className="mt-1 text-xs text-muted">
            Effective {formatManilaDate(unit.effectiveFrom)}
            {unit.effectiveTo !== undefined
              ? ` – ${formatManilaDate(unit.effectiveTo)}`
              : " onward"}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["create", "edit", "reparent", "deactivate"] as const).map(
              (action) => (
                <Button
                  key={action}
                  size="sm"
                  variant="secondary"
                  isDisabled={
                    !canManage ||
                    !!previewDate ||
                    !(permissions?.scopeUnitIds.includes(unit._id) ?? false) ||
                    unit.status !== "active" ||
                    (action === "create" && unit.typeCode === "TERRITORY") ||
                    ((action === "reparent" || action === "deactivate") &&
                      unit.code === "SUNPRIDE")
                  }
                  onPress={() => {
                    setChoice({ unit, action });
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
        </div>
        {children(unit._id).length ? (
          <ul className="mt-2 grid gap-2">
            {children(unit._id).map((child) => renderBranch(child, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <section className="grid gap-5">
      <div>
        <h2 className="text-lg font-semibold">Organization hierarchy</h2>
        <p className="text-sm text-muted">
          {previewDate
            ? "Preview as of Manila midnight"
            : "Current effective tree"}{" "}
          · Dates shown in Manila time
        </p>
        <label className="mt-3 grid max-w-xs gap-1 text-sm">
          Preview as of date (Asia/Manila)
          <input
            type="date"
            className={fieldClass}
            value={previewDate}
            onChange={(event) => {
              const value = event.target.value;
              setPreviewDate(value);
              setAsOf(value ? manilaDateToUtcMs(value) : Date.now());
            }}
          />
        </label>
      </div>
      {units === undefined ? (
        <p>Loading organization…</p>
      ) : units.length === 0 ? (
        <EmptyPanel
          title="No organization units"
          description="The organization foundation has not been seeded."
        />
      ) : (
        <ul className="grid gap-2">
          {children().map((unit) => renderBranch(unit, 0))}
        </ul>
      )}
      {choice ? (
        <form
          onSubmit={submit}
          className="grid gap-3 rounded-lg border border-border bg-surface p-5"
        >
          <h3 className="font-semibold">
            {choice.action === "create"
              ? "Create child of"
              : choice.action === "edit"
                ? "Edit"
                : choice.action === "reparent"
                  ? "Reparent"
                  : "Deactivate"}{" "}
            {choice.unit.name}
          </h3>
          {choice.action === "create" ? (
            <>
              <label className="grid gap-1 text-sm">
                Code
                <Input name="code" required />
              </label>
              <label className="grid gap-1 text-sm">
                Name
                <Input name="name" required />
              </label>
              <label className="grid gap-1 text-sm">
                Unit type
                <select
                  name="typeCode"
                  required
                  className={fieldClass}
                  defaultValue=""
                >
                  <option value="" disabled>
                    Select a type
                  </option>
                  {unitTypes
                    .filter(
                      (type) =>
                        unitTypes.indexOf(type) >
                        unitTypes.indexOf(choice.unit.typeCode),
                    )
                    .map((type) => (
                      <option key={type} value={type}>
                        {typeLabel(type)}
                      </option>
                    ))}
                </select>
              </label>
            </>
          ) : choice.action === "edit" ? (
            <label className="grid gap-1 text-sm">
              Name
              <Input name="name" defaultValue={choice.unit.name} required />
            </label>
          ) : choice.action === "reparent" ? (
            <label className="grid gap-1 text-sm">
              New parent
              <select
                name="parentId"
                required
                className={fieldClass}
                defaultValue=""
              >
                <option value="" disabled>
                  Select a unit
                </option>
                {(units ?? [])
                  .filter(
                    (unit) =>
                      unit._id !== choice.unit._id &&
                      unit._id !== choice.unit.parentId &&
                      unit.status === "active" &&
                      unitTypes.indexOf(unit.typeCode) <
                        unitTypes.indexOf(choice.unit.typeCode),
                  )
                  .map((unit) => (
                    <option key={unit._id} value={unit._id}>
                      {unit.code} · {unit.name}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
          {choice.action !== "edit" ? (
            <label className="grid gap-1 text-sm">
              Effective date (Asia/Manila)
              <input
                className={fieldClass}
                type="date"
                name="effectiveDate"
                required
              />
            </label>
          ) : null}
          <label className="grid gap-1 text-sm">
            Reason (required)
            <textarea
              className="rounded-md border border-border bg-surface p-2"
              name="reason"
              required
              rows={2}
            />
          </label>
          <p className="text-xs text-muted">
            The server records the reason for reparenting and deactivation.
            Create and edit do not yet accept a reason in the backend API.
          </p>
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
            >
              Save change
            </Button>
            <Button
              type="button"
              variant="secondary"
              onPress={() => setChoice(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {error && !choice ? <p role="alert">{error}</p> : null}
      {notice ? (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
