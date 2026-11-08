import Foundation

/// Authenticated calls to the Sunpride server: `GET /api/me`, `POST /api/devices/{challenge,bind}`, and the
/// device-signed `POST /api/sync/pull` projections (team summary, suggested order). Callers still name an
/// operation by its historic function path; `call` maps each one to its v2 endpoint and fails closed otherwise.
@MainActor
final class ServerAPI {
    enum Kind: String { case query, mutation }

    private let url: URL
    private let auth: AuthClient
    private let http: HTTPClient

    init(url: URL, auth: AuthClient, http: HTTPClient) {
        self.url = url
        self.auth = auth
        self.http = http
    }

    struct RequestBody<Args: Encodable>: Encodable {
        let path: String
        let args: Args
        let format = "json"
    }

    private struct Status: Decodable { let status: String }
    private struct Success<Value: Decodable>: Decodable { let value: Value? }
    private struct Failure: Decodable { let errorMessage: String?; let errorData: ErrorData? }
    private enum ErrorData: Decodable {
        case text(String), other
        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            self = (try? container.decode(String.self)).map(ErrorData.text) ?? .other
        }
    }

    func query<Args: Encodable, Value: Decodable>(_ path: String, _ args: Args, as: Value.Type = Value.self) async throws -> Value? {
        try await call(.query, path, args)
    }

    func mutation<Args: Encodable, Value: Decodable>(_ path: String, _ args: Args, as: Value.Type = Value.self) async throws -> Value? {
        try await call(.mutation, path, args)
    }

    /// One retry, with a forced JWT refresh, after a 401. Safe because every call here is either a read or
    /// a mutation the server rejected before executing (auth happens before the handler runs).
    func call<Args: Encodable, Value: Decodable>(_ kind: Kind, _ path: String, _ args: Args) async throws -> Value? {
        let argsObject = try NativeV2.object(JSONEncoder().encode(args))
        var endpoint: String
        var method = "POST"
        var body: Data? = nil
        switch path {
        case "mobile/devices:mine", "domains/profiles:current": endpoint = "api/me"; method = "GET"
        case "mobile/devices:challenge": endpoint = "api/devices/challenge"
        case "mobile/devices:bind": endpoint = "api/devices/bind"
        case "supervision/mobile:team", "analytics/suggested_orders:forOutlet":
            let key = try auth.signingKey()
            let gateway = NativeGateway(site: url, auth: auth, registry: ServerDeviceRegistry(functions: self), http: http, key: key)
            let me = try await currentMe()
            guard let device = me["device"] as? [String: Any], let id = device["id"] as? String,
                  let scope = me["scope"] as? [String: Any], let scopeId = scope["id"] as? String else { throw MobileError.invalidResponse }
            let projection = path == "supervision/mobile:team" ? "team.summary" : "suggested-order"
            let request = try NativeV2.pull(deviceId: id, scopeId: scopeId, projection: projection, params: argsObject)
            do {
                let response = try await gateway.post("/api/sync/pull", body: request, deviceId: id)
                let result = try NativeV2.bundle(response, scopeId: scopeId, projection: projection, mode: "snapshot")
                guard result.bundle["complete"] as? Bool == true, result.envelope["hasMore"] as? Bool == false,
                      let data = result.bundle["data"] else { throw MobileError.invalidResponse }
                return try JSONDecoder().decode(Value.self, from: NativeV2.bytes(data))
            } catch let failure as NativeFailure {
                throw MobileError.rejected(failure.withdraws ? "forbidden" : failure.code)
            }
        default: throw MobileError.invalidResponse
        }
        if method == "POST" { var fields = argsObject; fields["version"] = 2; body = try NativeV2.bytes(fields) }
        for attempt in 0..<2 {
            let token = try await auth.bearerToken(forceRefresh: attempt > 0)
            var request = URLRequest(url: url.appending(path: endpoint))
            request.httpMethod = method
            request.setValue(NativeV2.app, forHTTPHeaderField: "X-App")
            let publicKey = argsObject["publicKey"] as? String
            let keyId = try publicKey.flatMap { Data(base64Encoded: $0) }.map(RequestSigner.bodyDigest) ?? auth.keyId
            request.setValue(keyId, forHTTPHeaderField: "X-Device-Key-Id")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(token.value)", forHTTPHeaderField: "Authorization")
            request.httpBody = body
            let (data, response) = try await http.send(request)
            if response.statusCode == 401 {
                auth.invalidateToken()
                if attempt == 0 { continue }
                throw MobileError.unauthorized
            }
            guard (200..<300).contains(response.statusCode) else {
                if response.statusCode == 429 { throw MobileError.rateLimited }
                let failure = NativeFailure.decode(data, status: response.statusCode)
                throw MobileError.rejected(failure.withdraws ? "forbidden" : failure.code)
            }
            let value = try NativeV2.validate(data)
            var result: Any = value
            if path == "mobile/devices:mine" {
                guard var device = value["device"] as? [String: Any] else { return nil }
                device["deviceId"] = device["id"]; result = device
            } else if path == "domains/profiles:current" {
                guard let profile = value["profile"] as? [String: Any], let id = profile["id"] as? String,
                      let subject = profile["subject"] as? String, !id.isEmpty, !subject.isEmpty else { throw MobileError.invalidResponse }
                result = ["_id": id, "authSubject": subject]
            }
            return try JSONDecoder().decode(Value.self, from: NativeV2.bytes(result))
        }
        throw MobileError.unauthorized
    }

    /// SP-0164: a plain bearer JSON call (`GET /api/v1/...` or a JSON POST) whose status the caller interprets.
    /// One retry with a refreshed token after a 401. Never logs the body.
    func plain(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil) async throws -> (Data, Int) {
        var components = URLComponents(url: url.appending(path: path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { components?.queryItems = query }
        guard let target = components?.url else { throw MobileError.invalidResponse }
        for attempt in 0..<2 {
            let token = try await auth.bearerToken(forceRefresh: attempt > 0)
            var request = URLRequest(url: target)
            request.httpMethod = method
            request.timeoutInterval = 15
            request.setValue(NativeV2.app, forHTTPHeaderField: "X-App")
            request.setValue(try auth.keyId, forHTTPHeaderField: "X-Device-Key-Id")
            request.setValue("Bearer \(token.value)", forHTTPHeaderField: "Authorization")
            if let body { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = body }
            let (data, response) = try await http.send(request)
            if response.statusCode == 401 && attempt == 0 { auth.invalidateToken(); continue }
            return (data, response.statusCode)
        }
        throw MobileError.unauthorized
    }

    func signedPost(_ path: String, body: Data, deviceId: String) async throws -> Data {
        try await NativeGateway(site: url, auth: auth, registry: ServerDeviceRegistry(functions: self),
            http: http, key: auth.signingKey()).post(path, body: body, deviceId: deviceId)
    }
    func sameOrigin(_ other: URL) -> Bool { other.scheme == url.scheme && other.host == url.host && other.port == url.port }
    func currentMe() async throws -> [String: Any] {
        struct Me: Decodable { let profile: Profile; let scope: Scope; let device: Device?
            struct Profile: Decodable { let id: String; let subject: String }
            struct Scope: Decodable { let id: String; let fingerprint: String }
            struct Device: Decodable { let id: String; let status: String }
        }
        for attempt in 0..<2 {
            let token = try await auth.bearerToken(forceRefresh: attempt > 0)
            var request = URLRequest(url: url.appending(path: "api/me"))
            request.setValue("Bearer \(token.value)", forHTTPHeaderField: "Authorization")
            request.setValue(NativeV2.app, forHTTPHeaderField: "X-App")
            request.setValue(try auth.keyId, forHTTPHeaderField: "X-Device-Key-Id")
            let (data, response) = try await http.send(request)
            if response.statusCode == 401 && attempt == 0 { auth.invalidateToken(); continue }
            guard response.statusCode == 200 else {
                if response.statusCode == 401 { throw MobileError.unauthorized }
                if response.statusCode == 429 { throw MobileError.rateLimited }
                if response.statusCode >= 500 { throw MobileError.server }
                throw MobileError.rejected("forbidden")
            }
            _ = try JSONDecoder().decode(Me.self, from: data)
            return try NativeV2.validate(data)
        }
        throw MobileError.unauthorized
    }

    nonisolated static func decode<Value: Decodable>(_ data: Data, statusCode: Int) throws -> Value? {
        guard (200..<300).contains(statusCode) || statusCode == 560 else {
            throw statusCode >= 500 ? MobileError.server : MobileError.invalidResponse
        }
        guard let status = try? JSONDecoder().decode(Status.self, from: data) else { throw MobileError.invalidResponse }
        switch status.status {
        case "success":
            guard let success = try? JSONDecoder().decode(Success<Value>.self, from: data) else {
                throw MobileError.invalidResponse
            }
            return success.value
        case "error":
            let failure = try? JSONDecoder().decode(Failure.self, from: data)
            let reason: String
            if case .text(let text)? = failure?.errorData { reason = Self.reason(text) }
            else { reason = Self.reason(failure?.errorMessage ?? "unknown error") }
            // QSR-009: the server's back-off signal (challenge/bind budget spent) is retryable later.
            if reason == "rate_limited" { throw MobileError.rateLimited }
            throw MobileError.rejected(reason)
        default:
            throw MobileError.invalidResponse
        }
    }

    /// Server messages look like `[Request ID: x] Server Error\nDevice unavailable\n  at…`.
    /// Keep only the human reason, redacted and bounded.
    nonisolated static func reason(_ message: String) -> String {
        var lines = message.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
        lines.removeAll { $0.isEmpty || $0.hasPrefix("at ") || $0.hasPrefix("[Request ID") }
        var text = lines.first(where: { $0.contains("Error:") }) ?? lines.first ?? "unknown error"
        if let range = text.range(of: "Error: ") { text = String(text[range.upperBound...]) }
        return Redactor.redact(text)
    }
}
