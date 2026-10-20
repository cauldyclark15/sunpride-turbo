import Foundation

/// No page or cursor is written until the final page has been validated. Requests use independent,
/// one-use challenges; a 401 retry also re-signs with a fresh challenge rather than replaying a nonce.
@MainActor
final class BootstrapClient {
    enum Failure: Error, Equatable {
        case phoneRemoved, updateRequired, unauthorized, retryable, invalidResponse, restartRequired
        /// QSR-009 back-off (HTTP 429 or a refused challenge): retry on a later sync, not immediately.
        case throttled
    }
    private let site: URL
    private let auth: AuthClient
    private let registry: DeviceRegistry
    private let http: HTTPClient
    private let key: any DeviceSigningKey
    private var snapshotId: String?

    init(site: URL, auth: AuthClient, registry: DeviceRegistry, http: HTTPClient, key: any DeviceSigningKey) {
        self.site = site; self.auth = auth; self.registry = registry; self.http = http; self.key = key
    }

    nonisolated static func manilaDay(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: "Asia/Manila")!
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    func run(deviceId: String, subject: String, expectedEmployeeId: String? = nil,
             store: any FieldLocalStore, previous: StorePartition? = nil) async throws -> StorePartition {
        guard !deviceId.isEmpty, !subject.isEmpty else { throw Failure.invalidResponse }
        for restart in 0..<2 {
            do { return try await collect(deviceId: deviceId, subject: subject, expectedEmployeeId: expectedEmployeeId,
                                          store: store, previous: previous) }
            catch Failure.restartRequired where restart == 0 { continue }
        }
        throw Failure.restartRequired
    }

    private func collect(deviceId: String, subject: String, expectedEmployeeId: String?,
                         store: any FieldLocalStore, previous: StorePartition?) async throws -> StorePartition {
        snapshotId = nil
        var first: BootstrapV1.Page?
        var visits: [StoreSnapshot.Visit] = []
        var outlets: [StoreSnapshot.Outlet] = []
        var callSheets: [CallSheet] = []
        var orderTerms: [OrderTerms] = []
        var products: [BootstrapV1.Product] = []
        var inventory: [BootstrapV1.InventoryAvailability] = []
        var summaries: [AccountSummary] = []
        var customers: [StoreSnapshot.Customer] = []
        var tasks: [StoreSnapshot.Task] = []
        var route: StoreSnapshot.Route?
        var dayTarget: StoreSnapshot.DayTarget?
        var daySales: StoreSnapshot.DaySales?
        var activityRules: [ActivityRule]?
        var photoTypes: [PhotoType]?
        var serverVisits: [StoreSnapshot.ServerVisit] = []
        var next: String?
        var seen = Set<String>()
        var lease = Int64.max, cache = Int64.max
        for pageNumber in 1...50 {
            try Task.checkCancellation()
            let page = try await fetch(deviceId: deviceId, cursor: next, previous: previous, store: store, pageNumber: pageNumber)
            guard page.page == pageNumber,
                  expectedEmployeeId == nil || page.employee.id == expectedEmployeeId else { throw Failure.invalidResponse }
            if let initial = first {
                guard initial.employee.id == page.employee.id,
                      initial.employee.role == page.employee.role,
                      initial.employee.orgUnitId == page.employee.orgUnitId,
                      initial.scope == page.scope, initial.permissions == page.permissions else { throw Failure.restartRequired }
            } else { first = page }
            lease = min(lease, page.appConfig.offlineLeaseExpiresAt)
            cache = min(cache, page.appConfig.cacheExpiresAt)
            guard lease > page.serverTime, cache > page.serverTime else { throw Failure.retryable }
            visits += page.plannedVisits
            outlets += page.outlets
            callSheets += page.callSheets
            orderTerms += page.orderTerms
            products += page.productCatalog
            inventory += page.inventoryAvailability
            summaries += page.accountSummaries
            customers += page.localCustomers
            tasks += page.tasks
            if let target = page.dayTarget {
                // Every page reads the same standard; a mid-download change restarts the bootstrap.
                if let previousTarget = dayTarget, previousTarget != target { throw Failure.restartRequired }
                dayTarget = target
            }
            // Sales can grow between pages (an order lands mid-download): keep the latest, stamped
            // with that page's server time, instead of restarting the bootstrap.
            if var sales = page.daySales {
                sales.asOf = page.serverTime
                daySales = sales
            }
            if let rules = page.activityRules {
                // One download carries one rule set (the server's signed manifest): a change restarts.
                if let previousRules = activityRules, previousRules != rules { throw Failure.restartRequired }
                activityRules = rules
            }
            serverVisits += page.visitExecutions ?? []
            if let types = page.photoTypes {
                // Same rule as activityRules: one download, one list; a change restarts.
                if let previousTypes = photoTypes, previousTypes != types { throw Failure.restartRequired }
                photoTypes = types
            }
            if let r = page.route {
                if let previousRoute = route,
                   (previousRoute.id != r.id || previousRoute.code != r.code) { throw Failure.invalidResponse }
                route = r
            }
            if let token = page.nextPageCursor {
                guard !token.isEmpty, seen.insert(token).inserted, page.syncCursor == nil else { throw Failure.invalidResponse }
                next = token
                continue
            }
            guard let cursor = page.syncCursor, !cursor.isEmpty,
                  let initial = first else { throw Failure.invalidResponse }
            let partition = try StorePartition(subject: subject, deviceId: deviceId, scope: NativeV2.legacyEpoch + initial.scope.fingerprint)
            // A page can repeat an outlet/customer projected through several visits. Require identical
            // duplicates; conflicting entries or duplicate visit/task IDs are not silently overwritten.
            let uniqueOutlets = try Self.unique(outlets, id: { $0.id }, equivalent: { $0.name == $1.name && $0.routeId == $1.routeId })
            let uniqueCustomers = try Self.unique(customers, id: { $0.id }, equivalent: { $0.code == $1.code })
            let uniqueCallSheets = try Self.unique(callSheets, id: { $0.outletId }, equivalent: { $0 == $1 })
            let uniqueTerms = try Self.unique(orderTerms, id: { $0.outletId }, equivalent: { $0 == $1 })
            let uniqueProducts = try Self.unique(products, id: { $0.id }, equivalent: { $0 == $1 })
            let uniqueInventory = try Self.unique(inventory, id: { $0.id }, equivalent: { $0 == $1 })
            // The server ships each outlet's figures once per snapshot; a repeat must be identical.
            let uniqueSummaries = try Self.unique(summaries, id: { $0.outletId }, equivalent: { $0 == $1 })
            guard Set(visits.map(\.id)).count == visits.count,
                  Set(tasks.map(\.id)).count == tasks.count,
                  visits.allSatisfy({ visit in uniqueOutlets.contains(where: { $0.id == visit.outletId }) }) else { throw Failure.invalidResponse }
            let snapshot = StoreSnapshot(employee: initial.employee, visits: visits, outlets: uniqueOutlets,
                                         customers: uniqueCustomers, route: route, tasks: tasks, callSheets: uniqueCallSheets, orderTerms: uniqueTerms,
                                         productCatalog: uniqueProducts, inventoryAvailability: uniqueInventory,
                                         accountSummaries: uniqueSummaries, dayTarget: dayTarget, daySales: daySales,
                                         activityRules: activityRules ?? [], photoTypes: photoTypes ?? [],
                                         serverVisits: try Self.unique(serverVisits, id: { $0.id }, equivalent: { $0 == $1 }))
            try store.saveSnapshot(snapshot, cursor: cursor, leaseExpiresAt: lease, cacheExpiresAt: cache, for: partition)
            try store.setSyncHealth(SyncHealth(lastSuccessfulSyncAt: page.serverTime, lastErrorCode: nil), for: partition)
            return partition
        }
        throw Failure.invalidResponse
    }

