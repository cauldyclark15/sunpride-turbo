import Foundation

/// Foreground-only, single-flight at the AppModel boundary. The store owns every durable transition.
@MainActor
final class VisitSyncClient {
    enum Failure: Error, Equatable { case rebootstrap, unauthorized, revoked, updateRequired, retryable, invalidResponse }
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
    private func body(deviceId: String, items: [OutboxItem]) throws -> Data {
        guard (1...20).contains(items.count) else { throw Failure.invalidResponse }
        return try JSONSerialization.data(withJSONObject: ["type": "push.request", "contractVersion": 1,
            "deviceId": deviceId, "operations": try items.map(operation)], options: [.sortedKeys])
    }
    private func post(path: String, body: Data, deviceId: String) async throws -> Data {
        for attempt in 0..<2 {
            let jwt = try await auth.convexToken(forceRefresh: attempt > 0)
            let challenge = try await registry.challenge(deviceId: deviceId)
            guard challenge.expiresAt.isFinite, challenge.expiresAt > 30_000,
                  challenge.expiresAt < 9_007_199_254_740_991 else { throw Failure.invalidResponse }
            let timestamp = Int64(challenge.expiresAt) - 30_000
            let request = try RequestSigner(key: key).request(site: site, path: path, body: body,
                deviceId: deviceId, nonce: challenge.nonce, timestamp: timestamp, jwt: jwt)
            let (data, response) = try await http.send(request)
            if let version = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["contractVersion"] as? Int,
               version != 1 { throw Failure.updateRequired }
            if let error = try? BootstrapV1.decodeFailure(data) {
                switch error.error.code.rawValue {
                case "device_revoked": throw Failure.revoked
                case "version_unsupported": throw Failure.updateRequired
                case "rebootstrap_required", "invalid_cursor", "scope_changed": throw Failure.rebootstrap
                default: break
                }
            }
            if response.statusCode == 401 {
                auth.invalidateToken()
                if attempt == 0 { continue }
                throw Failure.unauthorized // A masked 401 does not establish revocation.
            }
            if response.statusCode == 409 { throw Failure.rebootstrap }
            guard response.statusCode == 200 else {
                throw response.statusCode >= 500 ? Failure.retryable : Failure.invalidResponse
            }
            return data
        }
        throw Failure.unauthorized
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
            let bytes = try body(deviceId: partition.deviceId, items: batch)
            let data = try await withBackoff { try await self.post(path: "/mobile/v1/push", body: bytes, deviceId: partition.deviceId) }
            try Task.checkCancellation()
            let result: BootstrapV1.PushResultEnvelope
            do { result = try JSONDecoder().decode(BootstrapV1.PushResultEnvelope.self, from: data) }
            catch { throw Failure.invalidResponse }
            guard result.results.count == batch.count else { throw Failure.invalidResponse }
            for (item, outcome) in zip(batch, result.results) {
                try Task.checkCancellation()
                guard outcome.clientRequestId == item.intent.requestId.uuidString.lowercased(),
                      outcome.kind.rawValue == item.intent.kind else { throw Failure.invalidResponse }
                switch outcome.status.rawValue {
                case "accepted":
                    guard let ack = outcome.ack else { throw Failure.invalidResponse }
                    try store.recordAck(ServerAck(entityId: ack.entityId, eventIds: ack.eventIds,
                        serverTime: ack.serverTime), for: item.intent.requestId, in: partition)
                case "rejected", "conflict":
                    let allowedCodes: Set<String> = ["invalid_request", "invalid_plan", "conflict", "dependency_missing",
                        "unsupported_operation", "out_of_scope", "evidence_pending_review", "invalid_transition"]
                    let raw = outcome.code?.rawValue ?? outcome.status.rawValue
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
            let body = try JSONEncoder().encode(PullRequest(deviceId: partition.deviceId, cursor: cursor))
            let data = try await withBackoff { try await self.post(path: "/mobile/v1/pull", body: body, deviceId: partition.deviceId) }
            try Task.checkCancellation()
            let page: PullPage
            do { page = try JSONDecoder().decode(PullPage.self, from: data) }
            catch { throw Failure.invalidResponse }
            guard page.type == "pull.response", page.contractVersion == 1,
                  page.serverTime > 0, !page.nextCursor.isEmpty,
                  (!page.hasMore || page.nextCursor != cursor), page.changes.count <= 50 else { throw Failure.invalidResponse }
            try store.applyDelta(page.changes, nextCursor: page.nextCursor, for: partition)
            if !page.hasMore { return }
        }
        throw Failure.retryable
    }
}
