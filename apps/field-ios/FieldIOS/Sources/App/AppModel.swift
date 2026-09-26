import Foundation

/// Composition root for the signed-in field session: Better Auth session, Convex functions and enrollment.
@MainActor
@Observable
final class AppModel {
    enum Pill: Equatable {
        case signedOut, checking, notRegistered, ready, removed
        var label: String {
            switch self {
            case .signedOut: "Offline — not signed in"
            case .checking: "Signed in — checking phone"
            case .notRegistered: "Signed in — phone not registered"
            case .ready: "Ready"
            case .removed: "Phone removed"
            }
        }
    }

    private(set) var signedIn = false
    private(set) var busy = false
    private(set) var signInError: String?
    let enrollment: Enrollment

    @ObservationIgnored private let auth: AuthClient
    @ObservationIgnored private let loadKey: () throws -> any DeviceSigningKey
    @ObservationIgnored private var fieldStore: EncryptedFieldStore?
    @ObservationIgnored private var activeStoragePartition: StorePartition?

    /// Bootstrap supplies the verified auth subject, bound device ID and server scope fingerprint.
    /// Never derive a partition from an email or from the cached employee row.
    func storage(for partition: StorePartition) throws -> any FieldLocalStore {
        guard signedIn else { throw StoreError.heldForReview }
        if fieldStore == nil {
            let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                        appropriateFor: nil, create: true).appending(path: "FieldStore", directoryHint: .isDirectory)
            fieldStore = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"))
        }
        if let previous = activeStoragePartition, previous != partition {
            try fieldStore?.holdForReview(previous)
        }
        activeStoragePartition = partition
        return fieldStore!
    }

    init(auth: AuthClient, registry: DeviceRegistry, store: SecretStore,
         pollInterval: Duration = .seconds(10), loadKey: @escaping () throws -> any DeviceSigningKey) {
        self.auth = auth
        self.loadKey = loadKey
        enrollment = Enrollment(registry: registry, store: store, pollInterval: pollInterval)
        enrollment.onSessionEnded = { [weak self] in
            Task { @MainActor in await self?.sessionEnded() }
        }
    }

    /// Real wiring: Keychain session, ephemeral cookie-less URLSession, Secure Enclave (or simulator) key.
    static func live(environment: AppEnvironment) -> AppModel {
        let store = KeychainStore()
        let http = HTTPClient()
        let auth = AuthClient(site: environment.siteURL, store: store, http: http)
        let functions = ConvexFunctions(url: environment.convexURL, auth: auth, http: http)
        return AppModel(auth: auth, registry: ConvexDeviceRegistry(functions: functions), store: store) {
            try DeviceKeys.loadOrCreate(store: store)
        }
    }

    var pill: Pill {
        guard signedIn else { return .signedOut }
        switch enrollment.state {
        case .signedOut: return .signedOut
        case .checking, .unverified: return .checking
        case .notRegistered, .binding: return .notRegistered
        case .ready: return .ready
        case .removed: return .removed
        }
    }

    /// Launch: a stored session is re-verified against the server (never trusted as "ready" offline).
    func launch() async {
        guard auth.hasSession, !signedIn else { return }
        signedIn = true
        await enrollment.start(loadKey: loadKey)
    }

    func signIn(email: String, password: String) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await auth.signIn(email: email, password: password)
            signInError = nil
            signedIn = true
            await enrollment.start(loadKey: loadKey)
        } catch let error as MobileError {
            signInError = error.description
        } catch {
            signInError = "Sign-in failed. Try again."
        }
    }

    func signOut() async {
        enrollment.signedOut()
        signInError = nil
        if let partition = activeStoragePartition {
            do { try fieldStore?.holdForReview(partition) }
            catch { signInError = "Local evidence needs supervised review; storage could not be locked." }
        }
        activeStoragePartition = nil
        signedIn = false
        await auth.signOut()
    }

    private func sessionEnded() async {
        let reason = enrollment.message
        await signOut()
        signInError = reason ?? MobileError.sessionExpired.description
    }
}
