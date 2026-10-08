import Foundation

/// SP-0133 Face ID / Touch ID sign-in (mirror of Android SP-0128). The password is never stored. When the
/// person turns it on, the Better Auth session token is moved into a Keychain item protected by
/// `SecAccessControl(.biometryCurrentSet)` + `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (a newly
/// enrolled face or finger makes it unreadable, so the password is required again; there is no passcode
/// fallback), and the ordinary copy is removed. At launch the system prompt opens it into this process's
/// memory only; server calls still exchange that session for the short-lived Convex JWT exactly as before.
enum BiometricAvailability: Equatable, Sendable { case available, notEnrolled, unavailable }

enum BiometryKind: Equatable, Sendable {
    case faceID, touchID, opticID, none
    /// Product name shown to the person ("Face ID" on the pilot iPhones).
    var name: String {
        switch self {
        case .faceID, .none: "Face ID"
        case .touchID: "Touch ID"
        case .opticID: "Optic ID"
        }
    }
}

/// An authenticated system-prompt round (wraps the evaluated `LAContext` on a real phone). Only ever used on
/// the main actor; marked Sendable so prompt results can cross a continuation.
final class BiometricContext: @unchecked Sendable {
    let handle: AnyObject?
    init(_ handle: AnyObject?) { self.handle = handle }
}

/// Result of one system prompt. Never carries prompt error text.
enum BiometricPromptOutcome: Sendable {
    case done(BiometricContext)
    /// Person closed the prompt or chose "Use password".
    case cancelled
    /// Face/finger enrollment changed or was removed: the sealed session can never be opened again.
    case invalidated
    /// Too many failed attempts; biometrics are locked for now.
    case lockedOut
    /// The app is not in the foreground (cold background launch); try again when it is.
    case notInteractive
    case failed
}

enum BiometricReadOutcome: Sendable {
    case done(Data)
    case invalidated
    case failed
}

/// The system prompt + biometry-bound Keychain item.
@MainActor
protocol BiometricCrypto: AnyObject {
    var kind: BiometryKind { get }
    func availability() -> BiometricAvailability
    /// Shows the system prompt once.
    func authenticate(reason: String) async -> BiometricPromptOutcome
    /// Stores `token` under `.biometryCurrentSet`, bound to the authenticated `context`.
    func write(_ token: Data, context: BiometricContext) throws
    /// Reads the sealed token with an authenticated `context` (no second prompt).
    func read(context: BiometricContext) -> BiometricReadOutcome
    func deleteSealed() throws
}

/// Local storage refused a write/remove. Fixed message; no stored value ever enters it.
struct SessionStorageFailure: Error, CustomStringConvertible {
    var description: String { "Couldn't save sign-in on this phone. Try again." }
}

/// The unlocked session for this process only; gone when the process dies. `epoch` changes whenever the
/// stored session changes (password sign-in, sign-out, biometric on/off), so a prompt that started before
/// the change can tell it is stale and must not touch the session. Shared by every vault in the process.
final class SessionMemory: @unchecked Sendable {
    fileprivate let lock = NSRecursiveLock()
    private var _token: String?
    private var _epoch: UInt64 = 0
    var token: String? {
        get { lock.withLock { _token } }
        set { lock.withLock { _token = newValue } }
    }
    var epoch: UInt64 { lock.withLock { _epoch } }
    fileprivate func bump() { lock.withLock { _epoch &+= 1 } }
    static let process = SessionMemory()
    init() {}
}

/// The app's `SecretStore`. Every account passes straight through except the Better Auth session:
/// - read: the unlocked in-memory session first; while the lock record exists (biometric sign-in on, or
///   the signed-out marker) the ordinary copy is NEVER read, even if its removal failed, so it cannot bypass
///   the prompt or come back after sign-out;
/// - save (password sign-in): replaces any session, removes the sealed item; biometric sign-in stays off;
/// - delete (sign-out, or a session the server refused): forgets the unlocked token, the sealed item, the
///   ordinary copy and then the lock record.
/// Cold background launches that were never unlocked see no session and do nothing.
final class LockableSessionStore: SecretStore, @unchecked Sendable {
    static let lockAccount = "auth.session.lock"
    static let biometricMarker = Data("biometric".utf8)
    /// Signed out, but the ordinary copy could not be removed. Never a valid lock value otherwise.
    static let signedOutMarker = Data("signed-out".utf8)

    private let plain: SecretStore
    private let memory: SessionMemory
    private let deleteSealed: @Sendable () throws -> Void

    init(plain: SecretStore, memory: SessionMemory = .process, deleteSealed: @escaping @Sendable () throws -> Void) {
        self.plain = plain
        self.memory = memory
        self.deleteSealed = deleteSealed
    }

    // MARK: SecretStore

    func read(_ account: String) throws -> Data? {
        guard account == StoreAccount.session else { return try plain.read(account) }
        return readSession().map { Data($0.utf8) }
    }

    func save(_ data: Data, for account: String) throws {
        guard account == StoreAccount.session else { return try plain.save(data, for: account) }
        try passwordSignedIn(data)
    }

