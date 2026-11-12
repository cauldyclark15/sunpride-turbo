"use client";
import { formatStatus } from "../../lib/format";
import Link from "next/link";
import { ActionForm, Field, Panel, fieldClass, value } from "./kit";
export type PartnerVanData = {
  ready: boolean;
  message: string;
  stockOwnership: string;
  vans: { id: string; name: string }[];
  arrangements: {
    id: string;
    name: string;
    reference: string;
    source: string;
  }[];
  operators: { id: string; name: string }[];
  vehicleOptions: { id: string; name: string; code: string }[];
  trips: {
    id: string;
    trip_number: string;
    service_date: string;
    status: string;
  }[];
  tripsTruncated: boolean;
};
export function VanArrangement({
  data,
  office,
  command,
}: {
  data: PartnerVanData;
  office: boolean;
  command: (action: string, body: Record<string, unknown>) => Promise<unknown>;
}) {
  return (
    <Panel title="Distributor van load and settlement" detail={data.message}>
      <p className="text-sm font-medium">
        {data.ready
          ? "Configured for the existing Van/Store app"
          : "Configuration needs attention"}
      </p>
      <p className="text-sm text-muted">
        {data.stockOwnership}. This is our configurable consignment
        recommendation, not a statement of Sunpride's existing commercial terms.
      </p>
      <div className="grid gap-2 text-sm">
        {data.arrangements.map((a) => (
          <p key={a.id}>
            {a.name} · {a.reference}
            {a.source === "sample" ? " · Sample arrangement" : ""}
          </p>
        ))}
        <p>
          Dedicated operators:{" "}
          {data.operators.map((p) => p.name).join(", ") ||
            "Invite and activate a van operator in Setup"}
        </p>
      </div>
      {office ? (
        <>
          <ActionForm
            title="Configure an existing company vehicle"
            detail="Company stock, return rules and independent office settlement approvals remain unchanged. Use a separate van login, not the portal login."
            submitLabel="Save consignment arrangement"
            onSubmit={(f) =>
              command("van-arrangements/save", {
                vehicleId: value(f, "vehicleId"),
                reference: value(f, "reference"),
                stockOwner: "sunpride",
                ...(value(f, "replacesId")
                  ? { replacesId: value(f, "replacesId") }
                  : {}),
                ...(value(f, "until")
                  ? {
                      effectiveTo: new Date(
                        value(f, "until") + "+08:00",
                      ).toISOString(),
                    }
                  : {}),
              })
            }
          >
            <Field label="Company vehicle">
              <select name="vehicleId" className={fieldClass} required>
                <option value="">
                  Choose a vehicle in this supervising area
                </option>
                {data.vehicleOptions.map((v) => (
                  <option value={v.id} key={v.id}>
                    {v.code} · {v.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Arrangement or sample reference">
              <input
                name="reference"
                className={fieldClass}
                required
                maxLength={300}
              />
            </Field>
            <Field label="Replace an earlier arrangement (optional)">
              <select name="replacesId" className={fieldClass}>
                <option value="">New arrangement</option>
                {data.arrangements.map((a) => (
                  <option value={a.id} key={a.id}>
                    {a.name} · {a.reference}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Ends at (Manila, optional)">
              <input
                type="datetime-local"
                name="until"
                className={fieldClass}
              />
            </Field>
          </ActionForm>
          <Link href="/van-trips" className="text-sm underline">
            Plan the trip, approve the load and review the shared settlement
          </Link>
        </>
      ) : null}
      <div className="grid gap-2">
        <h3 className="text-sm font-medium">Partner-arranged trips</h3>
        {data.trips.length ? (
          data.trips.map((t) => (
            <article
              className="rounded-lg border border-border p-3 text-sm"
              key={t.id}
            >
              {t.trip_number} · {t.service_date.slice(0, 10)} ·{" "}
              {formatStatus(t.status)}
            </article>
          ))
        ) : (
          <p className="text-sm text-muted">
            No partner trip planned yet. The office assigns the configured van
            and the dedicated operator using its existing trip planner.
          </p>
        )}
        {data.tripsTruncated ? (
          <p className="text-xs text-muted">
            Showing the latest 50 trips; use the office archive for older trips.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
