import Foundation
import XCTest
@testable import FieldIOS

@MainActor
final class SyncStatusDiagnosticsTests: XCTestCase {
    private var directory: URL!
    private var secrets: KeychainStore!
    private var store: EncryptedFieldStore!
    private var partition: StorePartition!
    private let fixedNow = ISO8601DateFormatter().date(from: "2026-10-02T10:00:00+08:00")!
    private func date(_ value: String) -> Date { ISO8601DateFormatter().date(from: value)! }
    override func setUp() async throws {
        try await super.setUp()
        directory = FileManager.default.temporaryDirectory.appending(path: "field-status-\(UUID().uuidString)")
        secrets = KeychainStore(service: "com.sunpride.status.tests.\(UUID().uuidString)")
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        partition = try StorePartition(subject: "test|subject", deviceId: "test-device", scope: "test-scope")
        let snapshot = StoreSnapshot(employee: .init(id: "test", role: "sales", orgUnitId: "unit"),
            visits: [], outlets: [], customers: [], route: nil, tasks: [])
        let now = Int64(fixedNow.timeIntervalSince1970 * 1000)
        try store.saveSnapshot(snapshot, cursor: "cursor", leaseExpiresAt: now + 600_000,
                               cacheExpiresAt: now + 600_000, for: partition)
        try store.setSyncHealth(SyncHealth(lastSuccessfulSyncAt: now, lastErrorCode: nil), for: partition)
    }
    override func tearDown() async throws {
        store.close()
        try? secrets.delete("db")
        try? secrets.delete("field.support.handle")
        try? FileManager.default.removeItem(at: directory)
        try await super.tearDown()
    }
    private func enqueue(deferred: Bool = false) throws -> UUID {
        let id = UUID()
        let object: [String: Any] = ["clientRequestId": id.uuidString.lowercased(),
            "kind": deferred ? "visit.activity" : "visit.checkIn",
            "payload": [:], "dependsOn": [UUID().uuidString.lowercased()]]
        let intent = VisitIntent(requestId: id, kind: deferred ? "visit.activity" : "visit.checkIn",
            operationJSON: try JSONSerialization.data(withJSONObject: object))
        if deferred { try store.enqueueDeferred(intent, for: partition, now: fixedNow) }
        else { try store.enqueue(intent, for: partition, now: fixedNow) }
        return id
    }
    private func status(sending: Bool = false) throws -> FieldSyncStatus {
        try FieldSyncStatus.read(store: store, partition: partition, now: fixedNow, sending: sending, offline: false)
    }
    func testCountsPendingDeferredReviewHeldAndRestart() throws {
        XCTAssertEqual(try status().label, "All synced")
        let first = try enqueue()
        _ = try enqueue(deferred: true)
        XCTAssertEqual(try status().queued, 2)
        XCTAssertEqual(try status().label, "Sync before 10 PM")
        XCTAssertEqual(try status(sending: true).sending, 2)
        try store.recordRejection(code: "invalid_transition", for: first, in: partition)
        XCTAssertEqual(try status().needsReview, 1)
        XCTAssertEqual(try status().queued, 1)
        store.close()
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        XCTAssertEqual(try status().queued, 1)
        XCTAssertEqual(try status().needsReview, 1)
        try store.holdForReview(partition)
        let held = try status()
        XCTAssertEqual(held.held, 1)
        XCTAssertEqual(held.queued, 0, "deferred work is held, not sendable")
        XCTAssertNotEqual(held.label, "All synced")
    }
    func testOtherScopeHeldWorkBlocksAllSynced() throws {
        _ = try enqueue()
        try store.holdForReview(partition)
        let current = try StorePartition(subject: partition.subject, deviceId: partition.deviceId, scope: "new-scope")
        let snapshot = try XCTUnwrap(store.snapshot(for: partition))
        let expiry = Int64(fixedNow.timeIntervalSince1970 * 1000) + 600_000
        try store.saveSnapshot(snapshot, cursor: "fresh", leaseExpiresAt: expiry, cacheExpiresAt: expiry, for: current)
        try store.setSyncHealth(SyncHealth(lastSuccessfulSyncAt: expiry - 600_000, lastErrorCode: nil), for: current)
        let result = try FieldSyncStatus.read(store: store, partition: current, now: fixedNow, sending: false, offline: false)
        XCTAssertTrue(result.otherHeldWork)
        XCTAssertEqual(result.label, "Held · needs supervisor")
    }
    func testExpiredLeaseAndCacheNeverClaimSynced() throws {
        let future = fixedNow.addingTimeInterval(800)
        let expired = try FieldSyncStatus.read(store: store, partition: partition, now: future, sending: false, offline: true)
        XCTAssertTrue(expired.leaseExpired)
        XCTAssertTrue(expired.cacheStale)
        XCTAssertEqual(expired.label, "Stale · pending")
    }
    func testManilaCloseBoundaryAndUnsentLateWorkWithFreshLease() throws {
        let start = try DiagnosticOperation.checkIn(plannedId: "p", outletId: "o", day: "2026-10-02",
            intents: [], reason: nil, location: nil, now: fixedNow)
        try store.enqueue(start, for: partition, now: fixedNow)
        let close = try XCTUnwrap(FieldDay.close(serviceDay: "2026-10-02"))
        XCTAssertEqual(close, date("2026-10-02T14:00:00Z"))
        XCTAssertEqual(FieldDay.nextClose(after: close.addingTimeInterval(-1)), close)
        XCTAssertEqual(FieldDay.nextClose(after: close), date("2026-10-03T22:00:00+08:00"))
        XCTAssertEqual(FieldDay.closeTimeLabel(close), "10:00 PM")
        let snapshot = try XCTUnwrap(store.snapshot(for: partition))
        // A refreshed lease must not erase the *work's* earlier service-day deadline.
        let nextClose = Int64(FieldDay.nextClose(after: close).timeIntervalSince1970 * 1000)
        try store.saveSnapshot(snapshot, cursor: "fresh", leaseExpiresAt: nextClose, cacheExpiresAt: nextClose, for: partition)
        func read(_ now: Date, sending: Bool = false) throws -> FieldSyncStatus {
            try FieldSyncStatus.read(store: store, partition: partition, now: now, sending: sending, offline: true)
        }
        XCTAssertEqual(try read(close.addingTimeInterval(-1)).label, "Sync before 10 PM")
        XCTAssertEqual(try read(close.addingTimeInterval(-1), sending: true).label, "Sync before 10 PM")
        XCTAssertEqual(try read(close).label, "Late · held for review")
        XCTAssertEqual(try read(close, sending: true).label, "Late · held for review")
        XCTAssertEqual(try read(close).accessUntilLabel, "10:00 PM")
        XCTAssertFalse(try read(close).leaseExpired)
        XCTAssertEqual(try read(date("2026-10-03T09:00:00+08:00")).label, "Late · held for review")
        XCTAssertTrue(BackgroundRetry.hasRetryableWork(store: store, partition: partition))
        // Only the dependent End remains unsent, but still belongs to the arrival's service day.
        try store.recordAck(.init(entityId: "visit", eventIds: [], serverTime: nextClose), for: start.requestId, in: partition)
        let end = try DiagnosticOperation.checkOut(outcome: "completed", reason: nil, checkIn: start.requestId,
            visitId: nil, now: close.addingTimeInterval(-1))
        try store.enqueueDeferred(end, for: partition, now: close.addingTimeInterval(-1))
        XCTAssertEqual(try read(close).label, "Late · held for review")
        try store.recordRejection(code: "mcp_order", for: end.requestId, in: partition)
        XCTAssertEqual(try read(close).label, "Needs review")
        let another = try DiagnosticOperation.checkIn(plannedId: "other", outletId: "o", day: "2026-10-02",
            intents: [], reason: nil, location: nil, now: fixedNow)
        try store.enqueue(another, for: partition, now: fixedNow)
        try store.holdForReview(partition)
        XCTAssertEqual(try read(close).label, "Held · needs supervisor")
    }

