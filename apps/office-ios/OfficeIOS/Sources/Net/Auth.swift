import Foundation
import Security
import Synchronization

/// Office sign-in (SP-0165), the field app's approach copied (not shared):
/// - `POST /api/auth/sign-in` `{version:2, app:"office-ios", email, password}` with no Origin header →
///   `{version:2, serverTime, sessionToken, sessionExpiresAt, accessToken, accessExpiresAt}`.
/// - The long-lived session lives only in the Keychain; the short access token only in memory.
/// - `POST /api/auth/refresh` with the session bearer mints a new access token; concurrent callers share one refresh.
/// - The office app carries no device key: the server refuses one for `office-ios` (it never registers a handheld).
enum OfficeApp {
    static let id = "office-ios"
}

/// Small secret store abstraction. Values are opaque bytes and are never logged.
nonisolated protocol SecretStore: Sendable {
    func read(_ account: String) throws -> Data?
    func save(_ data: Data, for account: String) throws
    func delete(_ account: String) throws
}

nonisolated enum StoreAccount {
    static let session = "auth.officeSession"
}

/// Generic-password Keychain items: after first unlock, this device only, never synchronized.
nonisolated struct KeychainStore: SecretStore {
    let service: String
    init(service: String = "com.sunpride.office") { self.service = service }

    private func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: kCFBooleanFalse as Any]
    }

    func read(_ account: String) throws -> Data? {
        var q = base(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw OfficeError.storage }
        return out as? Data
    }

    func save(_ data: Data, for account: String) throws {
        try delete(account)
        var q = base(account)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw OfficeError.storage }
    }

    func delete(_ account: String) throws {
        let status = SecItemDelete(base(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw OfficeError.storage }
    }
}

/// Process-memory store for unit tests. Never holds a real session.
nonisolated final class InMemoryStore: SecretStore {
    private let items = Mutex<[String: Data]>([:])
    init() {}
    func read(_ account: String) throws -> Data? { items.withLock { $0[account] } }
    func save(_ data: Data, for account: String) throws { items.withLock { $0[account] = data } }
    func delete(_ account: String) throws { _ = items.withLock { $0.removeValue(forKey: account) } }
}

/// Failures in plain words. Never carries tokens, bodies or headers; `refused` carries the server's own message.
enum OfficeError: Error, Equatable, LocalizedError {
    case invalidCredentials, rateLimited, offline, server, sessionExpired, notSignedIn
    case notAllowed, notFound, invalidResponse, storage
    case refused(String)

    var errorDescription: String? {
        switch self {
        case .invalidCredentials: "That email or password is not right."
        case .rateLimited: "Too many tries. Wait a minute and try again."
        case .offline: "You're offline. Check your connection and try again."
        case .server: "Sunpride is not answering right now. Try again in a moment."
        case .sessionExpired: "You were signed out. Sign in again."
        case .notSignedIn: "Sign in to continue."
        case .notAllowed: "Your account can't open this."
        case .notFound: "This is no longer here."
        case .invalidResponse: "Something unexpected came back. Pull down to try again."
        case .storage: "This device's secure storage is not available."
        case .refused(let message): message
        }
    }
}

/// Cookie-less, cache-less transport so the session never lands in a shared jar or cache.
nonisolated struct HTTPTransport: Sendable {
    let session: URLSession

    static func configuration(protocolClasses: [AnyClass]? = nil) -> URLSessionConfiguration {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 30
        if let protocolClasses { c.protocolClasses = protocolClasses }
        return c
    }

    init(session: URLSession = URLSession(configuration: HTTPTransport.configuration())) { self.session = session }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw OfficeError.invalidResponse }
            return (data, http)
        } catch let e as OfficeError {
            throw e
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw OfficeError.offline
        }
    }
}

/// Tokens issued by sign-in/refresh. Values bounded and whitespace-free.
nonisolated struct NativeTokens: Decodable, Sendable {
    let version: Int
    let serverTime: Double
    let sessionToken: String?
    let accessToken: String
    let accessExpiresAt: Double
}

@MainActor
final class AuthClient {
    static let refreshMargin: TimeInterval = 60

    private let origin: URL
    private let store: SecretStore
    private let http: HTTPTransport
    private let now: () -> Date
    private var access: String?
    private var accessExpiry: Date = .distantPast
    private var refreshTask: Task<String, Error>?
    private var epoch: UInt64 = 0

