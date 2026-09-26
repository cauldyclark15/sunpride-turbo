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
                        meta: unplanned ? "" : statusMeta(visit), trailing: "chevron.right")
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("visit-\(visit.id)")
        #else
        CalmListRow(symbol: unplanned ? "plus.circle" : "storefront", title: unplanned ? "Unplanned visit · \(visit.outlet)" : visit.outlet,
                    meta: unplanned ? "" : statusMeta(visit), trailing: "chevron.right")
            .accessibilityIdentifier("visit-\(visit.id)")
        #endif
    }
    private func statusMeta(_ visit: AppModel.TodayVisit) -> String {
        switch visit.status {
        case "Planned", "Scheduled": return ""
        case "Accepted": return "Done"
        case "Queued": return "Waiting"
        case "Needs review": return "To review"
        default: return visit.status
        }
    }
}
