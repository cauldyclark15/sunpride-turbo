import Foundation

/// Forward-readable server enum: the raw value survives decoding; unknown never authorizes a transition.
struct ResponseValue: Codable, Equatable, Sendable {
    let rawValue: String
    init(_ rawValue: String) { self.rawValue = rawValue }
    init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }
    func isKnown(_ values: Set<String>) -> Bool { values.contains(rawValue) }
}

enum BootstrapV1 {
    enum WireError: Error, Equatable { case invalidEnvelope, unsupportedVersion, unsafeValue }

    struct Request: Codable, Equatable {
        let type = "bootstrap.request"
        let contractVersion = 1
        let deviceId: String
        let dayFrom: String?
        let pageCursor: String?
        let limit: Int
        enum CodingKeys: String, CodingKey { case type, contractVersion, deviceId, dayFrom, pageCursor, limit }
        init(deviceId: String, dayFrom: String? = nil, pageCursor: String? = nil, limit: Int = 100) {
            self.deviceId = deviceId; self.dayFrom = dayFrom; self.pageCursor = pageCursor; self.limit = limit
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            guard try c.decode(String.self, forKey: .type) == "bootstrap.request",
                  try c.decode(Int.self, forKey: .contractVersion) == 1 else { throw WireError.invalidEnvelope }
            deviceId = try c.decode(String.self, forKey: .deviceId)
            dayFrom = try c.decodeIfPresent(String.self, forKey: .dayFrom)
            pageCursor = try c.decodeIfPresent(String.self, forKey: .pageCursor)
            limit = try c.decode(Int.self, forKey: .limit)
            guard (1...100).contains(limit) else { throw WireError.invalidEnvelope }
        }
    }

    struct Scope: Codable, Equatable { let fingerprint: String; let orgUnitIds: [String] }
    struct Config: Codable, Equatable {
        let offlineLeaseExpiresAt: Int64
        let cacheExpiresAt: Int64
        let orderCaptureEnabled: Bool
        let priceAvailability: ResponseValue
        let promotionsAvailability: ResponseValue
    }
    struct Product: Codable, Equatable { let id: String; let code: String; let name: String; let uom: String }
    struct Page: Codable {
        let type: String
        let contractVersion: Int
        let serverTime: Int64
        let permissions: [String]
        let employee: StoreSnapshot.Employee
        let scope: Scope
        let appConfig: Config
        let plannedVisits: [StoreSnapshot.Visit]
        let outlets: [StoreSnapshot.Outlet]
        let localCustomers: [StoreSnapshot.Customer]
        let route: StoreSnapshot.Route?
        let tasks: [StoreSnapshot.Task]
        let productCatalog: [Product]
        let page: Int
        let nextPageCursor: String?
        let syncCursor: String?