    func delete(_ account: String) throws {
        guard account == StoreAccount.session else { return try plain.delete(account) }
        try wipe()
    }

    // MARK: Session rules

    var epoch: UInt64 { memory.epoch }

    /// `nil` = no lock record; throws when the record cannot be read (callers fail closed).
    private func lockRecord() throws -> Data? { try plain.read(Self.lockAccount) }

    func readSession() -> String? {
        memory.lock.withLock {
            if let token = memory.token { return token }
            // Fail closed: an unreadable lock record hides the ordinary copy too.
            let record: Data?
            do { record = try lockRecord() } catch { return nil }
            guard record == nil, let data = (try? plain.read(StoreAccount.session)) ?? nil else { return nil }
            return String(data: data, encoding: .utf8)
        }
    }

    var biometricOn: Bool { ((try? lockRecord()) ?? nil) == Self.biometricMarker }
    /// A biometric session exists and nothing has unlocked it in this process.
    var isLocked: Bool { memory.lock.withLock { memory.token == nil && biometricOn } }

    /// Removes the ordinary copy, then the lock record. If the ordinary copy can't be removed, the lock
    /// record keeps (or gets) the signed-out marker so that copy is never read again; the failure rethrows.
    private func forgetStored() throws {
        do {
            try plain.delete(StoreAccount.session)
            if try plain.read(StoreAccount.session) != nil { throw SessionStorageFailure() }
        } catch {
            try? plain.save(Self.signedOutMarker, for: Self.lockAccount)
            throw error
        }
        try plain.delete(Self.lockAccount)
        if try plain.read(Self.lockAccount) != nil { throw SessionStorageFailure() }
    }

    /// Password sign-in: the new ordinary copy is saved first, then the lock record (old biometric session or
    /// signed-out marker) is removed. A failed save leaves the lock record hiding every ordinary copy; a failed
    /// removal rolls the new copy back.
    private func passwordSignedIn(_ data: Data) throws {
        try memory.lock.withLock {
            memory.bump()
            memory.token = nil
            try? deleteSealed()
            try plain.save(data, for: StoreAccount.session)
            do {
                try plain.delete(Self.lockAccount)
                if try plain.read(Self.lockAccount) != nil { throw SessionStorageFailure() }
            } catch {
                try? plain.delete(StoreAccount.session)
                throw error
            }
        }
    }

    /// Sign-out / dead session: unlocked token, sealed item, ordinary copy, then the lock record.
    func wipe() throws {
        try memory.lock.withLock {
            memory.bump()
            memory.token = nil
            try? deleteSealed()
            try forgetStored()
        }
    }

    /// The prompt opened the sealed session: keep it in memory only. Refused (false) when the session changed
    /// since the prompt started at `startedAt` or biometric sign-in is no longer on.
    func unlock(_ token: String, startedAt: UInt64) throws -> Bool {
        guard !token.isEmpty, token.count <= 4096, !token.contains(where: \.isWhitespace) else { throw SessionStorageFailure() }
        return memory.lock.withLock {
            guard memory.epoch == startedAt, biometricOn else { return false }
            memory.token = token
            return true
        }
    }

    /// Biometric sign-in on, after the sealed item was written: the lock record is written and verified
    /// before the ordinary copy is removed (if that removal fails, the lock record still wins on every read).
    /// Refused (false) when the session changed since the prompt started.
    func seal(_ token: String, startedAt: UInt64) throws -> Bool {
        try memory.lock.withLock {
            guard memory.epoch == startedAt, readSession() == token else { return false }
            try plain.save(Self.biometricMarker, for: Self.lockAccount)
            guard ((try? plain.read(Self.lockAccount)) ?? nil) == Self.biometricMarker else {
                try? plain.delete(Self.lockAccount)
                throw SessionStorageFailure()
            }
            memory.bump()
            memory.token = token
            try? plain.delete(StoreAccount.session)
            return true
        }
    }

    /// Biometric sign-in off: the session goes back to the ordinary Keychain copy (no prompt). The ordinary
    /// copy is saved and verified before the lock record is removed. Turned off while still locked, the
    /// sealed session is simply forgotten (signed out, never an older ordinary copy).
    func unseal() throws {
        try memory.lock.withLock {
            guard let token = readSession() else {
                memory.bump()
                try forgetStored()
                return
            }
            try plain.save(Data(token.utf8), for: StoreAccount.session)
            guard ((try? plain.read(StoreAccount.session)) ?? nil) == Data(token.utf8) else { throw SessionStorageFailure() }
            try plain.delete(Self.lockAccount)
            if try plain.read(Self.lockAccount) != nil { throw SessionStorageFailure() }
            memory.bump()
            memory.token = nil
        }
    }

    /// The sealed session can no longer be opened (enrollment changed): forget it; sign in with the password.
    func dropBiometric() throws {
        try memory.lock.withLock {
            memory.bump()
            memory.token = nil
            try forgetStored()
        }
    }
}
