import Foundation
@preconcurrency import LocalAuthentication
import Security

/// Real phone: `LAContext` prompt (biometrics only, no passcode fallback) + a generic-password Keychain item
/// protected by `SecAccessControl(.biometryCurrentSet)` with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
/// iOS makes the item unreadable when a face/finger is added or removed; the evaluated domain-state hash is
/// also compared so a changed enrollment is reported plainly instead of as a generic failure.
@MainActor
final class KeychainBiometricCrypto: BiometricCrypto {
    nonisolated static let sealedAccount = "auth.betterAuthSession.biometric"
    nonisolated static let stateAccount = "auth.biometric.domainState"
    let service: String

    init(service: String = "com.sunpride.field.dev") { self.service = service }

    var kind: BiometryKind {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch context.biometryType {
        case .faceID: return .faceID
        case .touchID: return .touchID
        case .opticID: return .opticID
        default: return .none
        }
    }

    func availability() -> BiometricAvailability {
        var error: NSError?
        if LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) { return .available }
        switch error.map({ LAError.Code(rawValue: $0.code) }) {
        case .biometryNotEnrolled?, .passcodeNotSet?: return .notEnrolled
        default: return .unavailable
        }
    }

    func authenticate(reason: String) async -> BiometricPromptOutcome {
        let context = LAContext()
        // No "Enter Passcode" fallback: the password is the way out (a passcode would defeat enrollment binding).
        context.localizedFallbackTitle = ""
        context.localizedCancelTitle = "Use password"
        let (ok, error): (Bool, (any Error)?) = await withCheckedContinuation { continuation in
            context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, error in
                continuation.resume(returning: (ok, error))
            }
        }
        if ok { return .done(BiometricContext(context)) }
        return Self.outcome(for: (error as NSError?).flatMap { LAError.Code(rawValue: $0.code) })
    }

    nonisolated static func outcome(for code: LAError.Code?) -> BiometricPromptOutcome {
        switch code {
        case .userCancel?, .appCancel?, .systemCancel?, .userFallback?: .cancelled
        case .biometryLockout?: .lockedOut
        case .biometryNotEnrolled?, .biometryNotAvailable?, .passcodeNotSet?: .invalidated
        case .notInteractive?: .notInteractive
        default: .failed
        }
    }

    private nonisolated static func base(_ service: String, _ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: kCFBooleanFalse as Any]
    }

    func write(_ token: Data, context: BiometricContext) throws {
        try deleteSealed()
        var cfError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                           .biometryCurrentSet, &cfError) else {
            cfError?.release()
            throw SecureStoreError.keychain(errSecParam)
        }
        var query = Self.base(service, Self.sealedAccount)
        query[kSecValueData as String] = token
        query[kSecAttrAccessControl as String] = access
        if let laContext = context.handle as? LAContext { query[kSecUseAuthenticationContext as String] = laContext }
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw SecureStoreError.keychain(status) }
        // Non-secret enrollment fingerprint, to tell "Face ID changed" apart from other failures.
        if let state = (context.handle as? LAContext)?.domainState.biometry.stateHash {
            var stateQuery = Self.base(service, Self.stateAccount)
            stateQuery[kSecValueData as String] = state
            stateQuery[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let saved = SecItemAdd(stateQuery as CFDictionary, nil)
            guard saved == errSecSuccess else { try? deleteSealed(); throw SecureStoreError.keychain(saved) }
        }
    }

    func read(context: BiometricContext) -> BiometricReadOutcome {
        guard let laContext = context.handle as? LAContext else { return .failed }
        if let expected = Self.copy(service, Self.stateAccount),
           let current = laContext.domainState.biometry.stateHash, expected != current {
            return .invalidated
        }
        var query = Self.base(service, Self.sealedAccount)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecUseAuthenticationContext as String] = laContext
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess: return (result as? Data).map { .done($0) } ?? .failed
        // biometryCurrentSet: a changed enrollment leaves the item unreadable (or gone).
        case errSecItemNotFound, errSecAuthFailed, errSecInvalidItemRef: return .invalidated
        default: return .failed
        }
    }

    private nonisolated static func copy(_ service: String, _ account: String) -> Data? {
        var query = base(service, account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    func deleteSealed() throws { try Self.deleteItems(service: service) }

    /// Usable from the session vault's teardown on any thread; never prompts.
    nonisolated static func deleteItems(service: String) throws {
        for account in [sealedAccount, stateAccount] {
            let status = SecItemDelete(base(service, account) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw SecureStoreError.keychain(status) }
        }
    }

    /// Stored attributes of the sealed item (never its data, never a prompt), for the device test.
    nonisolated static func sealedAttributes(service: String) -> [String: Any]? {
        var query = base(service, sealedAccount)
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? [String: Any]
    }

    /// Tries to read the sealed item without any UI; a biometry-protected item must refuse.
    nonisolated static func readWithoutPrompt(service: String) -> OSStatus {
        let context = LAContext()
        context.interactionNotAllowed = true
        var query = base(service, sealedAccount)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecUseAuthenticationContext as String] = context
        var result: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &result)
    }
}
