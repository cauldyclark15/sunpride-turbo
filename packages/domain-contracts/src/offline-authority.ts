/**
 * SFD-008 / ADR-022: the offline authority and conflict matrix, as data.
 *
 * Every synchronized entity on the field (mobile v1) and van (van v1) wires is classified here, and
 * every outcome code a phone can receive has exactly one remediation. `test/offline-authority.test.ts`
 * fails when a schema gains an entity, operation kind or code that this table does not classify.
 *
 * POLICY SOURCE: these rules are Turbo engineering defaults chosen without Sunpride input
 * (jc, 2026-10-07: server wins for master data and approvals, the phone wins for its own visit
 * facts, conflicts are held for review). When Sunpride confirms or changes a rule, edit the row and
 * flip `OFFLINE_POLICY.source` — there is no second copy of the policy anywhere.
 */

/** Who may change a record and how. */
export type AuthorityClass =
  /** Server master/reference data. The device only caches it and never edits it. */
  | "server_read_only"
  /** Lives only on the device until the user submits it; the server never sees intermediate edits. */
  | "device_draft"
  /** A device-originated fact. Immutable once queued; the server accepts it once or explains why not. */
  | "append_only_event"
  /** A server-owned lifecycle (approval, posting, trip/load/visit state). The device may only request a transition. */
  | "server_workflow";

/** How an out-of-date local copy is replaced. */
export type StaleRevisionHandling =
  /** A complete bootstrap generation replaces the cached partition in one local transaction. */
  | "snapshot_replace"
  /** A pull change applies only when its revision is higher than the local one; local pending work is never overwritten. */
  | "higher_revision_wins"
  /** The cursor/day manifest no longer matches: the device must rebootstrap, never patch partially. */
  | "rebootstrap"
  /** The queued bytes never change; the same request ID with different bytes is a conflict. */
  | "immutable_after_send"
  /** Never leaves the device, so it cannot be stale against the server. */
  | "local_only";

/** What decides business order. A device clock is deliberately not an option. */
export type BusinessOrdering =
  /** The server-allocated, per-organization `mobileChanges.sequence` (pull) or snapshot generation (bootstrap). */
  | "server_sequence"
  /** The device sends its outbox oldest-first; the server enforces `dependsOn`, planned-stop order and day rules, and stamps `serverTime`. */
  | "outbox_order_server_validated"
  /** The server's own transaction order (approvals, postings, trip transitions). */
  | "server_commit_order"
  /** Local edit order only; nothing is ordered against other people's work. */
  | "local_only";

/** How the device clock may be used. Never to order or approve business work. */
export type DeviceClockUse =
  | "none"
  /** Stored as evidence (when the rep says it happened) and range-checked against server time; never used for ordering. */
  | "evidence_only";

export type OfflineSurface = "mobile-v1" | "van-v1";
export type OfflineChannel =
  "bootstrap" | "pull" | "push" | "evidence" | "local";
export type OfflineImplementation =
  | "implemented"
  /** The wire accepts the kind but the server answers `unsupported_operation` until the feature ships. */
  | "rejected_until_supported"
  /** Signals only: the server emits it to force a rebootstrap; it carries no projected value. */
  | "rebootstrap_signal";

export type OfflineAuthorityRule = {
  readonly surface: OfflineSurface;
  readonly channel: OfflineChannel;
  /** Bootstrap section name, pull `entity`, push `kind`, or a local draft name. */
  readonly entity: string;
  readonly authority: AuthorityClass;
  readonly writer: "server" | "device";
  readonly stale: StaleRevisionHandling;
  readonly ordering: BusinessOrdering;
  readonly deviceClock: DeviceClockUse;
  /** How a retry is recognised as the same work. */
  readonly idempotency: string;
  readonly implementation: OfflineImplementation;
  readonly note: string;
};

const SNAPSHOT = {
  writer: "server",
  stale: "snapshot_replace",
  ordering: "server_sequence",
  deviceClock: "none",
  idempotency:
    "Read-only; a repeated page request with the same cursor returns the same generation.",
  implementation: "implemented",
} as const;

