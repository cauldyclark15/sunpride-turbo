"use client";

import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { mutate } from "../../lib/api";
import type { LocationRow } from "./location-coverage";

const PinMap = dynamic(() => import("./pin-map").then((m) => m.PinMap), {
  ssr: false,
});

/** A deliberate office correction, not a field proposal. The API checks scope again. */
export function StorePinEditor({
  store,
  onClose,
}: {
  store: LocationRow;
  onClose: () => void;
}) {
  const [pin, setPin] = useState<{
    latitude: number;
    longitude: number;
  } | null>(
    store.latitude != null && store.longitude != null
      ? { latitude: store.latitude, longitude: store.longitude }
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef<{ key: string; body: string } | null>(null);
  const saving = useRef(false);
  async function save() {
    if (!pin || saving.current) return;
    const body = { outletId: store.id, ...pin };
    const text = JSON.stringify(body);
    if (request.current?.body !== text)
      request.current = { key: crypto.randomUUID(), body: text };
    saving.current = true;
    setBusy(true);
    setMessage("");
    try {
      await mutate("/api/v1/masters/stores/location", body, {
        idempotencyKey: request.current.key,
        invalidate: [["masters"], ["customers"], ["outlets"]],
      });
      onClose();
    } catch {
      setMessage(
        "Could not save the location. Your pin is still here; try again.",
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      aria-label={`Location for ${store.name}`}
      className="grid gap-3 rounded-xl border border-border p-4"
    >
      <h3 className="font-medium">Set location · {store.name}</h3>
      <p className="text-sm text-muted">
        {store.address || "No address yet"}. Tap the store on the map or drag
        the pin, then save.
      </p>
      <PinMap
        pin={pin}
        draggable
        onMove={setPin}
        label={`Store location: ${store.name}`}
        googleKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? ""}
      />
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50"
          disabled={!pin || busy}
          onClick={save}
        >
          {busy ? "Saving…" : "Save location"}
        </button>
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-2 text-sm"
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
      {message ? <p role="alert">{message}</p> : null}
    </section>
  );
}
