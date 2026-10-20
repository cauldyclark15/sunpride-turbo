import Foundation
@testable import FieldIOS

/// Reuses frozen v1/local DTO fixtures for behavioral regression tests. The app sends actual v2
/// requests; this TEST-ONLY boundary converts fixture dialects. NativeV2TransportTests uses raw
/// StubURLProtocol.install instead and asserts the actual v2 wire without this adapter.
enum V2FixtureHarness {
    static func request(_ raw: StubURLProtocol.Recorded) -> StubURLProtocol.Recorded {
        var path = raw.path, method = raw.method, body = raw.body
        let value = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        func encoded(_ object: Any) -> Data { (try? JSONSerialization.data(withJSONObject: object, options: .sortedKeys)) ?? Data() }
        switch path {
        case "/api/auth/sign-in":
            path = "/api/auth/sign-in/email"; body = encoded(["email": value["email"] ?? "", "password": value["password"] ?? ""])
        case "/api/auth/refresh": path = "/legacy/auth/token"; method = "GET"; body = Data()
        case "/api/auth/sign-out": body = Data("{}".utf8)
        case "/api/me": path = "/api/query"; method = "POST"; body = encoded(["path": "domains/profiles:current", "args": [:], "format": "json"])
        case "/api/devices/challenge", "/api/devices/bind":
            let name = path.hasSuffix("challenge") ? "mobile/devices:challenge" : "mobile/devices:bind"
            path = "/api/mutation"; var args = value; args.removeValue(forKey: "version")
            body = encoded(["path": name, "args": args, "format": "json"])
        case "/api/sync/pull":
            let scopes = value["scopes"] as? [[String: Any]] ?? []
            let projection = scopes.first?["projection"] as? String ?? ""
            let params = scopes.first?["params"] as? [String: Any] ?? [:]
            if projection == "field.bundle" {
                let delta = value["since"] is String
                path = delta ? "/mobile/v1/pull" : "/mobile/v1/bootstrap"
                var fields: [String: Any] = ["type": delta ? "pull.request" : "bootstrap.request", "contractVersion": 1,
                    "deviceId": value["deviceId"] ?? "", "limit": value["limit"] ?? 100]
                if delta { fields["cursor"] = value["since"] }
                else if value["pageCursor"] is String { fields["pageCursor"] = value["pageCursor"] }
                else { fields["referenceData"] = true }
                body = encoded(fields)
            } else {
                path = "/api/query"
                body = encoded(["path": projection == "team.summary" ? "supervision/mobile:team" : "analytics/suggested_orders:forOutlet", "args": params, "format": "json"])
            }
        case "/api/sync/push":
            let operations = value["operations"] as? [[String: Any]] ?? []
            let location = operations.first?["opType"] as? String == "location.record"
            path = location ? "/mobile/v1/location" : "/mobile/v1/push"
            if location {
                body = encoded(["type": "location.request", "contractVersion": 1, "deviceId": value["deviceId"] ?? "",
                                "pings": operations.map { $0["payload"] ?? [:] }])
            } else {
                body = encoded(["type": "push.request", "contractVersion": 1, "deviceId": value["deviceId"] ?? "",
                    "operations": operations.map { op -> [String: Any] in
                        var row: [String: Any] = ["kind": op["opType"] ?? "", "clientRequestId": op["clientOpId"] ?? "", "payload": op["payload"] ?? [:]]
                        if let dependencies = op["dependsOn"] as? [String], !dependencies.isEmpty { row["dependsOn"] = dependencies }
                        return row
                    }])
            }
        default: break
        }
        return .init(method: method, path: path, headers: raw.headers, body: body)
    }
    static func reply(_ reply: StubURLProtocol.Reply, raw: StubURLProtocol.Recorded, scopeFingerprint: String = "scope-1") -> StubURLProtocol.Reply {
        guard let value = (try? JSONSerialization.jsonObject(with: reply.body)) as? [String: Any] else { return reply }
        if value["version"] as? Int == 2 { return reply }
        let legacy = request(raw)
        let time = value["serverTime"] as? Int64 ?? 1_800_000_000_000
        let rawObject = (try? JSONSerialization.jsonObject(with: raw.body)) as? [String: Any] ?? [:]
        if value["status"] as? String == "error" {
            let code = value["errorData"] as? String ?? "forbidden"
            return .json(code == "rate_limited" ? 429 : 403, ["version": 2, "serverTime": time,
                "error": ["code": code, "retryable": code == "rate_limited", "action": "none"]])
        }
        if reply.status >= 400 {
            let oldError = value["error"] as? [String: Any] ?? value
            let code = oldError["code"] as? String ?? value["errorData"] as? String ?? "forbidden"
            return .json(reply.status == 560 ? 403 : reply.status, ["version": 2, "serverTime": time,
                "error": ["code": code, "retryable": oldError["retryable"] ?? false,
                          "action": ["rebootstrap_required", "invalid_cursor", "scope_changed"].contains(code) ? "rebootstrap" : code == "version_unsupported" ? "update" : "none"]])
        }
        if raw.path == "/api/auth/refresh" {
            guard let token = value["token"] as? String, let expiry = AuthClient.expiry(ofJWT: token) else { return .json(200, ["version": 2]) }
            return .json(200, ["version": 2, "serverTime": Int64(expiry.timeIntervalSince1970 * 1000) - 900_000,
                               "accessToken": token, "accessExpiresAt": Int64(expiry.timeIntervalSince1970 * 1000)])
        }
        if raw.path == "/api/auth/sign-in" {
            let token = reply.headers["set-auth-token"] ?? value["token"]
            return .json(200, ["version": 2, "serverTime": time, "sessionToken": token ?? NSNull(),
                               "accessToken": "fixture-access", "accessExpiresAt": time + 900_000])
        }
        if raw.path == "/api/me" {
            let profile = value["value"] as? [String: Any] ?? [:]
            return .json(200, ["version": 2, "serverTime": time,
                "profile": ["id": profile["_id"] ?? "employee-1", "subject": profile["authSubject"] ?? "issuer|seller"],
                "scope": ["id": "unit-1", "fingerprint": scopeFingerprint, "epoch": "test"],
                "device": ["id": "device-1", "status": "active", "bound": true, "allowedApp": "field-ios"]])
        }
        if raw.path.hasPrefix("/api/devices/") {
            var result = value["value"] as? [String: Any] ?? value; result["version"] = 2
            // Frozen fixtures that never modelled the v2 per-request proof challenge get a fresh one.
            if raw.path == "/api/devices/challenge", result["nonce"] == nil {
                result["nonce"] = UUID().uuidString.lowercased(); result["expiresAt"] = time + 60_000; result["serverTime"] = time
            }
            return .json(reply.status, result)
        }
        if raw.path == "/api/sync/pull" {
            let scopes = rawObject["scopes"] as? [[String: Any]] ?? []
            let projection = scopes.first?["projection"] as? String ?? "field.bundle"
            let delta = rawObject["since"] is String
            let more = value["nextPageCursor"] is String || value["hasMore"] as? Bool == true
            var data = value
            let fingerprint = (value["scope"] as? [String: Any])?["fingerprint"] as? String ?? scopeFingerprint
            for key in ["type", "contractVersion", "serverTime", "page", "nextPageCursor", "syncCursor"] { data.removeValue(forKey: key) }
            if projection != "field.bundle" {
                if value["status"] as? String == "error" {
                    return .json(403, ["version": 2, "error": ["code": "forbidden", "action": "none", "retryable": false]])
                }
                data = value["value"] as? [String: Any] ?? value
            }
            let config = value["appConfig"] as? [String: Any] ?? [:]
            var bundle: [String: Any] = ["scopeId": scopes.first?["scopeId"] ?? "unit-1", "scopeFingerprint": fingerprint,
                "projection": projection, "params": scopes.first?["params"] ?? [:], "mode": delta ? "delta" : "snapshot", "complete": delta || !more]
            bundle["authorization"] = ["grantId": "test-grant", "epoch": "test", "expiresAt": config["cacheExpiresAt"] ?? (time + 900_000)] as [String: Any]
            bundle["offlineLease"] = ["expiresAt": config["offlineLeaseExpiresAt"] ?? (time + 900_000)]
            bundle["data"] = delta ? NSNull() as Any : data as Any
            bundle["changes"] = value["changes"] ?? []
            var envelope: [String: Any] = ["version": 2, "serverTime": time, "hasMore": more, "bundles": [bundle]]
            envelope["snapshotId"] = delta ? NSNull() as Any : "fixture-snapshot" as Any
            envelope["nextPageCursor"] = delta ? NSNull() : value["nextPageCursor"] ?? NSNull()
            envelope["nextCursor"] = delta ? value["nextCursor"] ?? NSNull() : value["syncCursor"] ?? (more ? NSNull() as Any : "fixture-cursor" as Any)
            return .json(reply.status, envelope)
        }
        if raw.path == "/api/sync/push" {
            guard let rows = value["results"] as? [[String: Any]] else { return reply }
            let operations = rawObject["operations"] as? [[String: Any]] ?? []
            return .json(reply.status, ["version": 2, "serverTime": time, "results": rows.enumerated().map { i, old -> [String: Any] in
                var row = old
                row["clientOpId"] = old["clientRequestId"] ?? old["clientPingId"] ?? ""
                row["opType"] = old["kind"] ?? (i < operations.count ? operations[i]["opType"] : "")
                row["status"] = old["status"] as? String == "accepted" ? "applied" : old["status"]
                row["retryable"] = false
                return row
            }])
        }
        _ = legacy
        return reply
    }
}
