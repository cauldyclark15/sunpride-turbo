"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Card, FormField, Pager } from "@sunpride/ui";
import { useQuery, useMutation } from "./master-data/api";
import { useSetupParam } from "./master-data/location";
import { SetupSearch } from "./master-data/setup-health";
import type { CustomerGroup } from "./master-data/model";

const button =
  "rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50";
export function CustomerGroupsAdmin() {
  const permissions = useQuery("org/permissions", {});
  const canRead = permissions?.capabilities.includes("territory.read") ?? false;
  const canManage =
    !!permissions?.national &&
    permissions.capabilities.includes("territory.manage");
  const missing = useSetupParam("missingCoverage");
  const [missingOnly, setMissingOnly] = useState(() => missing === "true");
  const [search, setSearch] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const [groupPages, setGroupPages] = useState<(string | null)[]>([null]);
  const [storePages, setStorePages] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<CustomerGroup | undefined>(
    undefined,
  );
  const [editing, setEditing] = useState<CustomerGroup | undefined>(undefined);
  const [showForm, setShowForm] = useState(false);
  const [onlyMembers, setOnlyMembers] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const groups = useQuery(
    "customer-groups/list",
    canRead
      ? {
          q: groupSearch,
          paginationOpts: { numItems: 25, cursor: groupPages.at(-1) },
        }
      : "skip",
  );
  const stores = useQuery(
    "outlets/list",
    canRead
      ? {
          q: search,
          status: "active",
          ...(onlyMembers && selected ? { customerGroupId: selected._id } : {}),
          ...(missingOnly ? { missingCoverage: "true" } : {}),
          paginationOpts: { numItems: 25, cursor: storePages.at(-1) },
        }
      : "skip",
  );
  const save = useMutation("customer-groups/save");
  const link = useMutation("customer-groups/link-stores");
  async function saveGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canManage) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await save({
        ...(editing
          ? { customerGroupId: editing._id }
          : { code: String(form.get("code") ?? "") }),
        name: String(form.get("name") ?? ""),
        reason: "Customer group saved in Setup",
      });
      setShowForm(false);
      setNotice(
        "Customer group saved. Choose Manage stores to link its stores.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function linkStores(remove = false) {
    if (!chosen.length || busy || !canManage || (!remove && !selected)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await link({
        outletIds: chosen,
        ...(!remove && selected ? { customerGroupId: selected._id } : {}),
        reason: remove
          ? "Store group removed in Setup"
          : "Stores linked to customer group in Setup",
      });
      setChosen([]);
      setNotice(
        remove
          ? "Selected stores removed from their groups. Location coverage applies unless manually assigned."
          : "Stores linked. Territory coverage has been updated; manual assignments still win.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card label="Customer groups">
      <div className="grid gap-4">
        <p>
          Chain or key-account groups, such as SM or Gaisano. These are separate
          from the customer classification lists. A group can cover stores in
          several cities or branches.
        </p>
        {!canRead ? (
          <p>Territory access required.</p>
        ) : (
          <>
            {canManage && (
              <button
                className={button}
                onClick={() => {
                  setEditing(undefined);
                  setShowForm(true);
                }}
              >
                Add customer group
              </button>
            )}
            {showForm && canManage && (
              <form
                key={editing?._id ?? "new"}
                className="grid gap-3"
                onSubmit={saveGroup}
              >
                {!editing && (
                  <FormField label="Group code">
                    <input name="code" required maxLength={40} />
                  </FormField>
                )}
                <FormField label="Group name">
                  <input
                    name="name"
                    required
                    maxLength={200}
                    defaultValue={editing?.name}
                  />
                </FormField>
                <div className="flex gap-2">
                  <button className={button} disabled={busy}>
                    Save group
                  </button>
                  <button
                    type="button"
                    className={button}
                    onClick={() => setShowForm(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            <SetupSearch
              label="Search customer groups"
              value={groupSearch}
              onChange={(value) => {
                setGroupSearch(value);
                setGroupPages([null]);
              }}
            />
            {!groups ? (
              <p>Loading customer groups…</p>
            ) : !groups.page.length ? (
              <p>No customer groups found.</p>
            ) : (
              <ul className="grid gap-2">
                {groups.page.map((group) => (
                  <li
                    key={group._id}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <span>
                      {group.name} · {group.code}
                    </span>
                    <button
                      className={button}
                      onClick={() => {
                        setSelected(group);
                        setChosen([]);
                        setOnlyMembers(true);
                        setMissingOnly(false);
                        setStorePages([null]);
                      }}
                    >
                      Manage stores
                    </button>
                    {canManage && (
                      <button
                        className={button}
                        onClick={() => {
                          setEditing(group);
                          setShowForm(true);
                        }}
                      >
                        Rename
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Pager
              label="Customer groups pages"
              page={groupPages.length}
              canPrevious={groupPages.length > 1}
              canNext={!!groups && !groups.isDone}
              onPrevious={() => setGroupPages((old) => old.slice(0, -1))}
              onNext={() =>
                groups &&
                setGroupPages((old) => [...old, groups.continueCursor])
              }
            />
            <h3>{selected ? `Stores for ${selected.name}` : "Stores"}</h3>
            <p>
              <Link href="/customers" className="underline">
                Open Customers to complete a store’s city or barangay.
              </Link>{" "}
              Link a store to a group below, then choose that group in Setup
              &gt; Territories.
            </p>
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={missingOnly}
                onChange={(e) => {
                  setMissingOnly(e.target.checked);
                  setStorePages([null]);
                  setChosen([]);
                }}
              />
              Only stores without a place or customer group
            </label>
            {selected && (
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={onlyMembers}
                  onChange={(e) => {
                    setOnlyMembers(e.target.checked);
                    setStorePages([null]);
                    setChosen([]);
                  }}
                />
                Only stores already in {selected.name} (uncheck to add stores)
              </label>
            )}
            <SetupSearch
              label="Search stores"
              value={search}
              onChange={(value) => {
                setSearch(value);
                setStorePages([null]);
              }}
            />
            {!stores ? (
              <p>Loading stores…</p>
            ) : !stores.page.length ? (
              <p>No stores match these choices.</p>
            ) : (
              <ul className="grid gap-2">
                {stores.page.map((store) => (
                  <li key={store._id} className="flex items-center gap-2">
                    {canManage && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${store.name}`}
                        checked={chosen.includes(store._id)}
                        onChange={(e) =>
                          setChosen((old) =>
                            e.target.checked
                              ? [...old, store._id]
                              : old.filter((id) => id !== store._id),
                          )
                        }
                      />
                    )}
                    <Link
                      className="underline"
                      href={`/customers?edit=${store._id}`}
                    >
                      {store.name} · {store.code}
                    </Link>
                    <span>
                      {store.customerGroupId === selected?._id && selected
                        ? selected.name
                        : store.customerGroupId
                          ? "Group linked"
                          : "No group"}{" "}
                      · {store.territoryName ?? "No territory"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Pager
              label="Group stores pages"
              page={storePages.length}
              canPrevious={storePages.length > 1}
              canNext={!!stores && !stores.isDone}
              onPrevious={() => setStorePages((old) => old.slice(0, -1))}
              onNext={() =>
                stores &&
                setStorePages((old) => [...old, stores.continueCursor])
              }
            />
            {canManage && (
              <div className="flex flex-wrap gap-2">
                <p>{chosen.length} stores selected (up to 100)</p>
                <button
                  className={button}
                  disabled={
                    !selected || !chosen.length || chosen.length > 100 || busy
                  }
                  onClick={() => linkStores()}
                >
                  Link selected stores
                  {selected
                    ? ` to ${selected.name}`
                    : " (choose a group first)"}
                </button>
                <button
                  className={button}
                  disabled={!chosen.length || chosen.length > 100 || busy}
                  onClick={() => linkStores(true)}
                >
                  Remove selected stores from groups
                </button>
              </div>
            )}
            {!canManage && (
              <p>
                A national administrator can maintain groups and their store
                links.
              </p>
            )}
          </>
        )}
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </div>
    </Card>
  );
}
