import BackgroundTasks
import Foundation

/// Best-effort refresh only. The OS chooses timing; no location collection occurs here.
@MainActor
final class BackgroundRetry {
    static let shared = BackgroundRetry()
    nonisolated static let identifier = "com.sunpride.field.dev.sync-refresh"
    var model: AppModel? // One process-wide flight for foreground and cold BG launches.
    private init() {}

    static func hasRetryableWork(store: any FieldLocalStore, partition: StorePartition) -> Bool {
        guard (try? store.isHeld(partition)) == false else { return false }
        return ((try? store.pendingOutbox(for: partition).count) ?? 0) +
            ((try? store.deferredOutbox(for: partition).count) ?? 0) > 0
    }

    private struct UnsafeTask: @unchecked Sendable { let value: BGAppRefreshTask }
    // Register before app launch finishes. The model is installed by the scene when available.
    nonisolated static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else { task.setTaskCompleted(success: false); return }
            let boxed = UnsafeTask(value: refresh) // BGTask's completion/expiration API is thread-safe.
            Task { @MainActor in shared.handle(boxed.value) }
        }
    }

    func scheduleIfNeeded() {
        guard model?.hasRetryableWork == true else { return }
        let request = BGAppRefreshTaskRequest(identifier: Self.identifier)
        request.earliestBeginDate = Date().addingTimeInterval(15 * 60) // hint, NOT a deadline
        try? BGTaskScheduler.shared.submit(request)
    }

    private func restoreModel() -> AppModel? {
        if let model { return model }
        let values = ["CONVEX_SITE_URL": Bundle.main.object(forInfoDictionaryKey: "CONVEX_SITE_URL") as? String ?? "",
                      "CONVEX_URL": Bundle.main.object(forInfoDictionaryKey: "CONVEX_URL") as? String ?? ""]
        guard let environment = try? AppEnvironment(values: values) else { return nil }
        let restored = AppModel.live(environment: environment)
        model = restored
        return restored
    }

    private func handle(_ task: BGAppRefreshTask) {
        guard let model = restoreModel() else {
            task.setTaskCompleted(success: false)
            return
        }
        if model.signedIn && !model.hasRetryableWork {
            task.setTaskCompleted(success: true)
            return
        }
        let work = Task { @MainActor in
            if model.signedIn { await model.syncNow() }
            else { await model.launch() } // Cold background launch restores the verified partition first.
            scheduleIfNeeded()
            task.setTaskCompleted(success: !Task.isCancelled)
        }
        task.expirationHandler = { work.cancel() }
    }
}
