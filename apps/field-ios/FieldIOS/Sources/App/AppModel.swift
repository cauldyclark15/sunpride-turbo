import Foundation
import Network

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
    /// Route-screen lookups from the same verified partition as `visits`.
    private(set) var outletDetails: [String: StoreSnapshot.Outlet] = [:]
    private(set) var customerDetails: [String: StoreSnapshot.Customer] = [:]
    private(set) var routeCode: String?
    /// IOS-011 customer directory: only outlets in the active verified scope partition, offline.
    private(set) var customers: [CustomerRecord] = []
    /// Day-level tasks from the same saved snapshot.
    private(set) var dayTasks: [StoreSnapshot.Task] = []
    private(set) var callSheets: [CallSheet] = []
    /// IOS-013 activity-form rules per visit intent from the active snapshot.
    private(set) var activityRules: [ActivityRule] = []
    private(set) var lastSyncedAt: Date?
    private(set) var syncStatus: FieldSyncStatus?
    private(set) var isOffline = false
    private(set) var dayTarget: StoreSnapshot.DayTarget?
    let enrollment: Enrollment
    /// Today's summary (date, target, calls, completion, next outlet, ordered route), store-derived.
    private(set) var daySales: StoreSnapshot.DaySales?
    var dashboard: TodayDashboard {
        TodayDashboard.make(visits: visits, target: dayTarget, sales: daySales, now: now(),
                            canStart: { [weak self] in self?.startFailure(for: $0) == nil })
    }

    struct TodayVisit: Identifiable {
        let id: String; let outletId: String; let outlet: String
        let serviceDate: String; let intents: [String]; let planned: Bool; let status: String
        var sequence: Int? = nil
        /// Current verified outlet pin, for the on-phone distance shown at Start/End (display only).
        var pin: OutletPin? = nil
        var startedAt: Date? = nil
        var endedAt: Date? = nil
        /// End outcome recorded on this phone ("completed" or "nonproductive"), queued or synced.
        var outcome: String? = nil
        /// Activity kinds recorded in this call on this phone (queued or synced, never rejected).
        var activityKinds: [String] = []
        /// End reason code (e.g. the truck seller's "no_sales_due_to_inventory").
        var reasonCode: String? = nil
        var timeSpent: String? {
            guard let startedAt, let endedAt else { return nil }
            return "\(max(0, Int(endedAt.timeIntervalSince(startedAt) / 60))) min"
        }
    }
    enum CallFailure: Error, Equatable {
        case callOpen, mcpOrder, alreadyStarted, notStarted, alreadyClosed, intentRequired, activitiesRequired
        var message: String {
            switch self {
            case .callOpen: "Finish the open call first"
            case .mcpOrder: "Visit stores in plan order"
            case .alreadyStarted: "Call already started"
            case .notStarted: "Start the call first"
            case .alreadyClosed: "Call already ended"
            case .intentRequired: "Choose at least one visit purpose"
            case .activitiesRequired: "Record the required activities, or end as not productive"
            }
        }
    }
    private struct LocalCall {
        let initial: VisitIntent
        let end: VisitIntent?
        var closed: Bool { end != nil }
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
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private var activeStoragePartition: StorePartition?
    @ObservationIgnored private var bootstrapping = false
    @ObservationIgnored private let networkMonitor = NWPathMonitor()
    @ObservationIgnored private var monitoring = false
    @ObservationIgnored private var breadcrumbs: DiagnosticBreadcrumbs?
    var hasRetryableWork: Bool {
        guard signedIn, let partition = activeStoragePartition, let store = fieldStore else { return false }
        return BackgroundRetry.hasRetryableWork(store: store, partition: partition)
    }
    var supportText: String { SupportInfo(secrets: secrets).text(status: syncStatus) }
    private func breadcrumb(_ event: DiagnosticEvent) {
        if breadcrumbs == nil,
           let folder = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                      appropriateFor: nil, create: true) {
            breadcrumbs = DiagnosticBreadcrumbs(url: folder.appending(path: "field-breadcrumbs.json"))
        }
        breadcrumbs?.add(event)
    }
    func startConnectivity() {
        guard !monitoring else { return }
        monitoring = true
        networkMonitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let wasOffline = self.isOffline
                self.isOffline = path.status != .satisfied
                self.refreshToday()
                if wasOffline && !self.isOffline { await self.syncNow() }
            }
        }
        networkMonitor.start(queue: DispatchQueue(label: "field.network.path"))
    }

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
         http: HTTPClient? = nil, localStore: EncryptedFieldStore? = nil,
         now: @escaping () -> Date = { Date() }, loadKey: @escaping () throws -> any DeviceSigningKey) {
        self.auth = auth
        self.registry = registry
        self.secrets = store
        self.site = site
        self.functions = functions
        self.http = http
        self.loadKey = loadKey
        self.fieldStore = localStore
        self.now = now
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
            clearToday()
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

    private func clearToday() {
        visits = []; callSheets = []; activityRules = []; outletDetails = [:]; customerDetails = [:]; routeCode = nil
        customers = []; dayTasks = []; dayTarget = nil; daySales = nil
    }

    /// Confirmed revocation/suspension (QSR-010): hold unsent work and drop this partition's cached
    /// plan, outlets, customers and prices from storage and memory.
    private func holdActive() {
        if let partition = activeStoragePartition {
            do { try fieldStore?.purgeCacheForReview(partition) }
            catch { try? fieldStore?.holdForReview(partition) }
        }
        clearToday()
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

    func refreshStatus() {
        guard let partition = activeStoragePartition, let store = fieldStore else { syncStatus = nil; return }
        syncStatus = try? FieldSyncStatus.read(store: store, partition: partition, now: now(),
                                               sending: syncing, offline: isOffline)
    }

    func refreshToday() {
        guard let partition = activeStoragePartition, let store = try? storage(for: partition) else { return }
        do {
            callSheets = try store.snapshot(for: partition)?.callSheets ?? []
            activityRules = try store.snapshot(for: partition)?.activityRules ?? []
            let day = BootstrapClient.manilaDay(now())
            let outlets = Dictionary(uniqueKeysWithValues: try store.outlets(for: partition).map { ($0.id, $0.name) })
            let planned = try store.todayVisits(day, for: partition)
            let localOutlets = try store.outlets(for: partition)
            let pins = Dictionary(localOutlets.compactMap { outlet in outlet.pin.map { (outlet.id, $0) } }, uniquingKeysWith: { a, _ in a })
            let saved = try store.snapshot(for: partition)
            outletDetails = Dictionary(localOutlets.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            customerDetails = Dictionary((saved?.customers ?? []).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            routeCode = saved?.route?.code
            let rows = planned.map { visit in
                TodayVisit(id: visit.id, outletId: visit.outletId, outlet: outlets[visit.outletId] ?? "Unknown outlet",
                    serviceDate: visit.serviceDate, intents: visit.intents, planned: true, status: "Planned", sequence: visit.sequence,
                    pin: pins[visit.outletId])
            } + localOutlets.filter { outlet in !planned.contains(where: { $0.outletId == outlet.id }) }.map { outlet in
                TodayVisit(id: "unplanned-\(outlet.id)", outletId: outlet.id, outlet: outlet.name,
                    serviceDate: day, intents: [], planned: false, status: "Unplanned", pin: outlet.pin)
            }
            let intents = try store.intents(for: partition)
            let queued = Set(try store.pendingOutbox(for: partition).map { $0.intent.requestId } +
                             (try store.deferredOutbox(for: partition).map { $0.intent.requestId }) +
                             (try store.heldOutbox(for: partition).map { $0.intent.requestId }))
            let rejected = try store.reviewOutbox(for: partition)
            review = rejected.map { item in
                let reasons: [String: String] = [
                    "invalid_request": "Invalid request", "invalid_plan": "Plan is no longer valid",
                    "conflict": "Conflicts with server record", "dependency_missing": "Check-in was not accepted",
                    "unsupported_operation": "Operation not supported", "out_of_scope": "Outside current scope",
                    "evidence_pending_review": "Evidence needs review", "invalid_transition": "Visit state changed",
                    "call_open": "Finish the open call first", "mcp_order": "Visit stores in plan order",
                    "wrong_date": "Visit date does not match the phone date",
                    "unknown_code": "Unrecognized server reason", "unknown_status": "Unrecognized server status"
                ]
                return "\(item.intent.kind) · \(reasons[item.code] ?? "Unknown outcome — ask supervisor")"
            }
            if try store.isHeld(partition), !intents.isEmpty { review.append("Unsent work held — verify account and scope") }
            if try store.hasOtherHeldWork(for: partition) { review.append("Prior scope has unsent work held for supervised review") }
            let calls = localCalls(intents: intents, rejected: Set(rejected.map { $0.intent.requestId }))
            visits = rows.map { visit in
                let initial = intents.first { $0.matches(visit) }
                let related = intents.filter { intent in
                    intent.matches(visit) || initial.map { start in intent.dependencies.contains(start.requestId.uuidString.lowercased()) } == true
                }
                let call = calls.first { $0.initial.matches(visit) }
                let status: String
                if related.contains(where: { intent in rejected.contains(where: { $0.intent.requestId == intent.requestId }) }) { status = "Needs review" }
                else if related.contains(where: { queued.contains($0.requestId) }) { status = syncing ? "Sending" : "Queued" }
                else if !related.isEmpty { status = "Accepted" }
                else { status = visit.status }
                let activityKinds = call.map { open in
                    intents.filter { intent in
                        intent.kind == "visit.activity" &&
                        intent.dependencies.contains(open.initial.requestId.uuidString.lowercased()) &&
                        !rejected.contains(where: { $0.intent.requestId == intent.requestId })
                    }.compactMap { ($0.payload?["activity"] as? [String: Any])?["kind"] as? String }
                } ?? []
                return TodayVisit(id: visit.id, outletId: visit.outletId, outlet: visit.outlet,
                                  serviceDate: visit.serviceDate, intents: visit.intents, planned: visit.planned, status: status,
                                  sequence: visit.sequence, pin: visit.pin, startedAt: call?.initial.deviceTime, endedAt: call?.end?.deviceTime,
                                  outcome: call?.end?.payload?["outcome"] as? String,
                                  activityKinds: activityKinds, reasonCode: call?.end?.payload?["reasonCode"] as? String)
            }
            let held = try store.isHeld(partition)
            let rejectedIds = Set(rejected.map { $0.intent.requestId })
            customers = CustomerDirectory.build(snapshot: saved, today: visits, day: day, history: intents.map { intent in
                let state: LocalIntentState
                if rejectedIds.contains(intent.requestId) { state = .review }
                else if queued.contains(intent.requestId) { state = held ? .held : .waiting }
                else { state = .sent }
                return (intent, state)
            })
            dayTasks = saved?.tasks ?? []
            dayTarget = saved?.dayTarget
            daySales = saved?.daySales
            lastSyncedAt = try store.syncHealth(for: partition).flatMap { $0.lastSuccessfulSyncAt }
                .map { Date(timeIntervalSince1970: Double($0) / 1000) }
            refreshStatus()
        } catch { syncMessage = "Cached visits are unavailable." }
    }

    private func localCalls(intents: [VisitIntent], rejected: Set<UUID>) -> [LocalCall] {
        intents.filter { $0.kind == "visit.checkIn" && !rejected.contains($0.requestId) }.map { initial in
            let end = intents.first { $0.kind == "visit.checkOut" && !rejected.contains($0.requestId) &&
                $0.dependencies.contains(initial.requestId.uuidString.lowercased()) &&
                ["completed", "nonproductive"].contains($0.payload?["outcome"] as? String ?? "") &&
                ($0.payload?["outcome"] as? String != "nonproductive" ||
                 ($0.payload?["reasonCode"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
            }
            return LocalCall(initial: initial, end: end)
        }
    }
    /// UI and commands share this durable guard; a queued End is enough to move on offline.
    func startFailure(for visit: TodayVisit) -> CallFailure? {
        do { try validateStart(visit); return nil }
        catch let error as CallFailure { return error }
        catch { return .notStarted }
    }
    private func validateStart(_ visit: TodayVisit) throws {
        guard let partition = activeStoragePartition else { throw StoreError.invalidInput }
        let store = try storage(for: partition)
        let intents = try store.intents(for: partition)
        if intents.contains(where: { $0.matches(visit) }) { throw CallFailure.alreadyStarted }
        let rejected = Set(try store.reviewOutbox(for: partition).map { $0.intent.requestId })
        let calls = localCalls(intents: intents, rejected: rejected)
        if calls.contains(where: { $0.initial.payload?["serviceDate"] as? String == visit.serviceDate && !$0.closed }) {
            throw CallFailure.callOpen
        }
        guard visit.planned else { return }
        // Read the authoritative saved plan, not sequence supplied by a stale view/caller.
        let planned = try store.snapshot(for: partition)?.visits.filter { $0.serviceDate == visit.serviceDate } ?? []
        guard let index = planned.firstIndex(where: { $0.id == visit.id }) else { throw StoreError.invalidInput }
        let sequence = planned[index].sequence ?? index
        for (position, earlier) in planned.enumerated() where (earlier.sequence ?? position) < sequence {
            guard calls.contains(where: { $0.initial.payload?["plannedVisitId"] as? String == earlier.id &&
                $0.initial.payload?["serviceDate"] as? String == visit.serviceDate && $0.closed }) else { throw CallFailure.mcpOrder }
        }
    }
    private func checkIn(for visit: TodayVisit) throws -> (VisitIntent, any FieldLocalStore, StorePartition) {
        guard let partition = activeStoragePartition else { throw StoreError.invalidInput }
        let store = try storage(for: partition)
        guard let intent = try store.intents(for: partition).first(where: { $0.matches(visit) }) else { throw CallFailure.notStarted }
        return (intent, store, partition)
    }
    /// A planned visit keeps its signed MCP intents (`intents` is ignored); an unplanned visit
    /// starts with the purposes the person chose (IOS-013), at least one.
    func queueCheckIn(_ visit: TodayVisit, unplannedReason: String?, intents chosen: [String] = [],
                      location: VisitLocation?) throws {
        try validateStart(visit)
        guard let partition = activeStoragePartition else { throw StoreError.invalidInput }
        let purposes = ActivityRules.intents.filter(chosen.contains)
        if !visit.planned && purposes.isEmpty { throw CallFailure.intentRequired }
        let store = try storage(for: partition)
        let timestamp = now()
        let intent = try DiagnosticOperation.checkIn(plannedId: visit.planned ? visit.id : nil,
            outletId: visit.outletId, day: visit.serviceDate, intents: visit.planned ? visit.intents : purposes,
            reason: visit.planned ? nil : unplannedReason, location: location, now: timestamp)
        try store.enqueue(intent, for: partition, now: timestamp)
        didQueueWork()
    }
    func queueNote(_ note: String, for visit: TodayVisit) throws {
        let (initial, store, partition) = try checkIn(for: visit)
        guard !(try store.intents(for: partition)).contains(where: { $0.kind == "visit.checkOut" &&
            $0.dependencies.contains(initial.requestId.uuidString.lowercased()) }) else { throw CallFailure.alreadyClosed }
        let ack = try store.ack(for: initial.requestId, in: partition)
        let timestamp = now()
        let intent = try DiagnosticOperation.note(note, checkIn: initial.requestId, visitId: ack?.entityId, now: timestamp)
        if ack == nil { try store.enqueueDeferred(intent, for: partition, now: timestamp) }
        else { try store.enqueue(intent, for: partition, now: timestamp) }
        didQueueWork()
    }
    /// The visit's purposes: signed MCP intents when planned, else those chosen at Start.
    func visitIntents(for visit: TodayVisit) -> [String] {
        if visit.planned { return visit.intents }
        guard let (initial, _, _) = try? checkIn(for: visit) else { return [] }
        return ActivityRules.intents(of: initial)
    }
    /// IOS-013 checklist for the visit's call: the forms its intents' rules require or offer.
    func activityChecklist(for visit: TodayVisit) -> [ActivityRules.Requirement] {
        let sheet = callSheet(for: visit)
        guard let (initial, store, partition) = try? checkIn(for: visit),
              let intents = try? store.intents(for: partition),
              let rejected = try? Set(store.reviewOutbox(for: partition).map { $0.intent.requestId }) else {
            return ActivityRules.checklist(rules: activityRules, intents: visitIntents(for: visit), recorded: []) {
                ActivityRules.capturable($0, sheet: sheet)
            }
        }
        return ActivityRules.checklist(rules: activityRules, intents: ActivityRules.intents(of: initial),
            recorded: ActivityRules.recordedKinds(checkIn: initial, intents: intents, rejected: rejected)) {
            ActivityRules.capturable($0, sheet: sheet)
        }
    }
    /// Queue one structured activity form (merchandising, promotion, inventory or price check).
    func queueActivity(_ activity: [String: Any], for visit: TodayVisit) throws {
        let (initial, store, partition) = try checkIn(for: visit)
        guard !visitProgress(for: visit).checkedOut else { throw CallFailure.alreadyClosed }
        // Validate against the active encrypted snapshot, not a stale editor projection.
        let sheet = try store.snapshot(for: partition)?.callSheets.first { $0.outletId == visit.outletId }
        try ActivityForms.validate(activity, sheet: sheet)
        let ack = try store.ack(for: initial.requestId, in: partition)
        let timestamp = now()
        let intent = try DiagnosticOperation.activity(activity, checkIn: initial.requestId,
                                                      visitId: ack?.entityId, now: timestamp)
        if ack == nil { try store.enqueueDeferred(intent, for: partition, now: timestamp) }
        else { try store.enqueue(intent, for: partition, now: timestamp) }
        didQueueWork()
    }
    func callSheet(for visit: TodayVisit) -> CallSheet? {
        callSheets.first { $0.outletId == visit.outletId }
    }
    func visitProgress(for visit: TodayVisit) -> (checkedIn: Bool, checkedOut: Bool) {
        guard let (initial, store, partition) = try? checkIn(for: visit) else { return (false, false) }
        let checkedOut = (try? store.intents(for: partition))?.contains { item in
            item.kind == "visit.checkOut" &&
            ((try? JSONSerialization.jsonObject(with: item.operationJSON) as? [String: Any])?["dependsOn"] as? [String])?.contains(initial.requestId.uuidString.lowercased()) == true
        } ?? false
        return (true, checkedOut)
    }
    func callSheetStatus(for visit: TodayVisit) -> String? {
        guard let (initial, store, partition) = try? checkIn(for: visit),
              let intents = try? store.intents(for: partition),
              let latest = intents.last(where: { item in
                  guard let object = try? JSONSerialization.jsonObject(with: item.operationJSON) as? [String: Any],
                        (object["dependsOn"] as? [String])?.contains(initial.requestId.uuidString.lowercased()) == true,
                        let payload = object["payload"] as? [String: Any],
                        let activity = payload["activity"] as? [String: Any] else { return false }
                  return activity["kind"] as? String == "call_sheet"
              }) else { return nil }
        if (try? store.ack(for: latest.requestId, in: partition)) != nil { return "Sent" }
        if (try? store.reviewOutbox(for: partition))?.contains(where: { $0.intent.requestId == latest.requestId }) == true { return "Needs review" }
        if (try? store.isHeld(partition)) == true { return "Held for review" }
        return syncing ? "Sending" : "Queued"
    }
    func queueCallSheet(_ drafts: [String: CallSheetDraft], for visit: TodayVisit) throws {
        let (initial, store, partition) = try checkIn(for: visit)
        // The call sheet belongs to the open call: after Start and before End.
        guard !visitProgress(for: visit).checkedOut else { throw CallFailure.alreadyClosed }
        // Always validate against the active encrypted snapshot, not a stale editor projection.
        guard let sheet = try store.snapshot(for: partition)?.callSheets.first(where: { $0.outletId == visit.outletId }) else {
            throw StoreError.invalidInput
        }
        let ack = try store.ack(for: initial.requestId, in: partition)
        let timestamp = now()
        let intent = try DiagnosticOperation.callSheet(sheet, drafts: drafts, checkIn: initial.requestId,
                                                       visitId: ack?.entityId, now: timestamp)
        if ack == nil { try store.enqueueDeferred(intent, for: partition, now: timestamp) }
        else { try store.enqueue(intent, for: partition, now: timestamp) }
        didQueueWork()
    }
    func queueCheckOut(outcome: String, reason: String?, for visit: TodayVisit, location: VisitLocation? = nil) throws {
        let (initial, store, partition) = try checkIn(for: visit)
        guard !(try store.intents(for: partition)).contains(where: { $0.kind == "visit.checkOut" &&
            $0.dependencies.contains(initial.requestId.uuidString.lowercased()) }) else { throw CallFailure.alreadyClosed }
        // IOS-013: a completed End needs every capturable required form; not productive needs none.
        if outcome == "completed" {
            let snapshot = try store.snapshot(for: partition)
            let rejected = Set(try store.reviewOutbox(for: partition).map { $0.intent.requestId })
            let missing = ActivityRules.missingForEnd(checkIn: initial, rules: snapshot?.activityRules ?? [],
                intents: try store.intents(for: partition), rejected: rejected,
                sheet: snapshot?.callSheets.first { $0.outletId == visit.outletId })
            if !missing.isEmpty { throw CallFailure.activitiesRequired }
        }
        let ack = try store.ack(for: initial.requestId, in: partition)
        let timestamp = now()
        let intent = try DiagnosticOperation.checkOut(outcome: outcome, reason: reason,
            checkIn: initial.requestId, visitId: ack?.entityId, location: location, now: timestamp)
        if ack == nil { try store.enqueueDeferred(intent, for: partition, now: timestamp) }
        else { try store.enqueue(intent, for: partition, now: timestamp) }
        didQueueWork()
    }
    private func didQueueWork() {
        refreshToday()
        breadcrumb(.workQueued)
        BackgroundRetry.shared.scheduleIfNeeded()
    }

    func syncNow() async {
        guard !bootstrapping, !Task.isCancelled, !isOffline, case .ready(let deviceId) = enrollment.state,
              let key = enrollment.key, let site, let functions, let http else { return }
        bootstrapping = true; syncing = true; breadcrumb(.syncStarted); refreshToday()
        var succeeded = false
        defer {
            if !succeeded && !Task.isCancelled, let partition = activeStoragePartition,
               let store = fieldStore, let message = syncMessage {
                let code: String
                if message.hasPrefix("Phone removed") { code = "revoked" }
                else if message.contains("proof") || message.contains("Sign-in") { code = "unauthorized" }
                else if message.contains("Plan") || message.contains("Scope") { code = "rebootstrap" }
                else if message.contains("Unexpected") { code = "invalid_response" }
                else { code = "retryable" }
                let previous = try? store.syncHealth(for: partition)
                try? store.setSyncHealth(SyncHealth(lastSuccessfulSyncAt: previous?.lastSuccessfulSyncAt,
                                                   lastErrorCode: code), for: partition)
                breadcrumb(.syncFailed)
            }
            bootstrapping = false; syncing = false; refreshToday()
            BackgroundRetry.shared.scheduleIfNeeded()
        }
        let sync = VisitSyncClient(site: site, auth: auth, registry: registry, http: http, key: key)
        if freshThisLaunch, let current = activeStoragePartition, let store = fieldStore,
           (try? store.cursor(for: current)) != nil {
            do {
                try await sync.push(store: store, partition: current)
                try await sync.pull(store: store, partition: current)
                try Task.checkCancellation()
                try store.setSyncHealth(SyncHealth(lastSuccessfulSyncAt: Int64(Date().timeIntervalSince1970 * 1000), lastErrorCode: nil), for: current)
                breadcrumb(.syncSucceeded)
                succeeded = true
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
            } catch is CancellationError {
                breadcrumb(.syncCancelled)
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
                try Task.checkCancellation()
                try store.setSyncHealth(SyncHealth(lastSuccessfulSyncAt: Int64(Date().timeIntervalSince1970 * 1000), lastErrorCode: nil), for: partition)
                breadcrumb(.syncSucceeded)
                succeeded = true
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
            } catch is CancellationError {
                breadcrumb(.syncCancelled)
                return
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
        } catch is CancellationError {
            breadcrumb(.syncCancelled)
            return
        } catch {
            freshThisLaunch = false
            await enrollment.check()
            if case .removed = enrollment.state {
                syncMessage = "Phone removed — unsent work held for review."
                holdActive()
            } else { syncMessage = "Offline — showing last saved visits." }
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

    /// The local store if one exists on disk; never creates a database (or its key) just to sign out.
    private func existingStore() throws -> EncryptedFieldStore? {
        if let fieldStore { return fieldStore }
        #if DEBUG
        let folder = StubBackend.scenario == nil ? "FieldStore" : "FieldStoreStub"
        #else
        let folder = "FieldStore"
        #endif
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first,
              FileManager.default.fileExists(atPath: support.appending(path: folder).appending(path: "field.sqlite").path)
        else { return nil }
        _ = try storageForBootstrap()
        return fieldStore
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
        // QSR-010: every partition is held and its cached plan, customers and prices removed; only
        // encrypted unsent evidence remains for supervised review.
        do { try existingStore()?.purgeAllCachesForReview() }
        catch {
            if let partition = activeStoragePartition { try? fieldStore?.holdForReview(partition) }
            signInError = "Local evidence needs supervised review; storage could not be locked."
        }
        activeStoragePartition = nil
        try? secrets.delete(Self.partitionAccount)
        clearToday()
        lastSyncedAt = nil
        syncStatus = nil
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
