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
                Text("Last synced \(time.formatted(date: .abbreviated, time: .shortened))")
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
                    VStack(alignment: .leading, spacing: SunprideTokens.Space.one) {
                        Text(visit.outlet).font(SunprideTokens.TypeStyle.body.weight(.semibold))
                        Text("\(visit.planned ? "Planned" : "Unplanned") · \(visit.status)")
                            .font(SunprideTokens.TypeStyle.caption)
                            .foregroundStyle(SunprideTokens.secondaryText)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("visit-\(visit.id)")
                }
            }
            Button { Task { await model.syncNow() } } label: {
                if model.syncing { ProgressView() } else { Label("Sync now", systemImage: "arrow.clockwise") }
            }
            .disabled(model.syncing || !model.enrollment.state.isReady)
            .accessibilityIdentifier("syncNow")
        }
        .padding(SunprideTokens.Space.six)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SunprideTokens.card, in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.field))
    }
}
