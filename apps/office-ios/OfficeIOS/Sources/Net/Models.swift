import Foundation

// Wire shapes of the office endpoints the web app reads. Captured from a real lane API
// (see OfficeIOSTests/Fixtures); every field the screens do not need is left out, and
// anything the server may omit or null is optional.

/// A number the server sends either as a JSON number or as a decimal string (bigint centavos).
nonisolated struct FlexNumber: Decodable, Hashable, Sendable {
    let value: Double
    init(_ value: Double) { self.value = value }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let d = try? c.decode(Double.self) { value = d; return }
        if let s = try? c.decode(String.self), let d = Double(s) { value = d; return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "not a number")
    }
}

// MARK: - /api/me (web shape, the same for the office app)

nonisolated struct Me: Decodable, Sendable {
    nonisolated struct User: Decodable, Sendable { let id: String; let email: String }
    nonisolated struct Profile: Decodable, Sendable { let id: String; let name: String?; let role: String; let status: String? }
    let user: User
    let profile: Profile?
    let capabilities: [String]
}

// MARK: - Shared analytics pieces

nonisolated struct Period: Decodable, Sendable { let from: String; let to: String; let days: Int? }
nonisolated struct Scope: Decodable, Sendable { let unitId: String?; let label: String? }
nonisolated struct Freshness: Decodable, Sendable { let asOf: Double; let devicesBehind: Int?; let oldestDeviceSyncAt: Double? }

nonisolated struct Kpi: Decodable, Identifiable, Sendable, Hashable {
    let key: String
    let label: String
    let value: Double?
    let unit: String
    let target: Double?
    let prior: Double?
    let deltaPct: Double?
    let status: String
    let definition: String?
    var id: String { key }
}

nonisolated struct ExceptionItem: Decodable, Identifiable, Sendable, Hashable {
    nonisolated struct Subject: Decodable, Sendable, Hashable { let type: String?; let id: String?; let label: String }
    nonisolated struct Owner: Decodable, Sendable, Hashable { let name: String? }
    nonisolated struct Action: Decodable, Sendable, Hashable { let label: String; let href: String? }
    let id: String
    let kind: String
    let severity: String
    let title: String
    let detail: String?
    let subject: Subject
    let owner: Owner?
    let dueAt: Double?
    let openedAt: Double?
    let action: Action?
}

// MARK: - Today (/api/v1/analytics/today)

nonisolated struct TodayResponse: Decodable, Sendable {
    nonisolated struct Field: Decodable, Sendable {
        nonisolated struct Counts: Decodable, Sendable { let noPlan: Int; let notStarted: Int; let inCall: Int; let done: Int; let idle: Int }
        nonisolated struct Person: Decodable, Identifiable, Sendable, Hashable {
            let profileId: String; let name: String; let territory: String?; let status: String
            let lastSeenAt: Double?; let planned: Int; let visited: Int; let productive: Int; let sales: Double
            var id: String { profileId }
        }
        let counts: Counts
        let people: [Person]
    }
    nonisolated struct Van: Decodable, Identifiable, Sendable, Hashable {
        let tripId: String; let truck: String?; let seller: String?; let status: String
        let salesCentavos: Double?; let cashExpected: Double?; let cashRemitted: Double?; let variance: Double?
        var id: String { tripId }
    }
    nonisolated struct TrendPoint: Decodable, Sendable, Hashable { let date: String; let sales: Double; let target: Double? }
    let period: Period
    let scope: Scope
    let freshness: Freshness
    let demo: Bool?
    let kpis: [Kpi]
    let field: Field
    let vans: [Van]
    let exceptions: [ExceptionItem]
    let trend: [TrendPoint]
}

// MARK: - Decide (/api/v1/decide/inbox, /api/v1/decide/act)

