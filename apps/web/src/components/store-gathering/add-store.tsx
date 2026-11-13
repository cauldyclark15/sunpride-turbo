"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Card, Notice } from "@sunpride/ui";
import { apiFetch, mutate, useApi } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import {
  addressLine,
  candidatePoints,
  formatDistance,
  reasonWords,
  type AddressParts,
  type Candidate,
  type PlaceDetails,
  type Prediction,
} from "./model";
import { CandidateList } from "./review";

const PinMap = dynamic(() => import("./pin-map").then((m) => m.PinMap), {
  ssr: false,
  loading: () => (
    <div className="h-72 rounded-xl border border-border bg-default-soft" />
  ),
});
const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";
const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm";
const button =
  "inline-flex h-9 items-center justify-center rounded-lg border border-border bg-surface px-3 text-[13px] font-medium text-foreground hover:bg-default-soft disabled:opacity-50";
const primary =
  "inline-flex h-9 items-center justify-center rounded-lg border border-foreground bg-foreground px-3 text-[13px] font-medium text-background hover:opacity-90 disabled:opacity-50";

type Master = { id: string; label: string; data: { channelId?: string } };
type Setup = {
  units: { id: string; name: string }[];
  defaultUnitId: string | null;
  addressSearch: boolean;
  channels: Master[];
  subchannels: Master[];
};

