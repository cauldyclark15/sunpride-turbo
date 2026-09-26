import XCTest
@testable import FieldIOS

@MainActor
final class StorageTests: XCTestCase {
    private var directory: URL!
    private var url: URL!
    private var secrets: KeychainStore!
    private var keyName: String!
    private let now = Date(timeIntervalSince1970: 1_790_380_800)
    private var partition: StorePartition { get throws { try StorePartition(subject: "issuer|seller", deviceId: "phone-1", scope: "scope-1") } }

    override func setUp() async throws {
        try await super.setUp()
        directory = FileManager.default.temporaryDirectory.appending(path: "field-store-\(UUID().uuidString)", directoryHint: .isDirectory)
        url = directory.appending(path: "field.sqlite")
        secrets = KeychainStore(service: "com.sunpride.field.storage.tests.\(UUID().uuidString)")
        keyName = "db"
    }
    override func tearDown() async throws {
        try? secrets.delete(keyName)
        try? FileManager.default.removeItem(at: directory)
        try await super.tearDown()
    }
    private func open() throws -> EncryptedFieldStore { try EncryptedFieldStore(url: url, secrets: secrets, keyAccount: keyName) }
    private func snapshot(marker: String = "CiphertextMarkerForFieldStore123456789") -> StoreSnapshot {
        StoreSnapshot(employee: .init(id: "profile-1", role: "sales", orgUnitId: "unit-1"),
            visits: [.init(id: "planned-1", outletId: "outlet-1", serviceDate: "2026-09-26", planId: "plan-1", planVersion: 1, intents: ["audit"])],
            outlets: [.init(id: "outlet-1", name: marker, routeId: "route-1")],
            customers: [.init(id: "customer-1", code: "C001")],
            route: .init(id: "route-1", code: "R001"),
            tasks: [.init(id: "task-1", kind: "audit", required: true)])
    }
    private func intent(_ uuid: UUID = UUID()) -> VisitIntent {
        let json = "{\"kind\":\"visit.checkIn\",\"clientRequestId\":\"\(uuid.uuidString.lowercased())\",\"payload\":{\"outletId\":\"outlet-1\"}}"
        return VisitIntent(requestId: uuid, kind: "visit.checkIn", operationJSON: Data(json.utf8))
    }
    private func seeded(_ store: EncryptedFieldStore, _ p: StorePartition) throws {
        try store.saveSnapshot(snapshot(), cursor: "opaque-start", leaseExpiresAt: 1_790_467_200_000,
                               cacheExpiresAt: 1_790_467_200_000, for: p)
    }

    func testEncryptionKeychainReopenAndWrongKey() throws {
        let p = try partition
        let store = try open()
        try seeded(store, p)
        XCTAssertEqual(try store.outlets(for: p).first?.name, "CiphertextMarkerForFieldStore123456789")
        let key = try XCTUnwrap(secrets.read(keyName))
        XCTAssertEqual(key.count, 32)
        let attributes = try XCTUnwrap(secrets.attributes(keyName))
        XCTAssertEqual(attributes["sync"] as? Int, 0)
        XCTAssertEqual(attributes["pdmn"] as? String, "cku")
        // Read encrypted database and any live WAL while the connection is still open.
        for suffix in ["", "-wal", "-shm"] {
            let candidate = URL(fileURLWithPath: url.path + suffix)
            if let raw = try? Data(contentsOf: candidate) {
                XCTAssertNil(raw.range(of: Data("CiphertextMarkerForFieldStore123456789".utf8)))
                XCTAssertTrue(try candidate.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup ?? false)
                // Simulator APFS may not report file-protection attributes despite a successful set.
                if let protection = try FileManager.default.attributesOfItem(atPath: candidate.path)[.protectionKey] as? FileProtectionType {
                    XCTAssertEqual(protection, .completeUntilFirstUserAuthentication)
                }
            }
        }
        store.close()
        let bytes = try Data(contentsOf: url)
        XCTAssertFalse(bytes.starts(with: Data("SQLite format 3".utf8)))
        let reopened = try open()
        XCTAssertEqual(try reopened.snapshot(for: p)?.route?.code, "R001")
        reopened.close()
        try secrets.save(Data(repeating: 99, count: 32), for: keyName)
        XCTAssertThrowsError(try open())
        try secrets.delete(keyName)
        XCTAssertThrowsError(try open()) { XCTAssertEqual($0 as? StoreError, .missingKey) }
    }

