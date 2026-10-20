import Foundation

/// The v2 wire boundary. Local DTOs and immutable v1 intent bytes are retained in SQLCipher;
/// only this adapter constructs the new envelopes. No legacy URL is ever requested.
enum NativeV2 {
    static let app = "field-ios"
    static let legacyEpoch = "bun-v2:"
    static func object(_ data: Data) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw MobileError.invalidResponse }
        return value
    }
    static func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    static func validate(_ data: Data) throws -> [String: Any] {
        let value = try object(data)
        guard value["version"] as? Int == 2 else { throw MobileError.invalidResponse }
        return value
    }
    static func pull(deviceId: String, scopeId: String, projection: String, params: [String: Any],
                     since: String? = nil, page: String? = nil, limit: Int = 100) throws -> Data {
        try bytes(["version": 2, "app": app, "deviceId": deviceId, "since": since as Any? ?? NSNull(),
                   "pageCursor": page as Any? ?? NSNull(), "limit": limit,
                   "scopes": [["scopeId": scopeId, "projection": projection, "params": params]]])
    }
    static func bundle(_ data: Data, scopeId: String, projection: String, mode: String) throws -> (envelope: [String: Any], bundle: [String: Any]) {
        let envelope = try validate(data)
        guard let serverTime = envelope["serverTime"] as? Int64, serverTime > 0,
              let bundles = envelope["bundles"] as? [[String: Any]], bundles.count == 1,
              let bundle = bundles.first, bundle["scopeId"] as? String == scopeId,
              bundle["projection"] as? String == projection, bundle["mode"] as? String == mode,
              let fingerprint = bundle["scopeFingerprint"] as? String, !fingerprint.isEmpty,
              let authorization = bundle["authorization"] as? [String: Any],
              let expiry = authorization["expiresAt"] as? Int64, expiry > serverTime,
              let epoch = authorization["epoch"] as? String, !epoch.isEmpty else { throw MobileError.invalidResponse }
        return (envelope, bundle)
    }
    static func operation(_ legacy: [String: Any]) throws -> [String: Any] {
        guard let id = legacy["clientRequestId"] as? String, UUID(uuidString: id) != nil,
              let kind = legacy["kind"] as? String, let payload = legacy["payload"] as? [String: Any],
              let time = (payload["deviceTime"] as? NSNumber)?.int64Value else { throw MobileError.invalidResponse }
        return ["clientOpId": id, "opType": kind, "clientTime": time,
                "dependsOn": legacy["dependsOn"] ?? [], "payload": payload]
    }
    static func push(deviceId: String, scopeId: String, operations: [[String: Any]]) throws -> Data {
        try bytes(["version": 2, "app": app, "deviceId": deviceId, "scopeId": scopeId, "operations": operations])
    }
    static func legacyResults(_ data: Data, location: Bool = false) throws -> Data {
        let value = try validate(data)
        guard let time = value["serverTime"] as? Int64, time > 0,
              let results = value["results"] as? [[String: Any]] else { throw MobileError.invalidResponse }
        let mapped = try results.map { item -> [String: Any] in
            guard let id = item["clientOpId"] as? String, let kind = item["opType"] as? String,
                  let status = item["status"] as? String, let retryable = item["retryable"] as? Bool else { throw MobileError.invalidResponse }
            // Retryable refusals retain unchanged operations; never freeze or prune uncertain work.
            if retryable { throw VisitSyncClient.Failure.retryable }
            var row = item
            row[location ? "clientPingId" : "clientRequestId"] = id
            row["kind"] = kind
            row["status"] = ["applied", "duplicate"].contains(status) ? "accepted" : status
            return row
        }
        return try bytes(["type": location ? "location.response" : "push.response", "contractVersion": 1,
                          "serverTime": time, "results": mapped])
    }
}

/// Typed errors contain only closed outcome codes, never server messages or response bodies.
struct NativeFailure: Error, Equatable {
    let code: String
    let action: String
    let retryable: Bool
    static func decode(_ data: Data, status: Int) -> NativeFailure {
        let value = try? NativeV2.object(data)
        let error = value?["error"] as? [String: Any]
        let codes: Set<String> = ["device_revoked", "device_suspended", "scope_withdrawn", "profile_unavailable",
            "scope_changed", "snapshot_changed", "cursor_expired", "cursor_invalid", "invalid_cursor", "rebootstrap_required",
            "version_unsupported", "rate_limited", "unauthorized", "session_invalid", "out_of_scope", "forbidden"]
        let raw = error?["code"] as? String ?? ""
        return NativeFailure(code: codes.contains(raw) ? raw : "request_refused",
                             action: error?["action"] as? String ?? "none", retryable: error?["retryable"] as? Bool ?? (status >= 500))
    }
    var withdraws: Bool { ["device_revoked", "device_suspended", "scope_withdrawn", "profile_unavailable"].contains(code) || action == "hold" }
}

@MainActor
final class NativeGateway {
    let site: URL
    let auth: AuthClient
    let registry: DeviceRegistry
    let http: HTTPClient
    let key: any DeviceSigningKey
    init(site: URL, auth: AuthClient, registry: DeviceRegistry, http: HTTPClient, key: any DeviceSigningKey) {
        self.site = site; self.auth = auth; self.registry = registry; self.http = http; self.key = key
    }
    func post(_ path: String, body: Data, deviceId: String) async throws -> Data {
        for attempt in 0..<2 {
            let token = try await auth.bearerToken(forceRefresh: attempt > 0)
            let challenge = try await registry.challenge(deviceId: deviceId)
            let timestamp = try challenge.proofTime()
            let request = try RequestSigner(key: key).request(site: site, path: path, body: body,
                deviceId: deviceId, nonce: challenge.nonce, timestamp: timestamp, jwt: token)
            let (data, response) = try await http.send(request)
            try Task.checkCancellation()
            if response.statusCode == 401 {
                auth.invalidateToken()
                if attempt == 0 { continue }
                throw MobileError.unauthorized
            }
            guard (200..<300).contains(response.statusCode) else {
                if response.statusCode == 429 { throw MobileError.rateLimited }
                throw NativeFailure.decode(data, status: response.statusCode)
            }
            _ = try NativeV2.validate(data)
            return data
        }
        throw MobileError.unauthorized
    }
}
