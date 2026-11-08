import Foundation

/// Foreground-only, single-flight at the AppModel boundary. The store owns every durable transition.
@MainActor
final class VisitSyncClient {
    enum Failure: Error, Equatable { case rebootstrap, unauthorized, revoked, updateRequired, retryable, invalidResponse
        /// QSR-009 back-off (HTTP 429 or a refused challenge): keep work queued and retry on a later
        /// sync, never immediately — an immediate retry would only be refused again.
        case throttled
    }
    private let site: URL
    private let auth: AuthClient
    private let registry: DeviceRegistry
    private let http: HTTPClient
    private let key: any DeviceSigningKey

    init(site: URL, auth: AuthClient, registry: DeviceRegistry, http: HTTPClient, key: any DeviceSigningKey) {
        self.site = site; self.auth = auth; self.registry = registry; self.http = http; self.key = key
    }

    private struct PullRequest: Encodable {
        let type = "pull.request"; let contractVersion = 1
        let deviceId: String; let cursor: String; let limit = 50
    }
    private struct PullPage: Decodable {
        let type: String; let contractVersion: Int; let serverTime: Int64
        let changes: [DeltaChange]; let nextCursor: String; let hasMore: Bool
    }
    private func operation(_ item: OutboxItem) throws -> Any {
        guard let object = try JSONSerialization.jsonObject(with: item.intent.operationJSON) as? [String: Any],
              object["clientRequestId"] as? String == item.intent.requestId.uuidString.lowercased(),
              object["kind"] as? String == item.intent.kind else { throw Failure.invalidResponse }
        return object
    }
    private func body(deviceId: String, scopeId: String, items: [OutboxItem]) throws -> Data {
        guard (1...20).contains(items.count) else { throw Failure.invalidResponse }
        return try NativeV2.push(deviceId: deviceId, scopeId: scopeId, operations: items.map {
            try NativeV2.operation(try operation($0) as! [String: Any])
        })
    }
    private func post(path: String, body: Data, deviceId: String) async throws -> Data {
        do {
            return try await NativeGateway(site: site, auth: auth, registry: registry, http: http, key: key)
                .post(path, body: body, deviceId: deviceId)
        } catch let error as NativeFailure {
            if error.withdraws { throw Failure.revoked }
            if error.action == "rebootstrap" || ["scope_changed", "cursor_invalid", "cursor_expired", "snapshot_changed", "rebootstrap_required"].contains(error.code) { throw Failure.rebootstrap }
            if error.action == "update" { throw Failure.updateRequired }
            throw error.retryable ? Failure.retryable : Failure.invalidResponse
        } catch MobileError.rateLimited { throw Failure.throttled }
        catch MobileError.unauthorized { throw Failure.unauthorized }
    }
    private func withBackoff(_ send: () async throws -> Data) async throws -> Data {
        for attempt in 0..<3 {
            do { return try await send() }
            catch Failure.retryable where attempt < 2 { }
            catch let error as Failure { throw error }
            catch MobileError.sessionExpired { throw Failure.unauthorized }
            catch MobileError.notSignedIn { throw Failure.unauthorized }
            catch MobileError.unauthorized { throw Failure.unauthorized }
            catch is CancellationError { throw CancellationError() }
            catch { if attempt == 2 { throw Failure.retryable } }
            // Only transport failures and explicit retryable failures are retried.
            let base = 200 * (1 << attempt)
            try await Task.sleep(for: .milliseconds(base + Int.random(in: 0..<base)))
        }
        throw Failure.retryable
    }
    /// Return only after every result is durable. An uncertain batch is resent with exactly the
    /// same persisted operation bytes and keys; only proof nonce/timestamp and envelope change.
    func push(store: any FieldLocalStore, partition: StorePartition) async throws {
        guard try !store.isHeld(partition) else { return }
        guard try store.isLeaseValid(now: Date(), for: partition) else { throw Failure.rebootstrap }
        for _ in 0..<100 {
            try Task.checkCancellation()
            // Materialize dependencies only after the check-in ack is durable. If check-in was
            // rejected, freeze dependent work instead of sending a bogus visit ID.
            for item in try store.deferredOutbox(for: partition) {
                guard let object = try? JSONSerialization.jsonObject(with: item.intent.operationJSON) as? [String: Any],
                      let key = (object["dependsOn"] as? [String])?.first,
                      let id = UUID(uuidString: key) else { throw Failure.invalidResponse }
                if let ack = try store.ack(for: id, in: partition) {
                    // Activity ack is an activity ID, not a visit ID: a dependent activity and
                    // checkout both reference the original check-in UUID directly.
                    if let source = try store.intent(for: id, in: partition), source.kind == "visit.checkIn" {
                        try store.materialize(item.intent.requestId, visitId: ack.entityId, in: partition)
                    } else { try store.recordRejection(code: "dependency_missing", for: item.intent.requestId, in: partition) }
                } else if try store.reviewOutbox(for: partition).contains(where: { $0.intent.requestId == id }) {
                    try store.recordRejection(code: "dependency_missing", for: item.intent.requestId, in: partition)
                }
            }
            let pending = try store.pendingOutbox(for: partition)
            guard !pending.isEmpty else { return }
            // Stop at the first unresolved deferred sequence. Don't reorder later operations.
            let boundary = try store.deferredOutbox(for: partition).first?.sequence ?? .max
            let batch = Array(pending.prefix(while: { $0.sequence < boundary }).prefix(20))
            guard !batch.isEmpty else { return }
            guard let employee = try store.snapshot(for: partition)?.employee else { throw Failure.rebootstrap }
            let bytes = try body(deviceId: partition.deviceId, scopeId: employee.orgUnitId ?? "unscoped", items: batch)
            let data = try await withBackoff { try await self.post(path: "/api/sync/push", body: bytes, deviceId: partition.deviceId) }
            try Task.checkCancellation()
            let result: BootstrapV1.PushResultEnvelope
            do { result = try JSONDecoder().decode(BootstrapV1.PushResultEnvelope.self, from: NativeV2.legacyResults(data)) }
            catch let error as Failure { throw error }
            catch { throw Failure.invalidResponse }
            guard result.results.count == batch.count else { throw Failure.invalidResponse }
            for (item, outcome) in zip(batch, result.results) {
                try Task.checkCancellation()
                guard try !store.isHeld(partition) else { return }
                guard outcome.clientRequestId == item.intent.requestId.uuidString.lowercased(),
                      outcome.kind.rawValue == item.intent.kind else { throw Failure.invalidResponse }
                switch outcome.status.rawValue {
                case "accepted":
                    guard let ack = outcome.ack else { throw Failure.invalidResponse }
                    try store.recordAck(ServerAck(entityId: ack.entityId, eventIds: ack.eventIds,
                        serverTime: ack.serverTime), for: item.intent.requestId, in: partition)
                case "rejected", "conflict":
                    let allowedCodes: Set<String> = ["invalid_request", "invalid_plan", "conflict", "dependency_missing",
                        "unsupported_operation", "out_of_scope", "evidence_pending_review", "invalid_transition", "call_open", "mcp_order",
                        "wrong_date", "idempotency_conflict", "stock_conflict", "load_not_posted", "place_mismatch", "mock_location_refused"]
                    let raw = outcome.reason.flatMap { allowedCodes.contains($0) ? $0 : nil }
                        ?? outcome.code?.rawValue ?? outcome.status.rawValue
                    try store.recordRejection(code: allowedCodes.contains(raw) ? raw : "unknown_code",
                        for: item.intent.requestId, in: partition)
                default:
                    try store.recordRejection(code: "unknown_status", for: item.intent.requestId, in: partition)
                }
            }
        }
        throw Failure.retryable // bounded foreground work, resume on the next tap
    }
    func pull(store: any FieldLocalStore, partition: StorePartition) async throws {
        guard try !store.isHeld(partition) else { return }
        var seen = Set<String>()
        for _ in 0..<100 {
            try Task.checkCancellation()
            guard let cursor = try store.cursor(for: partition), !cursor.isEmpty,
                  seen.insert(cursor).inserted else { throw Failure.rebootstrap }
            guard let employee = try store.snapshot(for: partition)?.employee else { throw Failure.rebootstrap }
            let scopeId = employee.orgUnitId ?? "unscoped"
            let body = try NativeV2.pull(deviceId: partition.deviceId, scopeId: scopeId, projection: "field.bundle",
                params: ["dayFrom": BootstrapClient.manilaDay(Date())], since: cursor, limit: 50)
            let raw = try await withBackoff { try await self.post(path: "/api/sync/pull", body: body, deviceId: partition.deviceId) }
            let decoded = try NativeV2.bundle(raw, scopeId: scopeId, projection: "field.bundle", mode: "delta")
            guard NativeV2.legacyEpoch + (decoded.bundle["scopeFingerprint"] as? String ?? "") == partition.scope else { throw Failure.rebootstrap }
            let data = try NativeV2.bytes(["type": "pull.response", "contractVersion": 1,
                "serverTime": decoded.envelope["serverTime"] as Any, "changes": decoded.bundle["changes"] as Any,
                "nextCursor": decoded.envelope["nextCursor"] as Any, "hasMore": decoded.envelope["hasMore"] as Any])
            try Task.checkCancellation()
            let page: PullPage
            do { page = try JSONDecoder().decode(PullPage.self, from: data) }
            catch { throw Failure.invalidResponse }
            guard page.type == "pull.response", page.contractVersion == 1,
                  page.serverTime > 0, !page.nextCursor.isEmpty,
                  (!page.hasMore || page.nextCursor != cursor), page.changes.count <= 50 else { throw Failure.invalidResponse }
            guard try !store.isHeld(partition) else { return }
            try store.applyDelta(page.changes, nextCursor: page.nextCursor, for: partition)
            if !page.hasMore { return }
        }
        throw Failure.retryable
    }

