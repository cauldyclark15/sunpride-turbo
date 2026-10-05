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
                if checkedIn && !checkedOut && !checklist.isEmpty {
                    SectionCard(title: "Activity forms") {
                        VStack(spacing: 0) {
                            ForEach(Array(checklist.enumerated()), id: \.element.kind) { index, item in
                                if index > 0 { activityDivider }
                                activityRow(item)
                            }
                        }
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
                    orderSection(open: true)
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
                    if !model.orderDrafts(for: currentVisit).isEmpty { orderSection(open: false) }
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
            if !checkedOut {
                PrimaryBottomButton(title: busy ? "Saving…" : checkedIn ? "End call" : "Start",
                                    disabled: busy || (!checkedIn && (startFailure != nil || (unplanned && (reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || purposes.isEmpty)))) || (checkedIn && (outcome.isEmpty || (outcome == "nonproductive" && reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) || (outcome == "completed" && !missing.isEmpty)))) {
                    let ending = checkedIn
                    busy = true
                    Task {
                        // Always attempt fresh evidence for both arrival and departure. A failed
                        // fix is serialized as null; the server records distance and geofence result,
                        // and only the supervisor decides an exception. Never a reason to refuse.
                        let captured = await location.capture()
                        let fix = captured.fix
                        do {
                            if ending {
                                try model.queueCheckOut(outcome: outcome, reason: outcome == "nonproductive" ? reason : nil,
                                                        for: visit, location: fix)
                            } else {
                                try model.queueCheckIn(visit, unplannedReason: unplanned ? reason : nil,
                                                       intents: purposes, location: fix)
                                reason = ""
                            }
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
    /// SP-0044: order drafts for this call (local only); new orders only while the call is open.
    @ViewBuilder private func orderSection(open: Bool) -> some View {
        let drafts = model.orderDrafts(for: currentVisit)
        SectionCard(title: "Order") {
            VStack(spacing: 0) {
                ForEach(Array(drafts.enumerated()), id: \.element.draftId) { index, draft in
                    if index > 0 { activityDivider }
                    let count = draft.lines.count == 1 ? "1 product" : "\(draft.lines.count) products"
                    NavigationLink {
                        OrderDraftScreen(model: model, visit: currentVisit, draftId: draft.draftId)
                    } label: {
                        CalmListRow(symbol: "cart", title: "Order draft",
                                    meta: "\(count) · saved on this phone" + (open ? "" : " · review comes next"),
                                    trailing: "chevron.right")
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("orderDraft")
                }
                if open {
                    if !drafts.isEmpty { activityDivider }
                    if model.orderCatalog(for: currentVisit).isEmpty {
                        Text(OrderDraftFailure.noCatalog.message)
                            .font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                            .accessibilityIdentifier("orderUnavailable")
                    } else {
                        NavigationLink {
                            OrderDraftScreen(model: model, visit: currentVisit)
                        } label: {
                            CalmListRow(symbol: "cart.badge.plus", title: "New order",
                                        meta: "Search this account's products", trailing: "chevron.right")
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("newOrder")
                    }
                }
            }
        }
    }
    private var activityDivider: some View {
        Rectangle().fill(SunprideTokens.secondaryText.opacity(0.2)).frame(height: 1).padding(.leading, 16)
    }
}
#endif
