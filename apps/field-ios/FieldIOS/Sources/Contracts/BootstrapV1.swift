import Foundation

/// Forward-readable server enum: the raw value survives decoding; unknown never authorizes a transition.
struct ResponseValue: Codable, Equatable, Sendable {
    let rawValue: String
    init(_ rawValue: String) { self.rawValue = rawValue }
    init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }
    func isKnown(_ values: Set<String>) -> Bool { values.contains(rawValue) }
}

/// All field-day boundaries are Manila civil time, independent of the handset timezone.
enum FieldDay {
    static let timeZone = TimeZone(identifier: "Asia/Manila")!
    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }
    static func close(serviceDay: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        guard let date = formatter.date(from: serviceDay), formatter.string(from: date) == serviceDay else { return nil }
        return calendar.date(bySettingHour: 22, minute: 0, second: 0, of: date)
    }
    static func nextClose(after date: Date) -> Date {
        let today = calendar.date(bySettingHour: 22, minute: 0, second: 0, of: date)!
        return date < today ? today : calendar.date(byAdding: .day, value: 1, to: today)!
    }
    static func closeTimeLabel(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "h:mm a"
        return formatter.string(from: date)
    }
}

enum BootstrapV1 {
    enum WireError: Error, Equatable { case invalidEnvelope, unsupportedVersion, unsafeValue }

