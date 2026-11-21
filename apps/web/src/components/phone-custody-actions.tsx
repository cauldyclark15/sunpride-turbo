"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import { Pager } from "@sunpride/ui";
import { api, useMutation, useQuery } from "./master-data/api";
import type { Device } from "./master-data/model";
import { SetupSearch } from "./master-data/setup-health";
import { AdminSelectField } from "./org-admin";

export const LOST_PHONE_BIR_NOTE =
  "If this is a BIR-registered POS phone, the office must also have its BIR device registration voided. Marking it as lost here does not do that.";

type Action = "reassign" | "lost" | "reregister";
const labels: Record<Action, string> = {
  reassign: "Give to another person",
  lost: "Mark as lost",
  reregister: "Register again",
};

export function PhoneCustodyActions({ device }: { device: Device }) {
  const [action, setAction] = useState<Action | null>(null);
  const [profileId, setProfileId] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const people = useQuery(
    api.people.queries.list,
    action === "reassign" || action === "reregister"
      ? {
          status: "active",
          canSignIn: "true",
          q: search,
          paginationOpts: { numItems: 25, cursor: cursors.at(-1) ?? null },
        }
      : "skip",
  );
  const reassign = useMutation(api.mobile.devices.reassign);
  const lost = useMutation(api.mobile.devices.lost);
  const reregister = useMutation(api.mobile.devices.reregister);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || pending) return;
    setError("");
    setNotice("");
    setPending(true);
    try {
      const input = { deviceId: device.deviceId };
      if (action === "reassign") {
        if (!profileId) throw new Error("Choose the replacement person");
        await reassign({ ...input, profileId });
        setNotice(
          "Phone reassigned. The old sign-in has ended. Ask the replacement person to sign in on this phone to download their own data.",
        );
      } else if (action === "lost") {
        await lost(input);
        setNotice(
          "Phone marked as lost. Sign-in and syncing are blocked until an administrator registers it again.",
        );
      } else {
        await reregister({ ...input, ...(profileId ? { profileId } : {}) });
        setNotice(
          "Phone registered again. The assigned person must sign in again before using it.",
        );
      }
      setAction(null);
      setProfileId("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  const actions: Action[] = device.lost
    ? ["reregister"]
    : device.status === "revoked"
      ? ["lost"]
      : ["reassign", "lost"];
  return (
    <section aria-label="Company phone" className="grid min-w-0 gap-3">
      {device.lost ? (
        <p className="text-sm text-danger">
          Lost phone · sign-in and syncing blocked
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {actions.map((next) => (
          <Button
            key={next}
            variant="outline"
            isDisabled={pending}
            onPress={() => {
              setAction(next);
              setProfileId("");
              setError("");
              setNotice("");
            }}
          >
            {labels[next]}
          </Button>
        ))}
      </div>
      {action ? (
        <form
          aria-label={labels[action]}
          onSubmit={submit}
          className="grid gap-3"
        >
          {action === "reassign" || action === "reregister" ? (
            <>
              <p className="text-sm text-muted">
                {action === "reregister"
                  ? "Only register again after the office has recovered and checked this phone. Choose the current person or a replacement. The old sign-in will not be restored."
                  : "This ends the old user’s sign-in on this phone, but keeps its history and received work. Check any unsent work with the old user first. The replacement person signs in to download only their own data."}
              </p>
              <p className="text-sm text-muted">
                If the replacement person has no account yet, add them in Setup
                &gt; People first.
              </p>
              <SetupSearch
                label="Find replacement person"
                value={search}
                onChange={(value) => {
                  setSearch(value);
                  setCursors([null]);
                  setProfileId("");
                }}
              />
              <AdminSelectField
                label="Replacement person"
                value={profileId}
                onChange={setProfileId}
                options={[
                  {
                    id: "",
                    label:
                      people === undefined
                        ? "Loading people…"
                        : action === "reregister"
                          ? `Keep ${device.employeeName ?? "the current person"}`
                          : "Choose a person",
                  },
                  ...(people?.page ?? [])
                    .filter(
                      (person) =>
                        person._id !== device.profileId &&
                        !!person.orgUnitId &&
                        !!person.userId,
                    )
                    .map((person) => ({
                      id: person._id,
                      label: `${person.name} · ${person.email}`,
                    })),
                ]}
              />
              <p className="text-sm text-muted">
                Only active people with a branch and a sign-in account are
                listed. Invite someone first in Setup &gt; People if they are
                missing.
              </p>
              <Pager
                label="Replacement people pages"
                page={cursors.length}
                canPrevious={cursors.length > 1}
                canNext={!!people && !people.isDone}
                onPrevious={() => {
                  setCursors((old) => old.slice(0, -1));
                  setProfileId("");
                }}
                onNext={() => {
                  if (people && !people.isDone) {
                    setCursors((old) => [...old, people.continueCursor]);
                    setProfileId("");
                  }
                }}
              />
            </>
          ) : (
            <>
              <p className="text-sm text-muted">
                This ends all sign-ins on this phone and stops further sign-in
                and syncing. Its history and received work are kept. Only an
                administrator can register this phone again.
              </p>
              <p className="text-sm text-muted">
                Work not yet uploaded may remain on the lost phone. This does
                not remotely erase the phone or remove data already downloaded.
              </p>
              <p className="rounded-xl bg-warning-soft p-3 text-sm">
                {LOST_PHONE_BIR_NOTE}
              </p>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" isPending={pending}>
              {labels[action]}
            </Button>
            <Button
              variant="outline"
              isDisabled={pending}
              onPress={() => setAction(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