    func testAtomicRollbackAndSnapshotSwapKeepsEvidence() throws {
        let p = try partition, store = try open(), op = intent()
        try seeded(store, p)
        store.failAfterIntentInsert = true
        XCTAssertThrowsError(try store.enqueue(op, for: p, now: now))
        XCTAssertEqual(try store.pendingOutbox(for: p).count, 0)
        store.failAfterIntentInsert = false
        try store.enqueue(op, for: p, now: now)
        XCTAssertThrowsError(try store.enqueue(op, for: p, now: now))
        try store.saveSnapshot(snapshot(marker: "new outlet"), cursor: "new-cursor", leaseExpiresAt: 1_790_467_200_000,
                               cacheExpiresAt: 1_790_467_200_000, for: p)
        var duplicate = snapshot(marker: "invalid")
        duplicate = StoreSnapshot(employee: duplicate.employee, visits: duplicate.visits,
            outlets: duplicate.outlets + duplicate.outlets, customers: duplicate.customers,
            route: duplicate.route, tasks: duplicate.tasks)
        XCTAssertThrowsError(try store.saveSnapshot(duplicate, cursor: "bad-cursor", leaseExpiresAt: 1_790_467_200_000,
                                                     cacheExpiresAt: 1_790_467_200_000, for: p))
        XCTAssertEqual(try store.cursor(for: p), "new-cursor")
        XCTAssertEqual(try store.outlets(for: p).first?.name, "new outlet")
        XCTAssertEqual(try store.pendingOutbox(for: p).map(\.intent), [op])
        try store.setCursor(nil, for: p)
        XCTAssertNil(try store.cursor(for: p))
        XCTAssertEqual(try store.pendingOutbox(for: p).count, 1)
        XCTAssertEqual(try store.todayVisits("2026-09-26", for: p).count, 1)
        XCTAssertTrue(try store.todayVisits("2026-09-27", for: p).isEmpty)
        store.close()
        XCTAssertEqual(try open().pendingOutbox(for: p).first?.intent, op)
    }

    func testAckBeforeDequeueRejectionAndOrdering() throws {
        let p = try partition, store = try open()
        try seeded(store, p)
        let a = intent(), b = intent()
        try store.enqueue(a, for: p, now: now)
        try store.enqueue(b, for: p, now: now)
        XCTAssertEqual(try store.pendingOutbox(for: p).map(\.intent), [a, b])
        let ack = ServerAck(entityId: "visit-1", eventIds: ["event-1"], serverTime: 1_790_380_800_001)
        try store.recordAck(ack, for: a.requestId, in: p)
        XCTAssertEqual(try store.ack(for: a.requestId, in: p), ack)
        XCTAssertEqual(try store.pendingOutbox(for: p).map(\.intent), [b])
        XCTAssertThrowsError(try store.recordAck(ack, for: a.requestId, in: p))
        try store.recordRejection(code: "out_of_scope", for: b.requestId, in: p)
        XCTAssertTrue(try store.pendingOutbox(for: p).isEmpty)
        XCTAssertEqual(try store.reviewOutbox(for: p), [ReviewItem(intent: b, code: "out_of_scope")])
        XCTAssertThrowsError(try store.recordAck(ack, for: b.requestId, in: p))
        store.close()
        XCTAssertEqual(try open().ack(for: a.requestId, in: p), ack)
    }