    private struct LocationResult: Decodable { let clientPingId: String; let status: String; let code: String? }
    private struct LocationResponse: Decodable {
        let type: String; let contractVersion: Int; let serverTime: Int64; let results: [LocationResult]
    }
    /// SP-0138: upload buffered live-location pings (`/mobile/v1/location`, at most 100 per signed batch).
    /// Every per-ping answer is final — `accepted` and `duplicate` are stored, a `rejected` ping is one the
    /// server will never take (outside hours, too old, too frequent…) — so each answered ping leaves the
    /// buffer. A transport failure or refused proof keeps the whole batch for the next try, same IDs.
    /// Returns the rejection codes seen (for status only).
    @discardableResult
    func pushLocation(store: any LiveLocationStore, partition: StorePartition, now: Date = Date()) async throws -> [String] {
        guard try !store.isHeld(partition) else { return [] }
        try store.dropPings(recordedBefore: Int64((now.timeIntervalSince1970 - LiveLocationPolicy.maxAge) * 1000), for: partition)
        var rejected: [String] = []
        for _ in 0..<20 {
            try Task.checkCancellation()
            let batch = try store.pendingPings(for: partition, limit: LiveLocationPolicy.maxBatch)
            guard !batch.isEmpty else { return rejected }
            let me = try await ServerAPI(url: site, auth: auth, http: http).currentMe()
            guard let scope = me["scope"] as? [String: Any], let scopeId = scope["id"] as? String,
                  NativeV2.legacyEpoch + (scope["fingerprint"] as? String ?? "") == partition.scope else { throw Failure.rebootstrap }
            let operations: [[String: Any]] = batch.map { ping in
                ["clientOpId": ping.clientPingId.uuidString.lowercased(), "opType": "location.record",
                 "clientTime": ping.recordedAt, "dependsOn": [], "payload": ping.wireObject]
            }
            let bytes = try NativeV2.push(deviceId: partition.deviceId, scopeId: scopeId, operations: operations)
            let raw = try await withBackoff { try await self.post(path: "/api/sync/push", body: bytes, deviceId: partition.deviceId) }
            let data = try NativeV2.legacyResults(raw, location: true)
            try Task.checkCancellation()
            let response: LocationResponse
            do { response = try JSONDecoder().decode(LocationResponse.self, from: data) }
            catch { throw Failure.invalidResponse }
            guard response.type == "location.response", response.contractVersion == 1,
                  response.results.count == batch.count,
                  zip(batch, response.results).allSatisfy({ $0.clientPingId.uuidString.lowercased() == $1.clientPingId }),
                  response.results.allSatisfy({ ["accepted", "duplicate", "rejected"].contains($0.status) })
            else { throw Failure.invalidResponse }
            rejected += response.results.filter { $0.status == "rejected" }.map { $0.code ?? "unknown_code" }
            guard try !store.isHeld(partition) else { return rejected }
            try store.removePings(batch.map(\.clientPingId), for: partition)
        }
        throw Failure.retryable // bounded; the rest goes on the next upload
    }
}
