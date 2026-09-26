import Foundation
import SwiftUI

/// A snapshot of durable state, never inferred from a successful HTTP response alone.
struct FieldSyncStatus: Equatable {
    let queued: Int
    let sending: Int
    let needsReview: Int
    let held: Int
    let otherHeldWork: Bool
    let lastSuccessful: Date?
    let lastErrorCode: String?
    let leaseExpired: Bool
    let cacheStale: Bool
    let offline: Bool

    var label: String {
        if held > 0 || otherHeldWork { return "Held · needs supervisor" }
        if needsReview > 0 { return "Needs review" }
        if queued + sending > 0 { return sending > 0 ? "Sending · not synced" : "Queued · not synced" }
        if lastErrorCode != nil { return "Sync unavailable · saved cache" }
        if cacheStale || leaseExpired { return "Stale · pending" }
        if offline { return "Offline · saved cache" }
        return lastSuccessful == nil ? "Not synced yet" : "All synced"
    }
    @MainActor static func read(store: any FieldLocalStore, partition: StorePartition, now: Date,
                     sending: Bool, offline: Bool) throws -> FieldSyncStatus {
        let heldPartition = try store.isHeld(partition)
        let held = heldPartition ? try store.heldOutbox(for: partition).count + store.deferredOutbox(for: partition).count : 0
        let pending = heldPartition ? 0 : try store.pendingOutbox(for: partition).count + store.deferredOutbox(for: partition).count
        let health = try store.syncHealth(for: partition)
        let cacheExpiry = try store.cacheExpiry(for: partition)
        return FieldSyncStatus(queued: sending ? 0 : pending, sending: sending ? pending : 0,
            needsReview: try store.reviewOutbox(for: partition).count, held: held,
            otherHeldWork: try store.hasOtherHeldWork(for: partition),
            lastSuccessful: health?.lastSuccessfulSyncAt.map { Date(timeIntervalSince1970: Double($0) / 1000) },
            lastErrorCode: health?.lastErrorCode, leaseExpired: try !store.isLeaseValid(now: now, for: partition),
            cacheStale: cacheExpiry.map { Double($0) <= now.timeIntervalSince1970 * 1000 } ?? true,
            offline: offline)
    }
}

struct SyncStatusDetail: View {
    let model: AppModel
    var body: some View {
        NavigationStack {
            List {
                if let status = model.syncStatus {
                    Section("Local sync") {
                        Text(status.label)
                        Text("Queued: \(status.queued) · Sending: \(status.sending) · Needs review: \(status.needsReview) · Held: \(status.held)")
                        if status.otherHeldWork { Text("Prior scope has held work — supervisor review required") }
                        if status.offline { Text("Offline — retry when connected") }
                        if status.leaseExpired { Text("Lease expired — reconnect before new work") }
                        if status.cacheStale { Text("Saved cache is stale") }
                        if let date = status.lastSuccessful {
                            Text("Last successful sync: \(date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, timeZone: TimeZone(identifier: "Asia/Manila")!))) PHT")
                        }
                    }
                }
                Section("Frozen work · never retried automatically") {
                    if model.review.isEmpty { Text("No frozen operations") }
                    ForEach(Array(model.review.enumerated()), id: \.offset) { _, reason in
                        Text(reason).foregroundStyle(SunprideTokens.dangerText)
                    }
                    Text("Hold for supervisor: contact your supervisor before resolving rejected or held work. Nothing is deleted here.")
                        .font(.caption)
                }
                Button("Sync now") { Task { await model.syncNow() } }
                    .disabled(model.syncing || !model.enrollment.state.isReady || model.isOffline)
            }
            .navigationTitle("Sync status")
        }
    }
}