    func testRedactorAndSupportText() throws {
        let samples = ["Bearer secret123", "abcdefgh.abcdefgh.abcdefgh", "seller@example.test",
            "+639171234567", "lat:14.612345 lng:121.023456", "14.612345,121.023456",
            "signature=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv==", "{\"password\":\"secret\"}",
            "name=Jane_Doe"]
        for sample in samples { XCTAssertFalse(DiagnosticRedactor.redact(sample).contains(sample), sample) }
        let info = SupportInfo(secrets: secrets)
        let text = info.text(status: try status())
        XCTAssertTrue(text.contains("Support handle"))
        XCTAssertFalse(text.contains("test|subject"))
        XCTAssertFalse(text.contains("test-device"))
        XCTAssertEqual(info.handle, SupportInfo(secrets: secrets).handle)
    }
    func testBreadcrumbRingBoundedAndPersisted() throws {
        let url = directory.appending(path: "breadcrumbs.json")
        let crumbs = DiagnosticBreadcrumbs(url: url)
        for _ in 0..<80 { crumbs.add(.workQueued) }
        XCTAssertEqual(crumbs.entries.count, 50)
        XCTAssertEqual(DiagnosticBreadcrumbs(url: url).entries.count, 50)
        XCTAssertFalse(String(decoding: try Data(contentsOf: url), as: UTF8.self).contains("test|subject"))
    }
}