nonisolated struct DecideInbox: Decodable, Sendable {
    let asOf: Double
    let total: Int
    let counts: [String: Int]
    let kinds: [String: String]
    let items: [DecideItem]
    let warnings: [Warning]
    let recent: [Recent]

    nonisolated struct Warning: Decodable, Sendable, Hashable { let kind: String; let message: String }
    nonisolated struct Recent: Decodable, Sendable, Hashable, Identifiable {
        let kind: String; let refId: String; let verdict: String; let reason: String
        let documentNumber: String?; let valueCentavos: Double?; let at: Double; let by: String
        var id: String { "\(kind):\(refId):\(at)" }
    }

    /// What the signed-in person can decide right now (the web badge rule).
    var openCount: Int { items.filter(\.canDecide).count }
}

nonisolated struct DecideItem: Decodable, Identifiable, Sendable, Hashable {
    nonisolated struct Line: Decodable, Sendable, Hashable { let label: String; let value: String }
    nonisolated struct Needs: Decodable, Sendable, Hashable { let chargeTo: Bool? }
    nonisolated struct SentBack: Decodable, Sendable, Hashable { let by: String?; let reason: String; let at: Double }
    nonisolated struct Extra: Decodable, Sendable, Hashable { let forced: Bool? }
    let id: String
    let ref: String
    let kind: String
    let kindLabel: String
    let title: String
    let documentNumber: String?
    let askedBy: String?
    let askedAt: Double?
    let valueCentavos: Double?
    let rule: String?
    let link: String?
    let canDecide: Bool
    let blockedReason: String?
    let makerChecker: String
    let lines: [Line]
    let needs: Needs
    let openOnly: Bool?
    let sentBack: SentBack?
    let extra: Extra?
}

nonisolated struct DecideActResult: Decodable, Sendable { let status: String? }

// MARK: - Stores (/api/v1/analytics/stores, /api/v1/analytics/store, /api/v1/location/store-pins)

nonisolated struct StoresResponse: Decodable, Sendable {
    nonisolated struct Row: Decodable, Identifiable, Sendable, Hashable {
        let storeId: String; let code: String?; let name: String; let channel: String?; let territory: String?
        let status: String; let salesPeriod: Double?; let salesPrior: Double?; let deltaPct: Double?
        let lastOrderAt: Double?; let lastVisitAt: Double?; let skuCount: Int?; let mustSellGaps: Int?; let arBalance: Double?
        var id: String { storeId }
    }
    let period: Period
    let scope: Scope
    let freshness: Freshness
    let kpis: [Kpi]
    let rows: [Row]
    let next: String?
}

nonisolated struct StoreResponse: Decodable, Sendable {
    nonisolated struct Store: Decodable, Sendable { let id: String; let name: String; let channel: String?; let territory: String?; let address: String?; let status: String? }
    nonisolated struct Visit: Decodable, Identifiable, Sendable, Hashable {
        let visitId: String; let at: Double; let agent: String?; let outcome: String?; let onPlan: Bool?; let productive: Bool?
        var id: String { visitId }
    }
    nonisolated struct Order: Decodable, Identifiable, Sendable, Hashable {
        let orderId: String; let number: String?; let lines: Int?; let at: Double; let status: String; let totalCentavos: Double?
        var id: String { orderId }
    }
    nonisolated struct TrendPoint: Decodable, Sendable, Hashable { let weekStart: String; let sales: Double }
    nonisolated struct Assortment: Decodable, Identifiable, Sendable, Hashable {
        let productId: String; let name: String; let lastBoughtAt: Double?; let onShelf: Bool?
        var id: String { productId }
    }
    nonisolated struct Context: Decodable, Sendable {
        nonisolated struct Coverage: Decodable, Sendable { let planned: Int?; let visited: Int?; let missed: Int? }
        nonisolated struct Classification: Decodable, Sendable { let label: String?; let potential: String? }
        let coverage: Coverage?
        let classification: Classification?
    }
    let store: Store
    let freshness: Freshness
    let kpis: [Kpi]
    let salesTrend: [TrendPoint]
    let visits: [Visit]
    let orders: [Order]
    let assortment: [Assortment]?
    let context: Context?
}

