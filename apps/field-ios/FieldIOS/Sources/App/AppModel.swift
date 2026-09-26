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
    private(set) var review: [String] = []
    private(set) var visits: [TodayVisit] = []
    private(set) var lastSyncedAt: Date?
    let enrollment: Enrollment

    struct TodayVisit: Identifiable {
        let id: String; let outletId: String; let outlet: String
        let serviceDate: String; let intents: [String]; let planned: Bool; let status: String
    }
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
            let planned = try store.todayVisits(day, for: partition)
            let localOutlets = try store.outlets(for: partition)
            let rows = planned.map { visit in
                TodayVisit(id: visit.id, outletId: visit.outletId, outlet: outlets[visit.outletId] ?? "Unknown outlet",
                    serviceDate: visit.serviceDate, intents: visit.intents, planned: true, status: "Planned")
            } + localOutlets.filter { outlet in !planned.contains(where: { $0.outletId == outlet.id }) }.map { outlet in
                TodayVisit(id: "unplanned-\(outlet.id)", outletId: outlet.id, outlet: outlet.name,
                    serviceDate: day, intents: [], planned: false, status: "Unplanned")
            }
            let intents = try store.intents(for: partition)
            let queued = Set(try store.pendingOutbox(for: partition).map { $0.intent.requestId } +
                             (try store.deferredOutbox(for: partition).map { $0.intent.requestId }) +
                             (try store.heldOutbox(for: partition).map { $0.intent.requestId }))
            let rejected = try store.reviewOutbox(for: partition)
            review = rejected.map { "\($0.intent.kind) · \($0.code)" }
            if try store.isHeld(partition), !intents.isEmpty { review.append("Unsent work held — verify account and scope") }
            if try store.hasOtherHeldWork(for: partition) { review.append("Prior scope has unsent work held for supervised review") }
            visits = rows.map { visit in
                let related = intents.filter { intent in
                    guard let object = try? JSONSerialization.jsonObject(with: intent.operationJSON) as? [String: Any],
                          let payload = object["payload"] as? [String: Any] else { return false }
                    if intent.kind == "visit.checkIn" { return payload["plannedVisitId"] as? String == visit.id ||
                        (payload["plannedVisitId"] is NSNull && payload["outletId"] as? String == visit.outletId) }
                    let dependency = (object["dependsOn"] as? [String])?.first
                    return intents.contains { initial in
                        guard initial.kind == "visit.checkIn", initial.requestId.uuidString.lowercased() == dependency,
                              let original = try? JSONSerialization.jsonObject(with: initial.operationJSON) as? [String: Any],
                              let body = original["payload"] as? [String: Any] else { return false }
                        return body["plannedVisitId"] as? String == visit.id ||
                            (body["plannedVisitId"] is NSNull && body["outletId"] as? String == visit.outletId)
                    }
                }
                let status: String
                if related.contains(where: { intent in rejected.contains(where: { $0.intent.requestId == intent.requestId }) }) { status = "Needs review" }
                else if related.contains(where: { queued.contains($0.requestId) }) { status = syncing ? "Sending" : "Queued" }
                else if !related.isEmpty { status = "Accepted" }
                else { status = visit.status }
                return TodayVisit(id: visit.id, outletId: visit.outletId, outlet: visit.outlet,
                                  serviceDate: visit.serviceDate, intents: visit.intents, planned: visit.planned, status: status)
            }
            lastSyncedAt = try store.syncHealth(for: partition).flatMap { $0.lastSuccessfulSyncAt }
                .map { Date(timeIntervalSince1970: Double($0) / 1000) }
        } catch { syncMessage = "Cached visits are unavailable." }
    }

    private func checkIn(for visit: TodayVisit) throws -> (VisitIntent, any FieldLocalStore, StorePartition) {
        guard let partition = activeStoragePartition else { throw StoreError.invalidInput }
        let store = try storage(for: partition)
        guard let intent = try store.intents(for: partition).first(where: { item in
            guard item.kind == "visit.checkIn",
                  let object = try? JSONSerialization.jsonObject(with: item.operationJSON) as? [String: Any],
                  let payload = object["payload"] as? [String: Any] else { return false }
            return payload["plannedVisitId"] as? String == visit.id ||
                (payload["plannedVisitId"] is NSNull && payload["outletId"] as? String == visit.outletId)
        }) else { throw StoreError.invalidInput }
        return (intent, store, partition)
    }
    func queueCheckIn(_ visit: TodayVisit, unplannedReason: String?, location: VisitLocation) throws {
        guard let partition = activeStoragePartition else { throw StoreError.invalidInput }
        if !visit.planned && unplannedReason == nil { throw DiagnosticOperation.Failure.invalidReason }
        let store = try storage(for: partition)
        guard !(try store.intents(for: partition)).contains(where: { item in
            guard item.kind == "visit.checkIn",
                  let object = try? JSONSerialization.jsonObject(with: item.operationJSON) as? [String: Any],
                  let payload = object["payload"] as? [String: Any] else { return false }
            return payload["plannedVisitId"] as? String == visit.id ||
                (payload["plannedVisitId"] is NSNull && payload["outletId"] as? String == visit.outletId)
        }) else { throw StoreError.alreadyResolved }
        let intent = try DiagnosticOperation.checkIn(plannedId: unplannedReason == nil ? visit.id : nil,
            outletId: visit.outletId, day: visit.serviceDate, intents: unplannedReason == nil ? visit.intents : [],
            reason: unplannedReason, location: location)
        try store.enqueue(intent, for: partition, now: Date())
        refreshToday()
    }
    func queueNote(_ note: String, for visit: TodayVisit) throws {
        let (initial, store, partition) = try checkIn(for: visit)
        guard !(try store.intents(for: partition)).contains(where: { item in
            item.kind == "visit.checkOut" &&
            ((try? JSONSerialization.jsonObject(with: item.operationJSON) as? [String: Any])?["dependsOn"] as? [String])?.contains(initial.requestId.uuidString.lowercased()) == true
        }) else { throw StoreError.alreadyResolved }
        let ack = try store.ack(for: initial.requestId, in: partition)
        let intent = try DiagnosticOperation.note(note, checkIn: initial.requestId, visitId: ack?.entityId)
        if ack == nil { try store.enqueueDeferred(intent, for: partition, now: Date()) }
        else { try store.enqueue(intent, for: partition, now: Date()) }
        refreshToday()
    }
    func queueCheckOut(outcome: String, reason: String?, for visit: TodayVisit) throws {
        let (initial, store, partition) = try checkIn(for: visit)
        guard !(try store.intents(for: partition)).contains(where: { $0.kind == "visit.checkOut" &&
            ((try? JSONSerialization.jsonObject(with: $0.operationJSON) as? [String: Any])?["dependsOn"] as? [String])?.contains(initial.requestId.uuidString.lowercased()) == true
        }) else { throw StoreError.alreadyResolved }
        let ack = try store.ack(for: initial.requestId, in: partition)
        let intent = try DiagnosticOperation.checkOut(outcome: outcome, reason: reason,
            checkIn: initial.requestId, visitId: ack?.entityId)
        if ack == nil { try store.enqueueDeferred(intent, for: partition, now: Date()) }
        else { try store.enqueue(intent, for: partition, now: Date()) }
        refreshToday()
    }

    func syncNow() async {
        guard !bootstrapping, case .ready(let deviceId) = enrollment.state,
              let key = enrollment.key, let site, let functions, let http else { return }
        bootstrapping = true; syncing = true; refreshToday()
        defer { bootstrapping = false; syncing = false; refreshToday() }
        let sync = VisitSyncClient(site: site, auth: auth, registry: registry, http: http, key: key)
        if freshThisLaunch, let current = activeStoragePartition, let store = fieldStore,
           (try? store.cursor(for: current)) != nil {
            do {
                try await sync.push(store: store, partition: current)
                try await sync.pull(store: store, partition: current)
                if syncMessage?.hasPrefix("Scope changed") != true { syncMessage = nil }
                return
            } catch VisitSyncClient.Failure.rebootstrap {
                try? store.holdForReview(current)
                freshThisLaunch = false
                // Continue into online identity check + staged bootstrap, without dropping the outbox.
            } catch VisitSyncClient.Failure.revoked {
                enrollment.markRemoved(); holdActive()
                syncMessage = "Phone removed — unsent work held for review."
                return
            } catch VisitSyncClient.Failure.unauthorized {
                await enrollment.check()
                if case .removed = enrollment.state { holdActive() }
                syncMessage = "Sync proof refused — work retained."
                return
            } catch {
                syncMessage = "Sync unavailable — queued work retained."
                return
            }
        }
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
            // A changed scope never resumes the prior partition's unsent work automatically.
            let scopeChanged = activeStoragePartition.map { $0 != partition } ?? false
            try store.releaseHeld(partition)
            if let prior = activeStoragePartition, prior != partition { try store.holdForReview(prior) }
            activeStoragePartition = partition
            try secrets.save(JSONEncoder().encode(CachedPartition(subject: partition.subject,
                deviceId: partition.deviceId, scope: partition.scope)), for: Self.partitionAccount)
            freshThisLaunch = true
            syncMessage = scopeChanged ? "Scope changed — prior unsent work held for review." : nil
            do {
                try await sync.push(store: store, partition: partition)
                try await sync.pull(store: store, partition: partition)
            } catch VisitSyncClient.Failure.rebootstrap {
                try store.holdForReview(partition)
                syncMessage = "Plan or cursor changed again — unsent work held for review."
            } catch VisitSyncClient.Failure.revoked {
                enrollment.markRemoved(); holdActive()
                syncMessage = "Phone removed — unsent work held for review."
            } catch VisitSyncClient.Failure.unauthorized {
                await enrollment.check()
                if case .removed = enrollment.state { holdActive() }
                syncMessage = "Sync proof refused — work retained."
            } catch {
                syncMessage = "Sync unavailable — queued work retained."
            }
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
