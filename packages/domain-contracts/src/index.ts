/** Canonical mobile v1 wire shapes, explicitly mapped from schemas/mobile-v1.schema.json; do not hand-add enum values. */
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../schemas/mobile-v1.schema.json";

export type BootstrapRequest = {
  type: "bootstrap.request";
  contractVersion: 1;
  deviceId: string;
  dayFrom?: string;
  pageCursor?: string;
  limit?: number;
};
export type BootstrapResponse = {
  type: "bootstrap.response";
  contractVersion: 1;
  serverTime: number;
  permissions: Array<string>;
  employee: { id: string; role: string; orgUnitId: string };
  scope: { fingerprint: string; orgUnitIds: Array<string> };
  appConfig: {
    offlineLeaseExpiresAt: number;
    cacheExpiresAt: number;
    orderCaptureEnabled: boolean;
    priceAvailability: "unavailable";
    promotionsAvailability: "unavailable";
  };
  plannedVisits: Array<{
    id: string;
    outletId: string;
    serviceDate: string;
    planId: string;
    planVersion: number;
    intents: Array<string>;
  }>;
  outlets: Array<{ id: string; name: string; routeId: string | null }>;
  localCustomers: Array<{ id: string; code: string }>;
  route: { id: string; code: string } | null;
  tasks: Array<{ id: string; kind: string; required: boolean }>;
  productCatalog: Array<{
    id: string;
    code: string;
    name: string;
    uom: string;
  }>;
  page: number;
  nextPageCursor: string | null;
  syncCursor: string | null;
};
export type PullRequest = {
  type: "pull.request";
  contractVersion: 1;
  deviceId: string;
  cursor: string;
  limit: number;
};
export type PullResponse = {
  type: "pull.response";
  contractVersion: 1;
  serverTime: number;
  changes: Array<{
    seq: number;
    entity: string;
    id: string;
    revision: number;
    op: "upsert" | "tombstone";
    value?: Record<string, unknown>;
  }>;
  nextCursor: string;
  hasMore: boolean;
};
export type PushRequest = {
  type: "push.request";
  contractVersion: 1;
  deviceId: string;
  operations: Array<
    | {
        kind: "visit.checkIn";
        clientRequestId: string;
        dependsOn?: Array<string>;
        payload: {
          clientVisitId: string;
          plannedVisitId: string | null;
          outletId: string;
          serviceDate: string;
          deviceTime: number;
          location: {
            latitude: number;
            longitude: number;
            accuracyMeters: number;
            provider: "gps" | "network" | "fused" | "unknown";
            mockSignal?: boolean;
            fixTime: number;
          } | null;
          unplannedReason?: string;
          intents: Array<
            | "sell"
            | "collect"
            | "merchandise"
            | "audit"
            | "deliver"
            | "promotion"
            | "complaint"
            | "follow-up"
          >;
        };
      }
    | {
        kind: "visit.activity";
        clientRequestId: string;
        dependsOn?: Array<string>;
        payload: {
          visitId: string;
          activity:
            | {
                kind: "inventory_check";
                productId: string;
                icoFinding: "present" | "absent" | "unknown";
                observedQuantity?: number | null;
              }
            | {
                kind: "merchandising";
                displayCondition: "compliant" | "needs_action" | "not_present";
                actionTaken?: string;
              }
            | {
                kind: "price_check";
                productId: string;
                observedPriceMinor: number;
                currency: string;
                compliant?: boolean | null;
              }
            | {
                kind: "promotion";
                programRef: string;
                finding: "executed" | "not_executed" | "not_applicable";
              }
            | { kind: "order_intent"; clientOrderId: string; note?: string }
            | { kind: "note"; text: string };
          deviceTime: number;
        };
      }
    | {
        kind: "visit.checkOut";
        clientRequestId: string;
        dependsOn?: Array<string>;
        payload: {
          visitId: string;
          outcome: "completed" | "nonproductive";
          reasonCode: string | null;
          deviceTime: number;
          location: {
            latitude: number;
            longitude: number;
            accuracyMeters: number;
            provider: "gps" | "network" | "fused" | "unknown";
            mockSignal?: boolean;
            fixTime: number;
          } | null;
        };
      }
    | {
        kind: "task.complete";
        clientRequestId: string;
        dependsOn?: Array<string>;
        payload: { referenceId: string; deviceTime: number };
      }
    | {
        kind: "collection.record";
        clientRequestId: string;
        dependsOn?: Array<string>;
        payload: { referenceId: string; deviceTime: number };
      }
  >;
};
export type PushResponse = {
  type: "push.response";
  contractVersion: 1;
  serverTime: number;
  results: Array<{
    kind:
      | "visit.checkIn"
      | "visit.activity"
      | "visit.checkOut"
      | "task.complete"
      | "collection.record";
    clientRequestId: string;
    status: "accepted" | "rejected" | "conflict";
    code?:
      | "conflict"
      | "unsupported_operation"
      | "dependency_missing"
      | "out_of_scope"
      | "evidence_pending_review"
      | "invalid_request";
    ack?: { entityId: string; eventIds: Array<string>; serverTime: number };
  }>;
};
export type ErrorResponse = {
  type: "error.response";
  contractVersion: 1;
  serverTime: number;
  error: {
    code:
      | "rebootstrap_required"
      | "conflict"
      | "unsupported_operation"
      | "device_revoked"
      | "scope_changed"
      | "version_unsupported"
      | "unauthorized"
      | "invalid_request"
      | "invalid_cursor"
      | "dependency_missing"
      | "out_of_scope"
      | "evidence_pending_review"
      | "temporarily_unavailable";
    message: string;
    retryable: boolean;
    details?: { field: string } | null;
  };
};

export type MobileV1Request = BootstrapRequest | PullRequest | PushRequest;
export type MobileV1Response =
  BootstrapResponse | PullResponse | PushResponse | ErrorResponse;
export type MobileV1Envelope = MobileV1Request | MobileV1Response;
export type PushOperation = PushRequest["operations"][number];
export type PushActivity = Extract<
  PushOperation,
  { kind: "visit.activity" }
>["payload"]["activity"];
export type PushResult = PushResponse["results"][number];
export type MobileErrorCode = ErrorResponse["error"]["code"];

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

/** Structural wire validation; authorization and cross-record policies remain server-side. */
export function isMobileV1Envelope(value: unknown): value is MobileV1Envelope {
  return validate(value) === true;
}
export function parseMobileV1Envelope(value: unknown): MobileV1Envelope {
  if (!isMobileV1Envelope(value)) {
    throw new Error(
      `Invalid mobile v1 envelope: ${ajv.errorsText(validate.errors)}`,
    );
  }
  return value;
}
export function parseMobileV1Request(value: unknown): MobileV1Request {
  const envelope = parseMobileV1Envelope(value);
  if (!envelope.type.endsWith(".request"))
    throw new Error("Expected mobile v1 request");
  return envelope as MobileV1Request;
}
export function parseMobileV1Response(value: unknown): MobileV1Response {
  const envelope = parseMobileV1Envelope(value);
  if (!envelope.type.endsWith(".response"))
    throw new Error("Expected mobile v1 response");
  return envelope as MobileV1Response;
}

/** Decode response enums without guessing a transition or losing the raw value. Requests remain strict. */
export function decodeResponseEnum<const T extends readonly string[]>(
  raw: string,
  known: T,
): T[number] | { readonly unknown: string } {
  return known.includes(raw) ? (raw as T[number]) : { unknown: raw };
}
