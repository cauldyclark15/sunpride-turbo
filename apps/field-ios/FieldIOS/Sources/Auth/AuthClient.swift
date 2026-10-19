import Foundation

/// Better Auth session (Keychain only) and the short-lived access token (memory only).
///
/// Wire (apps/api/src/core/auth.js, native credentials):
/// - `POST {origin}/api/auth/sign-in` JSON `{email,password}` with **no Origin header** →
///   `{version:2, serverTime, sessionToken, sessionExpiresAt, accessToken, accessExpiresAt}`.
/// - `POST {origin}/api/auth/refresh` with the session bearer → a fresh short-lived access token.
/// - `POST {origin}/api/auth/sign-out` with the session bearer.
@MainActor
final class AuthClient {
    /// Refresh this long before the JWT's `exp` so an in-flight call never carries an expiring token.
    static let refreshMargin: TimeInterval = 60

    private let site: URL
    private let store: SecretStore
    private let http: HTTPClient
    private let now: @Sendable () -> Date
    private var epoch: UInt64 = 0
    private var jwt: Redacted<String>?
    private var jwtExpiry: Date = .distantPast
    private var refreshTask: Task<Redacted<String>, Error>?

    init(site: URL, store: SecretStore, http: HTTPClient, now: @escaping @Sendable () -> Date = Date.init) {
        self.site = site
        self.store = store
        self.http = http
        self.now = now
    }

    var hasSession: Bool { ((try? store.read(StoreAccount.session)) ?? nil) != nil }
    /// Test/diagnostic view of the cached JWT expiry; never exposes the token.
    var cachedTokenExpiry: Date? { jwt == nil ? nil : jwtExpiry }

    func signingKey() throws -> any DeviceSigningKey { try DeviceKeys.loadOrCreate(store: store) }
    var keyId: String { get throws { RequestSigner.bodyDigest(try DeviceKeys.loadOrCreate(store: store).publicKeySPKI) } }
    private func accept(_ data: Data) throws -> Redacted<String> {
        let value = try NativeV2.validate(data)
        guard let token = value["accessToken"] as? String, !token.isEmpty, token.count <= 4096,
              !token.contains(where: \.isWhitespace), let server = value["serverTime"] as? Double,
              let expiry = value["accessExpiresAt"] as? Double, expiry > server,
              expiry - server <= 86_400_000 else { throw MobileError.invalidResponse }
        jwt = Redacted(token)
        jwtExpiry = now().addingTimeInterval((expiry - server) / 1000)
        return Redacted(token)
    }

    func signIn(email: String, password: String) async throws {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        var request = URLRequest(url: site.appending(path: "api/auth/sign-in"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Never set Origin: DEV rejects `Origin: null`, and forging a web origin is forbidden.
        epoch &+= 1
        let ticket = epoch
        refreshTask?.cancel(); refreshTask = nil
        let key = try DeviceKeys.loadOrCreate(store: store)
        request.httpBody = try NativeV2.bytes(["version": 2, "app": NativeV2.app, "email": trimmed, "password": password,
            "deviceKey": ["keyId": RequestSigner.bodyDigest(key.publicKeySPKI), "publicKeySpki": key.publicKeyBase64]])
        let (body, response) = try await http.send(request)
        switch response.statusCode {
        case 200..<300: break
        case 400, 401: throw MobileError.invalidCredentials
        case 403: throw MobileError.signInRefused
        case 429: throw MobileError.rateLimited
        case 500...: throw MobileError.server
        default: throw MobileError.invalidResponse
        }
        guard ticket == epoch else { throw CancellationError() }
        let token = try NativeV2.validate(body)["sessionToken"] as? String
        guard let token, !token.isEmpty, token.count <= 4096, !token.contains(where: \.isWhitespace) else {
            throw MobileError.invalidResponse
        }
        _ = try accept(body)
        do { try store.save(Data(token.utf8), for: StoreAccount.session) }
        catch { clearMemory(); throw MobileError.storage }
    }

    /// Returns the access token, refreshing when missing, within `refreshMargin` of expiry, or when forced.
    /// Concurrent callers share one refresh.
    func bearerToken(forceRefresh: Bool = false) async throws -> Redacted<String> {
        if !forceRefresh, let jwt, jwtExpiry.timeIntervalSince(now()) > Self.refreshMargin { return jwt }
        if let refreshTask { return try await refreshTask.value }
        let task = Task { try await self.exchange() }
        refreshTask = task
        defer { refreshTask = nil }
        return try await task.value
    }

    private func exchange() async throws -> Redacted<String> {
        guard let data = try? store.read(StoreAccount.session), let session = String(data: data, encoding: .utf8),
              !session.isEmpty else {
            clearMemory()
            throw MobileError.notSignedIn
        }
        let ticket = epoch
        var request = URLRequest(url: site.appending(path: "api/auth/refresh"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try NativeV2.bytes(["version": 2, "app": NativeV2.app, "deviceKeyId": keyId])
        request.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization")
        let (body, response) = try await http.send(request)
        if response.statusCode == 401 || response.statusCode == 403 {
            // The server no longer honours this session: lock locally and require online sign-in.
            clearMemory()
            try? store.delete(StoreAccount.session)
            throw MobileError.sessionExpired
        }
        guard (200..<300).contains(response.statusCode) else {
            throw response.statusCode >= 500 ? MobileError.server : MobileError.invalidResponse
        }
        try Task.checkCancellation()
        guard ticket == epoch else { throw CancellationError() }
        return try accept(body)
    }

    /// Reads only the public `exp` claim. The signature is verified by the server, not the phone.
    nonisolated static func expiry(ofJWT token: String) -> Date? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var payload = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let exp = (claims["exp"] as? NSNumber)?.doubleValue else { return nil }
        return Date(timeIntervalSince1970: exp)
    }

    /// Drops the in-memory JWT (e.g. after a 401 from the server) without touching the session.
    func invalidateToken() { clearMemory() }

    /// Local lockout always wins: memory and Keychain session are wiped before the best-effort remote call.
    /// Returns whether the server acknowledged the sign-out.
    @discardableResult
    func signOut() async -> Bool {
        epoch &+= 1
        let session = (try? store.read(StoreAccount.session)).flatMap { $0 }.flatMap { String(data: $0, encoding: .utf8) }
        refreshTask?.cancel()
        refreshTask = nil
        clearMemory()
        try? store.delete(StoreAccount.session)
        guard let session, !session.isEmpty else { return false }
        var request = URLRequest(url: site.appending(path: "api/auth/sign-out"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? NativeV2.bytes(["version": 2])
        guard let (_, response) = try? await http.send(request) else { return false }
        return (200..<300).contains(response.statusCode)
    }

    private func clearMemory() {
        jwt = nil
        jwtExpiry = .distantPast
    }
}