    private static func unique<T>(_ values: [T], id: (T) -> String, equivalent: (T, T) -> Bool) throws -> [T] {
        var result: [T] = []
        var indexes: [String: Int] = [:]
        for value in values {
            let key = id(value)
            guard !key.isEmpty else { throw Failure.invalidResponse }
            if let index = indexes[key] {
                guard equivalent(result[index], value) else { throw Failure.invalidResponse }
            } else { indexes[key] = result.count; result.append(value) }
        }
        return result
    }

    private func fetch(deviceId: String, cursor: String?, previous: StorePartition?,
                       store: any FieldLocalStore, pageNumber: Int) async throws -> BootstrapV1.Page {
        do {
            let me = try await ServerAPI(url: site, auth: auth, http: http).currentMe()
            guard let scope = me["scope"] as? [String: Any], let scopeId = scope["id"] as? String else { throw Failure.invalidResponse }
            let body = try NativeV2.pull(deviceId: deviceId, scopeId: scopeId, projection: "field.bundle",
                params: ["dayFrom": Self.manilaDay(Date())], page: cursor)
            let bytes = try await NativeGateway(site: site, auth: auth, registry: registry, http: http, key: key)
                .post("/api/sync/pull", body: body, deviceId: deviceId)
            let result = try NativeV2.bundle(bytes, scopeId: scopeId, projection: "field.bundle", mode: "snapshot")
            guard let more = result.envelope["hasMore"] as? Bool, result.bundle["complete"] as? Bool == !more,
                  let id = result.envelope["snapshotId"] as? String, !id.isEmpty,
                  let raw = result.bundle["data"] as? [String: Any] else { throw Failure.invalidResponse }
            if let snapshotId, snapshotId != id { throw Failure.restartRequired }
            snapshotId = id
            var page = raw
            page["type"] = "bootstrap.response"; page["contractVersion"] = 1
            page["serverTime"] = result.envelope["serverTime"]; page["page"] = pageNumber
            page["nextPageCursor"] = result.envelope["nextPageCursor"] ?? NSNull()
            page["syncCursor"] = result.envelope["nextCursor"] ?? NSNull()
            guard let fingerprint = (raw["scope"] as? [String: Any])?["fingerprint"] as? String,
                  fingerprint == result.bundle["scopeFingerprint"] as? String else { throw Failure.invalidResponse }
            return try JSONDecoder().decode(BootstrapV1.Page.self, from: NativeV2.bytes(page))
        } catch let error as NativeFailure {
            if error.withdraws { if let previous { try? store.holdForReview(previous) }; throw Failure.phoneRemoved }
            if error.action == "rebootstrap" || ["scope_changed", "cursor_invalid", "cursor_expired", "snapshot_changed", "rebootstrap_required"].contains(error.code) { throw Failure.restartRequired }
            if error.action == "update" { throw Failure.updateRequired }
            throw error.retryable ? Failure.retryable : Failure.invalidResponse
        } catch MobileError.rejected("forbidden") {
            if let previous { try? store.holdForReview(previous) }
            throw Failure.phoneRemoved
        } catch MobileError.rateLimited { throw Failure.throttled }
        catch MobileError.unauthorized { throw Failure.unauthorized }
        catch let failure as Failure { throw failure }
        catch MobileError.offline { throw MobileError.offline }
        catch MobileError.sessionExpired { throw Failure.unauthorized }
        catch MobileError.notSignedIn { throw Failure.unauthorized }
        catch is CancellationError { throw CancellationError() }
        catch { throw Failure.invalidResponse }
    }
}