    func testPartitionAndHoldAndLease() throws {
        let a = try partition, b = try StorePartition(subject: "issuer|other", deviceId: "phone-1", scope: "scope-1")
        let c = try StorePartition(subject: "issuer|seller", deviceId: "phone-2", scope: "scope-1")
        let d = try StorePartition(subject: "issuer|seller", deviceId: "phone-1", scope: "scope-2")
        let store = try open(), op = intent()
        try seeded(store, a)
        try store.enqueue(op, for: a, now: now)
        for other in [b, c, d] {
            XCTAssertNil(try store.snapshot(for: other))
            XCTAssertNil(try store.cursor(for: other))
            XCTAssertTrue(try store.pendingOutbox(for: other).isEmpty)
            XCTAssertFalse(try store.isLeaseValid(now: now, for: other))
            XCTAssertThrowsError(try store.enqueue(intent(), for: other, now: now))
        }
        XCTAssertTrue(try store.isLeaseValid(now: now, for: a))
        XCTAssertEqual(try store.cacheExpiry(for: a), 1_790_467_200_000)
        let expiry = try XCTUnwrap(store.leaseExpiry(for: a))
        XCTAssertFalse(try store.isLeaseValid(now: Date(timeIntervalSince1970: Double(expiry) / 1000), for: a))
        XCTAssertThrowsError(try store.enqueue(intent(), for: a, now: Date(timeIntervalSince1970: Double(expiry) / 1000))) {
            XCTAssertEqual($0 as? StoreError, .leaseExpired)
        }
        XCTAssertNotNil(try store.snapshot(for: a)) // stale but readable
        try store.holdForReview(a)
        XCTAssertNil(try store.cursor(for: a))
        XCTAssertTrue(try store.pendingOutbox(for: a).isEmpty)
        XCTAssertEqual(try store.heldOutbox(for: a).first?.intent, op)
        XCTAssertThrowsError(try store.enqueue(intent(), for: a, now: now)) {
            XCTAssertEqual($0 as? StoreError, .heldForReview)
        }
    }

    func testMigrationsV0PreserveUUIDAndV1NoOp() throws {
        let p = try partition, op = intent()
        try EncryptedFieldStore.createLegacyV0(url: url, secrets: secrets, keyAccount: keyName, partition: p, intent: op)
        let upgraded = try open()
        XCTAssertEqual(try upgraded.pendingOutbox(for: p).first?.intent, op)
        try upgraded.setCursor("after-migration", for: p)
        upgraded.close()
        let reopened = try open() // v1 → v1 no-op
        XCTAssertEqual(try reopened.pendingOutbox(for: p).first?.intent.requestId, op.requestId)
        XCTAssertEqual(try reopened.cursor(for: p), "after-migration")
    }

    func testSameBoundSubjectResumesHeldWorkDifferentAccountCannot() throws {
        let a = try partition
        let b = try StorePartition(subject: "issuer|other", deviceId: a.deviceId, scope: a.scope)
        let c = try StorePartition(subject: a.subject, deviceId: "another-phone", scope: a.scope)
        let store = try open()
        for p in [a, b, c] {
            try seeded(store, p)
            try store.enqueue(intent(), for: p, now: now)
            try store.holdForReview(p)
            XCTAssertTrue(try store.pendingOutbox(for: p).isEmpty)
            XCTAssertEqual(try store.heldOutbox(for: p).count, 1)
        }
        try store.releaseHeld(subject: a.subject, deviceId: a.deviceId)
        XCTAssertEqual(try store.pendingOutbox(for: a).count, 1)
        XCTAssertTrue(try store.heldOutbox(for: a).isEmpty)
        try store.holdForReview(a)
        try store.saveSnapshot(snapshot(marker: "refreshed while held"), cursor: "new", leaseExpiresAt: 1_790_467_200_000,
                               cacheExpiresAt: 1_790_467_200_000, for: a)
        XCTAssertTrue(try store.isHeld(a), "snapshot promotion cannot silently resume held work")
        try store.releaseHeld(subject: a.subject, deviceId: a.deviceId)
        XCTAssertEqual(try store.pendingOutbox(for: a).count, 1)
        for p in [b, c] {
            XCTAssertTrue(try store.isHeld(p))
            XCTAssertTrue(try store.pendingOutbox(for: p).isEmpty)
            XCTAssertEqual(try store.heldOutbox(for: p).count, 1)
        }
        store.close()
        let reopened = try open()
        XCTAssertEqual(try reopened.pendingOutbox(for: a).count, 1)
        XCTAssertTrue(try reopened.pendingOutbox(for: b).isEmpty)
    }

    func testSyncHealthSurvivesRestart() throws {
        let p = try partition, store = try open()
        let health = SyncHealth(lastSuccessfulSyncAt: 1_790_380_800_000, lastErrorCode: "invalid_cursor")
        try store.setSyncHealth(health, for: p)
        store.close()
        XCTAssertEqual(try open().syncHealth(for: p), health)
    }
}
