import SwiftUI

#if DEBUG
/// Diagnostic only: local work is queued, never credited as a productive or geofence-certified call.
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

    var body: some View {
        Form {
            Section("DEV visit diagnostic") {
                Text(visit.outlet).font(.headline)
                Text("Local state: \(model.visits.first(where: { $0.id == visit.id })?.status ?? visit.status)")
                    .accessibilityIdentifier("diagnosticState")
                Text("Server review determines location and productivity. No local credit is awarded.")
                    .font(.caption)
            }
            Section("Check in") {
                Toggle("Unplanned visit", isOn: $unplanned).disabled(!visit.planned)
                if unplanned { TextField("Unplanned reason (required)", text: $reason).accessibilityIdentifier("unplannedReason") }
                Button("Check in") {
                    busy = true
                    Task {
                        do {
                            let fix = try await location.capture()
                            try model.queueCheckIn(visit, unplannedReason: unplanned ? reason : nil, location: fix)
                            message = "Queued offline."
                        } catch LocationCapture.Failure.denied {
                            message = "Location permission denied. Enable When In Use in Settings before check-in."
                        } catch LocationCapture.Failure.unavailable {
                            message = "No current location fix. Set a simulator location or retry outdoors."
                        } catch StoreError.leaseExpired { message = "Offline lease expired. Reconnect and bootstrap before check-in." }
                        catch StoreError.heldForReview { message = "Unsent work is held for review. Reconnect and verify this phone." }
                        catch StoreError.invalidInput { message = "Invalid check-in operation. Retry after sync." }
                        catch StoreError.database { message = "Local storage unavailable. Do not uninstall; contact support." }
                        catch { message = "Could not queue check-in. Check reason and offline lease." }
                        busy = false
                    }
                }
                .disabled(busy || (unplanned && reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                .accessibilityIdentifier("diagnosticCheckIn")
            }
            Section("Activity") {
                TextField("Optional note", text: $note).accessibilityIdentifier("diagnosticNote")
                Button("Add note") {
                    do { try model.queueNote(note, for: visit); note = ""; message = "Note queued offline." }
                    catch { message = "Check in first or shorten the note." }
                }
                .accessibilityIdentifier("diagnosticAddNote")
            }
            Section("Check out") {
                Picker("Outcome", selection: $outcome) {
                    Text("Completed").tag("completed")
                    Text("Nonproductive").tag("nonproductive")
                }
                if outcome == "nonproductive" { TextField("Reason (required)", text: $reason) }
                Button("Check out") {
                    do {
                        try model.queueCheckOut(outcome: outcome, reason: outcome == "nonproductive" ? reason : nil, for: visit)
                        message = "Check-out queued offline."
                    } catch { message = "Check in first or check outcome/reason." }
                }
                .accessibilityIdentifier("diagnosticCheckOut")
            }
            if let message { Text(message).accessibilityIdentifier("diagnosticMessage") }
        }
        .navigationTitle("Visit diagnostic")
    }
}
#endif
