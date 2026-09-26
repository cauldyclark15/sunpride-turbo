import Foundation
import XCTest
@testable import FieldIOS

@MainActor
final class SyncStatusDiagnosticsTests: XCTestCase {
    private var directory: URL!
    private var secrets: KeychainStore!
    private var store: EncryptedFieldStore!
    private var partition: StorePartition!
    override func setUp() async throws {
        try await super.setUp()
        directory = FileManager.default.temporaryDirectory.appending(path: "field-status-\(UUID().uuidString)")
        secrets = KeychainStore(service: "com.sunpride.status.tests.\(UUID().uuidString)")
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        partition = try StorePartition(subject: "test|subject", deviceId: "test-device", scope: "test-scope")
        let snapshot = StoreSnapshot(employee: .init(id: "test", role: "sales", orgUnitId: "unit"),
            visits: [], outlets: [], customers: [], route: nil, tasks: [])
        let now = Int64(Date().timeIntervalSince1970 * 1000)
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
        if deferred { try store.enqueueDeferred(intent, for: partition, now: Date()) }
        else { try store.enqueue(intent, for: partition, now: Date()) }
        return id
    }
    private func status(sending: Bool = false) throws -> FieldSyncStatus {
        try FieldSyncStatus.read(store: store, partition: partition, now: Date(), sending: sending, offline: false)
    }
    func testCountsPendingDeferredReviewHeldAndRestart() throws {
        XCTAssertEqual(try status().label, "All synced")
        let first = try enqueue()
        _ = try enqueue(deferred: true)
        XCTAssertEqual(try status().queued, 2)
        XCTAssertEqual(try status().label, "Waiting · not synced")
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
        let expiry = Int64(Date().timeIntervalSince1970 * 1000) + 600_000
        try store.saveSnapshot(snapshot, cursor: "fresh", leaseExpiresAt: expiry, cacheExpiresAt: expiry, for: current)
        try store.setSyncHealth(SyncHealth(lastSuccessfulSyncAt: expiry - 600_000, lastErrorCode: nil), for: current)
        let result = try FieldSyncStatus.read(store: store, partition: current, now: Date(), sending: false, offline: false)
        XCTAssertTrue(result.otherHeldWork)
        XCTAssertEqual(result.label, "Held · needs supervisor")
    }
    func testExpiredLeaseAndCacheNeverClaimSynced() throws {
        let future = Date().addingTimeInterval(800)
        let expired = try FieldSyncStatus.read(store: store, partition: partition, now: future, sending: false, offline: true)
        XCTAssertTrue(expired.leaseExpired)
        XCTAssertTrue(expired.cacheStale)
        XCTAssertEqual(expired.label, "Stale · pending")
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
