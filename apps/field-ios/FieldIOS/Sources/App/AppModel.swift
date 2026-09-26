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
    private(set) var syncMessage: String?
    private(set) var syncing = false
    private(set) var freshThisLaunch = false
    private(set) var visits: [TodayVisit] = []
    private(set) var lastSyncedAt: Date?
    let enrollment: Enrollment

    struct TodayVisit: Identifiable { let id: String; let outlet: String; let planned: Bool; let status: String }
    private struct ProfileIdentity: Decodable { let _id: String; let authSubject: String }
    private struct CachedPartition: Codable { let subject: String; let deviceId: String; let scope: String }
    private static let partitionAccount = "field.lastVerifiedPartition"

    @ObservationIgnored private let auth: AuthClient
    @ObservationIgnored private let registry: DeviceRegistry
    @ObservationIgnored private let secrets: SecretStore
    @ObservationIgnored private let site: URL?
    @ObservationIgnored private let functions: ConvexFunctions?
    @ObservationIgnored private let http: HTTPClient?
    @ObservationIgnored private let loadKey: () throws -> any DeviceSigningKey
    @ObservationIgnored private var fieldStore: EncryptedFieldStore?
    @ObservationIgnored private var activeStoragePartition: StorePartition?
    @ObservationIgnored private var bootstrapping = false

    /// Bootstrap supplies the verified auth subject, bound device ID and server scope fingerprint.
    /// Never derive a partition from an email or from the cached employee row.
    func storage(for partition: StorePartition) throws -> any FieldLocalStore {
        guard signedIn else { throw StoreError.heldForReview }
        if fieldStore == nil { _ = try storageForBootstrap() }
        if let previous = activeStoragePartition, previous != partition {
            try fieldStore?.holdForReview(previous)
        }
        activeStoragePartition = partition
        return fieldStore!
    }

    init(auth: AuthClient, registry: DeviceRegistry, store: SecretStore,
         pollInterval: Duration = .seconds(10), site: URL? = nil, functions: ConvexFunctions? = nil,
         http: HTTPClient? = nil, loadKey: @escaping () throws -> any DeviceSigningKey) {
        self.auth = auth
        self.registry = registry
        self.secrets = store
        self.site = site
        self.functions = functions
        self.http = http
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
        return AppModel(auth: auth, registry: ConvexDeviceRegistry(functions: functions), store: store,
                        site: environment.siteURL, functions: functions, http: http) {
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
        loadCachedPartition()
        await enrollment.start(loadKey: loadKey)
        if case .ready = enrollment.state { await syncNow() }
        if case .removed = enrollment.state { holdActive() }
    }

    func signIn(email: String, password: String) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            // A prior person's cached partition cannot be shown to a new session.
            try? secrets.delete(Self.partitionAccount)
            activeStoragePartition = nil
            visits = []
            freshThisLaunch = false
            try await auth.signIn(email: email, password: password)
            signInError = nil
            signedIn = true
            await enrollment.start(loadKey: loadKey)
            if case .ready = enrollment.state { await syncNow() }
            if case .removed = enrollment.state { holdActive() }
        } catch let error as MobileError {
            signInError = error.description
        } catch {
            signInError = "Sign-in failed. Try again."
        }
    }

    private func loadCachedPartition() {
        guard let data = try? secrets.read(Self.partitionAccount),
              let cached = try? JSONDecoder().decode(CachedPartition.self, from: data),
              let partition = try? StorePartition(subject: cached.subject, deviceId: cached.deviceId, scope: cached.scope) else { return }
        activeStoragePartition = partition
        refreshToday()
    }

    private func holdActive() {
        if let partition = activeStoragePartition { try? fieldStore?.holdForReview(partition) }
        freshThisLaunch = false
    }

    var stale: Bool {
        guard let partition = activeStoragePartition, freshThisLaunch, syncMessage == nil,
              enrollment.state == .ready(deviceId: partition.deviceId),
              let store = fieldStore else { return true }
        guard (try? store.isLeaseValid(now: Date(), for: partition)) == true,
              let cacheExpiry = try? store.cacheExpiry(for: partition),
              Double(cacheExpiry) > Date().timeIntervalSince1970 * 1000 else { return true }
        return false
    }

    func refreshToday() {
        guard let partition = activeStoragePartition, let store = try? storage(for: partition) else { return }
        do {
            let day = BootstrapClient.manilaDay(Date())
            let outlets = Dictionary(uniqueKeysWithValues: try store.outlets(for: partition).map { ($0.id, $0.name) })
            visits = try store.todayVisits(day, for: partition).map {
                TodayVisit(id: $0.id, outlet: outlets[$0.outletId] ?? "Unknown outlet", planned: true, status: "Planned")
            }
            lastSyncedAt = try store.syncHealth(for: partition).flatMap { $0.lastSuccessfulSyncAt }
                .map { Date(timeIntervalSince1970: Double($0) / 1000) }
        } catch { syncMessage = "Cached visits are unavailable." }
    }

    func syncNow() async {
        guard !bootstrapping, case .ready(let deviceId) = enrollment.state,
              let key = enrollment.key, let site, let functions, let http else { return }
        bootstrapping = true; syncing = true
        defer { bootstrapping = false; syncing = false; refreshToday() }
        do {
            // profiles.current returns the full server-authenticated tokenIdentifier, not an email
            // or an unverified JWT claim. Verify its profile matches bootstrap's employee below.
            guard let profile: ProfileIdentity = try await functions.query("domains/profiles:current", EmptyArgs()),
                  !profile.authSubject.isEmpty else { throw BootstrapClient.Failure.unauthorized }
            let store = try storageForBootstrap()
            let client = BootstrapClient(site: site, auth: auth, registry: registry, http: http, key: key)
            let partition = try await client.run(deviceId: deviceId, subject: profile.authSubject,
                                                  expectedEmployeeId: profile._id,
                                                  store: store, previous: activeStoragePartition)
            guard try store.snapshot(for: partition)?.employee.id == profile._id else {
                try store.holdForReview(partition)
                throw BootstrapClient.Failure.invalidResponse
            }
            // Release only after current identity and bound device have both been verified online.
            try store.releaseHeld(subject: profile.authSubject, deviceId: deviceId)
            activeStoragePartition = partition
            try secrets.save(JSONEncoder().encode(CachedPartition(subject: partition.subject,
                deviceId: partition.deviceId, scope: partition.scope)), for: Self.partitionAccount)
            freshThisLaunch = true
            syncMessage = nil
        } catch let error as BootstrapClient.Failure {
            freshThisLaunch = false
            switch error {
            case .phoneRemoved:
                enrollment.markRemoved()
                syncMessage = "Phone removed — unsent work held for review."
                holdActive()
            case .updateRequired: syncMessage = "Update required before syncing."
            case .restartRequired: syncMessage = "Plan changed. Retry sync."
            case .unauthorized:
                await enrollment.check()
                if case .removed = enrollment.state {
                    syncMessage = "Phone removed — unsent work held for review."
                    holdActive()
                } else { syncMessage = "Sign-in or phone proof was refused." }
            case .retryable: syncMessage = "Sync unavailable. Showing last saved visits."
            case .invalidResponse: syncMessage = "Unexpected sync response. Showing saved visits."
            }
        } catch {
            freshThisLaunch = false
            await enrollment.check()
            if case .removed = enrollment.state {
                syncMessage = "Phone removed — unsent work held for review."
                holdActive()
            } else { syncMessage = "Offline — showing last saved visits." }
        }
        if let partition = activeStoragePartition, let store = fieldStore, let syncMessage {
            let previous = try? store.syncHealth(for: partition)
            try? store.setSyncHealth(SyncHealth(lastSuccessfulSyncAt: previous?.lastSuccessfulSyncAt,
                                               lastErrorCode: syncMessage), for: partition)
        }
    }

    private struct EmptyArgs: Encodable {}
    private func storageForBootstrap() throws -> any FieldLocalStore {
        if let fieldStore { return fieldStore }
        #if DEBUG
        let folder = StubBackend.scenario == nil ? "FieldStore" : "FieldStoreStub"
        #else
        let folder = "FieldStore"
        #endif
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true).appending(path: folder, directoryHint: .isDirectory)
        let store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets)
        fieldStore = store
        return store
    }

    func phoneStateChanged(_ state: Enrollment.State) async {
        switch state {
        case .ready: if !freshThisLaunch { await syncNow() }
        case .removed: holdActive()
        default: break
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
        try? secrets.delete(Self.partitionAccount)
        visits = []
        lastSyncedAt = nil
        freshThisLaunch = false
        syncMessage = nil
        signedIn = false
        await auth.signOut()
    }

    private func sessionEnded() async {
        let reason = enrollment.message
        await signOut()
        signInError = reason ?? MobileError.sessionExpired.description
    }
}
