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
    /// IOS-017: the End confirmation (what will be recorded) while the person decides; nil otherwise.
    @State private var review: EndReview?
    /// IOS-017: a truck seller's "visited, no sales due to inventory" End marker.
    @State private var noSales = false
    private var truckSeller: Bool { model.dayTarget?.productiveCallRule == "truck_seller" }
    private var endReason: String? {
        switch outcome {
        case "nonproductive": reason
        case "completed": truckSeller && noSales ? VisitCompletion.noSalesDueToInventory : nil
        default: nil
        }
    }
    /// IOS-013: purposes chosen for an unplanned visit before Start.
    @State private var purposes: [String] = []
    private var intents: [String] {
        _ = model.visits // Observe durable outbox refreshes.
        return !checkedIn && !visit.planned ? purposes : model.visitIntents(for: currentVisit)
    }
    private var checklist: [ActivityRules.Requirement] {
        _ = model.visits
        return model.activityChecklist(for: currentVisit)
    }
    private var missing: [String] { ActivityRules.missing(checklist) }
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
                if checkedIn || visit.planned {
                    if !intents.isEmpty {
                        Text("Purpose · " + intents.map(ActivityRules.intentLabel).joined(separator: ", "))
                            .font(SunprideTokens.TypeStyle.row)
                            .accessibilityIdentifier("visitIntents")
                    }
                } else {
                    SectionCard(title: "Visit purpose") {
                        VStack(alignment: .leading, spacing: 0) {
                            Text("Choose one or more").font(SunprideTokens.TypeStyle.meta)
                                .foregroundStyle(SunprideTokens.secondaryText)
                                .padding(.horizontal, 16).padding(.vertical, 8)
                            ForEach(ActivityRules.intents, id: \.self) { intent in
                                ChoiceRow(label: ActivityRules.intentLabel(intent), selected: purposes.contains(intent),
                                          disabled: busy) {
                                    if let index = purposes.firstIndex(of: intent) { purposes.remove(at: index) }
                                    else { purposes.append(intent) }
                                }
                                .accessibilityIdentifier("intent-\(intent)")
                            }
                        }
                    }
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
                if checkedIn && !checkedOut && review == nil && !checklist.isEmpty {
                    SectionCard(title: "Activity forms") {
                        VStack(spacing: 0) {
                            ForEach(Array(checklist.enumerated()), id: \.element.kind) { index, item in
                                if index > 0 { activityDivider }
                                activityRow(item)
                            }
                        }
                    }
                }
                if checkedIn && !checkedOut, let review {
                    reviewCard(review)
                } else if checkedIn && !checkedOut {
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
                            if outcome == "completed" && !missing.isEmpty {
                                Text("Still required: " + missing.map(ActivityRules.kindLabel).joined(separator: ", "))
                                    .font(SunprideTokens.TypeStyle.meta)
                                    .foregroundStyle(SunprideTokens.secondaryText)
                                    .padding(.bottom, 16)
                                    .accessibilityIdentifier("activitiesMissing")
                            }
                            if outcome == "completed" && truckSeller {
                                Toggle("No sales · store has enough stock", isOn: $noSales)
                                    .font(SunprideTokens.TypeStyle.row)
                                    .frame(minHeight: 48)
                                    .padding(.bottom, 8)
                                    .accessibilityIdentifier("noSalesDueToInventory")
                            }
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
                        VStack(spacing: 0) {
                            CalmListRow(symbol: "checkmark.circle", title: "Visit complete", meta: currentVisit.timeSpent ?? "Saved on phone")
                                .accessibilityIdentifier("callTimeSpent")
                            if let result = model.visitResult(for: currentVisit) { resultRows(result) }
                        }
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
                            ForEach(currentVisit.activityKinds.filter(ActivityRules.structuredForms.contains), id: \.self) { kind in
                                activityDivider
                                CalmListRow(symbol: "checklist", title: ActivityRules.kindLabel(kind), meta: "Recorded")
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
            if checkedIn && !checkedOut && review != nil {
                HStack(spacing: 12) {
                    SecondaryButton(title: "Back", disabled: busy) { review = nil }
                        .accessibilityIdentifier("endReviewBack")
                    PrimaryBottomButton(title: busy ? "Saving…" : "Confirm end", disabled: busy) { confirmEnd() }
                        .accessibilityIdentifier("diagnosticConfirmEnd")
                }
                .padding(16)
                .background(SunprideTokens.background)
            } else if !checkedOut {
                PrimaryBottomButton(title: busy ? "Saving…" : checkedIn ? "End call" : "Start",
                                    disabled: busy || (!checkedIn && (startFailure != nil || (unplanned && (reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || purposes.isEmpty)))) || (checkedIn && (outcome.isEmpty || (outcome == "nonproductive" && reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) || (outcome == "completed" && !missing.isEmpty)))) {
                    let ending = checkedIn
                    if ending {
                        // IOS-017: nothing is queued yet; show what End will record. The store re-checks on Confirm.
                        do { review = try model.endReview(outcome: outcome, reason: endReason, for: currentVisit); message = nil }
                        catch let error as AppModel.CallFailure { message = error.message }
                        catch { message = "Could not check this call · Try again" }
                        return
                    }
                    busy = true
                    Task {
                        // Always attempt fresh arrival evidence (departure: `confirmEnd`). A failed
                        // fix is serialized as null; the server records distance and geofence result,
                        // and only the supervisor decides an exception. Never a reason to refuse.
                        let captured = await location.capture()
                        let fix = captured.fix
                        do {
                            try model.queueCheckIn(visit, unplannedReason: unplanned ? reason : nil,
                                                   intents: purposes, location: fix)
                            reason = ""
                            message = LocationAssessment.notice(captured, pin: currentVisit.pin, at: Date()).text
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
        // A change to what End would record invalidates the confirmation.
        .onChange(of: outcome) { review = nil }
        .onChange(of: reason) { review = nil }
        .onChange(of: noSales) { review = nil }
    }
    /// IOS-017: capture the final location, then queue the immutable End the person just reviewed.
    private func confirmEnd() {
        busy = true
        Task {
            // Fresh departure evidence; a failed fix is serialized as null and flagged, never blocking.
            let captured = await location.capture()
            do {
                try model.queueCheckOut(outcome: outcome, reason: endReason, for: currentVisit, location: captured.fix)
                review = nil
                message = LocationAssessment.notice(captured, pin: currentVisit.pin, at: Date()).text
            } catch let error as AppModel.CallFailure { review = nil; message = error.message }
            catch StoreError.leaseExpired { message = "Day access closed · Reconnect to continue" }
            catch StoreError.heldForReview { message = "Work held · Contact supervisor" }
            catch StoreError.invalidInput { review = nil; message = "Invalid call · Sync and retry" }
            catch StoreError.database { message = "Storage unavailable · Contact support" }
            catch { message = "Call not saved · Check outcome or reason" }
            busy = false
        }
    }
    private func kinds(_ kinds: [String]) -> String {
        kinds.isEmpty ? "None recorded" : kinds.map(ActivityRules.kindLabel).joined(separator: ", ")
    }
    private func outcomeText(_ outcome: String, _ reason: String?) -> String {
        ([VisitCompletion.outcomeLabel(outcome)] + [reason.map(VisitCompletion.reasonLabel)].compactMap { $0 }).joined(separator: " · ")
    }
    private func productiveText(_ productive: Bool?) -> String? {
        productive.map { $0 ? "Yes" : "No productive activity" }
    }
    private func reviewCard(_ review: EndReview) -> some View {
        SectionCard(title: "Review and end") {
            VStack(alignment: .leading, spacing: 0) {
                DetailRow(label: "Outcome", value: outcomeText(review.outcome, review.reasonCode))
                    .accessibilityElement(children: .combine).accessibilityIdentifier("endReviewOutcome")
                DetailRow(label: "Time so far", value: "\(review.minutes) min")
                DetailRow(label: "Activities", value: kinds(review.recorded))
                    .accessibilityElement(children: .combine).accessibilityIdentifier("endReviewActivities")
                if !review.officeReview.isEmpty {
                    DetailRow(label: "Office will review", value: kinds(review.officeReview))
                        .accessibilityElement(children: .combine).accessibilityIdentifier("endReviewOffice")
                }
                if let productive = productiveText(review.productive) {
                    DetailRow(label: "Productive call", value: productive)
                        .accessibilityElement(children: .combine).accessibilityIdentifier("endReviewProductive")
                }
                Text("Your location is recorded when you confirm. You can't change this call after it ends.")
                    .font(SunprideTokens.TypeStyle.meta)
                    .foregroundStyle(SunprideTokens.secondaryText)
                    .padding(16)
            }
        }
    }
    @ViewBuilder private func resultRows(_ result: VisitResult) -> some View {
        DetailRow(label: "Outcome", value: outcomeText(result.outcome, result.reasonCode))
            .accessibilityElement(children: .combine).accessibilityIdentifier("resultOutcome")
        DetailRow(label: "Activities", value: kinds(result.recorded))
            .accessibilityElement(children: .combine).accessibilityIdentifier("resultActivities")
        if !result.officeReview.isEmpty {
            DetailRow(label: "Office will review", value: kinds(result.officeReview))
                .accessibilityElement(children: .combine).accessibilityIdentifier("resultOffice")
        }
        if let productive = productiveText(result.productive) {
            DetailRow(label: "Productive call", value: productive)
                .accessibilityElement(children: .combine).accessibilityIdentifier("resultProductive")
        }
        DetailRow(label: "Sync", value: result.sync)
            .accessibilityElement(children: .combine).accessibilityIdentifier("resultSync")
        Text(result.location)
            .font(SunprideTokens.TypeStyle.meta)
            .foregroundStyle(SunprideTokens.secondaryText)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier(result.locationReview ? "resultLocationReview" : "resultLocation")
    }
    /// One checklist row: opens its form, or the call sheet; the note uses the Note card below.
    @ViewBuilder private func activityRow(_ item: ActivityRules.Requirement) -> some View {
        let meta: String = switch item.status {
        case .done: "Recorded"
        case .unavailable: "Not available on this phone" + (item.required ? " · office will review" : "")
        case .toDo: item.required ? "Required" : "Optional"
        }
        let row = CalmListRow(symbol: item.status == .done ? "checkmark.circle" : "square.and.pencil",
                              title: ActivityRules.kindLabel(item.kind), meta: meta,
                              trailing: item.status == .unavailable || item.kind == "note" ? nil : "chevron.right")
        if item.status == .unavailable || item.kind == "note" {
            row.opacity(item.status == .unavailable ? 0.6 : 1).accessibilityIdentifier("activity-\(item.kind)")
        } else {
            NavigationLink {
                if item.kind == "call_sheet" { CallSheetScreen(model: model, visit: visit) }
                else { ActivityFormScreen(model: model, visit: visit, kind: item.kind) }
            } label: { row }
            .buttonStyle(.plain)
            .accessibilityIdentifier("activity-\(item.kind)")
        }
    }
    private var activityDivider: some View {
        Rectangle().fill(SunprideTokens.secondaryText.opacity(0.2)).frame(height: 1).padding(.leading, 16)
    }
}
#endif