const fieldSnapshot = (
  entity: string,
  authority: "server_read_only" | "server_workflow",
  note: string,
): OfflineAuthorityRule => ({
  surface: "mobile-v1",
  channel: "bootstrap",
  entity,
  authority,
  note,
  ...SNAPSHOT,
});
const vanSnapshot = (
  entity: string,
  authority: "server_read_only" | "server_workflow",
  note: string,
): OfflineAuthorityRule => ({
  surface: "van-v1",
  channel: "bootstrap",
  entity,
  authority,
  note,
  ...SNAPSHOT,
});

const VISIT_KEY =
  "clientRequestId (UUID v4) per kind, bound to device + profile + canonical SHA-256 payload hash (processedMobileOperations). Same bytes replay the stored ack; changed bytes conflict.";

export const OFFLINE_AUTHORITY_MATRIX: readonly OfflineAuthorityRule[] = [
  // ── Field bootstrap (mobile v1): everything the server sends is server-owned. ──
  fieldSnapshot(
    "permissions",
    "server_read_only",
    "Capabilities derived from the app role; UI hints only, the server rechecks.",
  ),
  fieldSnapshot(
    "employee",
    "server_read_only",
    "Profile and current effective assignment.",
  ),
  fieldSnapshot(
    "scope",
    "server_read_only",
    "Org unit and scope fingerprint; a change forces rebootstrap.",
  ),
  fieldSnapshot(
    "appConfig",
    "server_read_only",
    "Lease, cache and policy limits.",
  ),
  fieldSnapshot(
    "plannedVisits",
    "server_workflow",
    "Approved MCP stops for the day; plan status is server-owned (ADR-015).",
  ),
  fieldSnapshot(
    "outlets",
    "server_read_only",
    "Outlet master and verified pins.",
  ),
  fieldSnapshot(
    "localCustomers",
    "server_read_only",
    "Accounting customers linked to cached outlets.",
  ),
  fieldSnapshot(
    "route",
    "server_read_only",
    "Route/beat membership for the day.",
  ),
  fieldSnapshot(
    "tasks",
    "server_workflow",
    "Assigned tasks; completion is requested by push, never edited locally.",
  ),
  fieldSnapshot(
    "productCatalog",
    "server_read_only",
    "Products, UOMs and barcodes.",
  ),
  fieldSnapshot(
    "callSheets",
    "server_read_only",
    "Governed call-sheet templates.",
  ),
  fieldSnapshot(
    "inventoryAvailability",
    "server_read_only",
    "Stock as of serverTime; never shown as live.",
  ),
  fieldSnapshot(
    "activityRules",
    "server_read_only",
    "Required/optional activity forms per visit intent.",
  ),
  fieldSnapshot(
    "photoTypes",
    "server_read_only",
    "Allowed evidence photo types.",
  ),
  fieldSnapshot(
    "accountSummaries",
    "server_read_only",
    "Cached account figures as of the page's serverTime.",
  ),
  fieldSnapshot(
    "orderTerms",
    "server_read_only",
    "Price list and unit prices per account as of serverTime; a preview, the server re-prices every order.",
  ),
  fieldSnapshot(
    "dayTarget",
    "server_read_only",
    "Day target from approved standards.",
  ),
  fieldSnapshot(
    "daySales",
    "server_read_only",
    "Server-accepted sales so far today; queued work is shown separately.",
  ),

  // ── Field delta pull. ──
  {
    surface: "mobile-v1",
    channel: "pull",
    entity: "visit",
    authority: "server_workflow",
    writer: "server",
    stale: "higher_revision_wins",
    ordering: "server_sequence",
    deviceClock: "none",
    idempotency:
      "Change rows are keyed by (entity, id, revision); re-applying a revision is a no-op.",
    implementation: "implemented",
    note: "Server-certified visit state/productivity (ADR-016). Never overwrites a visit with pending local work.",
  },
  {
    surface: "mobile-v1",
    channel: "pull",
    entity: "activity",
    authority: "server_read_only",
    writer: "server",
    stale: "higher_revision_wins",
    ordering: "server_sequence",
    deviceClock: "none",
    idempotency:
      "Change rows are keyed by (entity, id, revision); re-applying a revision is a no-op.",
    implementation: "implemented",
    note: "Server acknowledgement of an accepted activity, stamped with serverTime.",
  },
  {
    surface: "mobile-v1",
    channel: "pull",
    entity: "product",
    authority: "server_read_only",
    writer: "server",
    stale: "higher_revision_wins",
    ordering: "server_sequence",
    deviceClock: "none",
    idempotency:
      "Ordered by (revision, entity, id) inside a pull cycle; re-applying a revision is a no-op.",
    implementation: "implemented",
    note: "Reference-data delta for devices that opted into referenceData.",
  },
  {
    surface: "mobile-v1",
    channel: "pull",
    entity: "inventory",
    authority: "server_read_only",
    writer: "server",
    stale: "higher_revision_wins",
    ordering: "server_sequence",
    deviceClock: "none",
    idempotency:
      "Ordered by (revision, entity, id) inside a pull cycle; re-applying a revision is a no-op.",
    implementation: "implemented",
    note: "Availability delta; still labelled 'as of', never live.",
  },
  {
    surface: "mobile-v1",
    channel: "pull",
    entity: "coveragePlan",
    authority: "server_workflow",
    writer: "server",
    stale: "rebootstrap",
    ordering: "server_sequence",
    deviceClock: "none",
    idempotency: "Not applied; any row invalidates the cursor.",
    implementation: "rebootstrap_signal",
    note: "Plan activation/supersession: the phone must take a fresh snapshot of the approved plan.",
  },
  {
    surface: "mobile-v1",
    channel: "pull",
    entity: "outletAssignment",
    authority: "server_workflow",
    writer: "server",
    stale: "rebootstrap",
    ordering: "server_sequence",
    deviceClock: "none",
    idempotency: "Not applied; any row invalidates the cursor.",
    implementation: "rebootstrap_signal",
    note: "Outlet moved between territories/routes: scope may have changed.",
  },

  // ── Field push: device facts are append-only events. ──
  {
    surface: "mobile-v1",
    channel: "push",
    entity: "visit.checkIn",
    authority: "append_only_event",
    writer: "device",
    stale: "immutable_after_send",
    ordering: "outbox_order_server_validated",
    deviceClock: "evidence_only",
    idempotency: `${VISIT_KEY} clientVisitId also refuses a second check-in for the same planned stop under a new key.`,
    implementation: "implemented",
    note: "The phone wins on what it saw (time, place, intents); the server decides whether it counts (plan, scope, day window, stop order).",
  },
  {
    surface: "mobile-v1",
    channel: "push",
    entity: "visit.activity",
    authority: "append_only_event",
    writer: "device",
    stale: "immutable_after_send",
    ordering: "outbox_order_server_validated",
    deviceClock: "evidence_only",
    idempotency: `${VISIT_KEY} Requires its check-in in dependsOn.`,
    implementation: "implemented",
    note: "Notes, checks, call sheets and order intent. Order intent is a request; pricing/credit/SAP remain server workflow.",
  },
  {
    surface: "mobile-v1",
    channel: "push",
    entity: "visit.checkOut",
    authority: "append_only_event",
    writer: "device",
    stale: "immutable_after_send",
    ordering: "outbox_order_server_validated",
    deviceClock: "evidence_only",
    idempotency: `${VISIT_KEY} Requires its prior activity/check-in in dependsOn.`,
    implementation: "implemented",
    note: "Productivity is computed by the server from governed facts, never from the phone's outcome alone.",
  },
  {
    surface: "mobile-v1",
    channel: "push",
    entity: "task.complete",
    authority: "server_workflow",
    writer: "device",
    stale: "immutable_after_send",
    ordering: "outbox_order_server_validated",
    deviceClock: "evidence_only",
    idempotency: VISIT_KEY,
    implementation: "rejected_until_supported",
    note: "A transition request; answered unsupported_operation (key not consumed) until task completion ships.",
  },
  {
    surface: "mobile-v1",
    channel: "push",
    entity: "collection.record",
    authority: "append_only_event",
    writer: "device",
    stale: "immutable_after_send",
    ordering: "outbox_order_server_validated",
    deviceClock: "evidence_only",
    idempotency: VISIT_KEY,
    implementation: "rejected_until_supported",
    note: "Cash custody evidence, not settlement; answered unsupported_operation (key not consumed) until collections ship.",
  },
  {
    surface: "mobile-v1",
    channel: "evidence",
    entity: "visit.photo",
    authority: "append_only_event",
    writer: "device",
    stale: "immutable_after_send",
    ordering: "outbox_order_server_validated",
    deviceClock: "evidence_only",
    idempotency:
      "Visit + SHA-256 checksum of the bytes; a lost attach answer resolves to the original evidence row, changed metadata under the same checksum conflicts.",
    implementation: "implemented",
    note: "Uploaded through a short-lived claim after the visit is acknowledged; stays pending review until verified.",
  },

  // ── Field local drafts: never synchronized until submitted. ──
  {
    surface: "mobile-v1",
    channel: "local",
    entity: "visit.draft",
    authority: "device_draft",
    writer: "device",
    stale: "local_only",
    ordering: "local_only",
    deviceClock: "none",
    idempotency:
      "Not sent. Submitting freezes it into immutable visit.* operations with fresh UUIDs.",
    implementation: "implemented",
    note: "An open call's unsaved notes and form answers.",
  },
  {
    surface: "mobile-v1",
    channel: "local",
    entity: "order.draft",
    authority: "device_draft",
    writer: "device",
    stale: "local_only",
    ordering: "local_only",
    deviceClock: "none",
    idempotency:
      "Not sent. Send freezes it into one visit.activity order_intent.",
    implementation: "implemented",
    note: "Draft/review/send order lines; editable until Send.",
  },

  // ── Van bootstrap. ──
  vanSnapshot(
    "serviceDate",
    "server_read_only",
    "Manila service date chosen by the server.",
  ),
  vanSnapshot("seller", "server_read_only", "Van salesman profile."),
  vanSnapshot("policy", "server_read_only", "Lease, cache and selling limits."),
  vanSnapshot(
    "trip",
    "server_workflow",
    "Trip state machine (planned → … → closed) is server-owned.",
  ),
  vanSnapshot(
    "load",
    "server_workflow",
    "Load sheet status; posting happens only in Convex postMovement.",
  ),
  vanSnapshot(
    "truckStock",
    "server_read_only",
    "Server truck balance as of serverTime; the phone keeps a conservative projection.",
  ),
  vanSnapshot("products", "server_read_only", "Products, UOMs and barcodes."),
  vanSnapshot(
    "customers",
    "server_read_only",
    "Route and unplanned customers.",
  ),
  vanSnapshot(
    "damageRecords",
    "server_workflow",
    "VAN-020: this trip's damage records and their supervisor approval state.",
  ),

  // ── Van push. ──
  {
    surface: "van-v1",
    channel: "push",
    entity: "trip.start",
    authority: "server_workflow",
    writer: "device",
    stale: "immutable_after_send",
    ordering: "server_commit_order",
    deviceClock: "none",
    idempotency:
      "(profile, clientRequestId) + payload hash in vanOperations; replay returns the stored ack, changed bytes conflict.",
    implementation: "implemented",
    note: "Requests loaded → active; the server checks trip status, date and device.",
  },
  {
    surface: "van-v1",
    channel: "push",
    entity: "load.confirm",
    authority: "server_workflow",
    writer: "device",
    stale: "immutable_after_send",
    ordering: "server_commit_order",
    deviceClock: "none",
    idempotency:
      "(profile, clientRequestId) + payload hash in vanOperations; the stock posting is keyed van-load:<loadId> in postMovement so it posts once.",
    implementation: "implemented",
    note: "Counted quantities are device facts; posting and discrepancy approval are server workflow.",
  },
  {
    surface: "van-v1",
    channel: "push",
    entity: "truck.damage",
    authority: "append_only_event",
    writer: "device",
    stale: "immutable_after_send",
    ordering: "server_commit_order",
    deviceClock: "none",
    idempotency:
      "(profile, clientRequestId) + payload hash in vanOperations; posting keyed van-damage:<profile>:<clientRequestId> in postMovement.",
    implementation: "implemented",
    note: "Available → damaged on the truck; never decrements below the server balance. VAN-020: a required photo is uploaded first (/van/v1/evidence, idempotent per seller + SHA-256) and named by photoSha256; large records wait for a supervisor, whose rejection posts a separate reversal movement.",
  },
  {
    surface: "van-v1",
    channel: "local",
    entity: "count.draft",
    authority: "device_draft",
    writer: "device",
    stale: "local_only",
    ordering: "local_only",
    deviceClock: "none",
    idempotency: "Not sent until submitted as a governed count.",
    implementation: "implemented",
    note: "Load check / end-of-day count in progress.",
  },
];

