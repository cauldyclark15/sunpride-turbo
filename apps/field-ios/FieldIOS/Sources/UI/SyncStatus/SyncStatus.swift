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
    var accessUntil: Date? = nil

    var label: String {
        if held > 0 || otherHeldWork { return "Held · needs supervisor" }
        if needsReview > 0 { return "Needs review" }
        if queued + sending > 0 { return sending > 0 ? "Sending · not synced" : "Waiting · not synced" }
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
        var status = FieldSyncStatus(queued: sending ? 0 : pending, sending: sending ? pending : 0,
            needsReview: try store.reviewOutbox(for: partition).count, held: held,
            otherHeldWork: try store.hasOtherHeldWork(for: partition),
            lastSuccessful: health?.lastSuccessfulSyncAt.map { Date(timeIntervalSince1970: Double($0) / 1000) },
            lastErrorCode: health?.lastErrorCode, leaseExpired: try !store.isLeaseValid(now: now, for: partition),
            cacheStale: cacheExpiry.map { Double($0) <= now.timeIntervalSince1970 * 1000 } ?? true,
            offline: offline)
        status.accessUntil = try store.leaseExpiry(for: partition).map { Date(timeIntervalSince1970: Double($0) / 1000) }
        return status
    }
}

struct SyncStatusDetail: View {
    let model: AppModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Sync").font(SunprideTokens.TypeStyle.title)
                    if let status = model.syncStatus {
                        SectionCard(title: "On this phone") {
                            VStack(spacing: 0) {
                                if status.queued > 0 {
                                    DetailRow(label: "Waiting", value: "\(status.queued)")
                                } else {
                                    DetailRow(label: "Nothing waiting", value: "")
                                }
                                divider
                                if status.needsReview > 0 {
                                    DetailRow(label: "To review", value: "\(status.needsReview)")
                                    divider
                                }
                                if status.held > 0 {
                                    DetailRow(label: "Held", value: "\(status.held)")
                                    divider
                                }
                                if status.sending > 0 {
                                    DetailRow(label: "Sending", value: "\(status.sending)")
                                    divider
                                }
                                DetailRow(label: "Last sync", value: status.lastSuccessful.map {
                                    $0.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: TimeZone(identifier: "Asia/Manila")!))
                                } ?? "Never")
                                divider
                                DetailRow(label: "Access until", value: status.accessUntil.map {
                                    $0.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: TimeZone(identifier: "Asia/Manila")!))
                                } ?? "Unavailable")
                            }
                        }
                        if status.needsReview > 0 {
                            SectionCard(title: "To review · \(status.needsReview)") {
                                ForEach(Array(model.review.enumerated()), id: \.offset) { _, reason in
                                    CalmListRow(symbol: "exclamationmark.circle", title: reason, meta: "Ask your supervisor")
                                }
                            }
                        }
                        if status.otherHeldWork {
                            SectionCard(title: "Attention") {
                                CalmListRow(symbol: "exclamationmark.circle", title: "Earlier work held", meta: "Ask your supervisor")
                            }
                        }
                    }
                }
                .padding(16)
                .padding(.bottom, 64)
            }
            .background(SunprideTokens.background)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }.foregroundStyle(SunprideTokens.text)
                }
            }
            .safeAreaInset(edge: .bottom) {
                PrimaryBottomButton(title: model.syncing ? "Syncing…" : "Sync now", disabled: model.syncing || !model.enrollment.state.isReady || model.isOffline) {
                    Task { await model.syncNow() }
                }.padding(16).background(SunprideTokens.background)
            }
        }
    }
    private var divider: some View {
        Rectangle().fill(SunprideTokens.secondaryText.opacity(0.2)).frame(height: 1).padding(.leading, 16)
    }
}