        enum CodingKeys: String, CodingKey {
            case type, contractVersion, serverTime, permissions, employee, scope, appConfig,
                 plannedVisits, outlets, localCustomers, route, tasks, productCatalog, page,
                 nextPageCursor, syncCursor
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            type = try c.decode(String.self, forKey: .type)
            contractVersion = try c.decode(Int.self, forKey: .contractVersion)
            guard contractVersion == 1 else { throw WireError.unsupportedVersion }
            guard type == "bootstrap.response" else { throw WireError.invalidEnvelope }
            serverTime = try c.decode(Int64.self, forKey: .serverTime)
            permissions = try c.decode([String].self, forKey: .permissions)
            employee = try c.decode(StoreSnapshot.Employee.self, forKey: .employee)
            scope = try c.decode(Scope.self, forKey: .scope)
            appConfig = try c.decode(Config.self, forKey: .appConfig)
            plannedVisits = try c.decode([StoreSnapshot.Visit].self, forKey: .plannedVisits)
            outlets = try c.decode([StoreSnapshot.Outlet].self, forKey: .outlets)
            localCustomers = try c.decode([StoreSnapshot.Customer].self, forKey: .localCustomers)
            // Required explicit nullable fields: missing is not equivalent to null.
            guard c.contains(.route), c.contains(.nextPageCursor), c.contains(.syncCursor) else { throw WireError.invalidEnvelope }
            route = try c.decodeIfPresent(StoreSnapshot.Route.self, forKey: .route)
            tasks = try c.decode([StoreSnapshot.Task].self, forKey: .tasks)
            productCatalog = try c.decode([Product].self, forKey: .productCatalog)
            page = try c.decode(Int.self, forKey: .page)
            nextPageCursor = try c.decodeIfPresent(String.self, forKey: .nextPageCursor)
            syncCursor = try c.decodeIfPresent(String.self, forKey: .syncCursor)
            guard page > 0, serverTime > 0, !scope.fingerprint.isEmpty,
                  !employee.id.isEmpty, appConfig.offlineLeaseExpiresAt > serverTime,
                  appConfig.cacheExpiresAt > serverTime,
                  !appConfig.orderCaptureEnabled,
                  appConfig.priceAvailability.rawValue == "unavailable",
                  appConfig.promotionsAvailability.rawValue == "unavailable",
                  productCatalog.isEmpty,
                  nextPageCursor == nil || syncCursor == nil,
                  nextPageCursor != nil || (syncCursor != nil && !syncCursor!.isEmpty) else { throw WireError.unsafeValue }
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(type, forKey: .type); try c.encode(contractVersion, forKey: .contractVersion)
            try c.encode(serverTime, forKey: .serverTime); try c.encode(permissions, forKey: .permissions)
            try c.encode(employee, forKey: .employee); try c.encode(scope, forKey: .scope)
            try c.encode(appConfig, forKey: .appConfig); try c.encode(plannedVisits, forKey: .plannedVisits)
            try c.encode(outlets, forKey: .outlets); try c.encode(localCustomers, forKey: .localCustomers)
            try c.encode(route, forKey: .route); try c.encode(tasks, forKey: .tasks)
            try c.encode(productCatalog, forKey: .productCatalog); try c.encode(page, forKey: .page)
            try c.encode(nextPageCursor, forKey: .nextPageCursor); try c.encode(syncCursor, forKey: .syncCursor)
        }
    }

    struct Failure: Codable {
        struct Detail: Codable { let field: String }
        struct Reason: Codable {
            let code: ResponseValue
            let message: String
            let retryable: Bool
            let details: Detail?
        }
        let type: String
        let contractVersion: Int
        let serverTime: Int64
        let error: Reason
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            type = try c.decode(String.self, forKey: .type)
            contractVersion = try c.decode(Int.self, forKey: .contractVersion)
            guard contractVersion == 1 else { throw WireError.unsupportedVersion }
            guard type == "error.response" else { throw WireError.invalidEnvelope }
            serverTime = try c.decode(Int64.self, forKey: .serverTime)
            error = try c.decode(Reason.self, forKey: .error)
        }
        // Production gateway currently emits flat `code/message/retryable`, unlike frozen fixtures.
        init(flat: FlatFailure) {
            type = flat.type; contractVersion = flat.contractVersion; serverTime = flat.serverTime
            error = Reason(code: flat.code, message: flat.message, retryable: flat.retryable, details: nil)
        }
    }
    /// Forward-read only: unknown push statuses are preserved, never interpreted as accepted.
    struct PushResultEnvelope: Codable {
        struct Result: Codable {
            struct Ack: Codable { let entityId: String; let eventIds: [String]; let serverTime: Int64 }
            let kind: ResponseValue
            let clientRequestId: String
            let status: ResponseValue
            let code: ResponseValue?
            let ack: Ack?
            var isAccepted: Bool { status.rawValue == "accepted" && ack != nil }
        }
        let type: String
        let contractVersion: Int
        let serverTime: Int64
        let results: [Result]
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            type = try c.decode(String.self, forKey: .type)
            contractVersion = try c.decode(Int.self, forKey: .contractVersion)
            guard contractVersion == 1 else { throw WireError.unsupportedVersion }
            guard type == "push.response" else { throw WireError.invalidEnvelope }
            serverTime = try c.decode(Int64.self, forKey: .serverTime)
            results = try c.decode([Result].self, forKey: .results)
        }
    }

    struct FlatFailure: Decodable {
        let type: String; let contractVersion: Int; let serverTime: Int64
        let code: ResponseValue; let message: String; let retryable: Bool
    }
    static func decodeFailure(_ data: Data) throws -> Failure {
        if let nested = try? JSONDecoder().decode(Failure.self, from: data) { return nested }
        let flat = try JSONDecoder().decode(FlatFailure.self, from: data)
        guard flat.contractVersion == 1 else { throw WireError.unsupportedVersion }
        guard flat.type == "error.response" else { throw WireError.invalidEnvelope }
        return Failure(flat: flat)
    }
}
