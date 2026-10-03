"use client";

import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  FormField,
  ListRow,
  IconTile,
  StatusPill,
  WorkspaceIcon,
} from "@sunpride/ui";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import {
  formatTime,
  PERSON_TONES,
  plottedStops,
  territoriesOf,
  type SupervisionFilters,
} from "./supervision-model";

type ActivityDay = FunctionReturnType<typeof api.supervision.activity.map>;
type Person = ActivityDay["people"][number];

function stopLabel(stop: Person["stops"][number]) {
  if (stop.source === "not_visited") return "Not visited";
  if (stop.state === "checked-in" || stop.state === "in-progress")
    return "In call";
  if (stop.productivity === "verified") return "Productive";
  if (stop.productivity === "nonproductive") return "Nonproductive";
  return "Visited";
}

function ActivityTileMap({
  people,
  showsFixes,
}: {
  people: Person[];
  showsFixes: boolean;
}) {
  const node = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!node.current) return;
    let disposed = false;
    let map: import("leaflet").Map | undefined;
    import("leaflet")
      .then((L) => {
        if (disposed || !node.current) return;
        map = L.map(node.current).setView([14.6, 121], 10);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 19,
        })
          .on("tileerror", () => setFailed(true))
          .addTo(map);
        const bounds: [number, number][] = [];
        people.forEach((person, index) => {
          const tone = PERSON_TONES[index % PERSON_TONES.length]!;
          const stops = plottedStops(person.stops);
          // Visit progression: visited stops joined in check-in order.
          const path = stops
            .filter((stop) => stop.source !== "not_visited")
            .map(
              (stop) =>
                [stop.point!.latitude, stop.point!.longitude] as [
                  number,
                  number,
                ],
            );
          if (path.length > 1)
            L.polyline(path, { color: tone, weight: 2, opacity: 0.7 }).addTo(
              map!,
            );
          let order = 0;
          for (const stop of stops) {
            const visited = stop.source !== "not_visited";
            if (visited) order += 1;
            const position: [number, number] = [
              stop.point!.latitude,
              stop.point!.longitude,
            ];
            bounds.push(position);
            const badge = document.createElement("span");
            badge.textContent = visited ? String(order) : "·";
            badge.style.cssText = `display:inline-block;min-width:22px;text-align:center;border-radius:999px;padding:2px 6px;font:500 12px/16px Mulish,sans-serif;${visited ? `background:${tone};color:white` : `background:white;color:${tone};border:1px solid ${tone}`}`;
            L.marker(position, {
              icon: L.divIcon({ className: "", html: badge.outerHTML }),
            })
              .bindPopup(() => {
                const label = document.createElement("span");
                label.textContent = `${person.name} · ${stop.outletCode} · ${stop.outletName} · ${stopLabel(stop)} · ${formatTime(stop.checkedInAt)}`;
                return label;
              })
              .addTo(map!);
          }
          if (showsFixes)
            for (const stop of person.stops)
              if (stop.fix) {
                const fix: [number, number] = [
                  stop.fix.latitude,
                  stop.fix.longitude,
                ];
                bounds.push(fix);
                L.circleMarker(fix, {
                  radius: 4,
                  color: tone,
                  weight: 1,
                  fillOpacity: 0.3,
                }).addTo(map!);
              }
        });
        if (bounds.length)
          map.fitBounds(L.latLngBounds(bounds), {
            padding: [24, 24],
            maxZoom: 15,
          });
      })
      .catch(() => setFailed(true));
    return () => {
      disposed = true;
      map?.remove();
    };
  }, [people, showsFixes]);
  return (
    <div className="grid gap-2">
      <div
        ref={node}
        aria-label="Field activity map"
        className="h-[420px] overflow-hidden rounded-xl border border-border"
      />
      {failed && (
        <p role="status" className="text-[13px] text-muted">
          Map unavailable. List below.
        </p>
      )}
      <small className="text-[12px] text-muted">
        © OpenStreetMap contributors
      </small>
    </div>
  );
}

