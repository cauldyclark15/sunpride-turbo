import SwiftUI

extension Enrollment.State {
    var isReady: Bool { if case .ready = self { return true }; return false }
}

/// The list is read exclusively from the encrypted store. Bootstrap is the only way to replace it.
struct TodayScreen: View {
    let model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: SunprideTokens.Space.four) {
            HStack {
                Text("Today").font(SunprideTokens.TypeStyle.heading)
                    .accessibilityIdentifier("todayTitle")
                Spacer()
                TimelineView(.periodic(from: .now, by: 30)) { _ in
                    if model.stale {
                        Label("Stale · pending", systemImage: "clock.arrow.circlepath")
                            .font(SunprideTokens.TypeStyle.caption.weight(.semibold))
                            .foregroundStyle(SunprideTokens.dangerText)
                            .accessibilityIdentifier("staleBadge")
                    }
                }
            }
            if let time = model.lastSyncedAt {
                Text("Last synced \(time.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, timeZone: TimeZone(identifier: "Asia/Manila")!))) PHT")
                    .font(SunprideTokens.TypeStyle.caption)
                    .foregroundStyle(SunprideTokens.secondaryText)
                    .accessibilityIdentifier("lastSynced")
            } else {
                Text("Not synced yet").foregroundStyle(SunprideTokens.secondaryText)
            }
            if let message = model.syncMessage {
                Text(message).foregroundStyle(SunprideTokens.dangerText)
                    .accessibilityIdentifier("syncMessage")
            }
            if model.visits.isEmpty {
                Text("No saved visits for today.").foregroundStyle(SunprideTokens.secondaryText)
            } else {
                ForEach(model.visits) { visit in
                    #if DEBUG
                    NavigationLink {
                        DiagnosticVisitScreen(model: model, visit: visit)
                    } label: {
                        visitRow(visit)
                    }
                    .accessibilityIdentifier("visit-\(visit.id)")
                    #else
                    visitRow(visit).accessibilityIdentifier("visit-\(visit.id)")
                    #endif
                }
            }
            if !model.review.isEmpty {
                Text("Needs review").font(.headline)
                ForEach(Array(model.review.enumerated()), id: \.offset) { _, item in
                    Text(item).font(.caption).foregroundStyle(SunprideTokens.dangerText)
                }
            }
            Button { Task { await model.syncNow() } } label: {
                if model.syncing { ProgressView() } else { Label("Sync now", systemImage: "arrow.clockwise") }
            }
            .disabled(model.syncing || !model.enrollment.state.isReady || model.isOffline)
            .accessibilityIdentifier("syncNow")
        }
        .padding(SunprideTokens.Space.six)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SunprideTokens.card, in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.field))
        .onReceive(Timer.publish(every: 30, on: .main, in: .common).autoconnect()) { _ in model.refreshStatus() }
    }
    private func visitRow(_ visit: AppModel.TodayVisit) -> some View {
        VStack(alignment: .leading, spacing: SunprideTokens.Space.one) {
            Text(visit.outlet).font(SunprideTokens.TypeStyle.body.weight(.semibold))
            Text("\(visit.planned ? "Planned" : "Unplanned") · \(visit.status)")
                .font(SunprideTokens.TypeStyle.caption)
                .foregroundStyle(SunprideTokens.secondaryText)
        }
        .accessibilityElement(children: .combine)
    }
}
