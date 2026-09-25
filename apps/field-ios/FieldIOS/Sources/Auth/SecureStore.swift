import Foundation
import Security
import Synchronization

/// Small secret store abstraction. Values are opaque bytes and are never logged.
protocol SecretStore: Sendable {
    func read(_ account: String) throws -> Data?
    func save(_ data: Data, for account: String) throws
    func delete(_ account: String) throws
}

enum SecureStoreError: Error, CustomStringConvertible {
    case keychain(OSStatus)
    var description: String {
        switch self {
        case .keychain(let status): "Keychain error \(status)"
        }
    }
}

/// Keychain account names. The session token is the only credential; device IDs are non-secret.
enum StoreAccount {
    static let session = "auth.betterAuthSession"
    static let secureEnclaveKey = "device.key.secureEnclave"
    static let simulatorKey = "device.key.simulatorTestOnly"
    static let deviceId = "device.registeredId"
    static let credentialId = "device.credentialId"
}

/// Generic-password Keychain items: available after first unlock, this device only, never synchronized
/// (excluded from iCloud Keychain and from backups restored to another device).
struct KeychainStore: SecretStore {
    let service: String
    init(service: String = "com.sunpride.field.dev") { self.service = service }

    private func baseQuery(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: kCFBooleanFalse as Any]
    }

    func read(_ account: String) throws -> Data? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw SecureStoreError.keychain(status) }
        return result as? Data
    }

    func save(_ data: Data, for account: String) throws {
        try delete(account)
        var query = baseQuery(account)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw SecureStoreError.keychain(status) }
    }

    func delete(_ account: String) throws {
        let status = SecItemDelete(baseQuery(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw SecureStoreError.keychain(status) }
    }

    /// Stored attributes (never the secret data), so tests can prove the protection class.
    func attributes(_ account: String) throws -> [String: Any]? {
        var query = baseQuery(account)
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw SecureStoreError.keychain(status) }
        return result as? [String: Any]
    }
}

/// Process-memory store for unit tests and the DEBUG UI-test stub backend. Never holds a real session.
final class InMemoryStore: SecretStore {
    private let items = Mutex<[String: Data]>([:])
    init() {}
    func read(_ account: String) throws -> Data? { items.withLock { $0[account] } }
    func save(_ data: Data, for account: String) throws { items.withLock { $0[account] = data } }
    func delete(_ account: String) throws { _ = items.withLock { $0.removeValue(forKey: account) } }
    var accounts: Set<String> { items.withLock { Set($0.keys) } }
}
