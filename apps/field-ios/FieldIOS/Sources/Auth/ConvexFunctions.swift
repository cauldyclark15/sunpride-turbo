import Foundation

/// Authenticated Convex function calls over HTTP (`{CONVEX_URL}/api/query|mutation`), the same protocol
/// `ConvexHttpClient` uses. Requests: `{path, args, format:"json"}`; responses:
/// `{status:"success", value}` or `{status:"error", errorMessage, errorData?}` (HTTP 200 or 560).
@MainActor
final class ConvexFunctions {
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
        let body = try JSONEncoder().encode(RequestBody(path: path, args: args))
        for attempt in 0..<2 {
            let token = try await auth.convexToken(forceRefresh: attempt > 0)
            var request = URLRequest(url: url.appending(path: "api/\(kind.rawValue)"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(token.value)", forHTTPHeaderField: "Authorization")
            request.httpBody = body
            let (data, response) = try await http.send(request)
            if response.statusCode == 401 {
                auth.invalidateToken()
                if attempt == 0 { continue }
                throw MobileError.unauthorized
            }
            return try Self.decode(data, statusCode: response.statusCode)
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
            if case .text(let text)? = failure?.errorData { throw MobileError.rejected(Self.reason(text)) }
            throw MobileError.rejected(Self.reason(failure?.errorMessage ?? "unknown error"))
        default:
            throw MobileError.invalidResponse
        }
    }

    /// Server messages look like `[Request ID: x] Server Error\nUncaught ConvexError: Device unavailable\n  at…`.
    /// Keep only the human reason, redacted and bounded.
    nonisolated static func reason(_ message: String) -> String {
        var lines = message.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
        lines.removeAll { $0.isEmpty || $0.hasPrefix("at ") || $0.hasPrefix("[Request ID") }
        var text = lines.first(where: { $0.contains("Error:") }) ?? lines.first ?? "unknown error"
        if let range = text.range(of: "Error: ") { text = String(text[range.upperBound...]) }
        return Redactor.redact(text)
    }
}