/** Debounced value (300 ms default) for search-as-you-type calls. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Address search box: suggestions from our proxy after 3 characters. */
export function AddressSuggestions({
  predictions,
  onPick,
}: {
  predictions: Prediction[];
  onPick: (p: Prediction) => void;
}) {
  if (!predictions.length) return null;
  return (
    <ul
      role="listbox"
      aria-label="Address suggestions"
      className="grid overflow-hidden rounded-lg border border-border bg-surface"
    >
      {predictions.map((p) => (
        <li key={p.placeId} role="option" aria-selected={false}>
          <button
            type="button"
            className="w-full px-3 py-2 text-left hover:bg-default-soft"
            onClick={() => onPick(p)}
          >
            <span className="block text-sm">{p.primary}</span>
            <span className="block text-xs text-muted">{p.secondary}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Live duplicate panel shown while the office fills the form. */
export function DuplicatePanel({
  candidates,
  acknowledged,
  onAcknowledge,
}: {
  candidates: Candidate[];
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
}) {
  if (!candidates.length)
    return (
      <p className="text-sm text-muted">
        No similar store found yet. This updates as you type.
      </p>
    );
  return (
    <div className="grid gap-2 rounded-lg border border-warning p-3">
      <p className="text-sm font-semibold">This might already be in the list</p>
      <CandidateList candidates={candidates} />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => onAcknowledge(e.target.checked)}
        />
        It&apos;s a different store
      </label>
    </div>
  );
}

export function summaryLine(c: Candidate): string {
  return `${c.name} — ${formatDistance(c.distanceMeters)} — ${reasonWords(c.reasons)}`;
}

/** SP-0162 office Add store: address search + draggable pin + live duplicate check. */
export function AddStore({
  onDone,
  onCancel,
  initialName = "",
  bare = false,
}: {
  onDone?: () => void;
  /** Closes the form without saving (Save / Cancel, docs/ui-actions.md). */
  onCancel?: () => void;
  initialName?: string;
  /** Inside a titled sheet: no card frame or heading of its own. */
  bare?: boolean;
}) {
  const { can } = usePermissions();
  const allowed = can("outlet.manage");
  const setup = useApi<Setup>(
    allowed ? ["masters", "store-setup"] : null,
    "/api/v1/masters/store-setup",
  );
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [parts, setParts] = useState<AddressParts | null>(null);
  const [placeId, setPlaceId] = useState<string | null>(null);
  const [pin, setPin] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [search, setSearch] = useState("");
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [searchNote, setSearchNote] = useState("");
  const [picked, setPicked] = useState("");
  const [channelId, setChannelId] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const session = useRef<string>("");
  const requestKey = useRef<string>("");
  const term = useDebounced(search.trim());
  useEffect(() => {
    if (term.length < 3 || term === picked || !setup.data?.addressSearch)
      return;
    if (!session.current) session.current = crypto.randomUUID();
    const controller = new AbortController();
    apiFetch<{ predictions: Prediction[] }>("/api/v1/places/autocomplete", {
      query: {
        input: term,
        session: session.current,
        ...(pin ? { lat: pin.latitude, lng: pin.longitude } : {}),
      },
      signal: controller.signal,
    })
      .then((r) => {
        setPredictions(r.predictions);
        setSearchNote(
          r.predictions.length ? "" : "No address found. Try other words.",
        );
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setPredictions([]);
        setSearchNote(
          e instanceof Error
            ? e.message
            : "Address search is not available right now.",
        );
      });
    return () => controller.abort();
    // The pin only biases suggestions; do not re-query when it moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, picked, setup.data?.addressSearch]);
  const dupName = useDebounced(name.trim(), 400);
  const dupPhone = useDebounced(phone.trim(), 400);
  useEffect(() => {
    if (!allowed || dupName.length < 2) return;
    const controller = new AbortController();
    apiFetch<{ candidates: Candidate[] }>(
      "/api/v1/masters/census/duplicate-check",
      {
        body: {
          name: dupName,
          phone: dupPhone || null,
          latitude: pin?.latitude ?? null,
          longitude: pin?.longitude ?? null,
          placeId,
        },
        signal: controller.signal,
      },
    )
      .then((r) => setCandidates(r.candidates))
      .catch(() => undefined);
    return () => controller.abort();
  }, [allowed, dupName, dupPhone, pin, placeId]);
  async function pick(p: Prediction) {
    setPredictions([]);
    setPicked(p.description.trim());
    setSearch(p.description);
    try {
      const d = await apiFetch<PlaceDetails>("/api/v1/places/details", {
        query: { placeId: p.placeId, session: session.current },
      });
      session.current = "";
      setPlaceId(d.placeId);
      setPin({ latitude: d.latitude, longitude: d.longitude });
      setAddress(d.formattedAddress);
      setParts(d.components);
      setSearchNote("Pin from address. Drag it onto the store if needed.");
    } catch (e) {
      setSearchNote(
        e instanceof Error ? e.message : "That address could not be opened.",
      );
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!pin) {
      setMessage("Search the address or set the pin on the map first.");
      return;
    }
    const f = new FormData(e.currentTarget);
    if (!requestKey.current) requestKey.current = crypto.randomUUID();
    setBusy(true);
    try {
      const r = await mutate<{ code: string }>(
        "/api/v1/masters/stores/office-add",
        {
          name,
          address,
          ownerName: f.get("ownerName"),
          ownerPhone: phone,
          channelId,
          subchannelId: f.get("subchannelId"),
          orgUnitId: f.get("orgUnitId") || null,
          latitude: pin.latitude,
          longitude: pin.longitude,
          placeId,
          landmark: f.get("landmark") || null,
          code: f.get("code") || null,
          acknowledgedDuplicateIds: matches.map((c) => c.id),
        },
        {
          idempotencyKey: requestKey.current,
          invalidate: [["masters"], ["stores"]],
        },
      );
      requestKey.current = "";
      setMessage(
        `${name} was added (code ${r.code}). Saved. Another person confirms the map pin.`,
      );
      setName("");
      setPhone("");
      setAddress("");
      setParts(null);
      setPlaceId(null);
      setPin(null);
      setSearch("");
      setCandidates([]);
      setAcknowledged(false);
      e.currentTarget?.reset();
      onDone?.();
    } catch (err) {
      setMessage(
        err instanceof Error ? err.message : "The store could not be added.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!allowed) return null;
  const s = setup.data;
  const subs = (s?.subchannels ?? []).filter(
    (x) => x.data.channelId === channelId,
  );
  // Stale answers are hidden rather than cleared inside effects.
  const shown = term.length >= 3 && term !== picked ? predictions : [];
  const matches = dupName.length >= 2 ? candidates : [];
  const blocked = matches.length > 0 && !acknowledged;
  return (
    <Frame bare={bare}>
      {setup.error ? (
        <Notice title={setup.error.message} tone="danger" />
      ) : null}
      <form onSubmit={submit} className="grid gap-4 lg:grid-cols-2">
        <div className="grid content-start gap-3">
          <label className="grid gap-1 text-xs">
            Store name
            <input
              className={field}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-xs">
              Owner name
              <input
                className={field}
                name="ownerName"
                required
                maxLength={100}
              />
            </label>
            <label className="grid gap-1 text-xs">
              Owner phone
              <input
                className={field}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                inputMode="tel"
                maxLength={40}
              />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-xs">
              Channel
              <select
                className={field}
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                required
              >
                <option value="">Choose…</option>
                {(s?.channels ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs">
              Sub-channel
              <select
                className={field}
                name="subchannelId"
                required
                key={channelId}
              >
                <option value="">Choose…</option>
                {subs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {s && s.units.length > 1 ? (
            <label className="grid gap-1 text-xs">
              Area
              <select
                className={field}
                name="orgUnitId"
                defaultValue={s.defaultUnitId ?? ""}
                required
              >
                <option value="">Choose…</option>
                {s.units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="grid gap-1 text-xs">
            <label htmlFor="address-search">Search address</label>
            <input
              id="address-search"
              className={field}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                s?.addressSearch === false
                  ? "Address search is not set up. Set the pin on the map."
                  : "Type at least 3 letters"
              }
              disabled={s?.addressSearch === false}
              autoComplete="off"
            />
            <AddressSuggestions predictions={shown} onPick={pick} />
            {searchNote ? (
              <span className="text-muted">{searchNote}</span>
            ) : null}
          </div>
          <label className="grid gap-1 text-xs">
            Address (as it should appear)
            <input
              className={field}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              required
              maxLength={500}
            />
            {parts ? (
              <span className="text-muted">{addressLine(parts)}</span>
            ) : null}
          </label>
          <label className="grid gap-1 text-xs">
            Landmark (optional)
            <input
              className={field}
              name="landmark"
              placeholder="e.g. beside the chapel"
              maxLength={200}
            />
          </label>
          <label className="grid gap-1 text-xs">
            Store code (leave blank to number it automatically)
            <input className={field} name="code" autoComplete="off" />
          </label>
        </div>
        <div className="grid content-start gap-3">
          <PinMap
            pin={pin}
            others={candidatePoints(matches)}
            draggable
            onMove={(at) => setPin(at)}
            label="Store pin"
            googleKey={GOOGLE_KEY}
          />
          {!pin ? (
            <button
              type="button"
              className={button}
              onClick={() => setPin({ latitude: 10.3157, longitude: 123.8854 })}
            >
              Place a pin to drag
            </button>
          ) : (
            <p className="text-xs text-muted">
              Drag the dark pin onto the store&apos;s door if it is not exact.
            </p>
          )}
          <DuplicatePanel
            candidates={matches}
            acknowledged={acknowledged}
            onAcknowledge={setAcknowledged}
          />
          <div>
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                className={primary}
                disabled={busy || blocked || !pin}
              >
                {busy ? "Saving…" : "Save"}
              </button>
              {onCancel ? (
                <button type="button" className={button} onClick={onCancel}>
                  Cancel
                </button>
              ) : null}
            </div>
            {blocked ? (
              <p className="mt-1 text-xs text-muted">
                Check the possible matches first.
              </p>
            ) : null}
          </div>
        </div>
      </form>
      {message ? (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      ) : null}
    </Frame>
  );
}

function Frame({
  bare,
  children,
}: {
  bare: boolean;
  children: React.ReactNode;
}) {
  return bare ? (
    <div>{children}</div>
  ) : (
    <Card label="Add a store">{children}</Card>
  );
}
