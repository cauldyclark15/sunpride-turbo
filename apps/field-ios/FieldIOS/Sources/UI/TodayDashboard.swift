import Foundation

/// Pure summary of the field day shown at the top of Today. Derived only from the saved plan,
/// the saved position standard and calls recorded on this phone (queued or synced), so it reads
/// the same offline as online.
///
/// Client answers (2 Oct 2026 call): a call is a store visited that is part of the day's route
/// plan; targets are per day, per route. Productive here is the phone's own End outcome
/// ("completed"); the server's productive-call rule (any one listed activity) stays authoritative
/// for the manager scorecard.
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
    let planned: Int
    let calls: Int
    let productive: Int
    let unplannedCalls: Int
    let route: [Stop]

    /// Order capture is not enabled on the phone yet (bootstrap `orderCaptureEnabled: false`,
    /// no approved prices), so sales are never shown as a made-up number.
    static let salesLabel = "Not on this phone yet"

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
        let share = "\(Int((Double(productive) / Double(calls) * 100).rounded()))%"
        return goal.map { "\(productive) · \(share) of \($0)" } ?? "\(productive) · \(share)"
    }

    static func make(visits: [AppModel.TodayVisit], target: StoreSnapshot.DayTarget?, now: Date) -> TodayDashboard {
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
            else if !nextAssigned && !anyOpen { state = .next; nextAssigned = true }
            else { state = .upcoming }
            return Stop(id: visit.id, position: index + 1, outlet: visit.outlet, state: state, timeSpent: visit.timeSpent)
        }
        let closed = ordered.filter { $0.endedAt != nil && $0.status != "Needs review" }
        return TodayDashboard(
            dateLabel: dateLabel(now),
            target: target,
            planned: ordered.count,
            calls: closed.count,
            productive: closed.filter { $0.outcome == "completed" }.count,
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