    init(origin: URL, store: SecretStore, http: HTTPTransport, now: @escaping () -> Date = Date.init) {
        self.origin = origin
        self.store = store
        self.http = http
        self.now = now
    }

    var hasSession: Bool { ((try? store.read(StoreAccount.session)) ?? nil) != nil }
    var cachedAccessExpiry: Date? { access == nil ? nil : accessExpiry }

    static func valid(_ token: String?, prefix: String) -> Bool {
        guard let token else { return false }
        return token.hasPrefix(prefix) && token.count <= 4096 && !token.contains(where: \.isWhitespace)
    }

    private func accept(_ data: Data) throws -> NativeTokens {
        guard let t = try? JSONDecoder().decode(NativeTokens.self, from: data), t.version == 2,
              Self.valid(t.accessToken, prefix: "spa_"), t.accessExpiresAt > t.serverTime,
              t.accessExpiresAt - t.serverTime <= 86_400_000 else { throw OfficeError.invalidResponse }
        access = t.accessToken
        accessExpiry = now().addingTimeInterval((t.accessExpiresAt - t.serverTime) / 1000)
        return t
    }

    func signIn(email: String, password: String) async throws {
        epoch &+= 1
        let ticket = epoch
        refreshTask?.cancel(); refreshTask = nil
        var request = URLRequest(url: origin.appending(path: "api/auth/sign-in"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Never set Origin: native clients authenticate by bearer, not by a forged web origin.
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "version": 2, "app": OfficeApp.id,
            "email": email.trimmingCharacters(in: .whitespacesAndNewlines), "password": password,
        ])
        let (body, response) = try await http.send(request)
        switch response.statusCode {
        case 200..<300: break
        case 400, 401: throw OfficeError.invalidCredentials
        case 403: throw OfficeError.notAllowed
        case 429: throw OfficeError.rateLimited
        case 500...: throw OfficeError.server
        default: throw OfficeError.invalidResponse
        }
        guard ticket == epoch else { throw CancellationError() }
        let tokens = try accept(body)
        guard Self.valid(tokens.sessionToken, prefix: "sps_"), let session = tokens.sessionToken else {
            clearMemory(); throw OfficeError.invalidResponse
        }
        do { try store.save(Data(session.utf8), for: StoreAccount.session) } catch { clearMemory(); throw OfficeError.storage }
    }

    /// The access token, refreshed when missing, near expiry or forced. One shared refresh.
    func bearer(forceRefresh: Bool = false) async throws -> String {
        if !forceRefresh, let access, accessExpiry.timeIntervalSince(now()) > Self.refreshMargin { return access }
        if let refreshTask { return try await refreshTask.value }
        let task = Task { try await self.refresh() }
        refreshTask = task
        defer { refreshTask = nil }
        return try await task.value
    }

    private func refresh() async throws -> String {
        guard let data = try? store.read(StoreAccount.session), let session = String(data: data, encoding: .utf8),
              !session.isEmpty else { clearMemory(); throw OfficeError.notSignedIn }
        let ticket = epoch
        var request = URLRequest(url: origin.appending(path: "api/auth/refresh"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["version": 2, "app": OfficeApp.id])
        let (body, response) = try await http.send(request)
        if response.statusCode == 401 || response.statusCode == 403 {
            clearMemory()
            try? store.delete(StoreAccount.session)
            throw OfficeError.sessionExpired
        }
        guard (200..<300).contains(response.statusCode) else {
            throw response.statusCode >= 500 ? OfficeError.server : OfficeError.invalidResponse
        }
        guard ticket == epoch else { throw CancellationError() }
        return try accept(body).accessToken
    }

    func invalidateAccess() { clearMemory() }

    /// Local sign-out always wins; the server call is best effort.
    func signOut() async {
        epoch &+= 1
        let session = (try? store.read(StoreAccount.session)).flatMap { $0 }.flatMap { String(data: $0, encoding: .utf8) }
        refreshTask?.cancel(); refreshTask = nil
        clearMemory()
        try? store.delete(StoreAccount.session)
        guard let session, !session.isEmpty else { return }
        var request = URLRequest(url: origin.appending(path: "api/auth/sign-out"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["version": 2])
        _ = try? await http.send(request)
    }

    private func clearMemory() {
        access = nil
        accessExpiry = .distantPast
    }
}
