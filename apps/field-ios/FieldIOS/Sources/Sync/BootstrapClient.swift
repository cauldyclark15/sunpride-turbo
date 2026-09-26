import Foundation

/// No page or cursor is written until the final page has been validated. Requests use independent,
/// one-use challenges; a 401 retry also re-signs with a fresh challenge rather than replaying a nonce.
@MainActor
final class BootstrapClient {
    enum Failure: Error, Equatable {
        case phoneRemoved, updateRequired, unauthorized, retryable, invalidResponse, restartRequired
    }
    private let site: URL
    private let auth: AuthClient
    private let registry: DeviceRegistry
    private let http: HTTPClient
    private let key: any DeviceSigningKey

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
        var first: BootstrapV1.Page?
        var visits: [StoreSnapshot.Visit] = []
        var outlets: [StoreSnapshot.Outlet] = []
        var customers: [StoreSnapshot.Customer] = []
        var tasks: [StoreSnapshot.Task] = []
        var route: StoreSnapshot.Route?
        var next: String?
        var seen = Set<String>()
        var lease = Int64.max, cache = Int64.max
        for pageNumber in 1...50 {
            try Task.checkCancellation()
            let page = try await fetch(deviceId: deviceId, cursor: next, previous: previous, store: store)
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
            customers += page.localCustomers
            tasks += page.tasks
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
            let partition = try StorePartition(subject: subject, deviceId: deviceId, scope: initial.scope.fingerprint)
            // A page can repeat an outlet/customer projected through several visits. Require identical
            // duplicates; conflicting entries or duplicate visit/task IDs are not silently overwritten.
            let uniqueOutlets = try Self.unique(outlets, id: { $0.id }, equivalent: { $0.name == $1.name && $0.routeId == $1.routeId })
            let uniqueCustomers = try Self.unique(customers, id: { $0.id }, equivalent: { $0.code == $1.code })
            guard Set(visits.map(\.id)).count == visits.count,
                  Set(tasks.map(\.id)).count == tasks.count,
                  visits.allSatisfy({ visit in uniqueOutlets.contains(where: { $0.id == visit.outletId }) }) else { throw Failure.invalidResponse }
            let snapshot = StoreSnapshot(employee: initial.employee, visits: visits, outlets: uniqueOutlets,
                                         customers: uniqueCustomers, route: route, tasks: tasks)
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
                       store: any FieldLocalStore) async throws -> BootstrapV1.Page {
        let body = try JSONEncoder().encode(BootstrapV1.Request(deviceId: deviceId, pageCursor: cursor))
        for attempt in 0..<2 {
            let jwt = try await auth.convexToken(forceRefresh: attempt > 0)
            let challenge = try await registry.challenge(deviceId: deviceId)
            // Challenge returns only expiresAt, not issuedAt; backend issues it at now + 60_000.
            // Midpoint is within ±30 s of server time throughout its lifetime, regardless of phone clock.
            guard challenge.expiresAt.isFinite, challenge.expiresAt > 30_000,
                  challenge.expiresAt < 9_007_199_254_740_991 else { throw Failure.invalidResponse }
            let timestamp = Int64(challenge.expiresAt) - 30_000
            guard timestamp > 0 else { throw Failure.invalidResponse }
            let request = try RequestSigner(key: key).request(site: site, path: "/mobile/v1/bootstrap",
                body: body, deviceId: deviceId, nonce: challenge.nonce, timestamp: timestamp, jwt: jwt)
            let (data, response) = try await http.send(request)
            if let version = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["contractVersion"] as? Int,
               version != 1 { throw Failure.updateRequired }
            if let error = try? BootstrapV1.decodeFailure(data), error.error.code.rawValue == "device_revoked" {
                if let previous { try store.holdForReview(previous) }
                throw Failure.phoneRemoved
            }
            if response.statusCode == 401 {
                auth.invalidateToken()
                if attempt == 0 { continue }
                // A 401 can also be a revoked device, but the current live gateway returns only
                // "unauthorized" for proof failures; never infer revocation from 401 alone.
                throw Failure.unauthorized
            }
            if let error = try? BootstrapV1.decodeFailure(data) {
                switch error.error.code.rawValue {
                case "device_revoked":
                    if let previous { try store.holdForReview(previous) }
                    throw Failure.phoneRemoved
                case "version_unsupported": throw Failure.updateRequired
                case "rebootstrap_required", "invalid_cursor": throw Failure.restartRequired
                case "temporarily_unavailable" where error.error.retryable: throw Failure.retryable
                default: throw response.statusCode >= 500 ? Failure.retryable : Failure.invalidResponse
                }
            }
            guard (200..<300).contains(response.statusCode) else {
                throw response.statusCode >= 500 ? Failure.retryable : Failure.invalidResponse
            }
            do { return try JSONDecoder().decode(BootstrapV1.Page.self, from: data) }
            catch BootstrapV1.WireError.unsupportedVersion { throw Failure.updateRequired }
            catch { throw Failure.invalidResponse }
        }
        throw Failure.unauthorized
    }
}
