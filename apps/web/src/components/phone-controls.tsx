"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { mutate, useApi } from "../lib/api";

export const phoneControlLabels: Record<string, string> = {
  sign_out: "Sign out phone", refresh: "Refresh phone", resend: "Send unsent work now",
  remove: "Remove phone", update: "Ask to update",
};
export type PhoneControlData = {
  person: { id: string; name: string; autoAccept: boolean };
  more: boolean;
  phones: Array<{ id: string; deviceId: string | null; requestId: string | null; app: string;
    label: string; model: string; appVersion: string | null; status: string; signedIn: boolean;
    unsentCount: number | null; lastSeenAt: string | null; historyMore: boolean;
    history: Array<{ id: string; kind: string; who: string; requestedAt: string; doneAt: string | null }> }>;
};
const button = "rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50";
const when = (s: string | null) => s ? new Date(s).toLocaleString("en-PH", { timeZone: "Asia/Manila" }) : "Not reported yet";
export function phoneControlsHref(profileId: string) {
  return `/setup?section=devices&phonePerson=${encodeURIComponent(profileId)}#phone-controls`;
}
export async function sendPhoneControl(profileId: string, action: string, extra: Record<string, unknown> = {}) {
  return mutate<{ count?: number }>("/api/v1/people/phone-controls", { profileId, action, ...extra }, {
    invalidate: [["phone-controls"], ["setup"], ["integrity"]], idempotencyKey: crypto.randomUUID(),
  });
}
export function PersonPhoneActions({ profileId, name }: { profileId: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return <span className="inline-flex flex-wrap items-center gap-2">
    <Link className={button} href={phoneControlsHref(profileId)}>Phone controls</Link>
    <button className={button} disabled={busy} onClick={async () => {
      if (!window.confirm(`Sign out all of ${name}'s phones? Unsent work stays on each phone.`)) return;
      setBusy(true); setMessage("");
      try { const r = await sendPhoneControl(profileId, "sign_out_all"); setMessage(r.count ? "Waiting for the phones" : "No phones are signed in"); }
      catch (e) { setMessage(e instanceof Error ? e.message : "Could not sign out phones"); }
      finally { setBusy(false); }
    }}>Sign out all phones</button>
    {message ? <span role="status" className="text-xs">{message}</span> : null}
  </span>;
}

export function PhoneControls({ profileId }: { profileId: string }) {
  const result = useApi<PhoneControlData>(["phone-controls", profileId], `/api/v1/people/phone-controls?profileId=${encodeURIComponent(profileId)}`);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [iosLinks, setIosLinks] = useState<Record<string,string>>({});
  // Poll confirmations as well as telemetry; a disconnected phone must never look completed.
  useEffect(() => { const timer = setInterval(() => { void result.refetch().catch(() => {}); }, 5000); return () => clearInterval(timer); }, [result.refetch]);
  async function send(action: string, question: string, extra: Record<string, unknown> = {}) {
    if (busy || !window.confirm(question)) return;
    setBusy(true); setMessage("");
    try { await sendPhoneControl(profileId, action, extra); setMessage(action === "auto_accept" ? "Auto-accept saved" : action === "register" ? "Phone registered. Waiting for the phone to check again." : "Waiting for the phone"); }
    catch (e) { setMessage(e instanceof Error ? e.message : "Could not send the request"); }
    finally { setBusy(false); }
  }
  const data = result.data;
  return <section id="phone-controls" aria-label="Phone controls" className="grid gap-4 rounded-xl border border-border bg-surface p-5">
    <h2 className="text-lg font-semibold">Phone controls{data ? ` · ${data.person.name}` : ""}</h2>
    <p className="text-sm text-muted">Requests wait until the phone has signal and checks again. Unsent work is not erased. Counts are from the last phone check; older apps may not report them yet.</p>
    {result.error ? <p role="alert">{result.error.message}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {!data ? <p>Loading phone controls…</p> : <>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>Auto-accept new phones: {data.person.autoAccept ? "On" : "Off"}</span>
        <button className={button} disabled={busy} onClick={() => void send("auto_accept", `${data.person.autoAccept ? "Turn off" : "Turn on"} automatic acceptance of this person's next new phone? Existing phones stay registered.`, { enabled: !data.person.autoAccept })}>Turn auto-accept {data.person.autoAccept ? "off" : "on"}</button>
        <PersonPhoneActions profileId={profileId} name={data.person.name} />
      </div>
      {data.more ? <p role="alert">Showing the latest 100 phones. Older phones are not shown.</p> : null}
      {data.phones.length === 0 ? <p>No phones for this person yet.</p> : null}
      {data.phones.map(phone => <article key={phone.id} className="grid gap-3 border-t border-border pt-4">
        <h3 className="font-medium">{phone.app === "van-android" ? "Van app" : phone.app === "field-ios" ? "Field app · iOS" : "Field app · Android"} · {phone.model}</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt>Person</dt><dd>{data.person.name}</dd><dt>App version</dt><dd>{phone.appVersion ?? "Not reported yet"}</dd>
          <dt>Last check-in</dt><dd>{when(phone.lastSeenAt)}</dd><dt>Sign-in</dt><dd>{phone.signedIn ? "Signed in" : "Signed out"}</dd>
          <dt>Unsent items</dt><dd>{phone.unsentCount ?? "Not reported yet"}</dd><dt>Registration</dt><dd className="capitalize">{phone.status}</dd>
        </dl>
        {phone.app === "field-ios" && phone.status !== "removed" ? <label className="grid gap-1 text-sm">iPhone update download link<input type="url" placeholder="https://…" value={iosLinks[phone.id] ?? ""} onChange={e => setIosLinks(old => ({...old,[phone.id]:e.target.value}))} /><span className="text-xs text-muted">Use the published, signed iPhone update link. Android updates use their usual download route.</span></label> : null}
        <div className="flex flex-wrap gap-2">
          {phone.requestId ? <button className={button} disabled={busy} onClick={() => void send("register", "Register this phone? Any older phone for this app will be turned off. Unsent work on the old phone stays there.", { requestId: phone.requestId })}>Register / Replace phone</button> : null}
          {phone.deviceId && phone.status !== "removed" ? Object.entries(phoneControlLabels).map(([action, label]) => <button key={action} className={button} disabled={busy} onClick={() => void send(action, action === "sign_out" ? "Sign out this phone? Unsent work stays and can send after the same person signs in again." : action === "remove" ? "Remove this phone for this person? It can no longer send work. Nothing on the phone is erased." : `${label} on this phone's next check?`, { deviceId: phone.deviceId, ...(phone.app === "field-ios" && action === "update" ? { downloadUrl: iosLinks[phone.id] } : {}) })}>{label}</button>) : null}
        </div>
        <h4 className="text-sm font-medium">Phone requests</h4>
        {phone.history.length === 0 ? <p className="text-sm text-muted">No requests yet.</p> : <ol className="grid gap-2 text-sm">{phone.history.map(entry => <li key={entry.id}>
          {phoneControlLabels[entry.kind] ?? "Phone request"} · {entry.who} · {when(entry.requestedAt)}<br />
          <span className="text-muted">{entry.doneAt ? `Done at ${when(entry.doneAt)}` : "Waiting for the phone"}</span>
        </li>)}</ol>}
        {phone.historyMore ? <p className="text-xs text-muted">Showing the latest 50 requests.</p> : null}
      </article>)}
    </>}
  </section>;
}
