import Foundation

/// Calls the same office endpoints the web app calls, with the office access bearer.
/// One retry with a forced refresh after a 401 (auth happens before any handler runs).
@MainActor
final class APIClient {
    let origin: URL
    let auth: AuthClient
    private let http: HTTPTransport
    var onSignedOut: (() -> Void)?

    init(origin: URL, auth: AuthClient, http: HTTPTransport) {
        self.origin = origin
        self.auth = auth
        self.http = http
    }

    static let decoder = JSONDecoder()

    func get<T: Decodable>(_ path: String, query: [String: String?] = [:], as: T.Type = T.self) async throws -> T {
        let data = try await send(path, method: "GET", query: query, body: nil)
        return try Self.decode(T.self, data)
    }

    func post<T: Decodable>(_ path: String, body: [String: Any], idempotencyKey: String? = nil, as: T.Type = T.self) async throws -> T {
        let bytes = try JSONSerialization.data(withJSONObject: body)
        let data = try await send(path, method: "POST", query: [:], body: bytes, idempotencyKey: idempotencyKey)
        return try Self.decode(T.self, data)
    }

    nonisolated static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw OfficeError.invalidResponse }
    }

    func url(_ path: String, query: [String: String?]) -> URL {
        var c = URLComponents(url: origin.appending(path: path), resolvingAgainstBaseURL: false)!
        let items = query.compactMap { k, v in v.flatMap { $0.isEmpty ? nil : URLQueryItem(name: k, value: $0) } }
            .sorted { $0.name < $1.name }
        if !items.isEmpty { c.queryItems = items }
        return c.url!
    }

    private func send(_ path: String, method: String, query: [String: String?], body: Data?, idempotencyKey: String? = nil) async throws -> Data {
        for attempt in 0..<2 {
            let token: String
            do { token = try await auth.bearer(forceRefresh: attempt > 0) } catch let e as OfficeError where e == .sessionExpired || e == .notSignedIn {
                onSignedOut?(); throw e
            }
            var request = URLRequest(url: url(path, query: query))
            request.httpMethod = method
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let body { request.httpBody = body; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
            if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
            let (data, response) = try await http.send(request)
            if response.statusCode == 401 && attempt == 0 { auth.invalidateAccess(); continue }
            if (200..<300).contains(response.statusCode) { return data }
            throw Self.failure(status: response.statusCode, data: data)
        }
        onSignedOut?()
        throw OfficeError.sessionExpired
    }

    /// The server's error envelope (web `{error:{code,message}}` or native v2) → plain words.
    nonisolated static func failure(status: Int, data: Data) -> OfficeError {
        struct Envelope: Decodable { struct E: Decodable { let code: String?; let message: String? }; let error: E? }
        let e = (try? JSONDecoder().decode(Envelope.self, from: data))?.error
        if let message = e?.message, !message.isEmpty, status != 401, status < 500, message.count < 400 {
            return .refused(message)
        }
        switch status {
        case 401: return .sessionExpired
        case 403: return .notAllowed
        case 404: return .notFound
        case 429: return .rateLimited
        case 500...: return .server
        default: return .refused(plainCode(e?.code))
        }
    }

    nonisolated static func plainCode(_ code: String?) -> String {
        switch code {
        case "conflict", "stale", "version_conflict": "Someone else changed this just now. Pull down to see the latest."
        case "invalid_request", "invalid": "Something in the form is not right. Check it and try again."
        case .none: "That did not go through. Try again."
        default: "That did not go through. Try again."
        }
    }
}
