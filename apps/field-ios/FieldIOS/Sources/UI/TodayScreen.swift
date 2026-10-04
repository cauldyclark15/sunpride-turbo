import SwiftUI

extension Enrollment.State {
    var isReady: Bool { if case .ready = self { return true }; return false }
}

/// Today dashboard: date, target, calls, completion, sales, sync state, next outlet and the
/// ordered daily route. Everything is read from the encrypted store, so it works offline.
struct TodayScreen: View {
    let model: AppModel
    private var dashboard: TodayDashboard { model.dashboard }
    private var unplanned: [AppModel.TodayVisit] { model.visits.filter { !$0.planned } }

    var body: some View {
        let dashboard = dashboard
        VStack(alignment: .leading, spacing: 16) {
            summaryCard(dashboard)
            nextCard(dashboard)
            SectionCard(title: "Route · \(dashboard.route.count)") {
                if dashboard.route.isEmpty {
                    CalmListRow(symbol: "calendar", title: "No visits today", meta: "")
                } else {
                    ForEach(dashboard.route) { stop in
                        if let visit = model.visits.first(where: { $0.id == stop.id }) {
                            visitLink(visit, symbol: Self.orderSymbol(stop.position), meta: stopMeta(stop, visit))
                                .accessibilityIdentifier("visit-\(visit.id)")
                        }
                    }
                }
            }
            if !unplanned.isEmpty {
                SectionCard(title: "Other outlets") {
                    ForEach(unplanned) { visit in
                        visitLink(visit, symbol: "plus.circle", title: "Unplanned visit · \(visit.outlet)", meta: statusMeta(visit))
                            .accessibilityIdentifier("visit-\(visit.id)")
                    }
                }
            }
            if let message = model.syncMessage {
                Text(message).font(SunprideTokens.TypeStyle.meta)
                    .foregroundStyle(SunprideTokens.dangerText)
                    .accessibilityIdentifier("syncMessage")
            }
        }
        .onReceive(Timer.publish(every: 30, on: .main, in: .common).autoconnect()) { _ in model.refreshStatus() }
    }

    private func summaryCard(_ dashboard: TodayDashboard) -> some View {
        SectionCard(title: dashboard.dateLabel) {
            VStack(spacing: 0) {
                DetailRow(label: "Calls", value: dashboard.callsLabel).accessibilityIdentifier("dashboardCalls")
                divider
                DetailRow(label: "Productive", value: dashboard.productiveLabel).accessibilityIdentifier("dashboardProductive")
                divider
                DetailRow(label: "Visits done", value: dashboard.completionLabel).accessibilityIdentifier("dashboardCompletion")
                divider
                DetailRow(label: "Sales", value: TodayDashboard.salesLabel).accessibilityIdentifier("dashboardSales")
                divider
                DetailRow(label: "Sync", value: syncLine).accessibilityIdentifier("dashboardSync")
            }
        }
    }

    @ViewBuilder private func nextCard(_ dashboard: TodayDashboard) -> some View {
        let openUnplanned = unplanned.contains { $0.startedAt != nil && $0.endedAt == nil }
        SectionCard(title: dashboard.current == nil && !openUnplanned ? "Next" : "Now") {
            if let stop = dashboard.current ?? dashboard.next,
               let visit = model.visits.first(where: { $0.id == stop.id }) {
                visitLink(visit, symbol: dashboard.current == nil ? "arrow.right.circle" : "timer",
                          meta: dashboard.current == nil ? "Stop \(stop.position) of \(dashboard.planned)"
                                                         : "In progress · stop \(stop.position)")
                    .accessibilityIdentifier("nextOutlet")
            } else if let open = unplanned.first(where: { $0.startedAt != nil && $0.endedAt == nil }) {
                visitLink(open, symbol: "timer", title: "Unplanned visit · \(open.outlet)", meta: "In progress")
                    .accessibilityIdentifier("nextOutlet")
            } else if dashboard.dayComplete {
                CalmListRow(symbol: "checkmark.circle", title: "All planned stores done", meta: dashboard.completionLabel)
                    .accessibilityIdentifier("nextOutlet")
            } else if let review = dashboard.route.first(where: { $0.state == .review }) {
                CalmListRow(symbol: "exclamationmark.circle", title: review.outlet, meta: "To review · ask your supervisor")
                    .accessibilityIdentifier("nextOutlet")
            } else {
                CalmListRow(symbol: "calendar", title: "No planned stores", meta: "")
                    .accessibilityIdentifier("nextOutlet")
            }
        }
    }

    /// Offline is stated first so it is never hidden behind a queue count.
    private var syncLine: String {
        let label = model.syncStatus?.label ?? (model.isOffline ? "Offline · saved cache" : "Not synced yet")
        let state = model.isOffline && !label.hasPrefix("Offline") ? "Offline · \(label)" : label
        guard let last = model.syncStatus?.lastSuccessful ?? model.lastSyncedAt else { return state }
        return "\(state) · \(FieldDay.closeTimeLabel(last))"
    }

    private var divider: some View {
        Rectangle().fill(SunprideTokens.secondaryText.opacity(0.2)).frame(height: 1).padding(.leading, 16)
    }

    static func orderSymbol(_ position: Int) -> String { (1...50).contains(position) ? "\(position).circle" : "storefront" }

    @ViewBuilder private func visitLink(_ visit: AppModel.TodayVisit, symbol: String, title: String? = nil, meta: String) -> some View {
        #if DEBUG
        NavigationLink {
            DiagnosticVisitScreen(model: model, visit: visit)
        } label: {
            CalmListRow(symbol: symbol, title: title ?? visit.outlet, meta: meta, trailing: "chevron.right")
        }
        .buttonStyle(.plain)
        #else
        CalmListRow(symbol: symbol, title: title ?? visit.outlet, meta: meta, trailing: "chevron.right")
        #endif
    }

    private func stopMeta(_ stop: TodayDashboard.Stop, _ visit: AppModel.TodayVisit) -> String {
        switch stop.state {
        case .review: return "To review"
        case .inProgress: return "In progress"
        case .next: return "Next"
        case .done, .upcoming: return statusMeta(visit)
        }
    }
    private func statusMeta(_ visit: AppModel.TodayVisit) -> String {
        if visit.status == "Needs review" { return "To review" }
        if let spent = visit.timeSpent { return visit.outcome == "nonproductive" ? "Not productive · \(spent)" : "Done · \(spent)" }
        if visit.startedAt != nil { return "In progress" }
        if let failure = model.startFailure(for: visit) { return failure.message }
        switch visit.status {
        case "Planned", "Scheduled", "Unplanned": return ""
        case "Accepted": return "Done"
        case "Queued": return "Waiting"
        case "Needs review": return "To review"
        default: return visit.status
        }
    }
}