/** What the device does with an outcome. */
export type DeviceAction =
  /** Store the server ack and mark the outbox row done. */
  | "mark_done"
  /** Keep the row queued unchanged and retry with backoff. */
  | "retry_backoff"
  /** Stop sending, keep everything, recheck the device/session before continuing. */
  | "hold_outbox"
  /** Stop sending, take a fresh bootstrap, then resume the same queued bytes. */
  | "rebootstrap_then_resume"
  /** Freeze this one row as Needs review; later independent rows continue. */
  | "freeze_for_review"
  /** Keep the row queued; resend the same bytes after its dependency is acknowledged. */
  | "resend_after_dependency"
  /** Stop: the app must be updated before it syncs again. */
  | "update_app";

export type OutcomeRule = {
  readonly code: string;
  readonly surfaces: readonly OfflineSurface[];
  /** `result` = per-operation push result; `error` = whole-request error; `reason` = additive mobile v1 reason. */
  readonly level: "result" | "error" | "reason";
  readonly deviceAction: DeviceAction;
  /**
   * Whether the same queued bytes may be sent again: `automatic` (the phone resends once the cause
   * clears), `after_fix` (someone fixes the cause — rep or office — then the unchanged bytes are
   * resent), `never` (the record stays in review; any redo is a new record with a new ID).
   */
  readonly resendSameBytes: "automatic" | "after_fix" | "never";
  /** Plain words shown to the rep. */
  readonly userMessage: string;
  /** Who resolves it and how. */
  readonly remediation: string;
};

