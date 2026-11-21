"use client";

import { useState } from "react";
import Link from "next/link";
import { FormField, Pager } from "@sunpride/ui";
import { useQuery } from "./master-data/api";
import { SetupSearch } from "./master-data/setup-health";
import type { Coverage, CoverageInput, ReadMap } from "./master-data/model";

export function readCoverageForm(data: Pick<FormData, "get">): CoverageInput {
  const raw = data.get("coverage");
  return raw ? (JSON.parse(String(raw)) as CoverageInput) : {};
}
const label = (row: {
  name: string;
  municipalityName?: string;
  provinceName?: string;
}) =>
  [row.name, row.municipalityName, row.provinceName]
    .filter(Boolean)
    .join(" · ");
const button = "rounded-lg border border-border px-3 py-2 text-sm";

export function TerritoryCoverageFields({
  initial,
}: {
  initial?: ReadMap["territories/detail"];
}) {
  const [type, setType] = useState(
    () => initial?.territory.territoryType ?? "location",
  );
  const [chosen, setChosen] = useState<Coverage[]>(
    () => initial?.coverage ?? [],
  );
  const [kind, setKind] = useState("municipality");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const places = useQuery(
    "territories/places",
    type === "location" && search.trim() ? { kind, q: search, offset } : "skip",
  );
  const groups = useQuery(
    "customer-groups/list",
    type === "customer_group"
      ? { q: search, paginationOpts: { numItems: 50, cursor: cursors.at(-1) } }
      : "skip",
  );
  const options: Coverage[] =
    type === "location"
      ? (places?.options ?? []).map((row) => ({
          ...row,
          _id: row.code,
          ...(kind === "municipality"
            ? { municipalityCode: row.code }
            : { barangayCode: row.code }),
        }))
      : (groups?.page ?? []).map((row) => ({
          ...row,
          customerGroupId: row._id,
        }));
  const value: CoverageInput = {
    territoryType: type,
    municipalityCodes: chosen.flatMap((r) =>
      r.municipalityCode ? [r.municipalityCode] : [],
    ),
    barangayCodes: chosen.flatMap((r) =>
      r.barangayCode ? [r.barangayCode] : [],
    ),
    customerGroupIds: chosen.flatMap((r) =>
      r.customerGroupId ? [r.customerGroupId] : [],
    ),
  };
  return (
    <fieldset className="grid min-w-0 grid-cols-1 gap-3 sm:col-span-2">
      <input type="hidden" name="coverage" value={JSON.stringify(value)} />
      <FormField label="Territory type">
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value as typeof type);
            setChosen([]);
            setSearch("");
            setOffset(0);
            setCursors([null]);
          }}
        >
          <option value="location">Location</option>
          <option value="customer_group">Customer group</option>
        </select>
      </FormField>
      <p className="text-sm text-muted">
        Stores fill in automatically. A manual store assignment wins. Customer
        groups take priority over location; a barangay takes priority over its
        whole city. Either type can serve Food Service.
      </p>
      {type === "location" && (
        <FormField label="Place type">
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setOffset(0);
            }}
          >
            <option value="municipality">City / Municipality</option>
            <option value="barangay">Barangay</option>
          </select>
        </FormField>
      )}
      <FormField
        label={
          type === "location"
            ? "Search Philippine places"
            : "Search customer groups"
        }
      >
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
            setCursors([null]);
          }}
          placeholder={
            type === "location"
              ? "Cebu, Mandaue, Lapu-Lapu or Guadalupe"
              : "SM or Gaisano"
          }
        />
      </FormField>
      {type === "location" && !search.trim() ? (
        <p>Type a city, municipality or barangay name to find it.</p>
      ) : !places && !groups ? (
        <p>Loading choices…</p>
      ) : options.length === 0 ? (
        <p>No matches found.</p>
      ) : (
        <ul className="grid max-h-60 gap-2 overflow-auto">
          {options.map((row) => {
            const exists = chosen.some(
              (r) =>
                (r.municipalityCode ?? r.barangayCode ?? r.customerGroupId) ===
                row._id,
            );
            return (
              <li
                key={row._id}
                className="flex items-center justify-between gap-2"
              >
                <span>{label(row)}</span>
                <button
                  type="button"
                  className={button}
                  disabled={exists}
                  onClick={() => setChosen((old) => [...old, row])}
                >
                  {exists ? "Added" : "Add"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Pager
        label="Coverage choices pages"
        page={type === "location" ? offset / 50 + 1 : cursors.length}
        canPrevious={type === "location" ? offset > 0 : cursors.length > 1}
        canNext={
          type === "location" ? !!places?.hasMore : !!groups && !groups.isDone
        }
        onPrevious={() =>
          type === "location"
            ? setOffset((n) => Math.max(0, n - 50))
            : setCursors((old) => old.slice(0, -1))
        }
        onNext={() =>
          type === "location"
            ? setOffset((n) => n + 50)
            : groups && setCursors((old) => [...old, groups.continueCursor])
        }
      />
      <h4>Selected {type === "location" ? "places" : "groups"}</h4>
      <ul className="grid gap-2">
        {chosen.map((row) => (
          <li key={row._id} className="flex items-center justify-between gap-2">
            <span>{label(row)}</span>
            <button
              type="button"
              className={button}
              aria-label={`Remove ${label(row)}`}
              onClick={() =>
                setChosen((old) => old.filter((r) => r._id !== row._id))
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {!chosen.length && (
        <p>
          No places or groups selected. Manual assignments will keep working.
        </p>
      )}
      {type === "customer_group" && (
        <Link className="underline" href="/admin?section=customer-groups">
          Add a group or link its stores in Setup &gt; Customer groups
        </Link>
      )}
    </fieldset>
  );
}

/** SP-0222: store-list read for the territory/group pickers; typing searches name, code,
 * city/barangay and territory (not the address province, which matched every store). */
export function storeListArgs(
  search: string,
  cursor: string | null,
  filters: Record<string, unknown> = {},
) {
  return {
    ...filters,
    q: search.trim(),
    searchIn: "store",
    status: "active",
    paginationOpts: { numItems: 25, cursor },
  };
}

export function TerritoryStores({ territoryId }: { territoryId: string }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  // Lazy initial value: sibling tests count plain useState("") calls by position.
  const [search, setSearch] = useState(() => "");
  const stores = useQuery(
    "outlets/list",
    storeListArgs(search, cursors.at(-1) ?? null, { territoryId }),
  );
  return (
    <section className="grid gap-2">
      <h4>Stores in this territory</h4>
      <SetupSearch
        label="Search stores"
        value={search}
        onChange={(value) => {
          setSearch(value);
          setCursors([null]);
        }}
      />
      {!stores ? (
        <p>Loading stores…</p>
      ) : !stores.page.length ? (
        <p>{search ? "No stores match this search." : "No active stores here yet."}</p>
      ) : (
        <ul>
          {stores.page.map((row) => (
            <li key={row._id}>
              <Link className="underline" href={`/customers?edit=${row._id}`}>
                {row.name} · {row.code}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Pager
        label="Territory stores pages"
        page={cursors.length}
        canPrevious={cursors.length > 1}
        canNext={!!stores && !stores.isDone}
        onPrevious={() => setCursors((old) => old.slice(0, -1))}
        onNext={() =>
          stores && setCursors((old) => [...old, stores.continueCursor])
        }
      />
    </section>
  );
}
