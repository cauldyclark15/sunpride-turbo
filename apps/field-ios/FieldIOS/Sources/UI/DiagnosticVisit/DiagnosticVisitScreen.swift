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
    @State private var outcome = "completed"
    @State private var busy = false
    @State private var message: String?
    @State private var checkedIn = false
    @State private var checkedOut = false
    @State private var noteQueued = false
    @FocusState private var noteFocused: Bool
    @Environment(\.dismiss) private var dismiss

    private var displayStatus: String {
        let status = model.visits.first(where: { $0.id == visit.id })?.status ?? visit.status
        if checkedOut || status == "Accepted" { return "Done" }
        if checkedIn || status == "Queued" { return "In progress" }
        if status == "Planned" || status == "Unplanned" || status == "Scheduled" { return "Not started" }
        if status == "Needs review" { return "To review" }
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
                if !checkedIn && unplanned {
                    SectionCard(title: "Check in") {
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
                                catch { message = "Check in first or shorten note" }
                            }
                            .accessibilityIdentifier("diagnosticAddNote")
                        }.padding(16)
                    }
                    SectionCard(title: "Outcome") {
                        VStack(alignment: .leading, spacing: 0) {
                            Menu {
                                Button("Completed") { outcome = "completed" }
                                Button("Nonproductive") { outcome = "nonproductive" }
                            } label: {
                                HStack {
                                    Text(outcome == "completed" ? "Completed" : "Nonproductive")
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
                                CalmField(label: "Reason") { TextField("Reason", text: $reason) }
                                    .padding(.bottom, 16)
                            }
                        }.padding(.horizontal, 16)
                    }
                } else if checkedOut {
                    SectionCard(title: "Done") {
                        CalmListRow(symbol: "checkmark.circle", title: "Visit complete", meta: "Saved on phone")
                    }
                }
                if checkedIn {
                    SectionCard(title: "Activity") {
                        VStack(spacing: 0) {
                            CalmListRow(symbol: "checkmark", title: "Check-in", meta: "Waiting")
                            if noteQueued {
                                activityDivider
                                CalmListRow(symbol: "note.text", title: "Note", meta: "Waiting")
                            }
                            if checkedOut {
                                activityDivider
                                CalmListRow(symbol: "checkmark", title: "Check-out", meta: "Waiting")
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
                PrimaryBottomButton(title: checkedIn ? "Check out" : busy ? "Checking in…" : "Check in",
                                    disabled: busy || (!checkedIn && unplanned && reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) || (checkedIn && outcome == "nonproductive" && reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)) {
                    if checkedIn {
                        do {
                            try model.queueCheckOut(outcome: outcome, reason: outcome == "nonproductive" ? reason : nil, for: visit)
                            checkedOut = true
                            message = nil
                        } catch { message = "Check in first or check reason" }
                    } else {
                        busy = true
                        Task {
                            do {
                                let fix = try await location.capture()
                                try model.queueCheckIn(visit, unplannedReason: unplanned ? reason : nil, location: fix)
                                checkedIn = true
                                message = nil
                            } catch LocationCapture.Failure.denied { message = "Location denied · Enable in Settings" }
                            catch LocationCapture.Failure.unavailable { message = "No location · Try again outdoors" }
                            catch StoreError.leaseExpired { message = "Reconnect before check-in" }
                            catch StoreError.heldForReview { message = "Work held · Contact supervisor" }
                            catch StoreError.invalidInput { message = "Invalid check-in · Sync and retry" }
                            catch StoreError.database { message = "Storage unavailable · Contact support" }
                            catch { message = "Check-in failed · Check reason or connection" }
                            busy = false
                        }
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
