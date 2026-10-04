import SwiftUI

extension Enrollment.State {
    var isReady: Bool { if case .ready = self { return true }; return false }
}

/// Visits are read exclusively from the encrypted store.
struct TodayScreen: View {
    let model: AppModel
    private var planned: [AppModel.TodayVisit] { model.visits.filter(\.planned) }
    private var unplanned: [AppModel.TodayVisit] { model.visits.filter { !$0.planned } }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !planned.isEmpty {
                SectionCard(title: "Route") {
                    NavigationLink { RouteScreen(model: model) } label: {
                        CalmListRow(symbol: "map", title: "Today's route", meta: routeMeta, trailing: "chevron.right")
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("openRoute")
                }
            }
            SectionCard(title: "Visits · \(planned.count)") {
                if planned.isEmpty {
                    CalmListRow(symbol: "calendar", title: "No visits today", meta: "")
                } else {
                    ForEach(planned) { visit in visitLink(visit) }
                }
                ForEach(unplanned) { visit in
                    visitLink(visit, unplanned: true)
                }
            }
            SectionCard(title: "Customers") {
                NavigationLink { CustomerSearchScreen(model: model) } label: {
                    CalmListRow(symbol: "magnifyingglass", title: "Find a customer",
                                meta: "\(model.customers.count) \(model.customers.count == 1 ? "outlet" : "outlets") on this phone",
                                trailing: "chevron.right")
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("openCustomers")
            }
            if let message = model.syncMessage {
                Text(message).font(SunprideTokens.TypeStyle.meta)
                    .foregroundStyle(SunprideTokens.dangerText)
                    .accessibilityIdentifier("syncMessage")
            }
        }
        .onReceive(Timer.publish(every: 30, on: .main, in: .common).autoconnect()) { _ in model.refreshStatus() }
    }

    @ViewBuilder private func visitLink(_ visit: AppModel.TodayVisit, unplanned: Bool = false) -> some View {
        #if DEBUG
        NavigationLink {
            DiagnosticVisitScreen(model: model, visit: visit)
        } label: {
            CalmListRow(symbol: unplanned ? "plus.circle" : "storefront", title: unplanned ? "Unplanned visit · \(visit.outlet)" : visit.outlet,
                        meta: statusMeta(visit), trailing: "chevron.right")
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("visit-\(visit.id)")
        #else
        CalmListRow(symbol: unplanned ? "plus.circle" : "storefront", title: unplanned ? "Unplanned visit · \(visit.outlet)" : visit.outlet,
                    meta: statusMeta(visit), trailing: "chevron.right")
            .accessibilityIdentifier("visit-\(visit.id)")
        #endif
    }
    private var routeMeta: String {
        let stops = DailyRoute.stops(visits: planned, outlets: model.outletDetails, customers: model.customerDetails, here: nil,
                                     canStart: { model.startFailure(for: $0) == nil })
        let count = "\(stops.count) \(stops.count == 1 ? "stop" : "stops")"
        guard let next = stops.first(where: { $0.state == .next }) else { return count }
        return "\(count) · Next: \(next.visit.outlet)"
    }
    private func statusMeta(_ visit: AppModel.TodayVisit) -> String {
        if visit.status == "Needs review" { return "To review" }
        if let spent = visit.timeSpent { return "Done · \(spent)" }
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