nonisolated struct StorePins: Decodable, Sendable {
    nonisolated struct Pin: Decodable, Sendable, Hashable { let outletId: String; let name: String; let latitude: Double; let longitude: Double }
    let items: [Pin]
    let nextCursor: String?
}

nonisolated struct CensusQueue: Decodable, Sendable {
    nonisolated struct Batch: Decodable, Identifiable, Sendable, Hashable {
        let id: String; let name: String; let expected_outlets: Int?; let accepted: Int?; let pending: Int?
        let coveragePct: Double?; let targetPct: Double?
    }
    nonisolated struct Capture: Decodable, Identifiable, Sendable, Hashable {
        let id: String; let name: String; let address: String?; let accuracy_meters: Double?
        let owner_name: String?; let owner_phone: String?; let estimated_class: String?; let agent: String?; let batch: String?
    }
    let batches: [Batch]
    let rows: [Capture]
    let truncated: Bool?
}

// MARK: - Stock

nonisolated struct InventoryLocation: Decodable, Identifiable, Sendable, Hashable {
    let id: String; let name: String; let type: String?; let active: Bool?
}

nonisolated struct Valuation: Decodable, Sendable {
    nonisolated struct Qty: Decodable, Sendable, Hashable { let base: Double; let cases: Double; let pieces: Double; let display: String }
    nonisolated struct Row: Decodable, Identifiable, Sendable, Hashable {
        let productId: String; let name: String; let category: String?
        let locationId: String?; let locationName: String?
        let onHand: Qty; let available: Qty?; let reserved: Qty?; let hold: Qty?; let damaged: Qty?; let expired: Qty?; let inTransit: Qty?
        let costValueCentavos: Double?; let costKnown: Bool?
        var id: String { "\(productId):\(locationId ?? "all")" }
    }
    nonisolated struct Totals: Decodable, Sendable { let costValueCentavos: Double?; let rowsWithoutCost: Int? }
    let asOf: Double
    let valueLabel: String?
    let rows: [Row]
    let totals: Totals
}

nonisolated struct TransferList: Decodable, Sendable {
    let transfers: [TransferSummary]
}

nonisolated struct TransferSummary: Decodable, Identifiable, Sendable, Hashable {
    nonisolated struct Place: Decodable, Sendable, Hashable { let name: String? }
    nonisolated struct Line: Decodable, Sendable, Hashable, Identifiable {
        let id: String; let productName: String?; let name: String?
        var label: String { productName ?? name ?? "Product" }
    }
    let id: String
    let number: String?
    let typeLabel: String?
    let status: String
    let source: Place?
    let destination: Place?
    let varianceStatus: String?
    let varianceValueCentavos: Double?
    let lineCount: Int?
    let dates: [String: String?]?
    let lines: [Line]?
}

nonisolated struct CountsMine: Decodable, Sendable {
    nonisolated struct Card: Decodable, Identifiable, Sendable, Hashable {
        nonisolated struct Progress: Decodable, Sendable, Hashable { let total: Int; let counted: Int; let recount: Int?; let needsReview: Int? }
        let id: String; let number: String?; let title: String?; let status: String; let location: String?
        let scope: String?; let submittedAt: Double?; let createdAt: Double?; let progress: Progress?
    }
    let mine: [Card]
    let toReview: [Card]
}

// MARK: - More: sales, vans, money, coverage

nonisolated struct SalesResponse: Decodable, Sendable {
    nonisolated struct Row: Decodable, Identifiable, Sendable, Hashable {
        let key: String; let label: String; let sales: Double; let target: Double?; let attainmentPct: Double?
        let prior: Double?; let deltaPct: Double?; let orders: Int?; let status: String?
        var id: String { key }
    }
    nonisolated struct Point: Decodable, Sendable, Hashable { let date: String; let cumSales: Double?; let cumTarget: Double?; let cumPrior: Double? }
    let period: Period
    let scope: Scope
    let freshness: Freshness
    let kpis: [Kpi]
    let trend: [Point]
    let rows: [Row]
}