const both = ["mobile-v1", "van-v1"] as const;
const field = ["mobile-v1"] as const;
const van = ["van-v1"] as const;

export const OFFLINE_OUTCOMES: readonly OutcomeRule[] = [
  {
    code: "accepted",
    surfaces: both,
    level: "result",
    deviceAction: "mark_done",
    resendSameBytes: "never",
    userMessage: "Synced at <server time>",
    remediation: "None. The ack's serverTime is the official time.",
  },
  // Per-operation results.
  {
    code: "conflict",
    surfaces: both,
    level: "result",
    deviceAction: "freeze_for_review",
    resendSameBytes: "never",
    userMessage: "Needs review: this was already recorded differently.",
    remediation:
      "Same request ID with different content, another device, or a duplicate visit for the same stop. Nothing is merged automatically; the supervisor compares both and the rep re-records only if the office says so.",
  },
  {
    code: "invalid_request",
    surfaces: both,
    level: "result",
    deviceAction: "freeze_for_review",
    resendSameBytes: "never",
    userMessage: "Needs review: the office could not accept this entry.",
    remediation:
      "Malformed or out-of-range data (including a device clock too far from server time). Fix the phone's clock/app; the supervisor decides whether to re-record.",
  },
  {
    code: "unsupported_operation",
    surfaces: field,
    level: "result",
    deviceAction: "freeze_for_review",
    resendSameBytes: "after_fix",
    userMessage: "Saved on this phone; this feature is not switched on yet.",
    remediation:
      "Keep the record; it can be resent unchanged after the feature ships or recorded on paper.",
  },
  {
    code: "dependency_missing",
    surfaces: field,
    level: "result",
    deviceAction: "resend_after_dependency",
    resendSameBytes: "automatic",
    userMessage: "Waiting for the check-in to sync first.",
    remediation:
      "Automatic. If the earlier step itself needs review, this one joins it in review.",
  },
  {
    code: "out_of_scope",
    surfaces: both,
    level: "result",
    deviceAction: "freeze_for_review",
    resendSameBytes: "after_fix",
    userMessage:
      "Needs review: this store or trip is no longer assigned to you.",
    remediation:
      "Assignment changed while offline. The supervisor reassigns or voids the entry; the server never stores it under the wrong owner.",
  },
  {
    code: "evidence_pending_review",
    surfaces: field,
    level: "result",
    deviceAction: "freeze_for_review",
    resendSameBytes: "after_fix",
    userMessage: "Waiting for the supervisor to check the photo/location.",
    remediation:
      "Supervisor reviews the evidence on the web; nothing to redo unless asked.",
  },
  {
    code: "wrong_date",
    surfaces: van,
    level: "result",
    deviceAction: "freeze_for_review",
    resendSameBytes: "never",
    userMessage: "Needs review: this belongs to a different day's trip.",
    remediation:
      "Office closes or reopens the right trip; the server's service date wins.",
  },
  {
    code: "load_not_posted",
    surfaces: van,
    level: "result",
    deviceAction: "freeze_for_review",
    resendSameBytes: "after_fix",
    userMessage: "Needs review: the load has not been approved yet.",
    remediation:
      "Warehouse approves the load discrepancy, then the same entry is resent unchanged.",
  },
  {
    code: "photo_required",
    surfaces: van,
    level: "result",
    deviceAction: "freeze_for_review",
    resendSameBytes: "never",
    userMessage:
      "Needs review: this damage needs a photo the office did not receive.",
    remediation:
      "Record the damage again with a photo; the handheld uploads photos before sending damage.",
  },
  {
    // Emitted by the current backend as a result code although the frozen v1 enum lacks it (ADR-022 open item).
    code: "invalid_plan",
    surfaces: field,
    level: "result",
    deviceAction: "freeze_for_review",
    resendSameBytes: "never",
    userMessage: "Needs review: this planned stop changed after you saved it.",
    remediation:
      "The approved plan wins. Refresh the plan; the supervisor decides whether the visit is re-recorded as unplanned.",
  },
  // Additive mobile v1 reasons (code = invalid_request).
  {
    code: "call_open",
    surfaces: field,
    level: "reason",
    deviceAction: "freeze_for_review",
    resendSameBytes: "after_fix",
    userMessage: "Needs review: another call was still open.",
    remediation:
      "Close the earlier call; the supervisor decides whether the later check-in stands.",
  },
  {
    code: "mcp_order",
    surfaces: field,
    level: "reason",
    deviceAction: "freeze_for_review",
    resendSameBytes: "after_fix",
    userMessage: "Needs review: an earlier planned stop was skipped.",
    remediation:
      "Record or skip the earlier stop with a reason; server plan order wins over phone time.",
  },
  {
    code: "wrong_date",
    surfaces: field,
    level: "reason",
    deviceAction: "freeze_for_review",
    resendSameBytes: "never",
    userMessage: "Needs review: this visit is outside its day window.",
    remediation:
      "Late work within the window is accepted and flagged; older work is refused and handled by the supervisor.",
  },
  // Whole-request errors.
  {
    code: "rebootstrap_required",
    surfaces: field,
    level: "error",
    deviceAction: "rebootstrap_then_resume",
    resendSameBytes: "automatic",
    userMessage: "Refreshing today's plan…",
    remediation:
      "Automatic. Queued work is kept and resent after the refresh; anything no longer valid moves to review.",
  },
  {
    code: "invalid_cursor",
    surfaces: field,
    level: "error",
    deviceAction: "rebootstrap_then_resume",
    resendSameBytes: "automatic",
    userMessage: "Refreshing today's plan…",
    remediation: "Automatic.",
  },
  {
    code: "scope_changed",
    surfaces: field,
    level: "error",
    deviceAction: "rebootstrap_then_resume",
    resendSameBytes: "after_fix",
    userMessage: "Your assignment changed. Refreshing…",
    remediation:
      "Work from the old scope stays held for review and is never released into the new scope.",
  },
  {
    code: "unauthorized",
    surfaces: both,
    level: "error",
    deviceAction: "hold_outbox",
    resendSameBytes: "after_fix",
    userMessage: "Sign in again to continue syncing. Your saved work is kept.",
    remediation:
      "The phone rechecks its registration before deciding it was removed; a 401 alone never deletes work.",
  },
  {
    code: "device_revoked",
    surfaces: field,
    level: "error",
    deviceAction: "hold_outbox",
    resendSameBytes: "never",
    userMessage: "This phone was removed. Hand it to your supervisor.",
    remediation:
      "Supervised recovery per ADR-020; revoked uploads are never silently restored.",
  },
  {
    code: "version_unsupported",
    surfaces: both,
    level: "error",
    deviceAction: "update_app",
    resendSameBytes: "after_fix",
    userMessage: "Update the app to keep syncing. Your saved work is kept.",
    remediation: "Install the update; the queue survives upgrades.",
  },
  {
    code: "invalid_request",
    surfaces: both,
    level: "error",
    deviceAction: "hold_outbox",
    resendSameBytes: "after_fix",
    userMessage: "Sync needs attention. Contact support.",
    remediation:
      "Whole request refused (e.g. over-budget working set): support exports diagnostics; the office splits the plan.",
  },
  {
    code: "temporarily_unavailable",
    surfaces: both,
    level: "error",
    deviceAction: "retry_backoff",
    resendSameBytes: "automatic",
    userMessage: "Saved on device • N pending",
    remediation:
      "Automatic retry; transport failures and lost answers are handled the same way.",
  },
  // Codes the v1 error enum reserves for request-level use; the same meaning as their result form.
  {
    code: "conflict",
    surfaces: field,
    level: "error",
    deviceAction: "freeze_for_review",
    resendSameBytes: "never",
    userMessage: "Needs review: this was already recorded differently.",
    remediation: "As the per-operation conflict.",
  },
  {
    code: "unsupported_operation",
    surfaces: field,
    level: "error",
    deviceAction: "freeze_for_review",
    resendSameBytes: "after_fix",
    userMessage: "Saved on this phone; this feature is not switched on yet.",
    remediation: "As the per-operation result.",
  },
  {
    code: "dependency_missing",
    surfaces: field,
    level: "error",
    deviceAction: "resend_after_dependency",
    resendSameBytes: "automatic",
    userMessage: "Waiting for the check-in to sync first.",
    remediation: "As the per-operation result.",
  },
  {
    code: "out_of_scope",
    surfaces: field,
    level: "error",
    deviceAction: "freeze_for_review",
    resendSameBytes: "after_fix",
    userMessage:
      "Needs review: this store or trip is no longer assigned to you.",
    remediation: "As the per-operation result.",
  },
  {
    code: "evidence_pending_review",
    surfaces: field,
    level: "error",
    deviceAction: "freeze_for_review",
    resendSameBytes: "after_fix",
    userMessage: "Waiting for the supervisor to check the photo/location.",
    remediation: "As the per-operation result.",
  },
];