    struct Request: Codable, Equatable {
        let type = "bootstrap.request"
        let contractVersion = 1
        let deviceId: String
        let dayFrom: String?
        let pageCursor: String?
        let referenceData: Bool?
        let limit: Int
        enum CodingKeys: String, CodingKey { case type, contractVersion, deviceId, dayFrom, pageCursor, referenceData, limit }
        init(deviceId: String, dayFrom: String? = nil, pageCursor: String? = nil, referenceData: Bool? = nil, limit: Int = 100) {
            self.deviceId = deviceId; self.dayFrom = dayFrom; self.pageCursor = pageCursor
            self.referenceData = referenceData; self.limit = limit
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            guard try c.decode(String.self, forKey: .type) == "bootstrap.request",
                  try c.decode(Int.self, forKey: .contractVersion) == 1 else { throw WireError.invalidEnvelope }
            deviceId = try c.decode(String.self, forKey: .deviceId)
            dayFrom = try c.decodeIfPresent(String.self, forKey: .dayFrom)
            pageCursor = try c.decodeIfPresent(String.self, forKey: .pageCursor)
            referenceData = try c.decodeIfPresent(Bool.self, forKey: .referenceData)
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
    /// Additive metadata is optional so the original four-field catalog remains readable.
    struct Product: Codable, Equatable, Sendable {
        struct Uom: Codable, Equatable, Sendable {
            let code: String; let name: String; let decimalPlaces: Int
        }
        struct Conversion: Codable, Equatable, Sendable {
            let numerator: Int64; let denominator: Int64; let roundingMode: String
        }
        struct SellingUom: Codable, Equatable, Sendable {
            let code: String; let name: String; let decimalPlaces: Int; let toBase: Conversion?
        }
        struct Barcode: Codable, Equatable, Sendable { let barcode: String; let uom: String? }
        let id: String; let code: String; let name: String; let uom: String
        var revision: Int64? = nil
        var quantityScale: Int? = nil
        var baseUom: Uom? = nil
        var sellingUoms: [SellingUom]? = nil
        var barcodes: [Barcode]? = nil
        var isValid: Bool {
            !id.isEmpty && (revision == nil || revision! > 0) && (quantityScale == nil || quantityScale! > 0) &&
            (barcodes?.count ?? 0) <= 20 && (barcodes ?? []).allSatisfy { !$0.barcode.isEmpty && $0.barcode.count <= 64 }
        }
    }
    struct InventoryAvailability: Codable, Equatable, Sendable {
        let id: String; let productId: String; let locationId: String
        let locationCode: String; let locationName: String
        let availableBase: Int64; let physicalBase: Int64; let reservedBase: Int64
        let revision: Int64; let asOf: Int64
        var isValid: Bool { !id.isEmpty && !productId.isEmpty && !locationId.isEmpty && revision > 0 && asOf > 0 }
    }
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
        let inventoryAvailability: [InventoryAvailability]
        let callSheets: [CallSheet]
        let orderTerms: [OrderTerms]
        /// IOS-011 additive field: cached account figures for this page's newly shipped outlets.
        let accountSummaries: [AccountSummary]
        let page: Int
        let nextPageCursor: String?
        let syncCursor: String?
        /// Additive optional v1 field: the person's daily position standard. Absent on older servers.
        let dayTarget: StoreSnapshot.DayTarget?
        /// Additive optional v1 field: today's sales and daily sales target. Absent on older servers.
        let daySales: StoreSnapshot.DaySales?
        /// Additive optional v1 field (IOS-013): activity-form rules per visit intent. nil = older server.
        let activityRules: [ActivityRule]?
        /// Additive optional v1 field (IOS-016): photo types a visit photo may carry. nil = older server.
        let photoTypes: [PhotoType]?

        enum CodingKeys: String, CodingKey {
            case type, contractVersion, serverTime, permissions, employee, scope, appConfig,
                 plannedVisits, outlets, localCustomers, route, tasks, productCatalog, page,
                 nextPageCursor, syncCursor, callSheets, orderTerms, inventoryAvailability, accountSummaries, dayTarget, daySales, activityRules, photoTypes
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
            // Additive v1 field: old bootstraps omit sequence and retain their list order.
            guard plannedVisits.allSatisfy({ $0.sequence == nil || $0.sequence! >= 0 }) else { throw WireError.unsafeValue }
            outlets = try c.decode([StoreSnapshot.Outlet].self, forKey: .outlets)
            // Additive route-screen pin: an out-of-range coordinate is a corrupt feed, never a map target.
            // Additive order-association territory (SP-0044): both or neither.
            guard outlets.allSatisfy({ ($0.territoryId == nil) == ($0.territoryCode == nil) }),
                  outlets.allSatisfy({ ($0.latitude == nil) == ($0.longitude == nil) }),
                  outlets.allSatisfy({ outlet in outlet.location.map { RouteMath.isValid($0) } ?? true }) else {
                throw WireError.unsafeValue
            }
            localCustomers = try c.decode([StoreSnapshot.Customer].self, forKey: .localCustomers)
            // Required explicit nullable fields: missing is not equivalent to null.
            guard c.contains(.route), c.contains(.nextPageCursor), c.contains(.syncCursor) else { throw WireError.invalidEnvelope }
            route = try c.decodeIfPresent(StoreSnapshot.Route.self, forKey: .route)
            tasks = try c.decode([StoreSnapshot.Task].self, forKey: .tasks)
            productCatalog = try c.decode([Product].self, forKey: .productCatalog)
            inventoryAvailability = try c.decodeIfPresent([InventoryAvailability].self, forKey: .inventoryAvailability) ?? []
            if c.contains(.callSheets) {
                callSheets = try c.decode([CallSheet].self, forKey: .callSheets)
            } else { callSheets = [] } // Old servers omit the additive field.
            if c.contains(.orderTerms) {
                orderTerms = try c.decode([OrderTerms].self, forKey: .orderTerms)
            } else { orderTerms = [] }
            let termOutlets = Set(plannedVisits.map(\.outletId))
            guard orderTerms.count <= 200, Set(orderTerms.map(\.outletId)).count == orderTerms.count,
                  orderTerms.allSatisfy({ termOutlets.contains($0.outletId) }) else {
                throw WireError.unsafeValue
            }
            if c.contains(.accountSummaries) {
                accountSummaries = try c.decode([AccountSummary].self, forKey: .accountSummaries)
            } else { accountSummaries = [] } // Old servers omit the additive field.
            page = try c.decode(Int.self, forKey: .page)
            nextPageCursor = try c.decodeIfPresent(String.self, forKey: .nextPageCursor)
            syncCursor = try c.decodeIfPresent(String.self, forKey: .syncCursor)
            dayTarget = try c.decodeIfPresent(StoreSnapshot.DayTarget.self, forKey: .dayTarget)
            guard dayTarget?.isValid ?? true else { throw WireError.unsafeValue }
            // `asOf` is not a wire field: the client stamps the page's serverTime.
            daySales = try c.decodeIfPresent(StoreSnapshot.DaySales.self, forKey: .daySales).map {
                StoreSnapshot.DaySales(amountMinor: $0.amountMinor, orders: $0.orders, targetMinor: $0.targetMinor)
            }
            guard daySales?.isValid ?? true else { throw WireError.unsafeValue }
            // Strict when present; explicit null is not an omission.
            if c.contains(.activityRules) {
                let rules = try c.decode([ActivityRule].self, forKey: .activityRules)
                guard rules.count <= 32, Set(rules.map(\.intent)).count == rules.count else { throw WireError.unsafeValue }
                activityRules = rules
            } else { activityRules = nil }
            if c.contains(.photoTypes) {
                let types = try c.decode([PhotoType].self, forKey: .photoTypes)
                guard types.count <= 32, Set(types.map(\.code)).count == types.count else { throw WireError.unsafeValue }
                photoTypes = types
            } else { photoTypes = nil }
            guard Set(callSheets.map(\.outletId)).count == callSheets.count,
                  callSheets.allSatisfy({ sheet in plannedVisits.contains { $0.outletId == sheet.outletId } }) else {
                throw WireError.unsafeValue
            }
            // One summary per outlet, only for an outlet on this page, internally consistent.
            guard Set(accountSummaries.map(\.outletId)).count == accountSummaries.count,
                  accountSummaries.allSatisfy(\.isValid),
                  accountSummaries.allSatisfy({ summary in outlets.contains { $0.id == summary.outletId } }) else {
                throw WireError.unsafeValue
            }
            guard page > 0, serverTime > 0, !scope.fingerprint.isEmpty,
                  !employee.id.isEmpty, appConfig.offlineLeaseExpiresAt > serverTime,
                  appConfig.cacheExpiresAt > serverTime,
                  !appConfig.orderCaptureEnabled,
                  appConfig.priceAvailability.rawValue == "unavailable",
                  appConfig.promotionsAvailability.rawValue == "unavailable",
                  productCatalog.allSatisfy(\.isValid), inventoryAvailability.allSatisfy(\.isValid),
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
            try c.encode(callSheets, forKey: .callSheets)
            try c.encode(orderTerms, forKey: .orderTerms)
            try c.encode(inventoryAvailability, forKey: .inventoryAvailability)
            try c.encode(accountSummaries, forKey: .accountSummaries)
            try c.encodeIfPresent(dayTarget, forKey: .dayTarget)
            try c.encodeIfPresent(daySales, forKey: .daySales)
            try c.encodeIfPresent(activityRules, forKey: .activityRules)
            try c.encodeIfPresent(photoTypes, forKey: .photoTypes)
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
            /// Additive v1 field: the specific rule behind a rejection (call_open, mcp_order, wrong_date).
            let reason: String?
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