nonisolated struct VansResponse: Decodable, Sendable {
    nonisolated struct Row: Decodable, Identifiable, Sendable, Hashable {
        let tripId: String; let truck: String?; let seller: String?; let status: String
        let loadedCases: Double?; let soldCases: Double?; let returnedCases: Double?
        let salesCentavos: Double?; let cashExpected: Double?; let cashRemitted: Double?; let variance: Double?; let closedAt: Double?
        var id: String { tripId }
    }
    let period: Period
    let scope: Scope
    let freshness: Freshness
    let kpis: [Kpi]
    let rows: [Row]
}

nonisolated struct MoneyResponse: Decodable, Sendable {
    nonisolated struct Aging: Decodable, Sendable { let current: Double; let d1_30: Double; let d31_60: Double; let d61_90: Double; let d90p: Double }
    nonisolated struct Row: Decodable, Identifiable, Sendable, Hashable {
        let accountId: String; let name: String; let channel: String?; let balance: Double; let creditLimit: Double?
        let lastPaymentAt: Double?; let status: String?; let d31_60: Double?; let d61_90: Double?; let d90p: Double?
        var id: String { accountId }
    }
    let period: Period
    let scope: Scope
    let freshness: Freshness
    let kpis: [Kpi]
    let aging: Aging
    let rows: [Row]
}

nonisolated struct CoverageResponse: Decodable, Sendable {
    nonisolated struct Row: Decodable, Identifiable, Sendable, Hashable {
        let key: String; let label: String; let planned: Int?; let visited: Int?; let compliancePct: Double?
        let missed: Int?; let productive: Int?; let productiveCallPct: Double?; let strikeRatePct: Double?; let status: String?
        var id: String { key }
    }
    let period: Period
    let scope: Scope
    let freshness: Freshness
    let kpis: [Kpi]
    let rows: [Row]
}

// MARK: - Stores POS and issues

nonisolated struct StorePOSWorkspace: Decodable, Sendable {
    nonisolated struct Location: Decodable, Identifiable, Sendable, Hashable { let id: String; let name: String }
    nonisolated struct Register: Decodable, Identifiable, Sendable, Hashable {
        let id: String; let name: String; let location_id: String?; let store_name: String?
    }
    let locations: [Location]
    let registers: [Register]
}

nonisolated struct TillDays: Decodable, Sendable {
    nonisolated struct Day: Decodable, Identifiable, Sendable, Hashable {
        let id: String; let registerName: String?; let storeName: String?; let businessDate: String; let status: String
        let sessions: Int?; let openSessions: Int?; let netSalesCentavos: FlexNumber?; let zNumber: String?
    }
    let from: String?
    let to: String?
    let days: [Day]
}

nonisolated struct ZReadings: Decodable, Sendable {
    nonisolated struct Reading: Decodable, Identifiable, Sendable, Hashable {
        let id: String; let businessDate: String; let zCounter: Int?; let netSalesCentavos: FlexNumber?
        let grossSalesCentavos: FlexNumber?; let docNumber: String?
    }
    let readings: [Reading]
    let legacy: [Reading]
}

nonisolated struct ReceiptsList: Decodable, Sendable {
    nonisolated struct Row: Decodable, Identifiable, Sendable, Hashable {
        let id: String; let documentNumber: String?; let documentType: String?; let issuedAt: String?
        let totalDueMinor: FlexNumber?; let buyerName: String?; let voided: Bool?
    }
    let receipts: [Row]
    let hasMore: Bool?
}

nonisolated struct IssuesBoard: Decodable, Sendable {
    nonisolated struct Issue: Decodable, Identifiable, Sendable, Hashable {
        let _id: String; let title: String; let status: String?; let priority: String?; let area: String?
        let assigneeName: String?; let reporterName: String?; let updatedAt: Double?; let commentCount: Int?
        var id: String { _id }
    }
    nonisolated struct Summary: Decodable, Sendable { let open: Int; let urgent: Int; let unassigned: Int; let readyForRetest: Int; let completedThisWeek: Int }
    let issues: [Issue]
    let counts: [String: Int]
    let total: Int
    let summary: Summary?
}
