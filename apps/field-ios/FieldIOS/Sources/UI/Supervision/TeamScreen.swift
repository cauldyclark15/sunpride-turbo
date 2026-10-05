import SwiftUI

/// IOS-020 Team page: each direct report's coverage today and the day's exceptions, from the server's
/// scoped summary (or the copy saved on this phone when offline). Read-only: decisions stay on the web.
struct TeamScreen: View {
    let model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let view = model.team
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Button { dismiss() } label: {
                            Image(systemName: "chevron.left")
                                .foregroundStyle(SunprideTokens.text)
                                .frame(width: 44, height: 44)
                        }
                        .accessibilityLabel("Back")
                        .accessibilityIdentifier("BackButton")
                        Text("Today").font(SunprideTokens.TypeStyle.meta)
                            .foregroundStyle(SunprideTokens.secondaryText)
                        Spacer()
                    }
                    Text("Team").font(SunprideTokens.TypeStyle.title)
                        .foregroundStyle(SunprideTokens.text)
                        .accessibilityIdentifier("teamTitle")
                    HStack(spacing: 8) {
                        filter("Direct reports", selected: model.teamDirectOnly, id: "teamDirect") { true }
                        filter("Whole area", selected: !model.teamDirectOnly, id: "teamAll") { false }
                    }
                    if let summary = view.summary {
                        Text(TeamText.headline(summary) + (view.saved ? " · Saved on this phone"
                                                           : " · Updated \(TeamRepository.clock(summary.generatedAt))"))
                            .font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                            .accessibilityIdentifier("teamSummary")
                    }
                    if let message = view.message {
                        Text(message).font(SunprideTokens.TypeStyle.meta)
                            .foregroundStyle(view.notAllowed || view.summary == nil ? SunprideTokens.dangerText : SunprideTokens.secondaryText)
                            .accessibilityIdentifier("teamMessage")
                    }
                    if view.summary == nil && view.message == nil && model.teamLoading {
                        Text("Loading your team…").font(SunprideTokens.TypeStyle.meta)
                            .foregroundStyle(SunprideTokens.secondaryText)
                            .accessibilityIdentifier("teamLoading")
                    }
                    if let summary = view.summary {
                        SectionCard(title: "People · \(summary.people.count)") {
                            if summary.people.isEmpty {
                                CalmListRow(symbol: "person.2", title: summary.directOnly
                                            ? "No direct reports are assigned to you. Try Whole area."
                                            : "No field people in your area.", meta: "")
                                    .accessibilityIdentifier("teamEmpty")
                            }
                            ForEach(Array(summary.people.enumerated()), id: \.element.id) { index, person in
                                if index > 0 { divider }
                                personRow(person, status: TeamText.status(person, now: now, dayCloseAt: summary.dayCloseAt))
                            }
                        }
                        SectionCard(title: "Exceptions · \(summary.openExceptions) to review") {
                            if summary.exceptions.isEmpty {
                                CalmListRow(symbol: "checkmark.circle", title: "No exceptions today", meta: "")
                                    .accessibilityIdentifier("teamNoExceptions")
                            }
                            ForEach(Array(summary.exceptions.enumerated()), id: \.element.id) { index, item in
                                if index > 0 { divider }
                                exceptionRow(item, label: TeamText.kind(item, now: now, dayCloseAt: summary.dayCloseAt))
                            }
                            if summary.totalExceptions > summary.exceptions.count {
                                Text("Showing \(summary.exceptions.count) of \(summary.totalExceptions). See the rest on the web.")
                                    .font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                                    .padding(16)
                                    .accessibilityIdentifier("teamMore")
                            }
                        }
                        if summary.truncated && summary.totalExceptions <= summary.exceptions.count {
                            Text("Your area is large; some people are not shown. Use the web to narrow by unit or channel.")
                                .font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                                .accessibilityIdentifier("teamTruncated")
                        }
                    }
                }
                .frame(maxWidth: 520, alignment: .leading)
                .padding(16)
            }
            PrimaryBottomButton(title: model.teamLoading ? "Updating…" : "Update", disabled: model.teamLoading) {
                Task { await model.loadTeam() }
            }
            .accessibilityIdentifier("teamRefresh")
            .padding(16)
        }
        .background(SunprideTokens.background)
        .toolbar(.hidden, for: .navigationBar)
        // Each visit to the Team page asks the server again (saved copy when offline).
        .task { await model.loadTeam() }
    }

    private var divider: some View {
        Rectangle().fill(SunprideTokens.secondaryText.opacity(0.2)).frame(height: 1).padding(.leading, 16)
    }

    private func filter(_ title: String, selected: Bool, id: String, directOnly: @escaping () -> Bool) -> some View {
        // The selected filter keeps full contrast (a disabled look would read as unselected); tapping it is a no-op.
        SecondaryButton(title: selected ? "✓ \(title)" : title, disabled: model.teamLoading, fullWidth: true) {
            guard !selected else { return }
            Task { await model.loadTeam(directOnly: directOnly()) }
        }
        .accessibilityIdentifier(id)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func personRow(_ person: TeamPerson, status: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text(person.name).font(SunprideTokens.TypeStyle.row).foregroundStyle(SunprideTokens.text).lineLimit(1)
                Spacer(minLength: 4)
                Text(status).font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
            }
            Text([person.positionLabel ?? person.channel, TeamText.coverage(person)].joined(separator: " · "))
                .font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
            let flags = TeamText.flags(person)
            if !flags.isEmpty {
                Text(flags).font(SunprideTokens.TypeStyle.meta)
                    .foregroundStyle(person.openExceptions > 0 ? SunprideTokens.dangerText : SunprideTokens.secondaryText)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("teamPerson-\(person.profileId)")
    }

    private func exceptionRow(_ item: TeamException, label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text(label).font(SunprideTokens.TypeStyle.row)
                    .foregroundStyle(item.open ? SunprideTokens.dangerText : SunprideTokens.text)
                Spacer(minLength: 4)
                if let at = item.at {
                    Text(TeamRepository.clock(at)).font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                }
            }
            Text(TeamText.detail(item)).font(SunprideTokens.TypeStyle.meta)
                .foregroundStyle(SunprideTokens.secondaryText).lineLimit(3)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(item.open ? "teamExceptionOpen-\(item.id)" : "teamException-\(item.id)")
    }
}