/** Retry, ordering and review defaults (ADR-019 values; provisional until Sunpride confirms). */
export const OFFLINE_POLICY = {
  /** Flip to "sunpride-approved" (and record the approval in ADR-022) once the client signs off. */
  source: "turbo-default" as "turbo-default" | "sunpride-approved",
  retry: {
    initialDelayMs: 5_000,
    maxDelayMs: 15 * 60_000,
    jitter: true,
    /** After this many failed attempts the status reads "Needs attention"; safe retries continue. */
    needsAttentionAfterAttempts: 5,
  },
  push: {
    /** Operations per push, sent oldest-first; one in-flight sync per device scope. */
    maxOperationsPerBatch: 20,
    maxDependsOn: 20,
  },
  pull: { maxChangesPerPage: 50 },
  /** A device time further ahead of server time than this is refused (visits/policy.ts maxDeviceSkewMs). */
  maxDeviceClockAheadMs: 24 * 60 * 60_000,
  /** Work older than this many days past its service date is refused; within it, accepted and flagged late. */
  lateWindowDays: 7,
  /** Server-side outcomes that are never auto-merged or auto-deleted. */
  neverAutoResolve: ["conflict", "out_of_scope", "evidence_pending_review"],
  /** The server time in an ack (or a postMovement commit) is the official business time. */
  officialTime: "server",
} as const;

export function authorityRule(
  surface: OfflineSurface,
  channel: OfflineChannel,
  entity: string,
): OfflineAuthorityRule | undefined {
  return OFFLINE_AUTHORITY_MATRIX.find(
    (rule) =>
      rule.surface === surface &&
      rule.channel === channel &&
      rule.entity === entity,
  );
}

export function outcomeRule(
  surface: OfflineSurface,
  level: OutcomeRule["level"],
  code: string,
): OutcomeRule | undefined {
  return OFFLINE_OUTCOMES.find(
    (rule) =>
      rule.level === level &&
      rule.code === code &&
      rule.surfaces.includes(surface),
  );
}
