import Foundation

/// The client's productive-call rule, mirrored from the server's governed
/// `packages/backend/convex/sfa/productive_call.ts` (rule version productive-call/2026-10-02) so
/// the phone counts a call exactly as the manager scorecard and Daily Sales Report do:
///
/// - only a closed call at a route-plan store is a call;
/// - it is productive when ANY ONE listed activity was recorded at that visit (the End
///   button's own "completed" outcome is not evidence of an activity);
/// - a truck seller's merchandising counts only with the "visited, no sales due to inventory"
///   End reason.
enum ProductiveCall {
    static let ruleVersion = "productive-call/2026-10-02"
    static let activityCodes = ["purchase_order", "merchandising", "inventory_retrieval", "suggested_order",
                                "negotiation", "bad_order_pickup", "collection", "meeting"]
    static let noSalesDueToInventory = "no_sales_due_to_inventory"

    /// Server `productiveCodesFromVisitRecords`: recorded activity kinds → the client's activity codes.
    static func codes(activityKinds: [String], collectionCount: Int = 0) -> [String] {
        var found = Set<String>()
        for kind in activityKinds {
            switch kind {
            case "order_intent": found.insert("purchase_order")
            case "merchandising", "price_check": found.insert("merchandising")
            case "inventory_check": found.insert("inventory_retrieval")
            default: if activityCodes.contains(kind) { found.insert(kind) }
            }
        }
        if collectionCount > 0 { found.insert("collection") }
        return activityCodes.filter(found.contains)
    }

    /// Server `evaluateProductiveCall` for a closed route-plan call. An unknown or absent rule is
    /// the default rule, as the server applies to a position without one.
    static func isProductive(rule: String?, activityKinds: [String], reasonCode: String?) -> Bool {
        let recorded = codes(activityKinds: activityKinds)
        let marker = reasonCode?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == noSalesDueToInventory
        let matched = rule == "truck_seller" && !marker ? recorded.filter { $0 != "merchandising" } : recorded
        return !matched.isEmpty
    }
}

/// Pure summary of the field day shown at the top of Today. Derived only from the saved plan,
/// the saved position standard and sales, and calls recorded on this phone (queued or synced),
/// so it reads the same offline as online.
///
/// Client answers (2 Oct 2026 call): a call is a store visited that is part of the day's route
/// plan; targets are per day, per route.
struct TodayDashboard: Equatable {
    enum StopState: Equatable { case done, inProgress, next, upcoming, review }
    struct Stop: Equatable, Identifiable {
        let id: String
        let position: Int // 1-based MCP order
        let outlet: String
        let state: StopState
        var timeSpent: String? = nil
    }

    let dateLabel: String
    let target: StoreSnapshot.DayTarget?
    let sales: StoreSnapshot.DaySales?
    let planned: Int
    let calls: Int
    let productive: Int
    let unplannedCalls: Int
    let route: [Stop]

    var current: Stop? { route.first { $0.state == .inProgress } }
    var next: Stop? { route.first { $0.state == .next } }
    var dayComplete: Bool { planned > 0 && calls == planned && current == nil }

    var completionLabel: String {
        planned == 0 ? "No planned stores" : "\(calls) of \(planned) stores"
    }
    var callsLabel: String {
        guard let goal = target?.dailyCalls else { return "\(calls) · no target set" }
        return "\(calls) of \(goal)"
    }
    var productiveLabel: String {
        let goal = target?.productivePct.map { $0 == $0.rounded() ? "\(Int($0))%" : String(format: "%.1f%%", $0) }
        guard calls > 0 else { return goal.map { "\(productive) · target \($0)" } ?? "\(productive)" }
        // Whole percent rounded down, like the server's summarizeCalls.
        let share = "\(productive * 100 / calls)%"
        return goal.map { "\(productive) · \(share) of \($0)" } ?? "\(productive) · \(share)"
    }
    /// Sales come from the server (order capture is not on the phone), as of the last download:
    /// "₱1,750.50 of ₱5,000.00 · as of 9:14 AM".
    var salesLabel: String {
        guard let sales else { return "Not available yet" }
        let amount = Self.peso(sales.amountMinor)
        let value = sales.targetMinor.map { "\(amount) of \(Self.peso($0))" } ?? "\(amount) · no target set"
        guard let asOf = sales.asOf else { return value }
        return "\(value) · as of \(FieldDay.closeTimeLabel(Date(timeIntervalSince1970: Double(asOf) / 1000)))"
    }

    static func peso(_ minor: Int64) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = true
        formatter.groupingSeparator = ","
        formatter.groupingSize = 3
        formatter.decimalSeparator = "."
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        let text = formatter.string(from: NSDecimalNumber(value: minor).dividing(by: 100).magnitudeDecimal) ?? "\(abs(minor) / 100)"
        return minor < 0 ? "-₱\(text)" : "₱\(text)"
    }

    /// `canStart` is the model's MCP/open-call Start guard: "Next" is only ever a stop the seller
    /// may Start now, never one the phone would refuse (e.g. behind a rejected check-in).
    static func make(visits: [AppModel.TodayVisit], target: StoreSnapshot.DayTarget?,
                     sales: StoreSnapshot.DaySales? = nil, now: Date,
                     canStart: ((AppModel.TodayVisit) -> Bool)? = nil) -> TodayDashboard {
        let day = BootstrapClient.manilaDay(now)
        let plannedRows = visits.filter { $0.planned && $0.serviceDate == day }
        // TodayVisit planned rows arrive in saved MCP order; keep it stable when sequence is absent.
        let ordered = plannedRows.enumerated().sorted {
            let a = $0.element.sequence ?? $0.offset, b = $1.element.sequence ?? $1.offset
            return a == b ? $0.offset < $1.offset : a < b
        }.map(\.element)
        let anyOpen = visits.contains { $0.startedAt != nil && $0.endedAt == nil }
        var nextAssigned = false
        let route = ordered.enumerated().map { index, visit -> Stop in
            let state: StopState
            if visit.status == "Needs review" { state = .review }
            else if visit.endedAt != nil { state = .done }
            else if visit.startedAt != nil { state = .inProgress }
            else if !nextAssigned && !anyOpen && canStart?(visit) != false { state = .next; nextAssigned = true }
            else { state = .upcoming }
            return Stop(id: visit.id, position: index + 1, outlet: visit.outlet, state: state, timeSpent: visit.timeSpent)
        }
        let closed = ordered.filter { $0.endedAt != nil && $0.status != "Needs review" }
        return TodayDashboard(
            dateLabel: dateLabel(now),
            target: target,
            sales: sales,
            planned: ordered.count,
            calls: closed.count,
            productive: closed.filter {
                ProductiveCall.isProductive(rule: target?.productiveCallRule, activityKinds: $0.activityKinds,
                                            reasonCode: $0.reasonCode)
            }.count,
            unplannedCalls: visits.filter { !$0.planned && $0.endedAt != nil && $0.serviceDate == day }.count,
            route: route)
    }

    static func dateLabel(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = FieldDay.timeZone
        formatter.dateFormat = "EEE, d MMM"
        return formatter.string(from: date)
    }
}

private extension NSDecimalNumber {
    var magnitudeDecimal: NSDecimalNumber { compare(NSDecimalNumber.zero) == .orderedAscending ? multiplying(by: -1) : self }
}
