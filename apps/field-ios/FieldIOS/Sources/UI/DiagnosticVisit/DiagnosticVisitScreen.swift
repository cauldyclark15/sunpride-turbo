import SwiftUI

#if DEBUG
/// Diagnostic only: local work is queued, never credited as a productive call.
struct DiagnosticVisitScreen: View {
    let model: AppModel
    let visit: AppModel.TodayVisit
    @State private var location = LocationCapture()
    @State private var unplanned: Bool
    init(model: AppModel, visit: AppModel.TodayVisit) {
        self.model = model; self.visit = visit
        _unplanned = State(initialValue: !visit.planned)
    }
    @State private var reason = ""
    @State private var note = ""
    @State private var outcome = ""
    @State private var busy = false
    @State private var message: String?
    private var currentVisit: AppModel.TodayVisit { model.visits.first { $0.id == visit.id } ?? visit }
    private var checkedIn: Bool { currentVisit.startedAt != nil }
    private var checkedOut: Bool { currentVisit.endedAt != nil }
    private var startFailure: AppModel.CallFailure? { model.startFailure(for: currentVisit) }
    @State private var noteQueued = false
    @FocusState private var noteFocused: Bool
    @Environment(\.dismiss) private var dismiss

    private var displayStatus: String {
        let status = model.visits.first(where: { $0.id == visit.id })?.status ?? visit.status
        if status == "Needs review" { return "To review" }
        if checkedOut { return "Done" }
        if checkedIn { return "In progress" }
        if status == "Planned" || status == "Unplanned" || status == "Scheduled" { return "Not started" }
        return status
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left")
                            .foregroundStyle(SunprideTokens.text)
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityIdentifier("BackButton")
                    Text("Visit").font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.secondaryText)
                    Spacer()
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(visit.outlet).font(SunprideTokens.TypeStyle.title)
                    Text("\(visit.planned ? "Planned" : "Unplanned visit") · \(displayStatus)")
                        .font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.secondaryText)
                        .accessibilityIdentifier("diagnosticState")
                }
                if let message {
                    Text(message).font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.secondaryText)
                        .accessibilityIdentifier("diagnosticMessage")
                }
                if !checkedIn, let failure = startFailure {
                    Text(failure.message).font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.secondaryText)
                        .accessibilityIdentifier("callStartBlocked")
                }
                if !checkedIn && unplanned {
                    SectionCard(title: "Start") {
                        VStack(alignment: .leading, spacing: 12) {
                            Toggle("Unplanned visit", isOn: $unplanned).disabled(!visit.planned)
                                .font(SunprideTokens.TypeStyle.row)
                            CalmField(label: "Reason") {
                                TextField("Reason", text: $reason)
                                    .accessibilityIdentifier("unplannedReason")
                            }
                        }.padding(16)
                    }
                }
                if checkedIn && !checkedOut {
                    SectionCard(title: "Note") {
                        VStack(alignment: .trailing, spacing: 8) {
                            CalmField(label: nil) {
                                TextField("Add a note (optional)", text: $note)
                                    .focused($noteFocused)
                                    .accessibilityIdentifier("diagnosticNote")
                            }
                            SecondaryButton(title: "Add note", disabled: note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                                do { try model.queueNote(note, for: visit); note = ""; noteFocused = false; noteQueued = true; message = nil }
                                catch { message = "Start first or shorten note" }
                            }
                            .accessibilityIdentifier("diagnosticAddNote")
                        }.padding(16)
                    }
                    if model.callSheet(for: visit) != nil {
                        NavigationLink {
                            CallSheetScreen(model: model, visit: visit)
                        } label: {
                            SectionCard(title: "Call sheet") {
                                CalmListRow(symbol: "tablecells", title: "Call sheet",
                                            meta: model.callSheetStatus(for: visit) ?? "Record product quantities",
                                            trailing: "chevron.right")
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("openCallSheet")
                    } else {
                        Text("No call sheet set up for this account yet. Ask your office.")
                            .font(SunprideTokens.TypeStyle.meta)
                            .foregroundStyle(SunprideTokens.secondaryText)
                    }
                    SectionCard(title: "Outcome") {
                        VStack(alignment: .leading, spacing: 0) {
                            Menu {
                                Button("Completed") { outcome = "completed" }
                                Button("Nonproductive") { outcome = "nonproductive" }
                            } label: {
                                HStack {
                                    Text(outcome.isEmpty ? "Select outcome" : outcome == "completed" ? "Completed" : "Nonproductive")
                                        .font(SunprideTokens.TypeStyle.row)
                                    Spacer()
                                    Image(systemName: "chevron.down")
                                        .font(SunprideTokens.TypeStyle.meta)
                                }
                                .foregroundStyle(SunprideTokens.text)
                                .frame(minHeight: 48)
                                .contentShape(Rectangle())
                            }
                            .accessibilityIdentifier("diagnosticOutcome")
                            if outcome == "nonproductive" {
                                CalmField(label: "Reason") {
                                    TextField("Reason", text: $reason).accessibilityIdentifier("nonproductiveReason")
                                }
                                    .padding(.bottom, 16)
                            }
                        }.padding(.horizontal, 16)
                    }
                } else if checkedOut {
                    SectionCard(title: "Done") {
                        CalmListRow(symbol: "checkmark.circle", title: "Visit complete", meta: currentVisit.timeSpent ?? "Saved on phone")
                            .accessibilityIdentifier("callTimeSpent")
                    }
                }
                if checkedIn {
                    SectionCard(title: "Activity") {
                        VStack(spacing: 0) {
                            CalmListRow(symbol: "checkmark", title: "Start", meta: "Waiting")
                            if noteQueued {
                                activityDivider
                                CalmListRow(symbol: "note.text", title: "Note", meta: "Waiting")
                            }
                            if let status = model.callSheetStatus(for: visit) {
                                activityDivider
                                CalmListRow(symbol: "tablecells", title: "Call sheet", meta: status)
                                    .accessibilityIdentifier("callSheetActivity")
                            }
                            if checkedOut {
                                activityDivider
                                CalmListRow(symbol: "checkmark", title: "End call", meta: "Waiting")
                            }
                        }
                    }
                }
            }
            .padding(16)
            .padding(.bottom, checkedOut ? 16 : 64)
        }
        .background(SunprideTokens.background)
        .safeAreaInset(edge: .bottom) {
            if !checkedOut {
                PrimaryBottomButton(title: busy ? "Saving…" : checkedIn ? "End call" : "Start",
                                    disabled: busy || (!checkedIn && (startFailure != nil || (unplanned && reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))) || (checkedIn && (outcome.isEmpty || (outcome == "nonproductive" && reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)))) {
                    let ending = checkedIn
                    busy = true
                    Task {
                        // Always attempt fresh evidence for both arrival and departure. A failed
                        // fix is serialized as null; only the supervisor decides its reliability.
                        let fix = await location.captureIfAvailable()
                        do {
                            if ending {
                                try model.queueCheckOut(outcome: outcome, reason: outcome == "nonproductive" ? reason : nil,
                                                        for: visit, location: fix)
                            } else {
                                try model.queueCheckIn(visit, unplannedReason: unplanned ? reason : nil, location: fix)
                                reason = ""
                            }
                            message = fix == nil ? "Location unavailable · Saved for supervisor review" : nil
                        } catch let error as AppModel.CallFailure { message = error.message }
                        catch StoreError.leaseExpired { message = "Day access closed · Reconnect to continue" }
                        catch StoreError.heldForReview { message = "Work held · Contact supervisor" }
                        catch StoreError.invalidInput { message = "Invalid call · Sync and retry" }
                        catch StoreError.database { message = "Storage unavailable · Contact support" }
                        catch { message = "Call not saved · Check outcome or reason" }
                        busy = false
                    }
                }
                .accessibilityIdentifier(checkedIn ? "diagnosticCheckOut" : "diagnosticCheckIn")
                .padding(16)
                .background(SunprideTokens.background)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
    }
    private var activityDivider: some View {
        Rectangle().fill(SunprideTokens.secondaryText.opacity(0.2)).frame(height: 1).padding(.leading, 16)
    }
}
#endif
