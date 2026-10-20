"use client";
import { useState } from "react";
import type { Command, Partner, Policy } from "./types";
import {
  ActionForm,
  Cell,
  Field,
  fieldClass,
  fileInput,
  manilaToday,
  number,
  Panel,
  State,
  Table,
  usePartnerQuery,
  value,
  when,
  words,
} from "./kit";

type SetupData = {
  distributor: Partner;
  master: {
    version: number;
    source: string;
    source_key: string;
    received_at: string;
    payload: Record<string, unknown>;
  } | null;
  policy: { version: number; settings: Policy } | null;
  users: {
    id: string;
    name: string;
    email: string;
    grants: string[];
    effective_to: string | null;
  }[];
  usersTruncated: boolean;
};
const GRANTS = [
  "read",
  "order",
  "stock",
  "secondary",
  "claim",
  "finance",
  "documents",
  "dsr",
  "settlement",
];
const POLICY_FIELDS = [
  ["doiWindowDays", "Offtake window (days)"],
  ["stockFreshDays", "Declaration freshness (days)"],
  ["nearExpiryDays", "Near-expiry band (days)"],
  ["understockDays", "Understock threshold (days)"],
  ["overstockDays", "Overstock threshold (days)"],
  ["creditMaxAgeSeconds", "Maximum credit age (seconds)"],
  ["reconciliationToleranceBase", "Reconciliation tolerance (pieces)"],
  ["secondaryTargetCentavos", "28-day secondary target (centavos)"],
] as const;
export function Setup({ id, command }: { id: string; command: Command }) {
  const query = usePartnerQuery<SetupData>(id, "setup");
  return (
    <State query={query}>
      {(s) => (
        <SetupForms
          key={`${id}-${s.policy?.version ?? 0}`}
          setup={s}
          command={command}
        />
      )}
    </State>
  );
}
function SetupForms({
  setup: s,
  command,
}: {
  setup: SetupData;
  command: Command;
}) {
  const p = s.policy?.settings;
  const [claimTypes, setClaimTypes] = useState(
    p?.claimTypes ?? [
      { kind: "damage", minimumEvidence: 1 },
      { kind: "promotion", minimumEvidence: 1 },
      { kind: "freight", minimumEvidence: 1 },
      { kind: "shortage", minimumEvidence: 1 },
    ],
  );
  return (
    <>
      <Panel
        title="Distributor configuration"
        detail="Policies are our provisional settings until Sunpride confirms them. Each change creates a new effective version."
      >
        <p className="text-sm">
          Master{" "}
          {s.master
            ? `version ${s.master.version} · ${s.master.source === "sample" ? "Mock SAP" : "SAP"} · received ${when(s.master.received_at)}`
            : "needs synchronization"}
          . Policy {s.policy ? `version ${s.policy.version}` : "needs setup"}.
        </p>
      </Panel>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <ActionForm
          title="Invite or update a partner user"
          submitLabel="Save partner access"
          detail="Portal users keep separate financial grants. Field representatives use the existing field app, assigned stores, PJP and MSL. Use a new email, not an employee or portal login."
          onSubmit={(f) =>
            command("invite", {
              email: value(f, "email"),
              name: value(f, "name"),
              access: value(f, "access"),
              grants:
                value(f, "access") === "field"
                  ? ["read", "dsr"]
                  : f.getAll("grant").map(String),
            })
          }
        >
          <Field label="Name">
            <input name="name" required className={fieldClass} />
          </Field>
          <Field label="Email">
            <input type="email" name="email" required className={fieldClass} />
          </Field>
          <Field label="Access type">
            <select name="access" className={fieldClass}>
              <option value="portal">Distributor portal</option>
              <option value="field">
                Field representative — existing Android field app
              </option>
            </select>
          </Field>
          <fieldset className="grid grid-cols-2 gap-2">
            <legend className="mb-2 text-sm font-medium">Partner grants</legend>
            {GRANTS.map((g) => (
              <label className="text-sm" key={g}>
                <input
                  type="checkbox"
                  name="grant"
                  value={g}
                  defaultChecked={g === "read"}
                />{" "}
                {words(g)}
              </label>
            ))}
          </fieldset>
        </ActionForm>
        <ActionForm
          title="Add a warehouse or van"
          submitLabel="Save partner location"
          detail="Locations stay inside this distributor. Shared van-engine binding is completed at integration; this does not create a second settlement ledger."
          onSubmit={(f) =>
            command("location", {
              code: value(f, "code"),
              name: value(f, "name"),
              kind: value(f, "kind"),
            })
          }
        >
          <Field label="Location code">
            <input name="code" required className={fieldClass} />
          </Field>
          <Field label="Location name">
            <input name="name" required className={fieldClass} />
          </Field>
          <Field label="Location type">
            <select name="kind" className={fieldClass}>
              <option value="warehouse">Warehouse</option>
              <option value="van">Van</option>
            </select>
          </Field>
        </ActionForm>
      </div>
      <Panel title="Current and prior partner grants">
        <Table headers={["User", "Email", "Grants", "Access"]}>
          {s.users.map((u) => (
            <tr key={u.id}>
              <Cell>{u.name}</Cell>
              <Cell>{u.email}</Cell>
              <Cell>{u.grants.map(words).join(", ")}</Cell>
              <Cell>
                {u.effective_to ? (
                  `Ended ${when(u.effective_to)}`
                ) : (
                  <ActionForm
                    title="Withdraw access"
                    submitLabel="End this membership"
                    onSubmit={() => command("revoke", { membershipId: u.id })}
                  >
                    <p className="text-xs text-muted">
                      New reads, writes, exports and sync are refused
                      immediately.
                    </p>
                  </ActionForm>
                )}
              </Cell>
            </tr>
          ))}
        </Table>
        {s.usersTruncated ? (
          <p className="text-sm text-muted">
            Showing the latest 200 memberships.
          </p>
        ) : null}
      </Panel>
      <ActionForm
        title="Stock, credit and scorecard policy"
        submitLabel="Save new effective policy"
        onSubmit={(f) => {
          const settings: Record<string, unknown> = {};
          for (const [key] of POLICY_FIELDS) settings[key] = number(f, key);
          settings.requiredDocuments = f.getAll("requiredDocument").map(String);
          settings.claimTypes = claimTypes.map((_, i) => ({
            kind: value(f, `kind:${i}`),
            minimumEvidence: number(f, `evidence:${i}`),
          }));
          settings.scorecardWeights = Object.fromEntries(
            [
              "submission",
              "coverage",
              "growth",
              "stock",
              "payment",
              "infrastructure",
              "manpower",
            ].map((k) => [k, number(f, `weight:${k}`)]),
          );
          return command("policy", { settings });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {POLICY_FIELDS.map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                type="number"
                min="0"
                step="1"
                name={key}
                required
                defaultValue={p?.[key]}
                className={fieldClass}
              />
            </Field>
          ))}
        </div>
        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-2 text-sm font-medium">
            Required accreditation documents
          </legend>
          {["registration", "tax", "credit"].map((k) => (
            <label key={k} className="text-sm">
              <input
                type="checkbox"
                name="requiredDocument"
                value={k}
                defaultChecked={p?.requiredDocuments.includes(k) ?? true}
              />{" "}
              {words(k)}
            </label>
          ))}
        </fieldset>
        <fieldset className="grid gap-3">
          <legend className="mb-2 text-sm font-medium">
            Claim types and required evidence
          </legend>
          {claimTypes.map((type, i) => (
            <div key={i} className="grid grid-cols-2 gap-3">
              <Field label="Claim type">
                <input
                  name={`kind:${i}`}
                  defaultValue={type.kind}
                  required
                  className={fieldClass}
                />
              </Field>
              <Field label="Minimum evidence documents">
                <input
                  name={`evidence:${i}`}
                  type="number"
                  min="1"
                  max="20"
                  defaultValue={type.minimumEvidence}
                  required
                  className={fieldClass}
                />
              </Field>
            </div>
          ))}
          <button
            type="button"
            className="text-left text-sm underline"
            onClick={() =>
              setClaimTypes([...claimTypes, { kind: "", minimumEvidence: 1 }])
            }
          >
            Add a claim type
          </button>
        </fieldset>
        <fieldset className="grid gap-3 sm:grid-cols-4">
          <legend className="mb-2 text-sm font-medium">
            Scorecard weights (must total 100)
          </legend>
          {[
            "submission",
            "coverage",
            "growth",
            "stock",
            "payment",
            "infrastructure",
            "manpower",
          ].map((k) => (
            <Field key={k} label={words(k)}>
              <input
                name={`weight:${k}`}
                type="number"
                min="0"
                max="100"
                defaultValue={p?.scorecardWeights[k]}
                required
                className={fieldClass}
              />
            </Field>
          ))}
        </fieldset>
      </ActionForm>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <ActionForm
          title="Import a SAP master snapshot"
          submitLabel="Validate and apply snapshot"
          detail="The source file supplies source, sourceKey, version, effectiveFrom and payload. It replaces catalog, territory/outlet grants, terms and scheme eligibility atomically. SAP remains authoritative."
          onSubmit={async (f) => {
            const file = fileInput(f);
            if (file.size > 700000)
              throw new Error("Snapshot must be below 700 KB.");
            const body = JSON.parse(await file.text()) as Record<
              string,
              unknown
            >;
            await command("master/sync", body);
          }}
        >
          <Field label="SAP master JSON file">
            <input
              type="file"
              name="file"
              accept=".json"
              required
              className={fieldClass}
            />
          </Field>
          <p className="text-xs text-muted">
            Use the connector contract in the lane design notes. Real-source
            snapshots never simulate credit approval or SAP acknowledgements.
          </p>
        </ActionForm>
        <ActionForm
          title="Import SAP statement and primary movements"
          submitLabel="Apply source replicas"
          detail="Versioned SAP open items and primary shipment/return/transfer/adjustment records. This never posts to an accounting ledger."
          onSubmit={async (f) => {
            const file = fileInput(f);
            if (file.size > 700000)
              throw new Error("File must be below 700 KB.");
            await command(
              "financial/sync",
              JSON.parse(await file.text()) as Record<string, unknown>,
            );
          }}
        >
          <Field label="SAP financial JSON file">
            <input
              type="file"
              name="file"
              accept=".json"
              required
              className={fieldClass}
            />
          </Field>
        </ActionForm>
      </div>
      <ActionForm
        title="Capability audit"
        submitLabel="Record capability audit"
        onSubmit={(f) =>
          command("audit", {
            auditDate: value(f, "date"),
            infrastructureScore: number(f, "infrastructure"),
            manpowerScore: number(f, "manpower"),
            findings: value(f, "findings"),
          })
        }
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Audit date">
            <input
              type="date"
              name="date"
              required
              defaultValue={manilaToday()}
              className={fieldClass}
            />
          </Field>
          <Field label="Infrastructure score / 100">
            <input
              type="number"
              name="infrastructure"
              min="0"
              max="100"
              required
              className={fieldClass}
            />
          </Field>
          <Field label="Manpower score / 100">
            <input
              type="number"
              name="manpower"
              min="0"
              max="100"
              required
              className={fieldClass}
            />
          </Field>
        </div>
        <Field label="Evidence and findings">
          <textarea name="findings" required className={fieldClass} />
        </Field>
      </ActionForm>
    </>
  );
}