export function ActivityMapView({
  data,
  profileId,
  territory,
  onProfile,
  onTerritory,
}: {
  data: ActivityDay;
  profileId: Id<"profiles"> | "";
  territory: string;
  onProfile: (id: Id<"profiles"> | "") => void;
  onTerritory: (code: string) => void;
}) {
  const territories = territoriesOf(data.people);
  // Memoized so the Leaflet map rebuilds only when the data or filters change.
  const people = useMemo(
    () =>
      data.people
        .filter((person) => !profileId || person.profileId === profileId)
        .map((person) => ({
          ...person,
          stops: territory
            ? person.stops.filter((stop) => stop.territoryCode === territory)
            : person.stops,
        })),
    [data.people, profileId, territory],
  );
  const visited = people.reduce(
    (n, person) =>
      n + person.stops.filter((stop) => stop.source !== "not_visited").length,
    0,
  );
  return (
    <Card
      label="Field activity"
      count={visited}
      icon={<WorkspaceIcon name="field" />}
    >
      <div className="grid gap-4">
        <div className="flex flex-wrap gap-3">
          <div className="w-[220px] max-w-full">
            <FormField label="Person">
              <select
                aria-label="Person"
                className="h-10 w-full"
                value={profileId}
                onChange={(event) =>
                  onProfile(event.target.value as Id<"profiles"> | "")
                }
              >
                <option value="">Everyone</option>
                {data.people.map((person) => (
                  <option key={person.profileId} value={person.profileId}>
                    {person.name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
          <div className="w-[180px] max-w-full">
            <FormField label="Territory">
              <select
                aria-label="Territory"
                className="h-10 w-full"
                value={territory}
                onChange={(event) => onTerritory(event.target.value)}
              >
                <option value="">All</option>
                {territories.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        </div>
        <ActivityTileMap people={people} showsFixes={data.showsFixes} />
        {data.truncated && (
          <p className="text-[13px] text-muted">
            First {data.people.length} people shown. Pick a unit.
          </p>
        )}
        {people.every((person) => person.stops.length === 0) ? (
          <p className="text-[13px] text-muted">No field activity</p>
        ) : (
          people
            .filter((person) => person.stops.length)
            .map((person) => (
              <section key={person.profileId} className="grid">
                <h3 className="pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                  {person.name} · {person.channel}
                </h3>
                <div className="divide-y divide-separator rounded-xl border border-border">
                  {person.stops.map((stop) => (
                    <ListRow
                      key={stop.id}
                      icon={
                        <IconTile
                          tone={
                            stop.source === "not_visited"
                              ? "neutral"
                              : stop.productivity === "verified"
                                ? "success"
                                : stop.productivity === "nonproductive"
                                  ? "warning"
                                  : "neutral"
                          }
                          icon={<WorkspaceIcon name="field" />}
                        />
                      }
                      title={`${stop.outletName}`}
                      meta={[
                        stop.outletCode,
                        stop.territoryCode,
                        stop.sequence !== null ? `Stop ${stop.sequence}` : null,
                        stop.source === "unplanned" ? "Unplanned" : null,
                        stop.point ? null : "No pin",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      value={
                        <span className="font-mono text-[13px] tabular-nums">
                          {formatTime(stop.checkedInAt)}–
                          {formatTime(stop.checkedOutAt)}
                        </span>
                      }
                      action={<StatusPill>{stopLabel(stop)}</StatusPill>}
                    />
                  ))}
                </div>
              </section>
            ))
        )}
      </div>
    </Card>
  );
}

export function ActivityMap({ filters }: { filters: SupervisionFilters }) {
  const [profileId, setProfileId] = useState<Id<"profiles"> | "">("");
  const [territory, setTerritory] = useState("");
  const data = useQuery(api.supervision.activity.map, filters);
  if (data === undefined)
    return <span className="text-[13px] text-muted">Loading activity…</span>;
  return (
    <ActivityMapView
      data={data}
      profileId={profileId}
      territory={territory}
      onProfile={setProfileId}
      onTerritory={setTerritory}
    />
  );
}
