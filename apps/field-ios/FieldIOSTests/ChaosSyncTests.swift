import CryptoKit
import Foundation
import Synchronization
import XCTest
@testable import FieldIOS

/// Faults run through the existing URLProtocol/HTTPClient, the real sync clients and SQLCipher.
/// Seeds determine faults and UUIDs, not wall-clock retry jitter in VisitSyncClient.withBackoff.
@MainActor
final class ChaosSyncTests: XCTestCase {
    private var directory: URL!
    private var secrets: KeychainStore!
    private var store: EncryptedFieldStore!
    private var partition: StorePartition!
    private var clock: TestClock!
    private var http: HTTPClient!
    private var auth: AuthClient!
    private var key: SoftwareDeviceKey!
    private var transport: ChaosTransport!
    private var engine: VisitSyncClient?
    private var model: AppModel?

    override func setUp() async throws {
        try await super.setUp()
        directory = FileManager.default.temporaryDirectory.appending(path: "field-chaos-\(UUID().uuidString)")
        secrets = KeychainStore(service: "com.sunpride.field.chaos.tests.\(UUID().uuidString)")
        clock = TestClock(Date())
        partition = try StorePartition(subject: "issuer|seller", deviceId: "device-1", scope: "scope-v1")
        key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        try secrets.save(Data("test-session".utf8), for: StoreAccount.session)
        try reset(seed: 1)
    }

    override func tearDown() async throws {
        model?.enrollment.signedOut()
        model = nil
        engine = nil
        store.close()
        // No production account/key or simulator-wide state is cleared.
        for account in ["db", StoreAccount.session, StoreAccount.deviceId, StoreAccount.credentialId,
                        "field.lastVerifiedPartition"] { try? secrets.delete(account) }
        try? FileManager.default.removeItem(at: directory)
        StubURLProtocol.install { _ in .fail(.notConnectedToInternet) }
        try await super.tearDown()
    }

    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "json")))
    }
    private func object(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    private func bytes(_ value: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }
    private func uuid(seed: UInt64, index: Int) -> UUID {
        UUID(uuidString: String(format: "%08llx-0000-4000-8000-%012x", seed, index))!
    }
    private func stable(_ intent: VisitIntent, seed: UInt64, index: Int) throws -> VisitIntent {
        var op = try object(intent.operationJSON)
        let id = uuid(seed: seed, index: index)
        op["clientRequestId"] = id.uuidString.lowercased()
        if intent.kind == "visit.checkIn" {
            var payload = try XCTUnwrap(op["payload"] as? [String: Any])
            payload["clientVisitId"] = uuid(seed: seed, index: 100 + index).uuidString.lowercased()
            op["payload"] = payload
        }
        return VisitIntent(requestId: id, kind: intent.kind, operationJSON: try bytes(op))
    }
    private func reset(seed: UInt64) throws {
        engine = nil
        store?.close()
        // Each seed has an independent on-disk store; restarts reuse this exact URL and key.
        store = try EncryptedFieldStore(url: directory.appending(path: "seed-\(seed).sqlite"), secrets: secrets, keyAccount: "db")
        http = StubHTTP.client()
        auth = AuthClient(site: StubHTTP.site, store: secrets, http: http)
        let page = try bootstrapPage()
        transport = ChaosTransport(seed: seed, now: clock.now, bootstrap: [page])
        transport.install()
        let decoded = try JSONDecoder().decode(BootstrapV1.Page.self, from: page)
        try store.saveSnapshot(.init(employee: decoded.employee, visits: decoded.plannedVisits,
            outlets: decoded.outlets, customers: [], route: nil, tasks: [], callSheets: decoded.callSheets),
            cursor: "cursor-0", leaseExpiresAt: decoded.appConfig.offlineLeaseExpiresAt,
            cacheExpiresAt: decoded.appConfig.cacheExpiresAt, for: partition)
        try store.setSyncHealth(.init(lastSuccessfulSyncAt: Int64(clock.now.timeIntervalSince1970 * 1000),
                                    lastErrorCode: nil), for: partition)
        makeEngine()
    }
    private func makeEngine() {
        engine = VisitSyncClient(site: StubHTTP.site, auth: auth,
            registry: ConvexDeviceRegistry(functions: ConvexFunctions(url: StubHTTP.cloud, auth: auth, http: http)),
            http: http, key: key)
    }
    private func restart() throws {
        let url = store.url
        let before = try store.intents(for: partition)
        let acks = try before.map { try store.ack(for: $0.requestId, in: partition) }
        let cursor = try store.cursor(for: partition)
        let health = try store.syncHealth(for: partition)
        let held = try store.isHeld(partition)
        engine = nil // discard the old engine, HTTP session and auth token cache
        store.close()
        XCTAssertFalse(try Data(contentsOf: url).starts(with: Data("SQLite format 3".utf8)))
        store = try EncryptedFieldStore(url: url, secrets: secrets, keyAccount: "db")
        http = StubHTTP.client()
        auth = AuthClient(site: StubHTTP.site, store: secrets, http: http)
        makeEngine()
        XCTAssertEqual(try store.intents(for: partition), before, "UUIDs/templates/frozen bytes survive reopen")
        XCTAssertEqual(try before.map { try store.ack(for: $0.requestId, in: partition) }, acks)
        XCTAssertEqual(try store.cursor(for: partition), cursor)
        XCTAssertEqual(try store.syncHealth(for: partition), health)
        XCTAssertEqual(try store.isHeld(partition), held)
    }
    private func bootstrapPage(now: Date? = nil) throws -> Data {
        let now = now ?? clock.now
        var page = try object(fixture("bootstrap-call-sheet-response"))
        let expiry = Int64(FieldDay.nextClose(after: now).timeIntervalSince1970 * 1000)
        page["serverTime"] = Int64(now.timeIntervalSince1970 * 1000)
        var config = try XCTUnwrap(page["appConfig"] as? [String: Any])
        config["offlineLeaseExpiresAt"] = expiry
        config["cacheExpiresAt"] = expiry
        page["appConfig"] = config
        page["employee"] = ["id": "profile-1", "role": "sales", "orgUnitId": "unit-1"]
        page["scope"] = ["fingerprint": partition.scope, "orgUnitIds": ["unit-1"]]
        page["plannedVisits"] = (1...2).map { n in
            ["id": "planned-\(n)", "outletId": "outlet-\(n)", "serviceDate": BootstrapClient.manilaDay(now),
             "planId": "plan-1", "planVersion": 1, "intents": ["merchandise"], "sequence": n - 1] as [String: Any]
        }
        page["outlets"] = (1...2).map { ["id": "outlet-\($0)", "name": "Store \($0)", "routeId": NSNull()] as [String: Any] }
        let sheet = try XCTUnwrap((page["callSheets"] as? [[String: Any]])?.first)
        page["callSheets"] = (1...2).map { n in var copy = sheet; copy["outletId"] = "outlet-\(n)"; return copy }
        page["syncCursor"] = "cursor-0"
        return try bytes(page)
    }
    private func day(seed: UInt64, restartAfterEnqueue: Bool = false) throws -> [VisitIntent] {
        var result: [VisitIntent] = []
        let sheets = try XCTUnwrap(store.snapshot(for: partition)).callSheets
        for outlet in 1...2 {
            let base = (outlet - 1) * 4
            let initial = try stable(DiagnosticOperation.checkIn(plannedId: "planned-\(outlet)", outletId: "outlet-\(outlet)",
                day: BootstrapClient.manilaDay(clock.now), intents: ["merchandise"], reason: nil, location: nil, now: clock.now),
                seed: seed, index: base + 1)
            let note = try stable(DiagnosticOperation.note("Offline store \(outlet)", checkIn: initial.requestId,
                visitId: nil, now: clock.now), seed: seed, index: base + 2)
            let sheet = try stable(DiagnosticOperation.callSheet(XCTUnwrap(sheets.first { $0.outletId == "outlet-\(outlet)" }),
                drafts: ["product-1": .init(values: [.order: "12", .endInventory: "0"])], checkIn: initial.requestId,
                visitId: nil, now: clock.now), seed: seed, index: base + 3)
            let end = try stable(DiagnosticOperation.checkOut(outcome: "completed", reason: nil, checkIn: initial.requestId,
                visitId: nil, now: clock.now), seed: seed, index: base + 4)
            for op in [initial, note, sheet, end] {
                if op.kind == "visit.checkIn" { try store.enqueue(op, for: partition, now: clock.now) }
                else { try store.enqueueDeferred(op, for: partition, now: clock.now) }
                result.append(op)
                if restartAfterEnqueue { try restart() }
            }
        }
        return result
    }
    private func assertNotSynced(offline: Bool = false, sending: Bool = false,
                                 file: StaticString = #filePath, line: UInt = #line) throws {
        let status = try FieldSyncStatus.read(store: store, partition: partition, now: clock.now,
                                              sending: sending, offline: offline)
        XCTAssertNotEqual(status.label, "All synced", file: file, line: line)
    }
    private func assertFinished(_ operations: [VisitIntent], file: StaticString = #filePath, line: UInt = #line) throws {
        let ledger = transport.ledger
        let ids = operations.map { $0.requestId.uuidString.lowercased() }
        XCTAssertEqual(ledger.order, ids, "First commits follow durable enqueue order", file: file, line: line)
        XCTAssertEqual(ledger.commits.count, operations.count, file: file, line: line)
        XCTAssertTrue(ledger.violations.isEmpty, ledger.violations.joined(separator: "; "), file: file, line: line)
        XCTAssertTrue(try store.pendingOutbox(for: partition).isEmpty, file: file, line: line)
        XCTAssertTrue(try store.deferredOutbox(for: partition).isEmpty, file: file, line: line)
        XCTAssertTrue(try store.reviewOutbox(for: partition).isEmpty, file: file, line: line)
        for op in operations {
            let id = op.requestId.uuidString.lowercased()
            let committed = try XCTUnwrap(ledger.commits[id], file: file, line: line)
            XCTAssertEqual(committed.count, 1, file: file, line: line)
            XCTAssertEqual(try store.ack(for: op.requestId, in: partition), committed.ack, file: file, line: line)
            let persisted = try XCTUnwrap(store.intent(for: op.requestId, in: partition))
            XCTAssertEqual(persisted.operationJSON, committed.bytes, file: file, line: line)
            XCTAssertTrue(ledger.attempts[id]?.allSatisfy { $0 == committed.bytes } == true,
                          "Every wire replay must match the frozen operation, not just its UUID", file: file, line: line)
            if op.kind == "visit.checkIn" { XCTAssertEqual(persisted, op, file: file, line: line) }
            else {
                var expected = try object(op.operationJSON)
                var payload = try XCTUnwrap(expected["payload"] as? [String: Any])
                let dependency = try XCTUnwrap(op.dependencies.first)
                payload["visitId"] = try XCTUnwrap(ledger.commits[dependency]).ack.entityId
                expected["payload"] = payload
                XCTAssertEqual(persisted.operationJSON, try bytes(expected), "Only one-time visitId materialization is allowed",
                               file: file, line: line)
            }
        }
        XCTAssertFalse(BackgroundRetry.hasRetryableWork(store: store, partition: partition), file: file, line: line)
    }
    private func expectRetryablePush() async throws {
        do { try await XCTUnwrap(engine).push(store: store, partition: partition); XCTFail("Expected interrupted push") }
        catch { XCTAssertEqual(error as? VisitSyncClient.Failure, .retryable) }
    }
    private func bootstrap() -> BootstrapClient {
        BootstrapClient(site: StubHTTP.site, auth: auth,
            registry: ConvexDeviceRegistry(functions: ConvexFunctions(url: StubHTTP.cloud, auth: auth, http: http)),
            http: http, key: key)
    }
    private func launchModel(_ registry: FakeRegistry) async {
        let functions = ConvexFunctions(url: StubHTTP.cloud, auth: auth, http: http)
        let signingKey = key!
        model = AppModel(auth: auth, registry: registry, store: secrets, site: StubHTTP.site, functions: functions,
                         http: http, localStore: store, now: clock.closure) { signingKey }
        await model!.launch()
        XCTAssertTrue(model!.freshThisLaunch)
        XCTAssertEqual(model!.enrollment.state, .ready(deviceId: partition.deviceId))
    }

    func testSeededOfflineDayDrainsTwoStoresExactlyOnceInEnqueueOrder() async throws {
        var observed = Set<ChaosTransport.Fault>()
        var partialCommits = 0
        for seed in UInt64(1)...30 {
            try reset(seed: seed)
            let operations = try day(seed: seed)
            XCTAssertEqual(try store.pendingOutbox(for: partition).count, 2)
            XCTAssertEqual(try store.deferredOutbox(for: partition).count, 6)
            try assertNotSynced(offline: true)
            transport.randomizePushes(8)
            for _ in 0..<8 where BackgroundRetry.hasRetryableWork(store: store, partition: partition) {
                do { try await XCTUnwrap(engine).push(store: store, partition: partition) }
                catch { XCTAssertEqual(error as? VisitSyncClient.Failure, .retryable, "seed \(seed)") }
                if BackgroundRetry.hasRetryableWork(store: store, partition: partition) { try assertNotSynced() }
                try restart()
            }
            try assertFinished(operations)
            observed.formUnion(transport.ledger.faults)
            partialCommits += transport.ledger.partialCommits
        }
        XCTAssertTrue(Set([.airplane, .lostAck, .duplicate, .midBatch] as [ChaosTransport.Fault]).isSubset(of: observed))
        XCTAssertGreaterThan(partialCommits, 0, "At least one multi-operation batch must fail after a prefix commit")
    }

    /// A planned MCP day queued through the real AppModel commands and its durable stop-order guard,
    /// then drained through seeded faults and restarts against a fake server that applies the MCP rules.
    func testPlannedDayStopOrderAndNoSaleCloseDrainExactlyOnceUnderSeededFaults() async throws {
        var observed = Set<ChaosTransport.Fault>()
        for seed in UInt64(41)...52 { // Real retry backoff runs on the wall clock: keep the suite inside its time budget.
            model?.enrollment.signedOut()
            model = nil
            try reset(seed: seed)
            let registry = FakeRegistry()
            registry.lastMine = .success(.init(deviceId: partition.deviceId, status: "active", bound: true, allowedApp: "IOS"))
            await launchModel(registry)
            let app = try XCTUnwrap(model)
            app.refreshToday()
            func stop(_ id: String) throws -> AppModel.TodayVisit { try XCTUnwrap(app.visits.first { $0.id == id }) }
            XCTAssertEqual(app.startFailure(for: try stop("planned-2")), .mcpOrder)
            try app.queueCheckIn(try stop("planned-1"), unplannedReason: nil, location: nil)
            XCTAssertEqual(app.startFailure(for: try stop("planned-2")), .callOpen)
            XCTAssertThrowsError(try app.queueCheckIn(try stop("planned-1"), unplannedReason: nil, location: nil)) {
                XCTAssertEqual($0 as? AppModel.CallFailure, .alreadyStarted)
            }
            try app.queueNote("Planned stop, offline", for: try stop("planned-1"))
            try app.queueCallSheet(["product-1": .init(values: [.order: "12", .endInventory: "0"])], for: try stop("planned-1"))
            try app.queueCheckOut(outcome: "completed", reason: nil, for: try stop("planned-1"))
            XCTAssertNil(app.startFailure(for: try stop("planned-2")), "A queued, unsent End is enough to move on offline")
            try app.queueCheckIn(try stop("planned-2"), unplannedReason: nil, location: nil)
            XCTAssertThrowsError(try app.queueCheckOut(outcome: "nonproductive", reason: nil, for: try stop("planned-2"))) {
                XCTAssertEqual($0 as? DiagnosticOperation.Failure, .invalidOutcome)
            }
            try app.queueCheckOut(outcome: "nonproductive", reason: "STORE_CLOSED", for: try stop("planned-2"))
            let operations = try store.intents(for: partition)
            XCTAssertEqual(operations.map(\.kind), ["visit.checkIn", "visit.activity", "visit.activity", "visit.checkOut",
                                                    "visit.checkIn", "visit.checkOut"])
            try assertNotSynced(offline: true)
            app.enrollment.signedOut()
            model = nil
            try restart()
            transport.randomizePushes(10)
            for _ in 0..<20 where BackgroundRetry.hasRetryableWork(store: store, partition: partition) {
                do { try await XCTUnwrap(engine).push(store: store, partition: partition) }
                catch { XCTAssertEqual(error as? VisitSyncClient.Failure, .retryable, "seed \(seed)") }
                if BackgroundRetry.hasRetryableWork(store: store, partition: partition) { try assertNotSynced() }
                try restart()
            }
            try assertFinished(operations)
            XCTAssertEqual(transport.ledger.outcomes, ["planned-1|completed|", "planned-2|nonproductive|STORE_CLOSED"], "seed \(seed)")
            XCTAssertEqual(transport.ledger.visitPlans.values.sorted(), ["planned-1", "planned-2"])
            observed.formUnion(transport.ledger.faults)
        }
        XCTAssertTrue(Set([.airplane, .lostAck, .duplicate, .midBatch] as [ChaosTransport.Fault]).isSubset(of: observed))
    }

    func testRestartBetweenEveryStepReplaysFrozenBytesAndFinishesOnce() async throws {
        let operations = try day(seed: 1, restartAfterEnqueue: true)
        // Pause AFTER server commit but BEFORE response delivery. Cancellation substitutes only
        // for the process termination boundary; the engine/store are then discarded and reopened.
        // Existing-key replays return immediately, so each new batch gets its own crash boundary.
        transport.pauseNewPushes()
        for pause in 1...3 {
            let sync = try XCTUnwrap(engine)
            let flight = Task { try await sync.push(store: store, partition: partition) }
            for _ in 0..<100 where transport.ledger.pauses < pause {
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertEqual(transport.ledger.pauses, pause)
            try assertNotSynced(sending: true)
            flight.cancel()
            do { try await flight.value; XCTFail("Crash boundary must not complete") }
            catch is CancellationError { }
            catch { XCTAssertEqual((error as? URLError)?.code, .cancelled) }
            try restart()
            try assertNotSynced()
        }
        transport.resume()
        try await XCTUnwrap(engine).push(store: store, partition: partition)
        try restart()
        try assertFinished(operations)
        XCTAssertTrue(transport.ledger.attempts.values.allSatisfy { $0.count >= 2 })
    }

    func testLostAcknowledgementReconnectReturnsSameAckWithoutDoubleCount() async throws {
        let operations = try day(seed: 1)
        transport.script("/mobile/v1/push", [.lostAck, .lostAck, .lostAck])
        try await expectRetryablePush()
        let initial = operations[0]
        let id = initial.requestId.uuidString.lowercased()
        let committed = try XCTUnwrap(transport.ledger.commits[id])
        XCTAssertEqual(transport.ledger.order, [id])
        XCTAssertNil(try store.ack(for: initial.requestId, in: partition))
        XCTAssertEqual(try store.deferredOutbox(for: partition).count, 6)
        try restart()
        transport.script("/mobile/v1/push", [.duplicate])
        try await XCTUnwrap(engine).push(store: store, partition: partition)
        XCTAssertEqual(try store.ack(for: initial.requestId, in: partition), committed.ack)
        try assertFinished(operations)
        XCTAssertGreaterThanOrEqual(transport.ledger.attempts[id]?.count ?? 0, 4)

        // Sanity-check the oracle: the same key with changed bytes must conflict, not get a
        // fresh ack. Neither local frozen intent nor fake-server commit can be overwritten.
        var changed = try object(initial.operationJSON)
        var payload = try XCTUnwrap(changed["payload"] as? [String: Any])
        payload["intents"] = ["audit"]
        changed["payload"] = payload
        XCTAssertThrowsError(try store.enqueue(.init(requestId: initial.requestId, kind: initial.kind,
            operationJSON: bytes(changed)), for: partition, now: clock.now))
        let response = transport.handle(.init(method: "POST", path: "/mobile/v1/push", headers: [:],
            body: try bytes(["operations": [changed]])))
        guard case .reply(let reply) = response else { return XCTFail("Expected conflict envelope") }
        let result = try JSONDecoder().decode(BootstrapV1.PushResultEnvelope.self, from: reply.body)
        XCTAssertEqual(result.results.first?.status.rawValue, "conflict")
        XCTAssertEqual(transport.ledger.commits[id]?.ack, committed.ack)
        XCTAssertEqual(transport.ledger.commits[id]?.bytes, committed.bytes)
        XCTAssertEqual(transport.ledger.commits[id]?.count, 1)
    }

    func testTodayStatusNeverClaimsAllSyncedForPendingDeferredReviewOrHeldWork() throws {
        XCTAssertEqual(try FieldSyncStatus.read(store: store, partition: partition, now: clock.now,
            sending: false, offline: false).label, "All synced")
        let operations = try day(seed: 1)
        for sending in [false, true] { try assertNotSynced(sending: sending) }
        for initial in [operations[0], operations[4]] {
            try store.recordAck(.init(entityId: "visit-\(initial.requestId)", eventIds: [], serverTime: 1_800_000_000_000),
                                for: initial.requestId, in: partition)
        }
        XCTAssertTrue(try store.pendingOutbox(for: partition).isEmpty)
        XCTAssertEqual(try store.deferredOutbox(for: partition).count, 6)
        try assertNotSynced() // deferred-only, despite a recorded successful sync
        try store.recordRejection(code: "conflict", for: operations[1].requestId, in: partition)
        try assertNotSynced()
        try store.holdForReview(partition)
        try restart()
        let held = try FieldSyncStatus.read(store: store, partition: partition, now: clock.now, sending: false, offline: false)
        XCTAssertEqual(held.held, 5)
        XCTAssertEqual(held.needsReview, 1)
        XCTAssertEqual(held.label, "Held · needs supervisor")
        XCTAssertFalse(BackgroundRetry.hasRetryableWork(store: store, partition: partition))
        let newScope = try StorePartition(subject: partition.subject, deviceId: partition.deviceId, scope: "scope-v2")
        let snapshot = try XCTUnwrap(store.snapshot(for: partition))
        let expiry = try XCTUnwrap(store.leaseExpiry(for: partition))
        try store.saveSnapshot(snapshot, cursor: "new-scope", leaseExpiresAt: expiry, cacheExpiresAt: expiry, for: newScope)
        try store.setSyncHealth(.init(lastSuccessfulSyncAt: Int64(clock.now.timeIntervalSince1970 * 1000), lastErrorCode: nil), for: newScope)
        let current = try FieldSyncStatus.read(store: store, partition: newScope, now: clock.now, sending: false, offline: false)
        XCTAssertTrue(current.otherHeldWork)
        XCTAssertNotEqual(current.label, "All synced")
    }

    func testLongOfflineExpiredLeasePreservesWorkAndRequiresBootstrapBeforeRetry() async throws {
        // Push has no injectable clock: use a genuinely historical lease as well as advancing
        // TestClock, so its Date() guard and status/enqueue's supplied clock agree on expiry.
        clock = TestClock(Date().addingTimeInterval(-4 * 86_400))
        try reset(seed: 2)
        let operations = try day(seed: 2)
        let expiry = try XCTUnwrap(store.leaseExpiry(for: partition))
        let exactExpiry = Date(timeIntervalSince1970: Double(expiry) / 1000)
        XCTAssertFalse(try store.isLeaseValid(now: exactExpiry, for: partition))
        clock.advance(3 * 86_400)
        try restart()
        let status = try FieldSyncStatus.read(store: store, partition: partition, now: clock.now, sending: false, offline: true)
        XCTAssertTrue(status.leaseExpired)
        XCTAssertTrue(status.cacheStale)
        XCTAssertTrue(status.lateWork)
        XCTAssertNotEqual(status.label, "All synced")
        let newWork = try DiagnosticOperation.note("Too late", checkIn: operations[0].requestId, visitId: nil, now: exactExpiry)
        XCTAssertThrowsError(try store.enqueueDeferred(newWork, for: partition, now: exactExpiry)) {
            XCTAssertEqual($0 as? StoreError, .leaseExpired)
        }
        do { try await XCTUnwrap(engine).push(store: store, partition: partition); XCTFail("Expired lease must bootstrap") }
        catch { XCTAssertEqual(error as? VisitSyncClient.Failure, .rebootstrap) }
        XCTAssertTrue(StubURLProtocol.requests(to: "/mobile/v1/push").isEmpty)
        XCTAssertEqual(try store.intents(for: partition), operations)
        XCTAssertTrue(BackgroundRetry.hasRetryableWork(store: store, partition: partition))
        try store.holdForReview(partition) // AppModel's rebootstrap branch, not an expiry-time deletion
        transport.script("/mobile/v1/bootstrap", [.airplane])
        do { _ = try await bootstrap().run(deviceId: partition.deviceId, subject: partition.subject, store: store, previous: partition)
            XCTFail("Offline bootstrap cannot renew the lease")
        } catch { XCTAssertEqual(error as? MobileError, .offline) }
        XCTAssertEqual(try store.leaseExpiry(for: partition), expiry)
        XCTAssertEqual(try store.intents(for: partition), operations)
        transport.setBootstrap([try bootstrapPage(now: Date())])
        let verified = try await bootstrap().run(deviceId: partition.deviceId, subject: partition.subject,
            expectedEmployeeId: "profile-1", store: store, previous: partition)
        XCTAssertEqual(verified, partition)
        XCTAssertTrue(try store.isHeld(partition), "BootstrapClient alone does not release a hold")
        try store.releaseHeld(verified) // same verified subject/device/scope, as AppModel does
        XCTAssertTrue(BackgroundRetry.hasRetryableWork(store: store, partition: partition))
        try await XCTUnwrap(engine).push(store: store, partition: partition)
        try assertFinished(operations)
    }

    func testReconnectRevocationAnd409HoldWithoutDeletingQueuedWork() async throws {
        for (index, fault) in [ChaosTransport.Fault.revoked, .unauthorized, .rebootstrap].enumerated() {
            model?.enrollment.signedOut()
            model = nil
            try reset(seed: UInt64(index + 10))
            let registry = FakeRegistry()
            registry.lastMine = .success(.init(deviceId: partition.deviceId, status: "active", bound: true, allowedApp: "IOS"))
            await launchModel(registry)
            let operations = try day(seed: UInt64(index + 10))
            // Real AppModel catches these failures and owns the hold transition. A bare
            // VisitSyncClient reports a failure; it does not claim to lock a partition itself.
            transport.script("/mobile/v1/push", fault == .unauthorized ? [.unauthorized, .unauthorized] : [fault])
            if fault == .unauthorized {
                registry.lastMine = .success(.init(deviceId: partition.deviceId, status: "revoked", bound: true, allowedApp: "IOS"))
            }
            if fault == .rebootstrap {
                // Failed reconnect bootstrap must leave the existing partition held.
                transport.script("/mobile/v1/bootstrap", [.unavailable])
            }
            await model!.syncNow()
            XCTAssertTrue(try store.isHeld(partition), "\(fault)")
            XCTAssertNil(try store.cursor(for: partition))
            XCTAssertEqual(try store.intents(for: partition), operations)
            XCTAssertEqual(try store.heldOutbox(for: partition).count, 2)
            XCTAssertEqual(try store.deferredOutbox(for: partition).count, 6)
            XCTAssertEqual(model!.syncStatus?.held, 8)
            XCTAssertNotEqual(model!.syncStatus?.label, "All synced")
            XCTAssertFalse(model!.hasRetryableWork)
            if fault == .rebootstrap { XCTAssertEqual(model!.enrollment.state, .ready(deviceId: partition.deviceId)) }
            else { XCTAssertEqual(model!.enrollment.state, .removed) }
            model!.enrollment.signedOut()
            model = nil
            try restart()
            let requests = StubURLProtocol.requests(to: "/mobile/v1/push").count
            try await XCTUnwrap(engine).push(store: store, partition: partition)
            XCTAssertEqual(StubURLProtocol.requests(to: "/mobile/v1/push").count, requests)
            XCTAssertEqual(try store.intents(for: partition), operations)
            XCTAssertTrue(transport.ledger.commits.isEmpty)
        }
    }

    func testUnresolved401RetainsPendingWorkWithoutInventingRevocation() async throws {
        let registry = FakeRegistry()
        registry.lastMine = .success(.init(deviceId: partition.deviceId, status: "active", bound: true, allowedApp: "IOS"))
        await launchModel(registry)
        let operations = try day(seed: 1)
        transport.script("/mobile/v1/push", [.unauthorized, .unauthorized])
        let tokensBefore = StubURLProtocol.requests(to: "/api/auth/convex/token").count
        await model!.syncNow()
        XCTAssertEqual(StubURLProtocol.requests(to: "/mobile/v1/push").count, 2)
        XCTAssertEqual(StubURLProtocol.requests(to: "/api/auth/convex/token").count, tokensBefore + 1)
        XCTAssertEqual(model!.enrollment.state, .ready(deviceId: partition.deviceId))
        // Production deliberately does not infer revocation or hold from an ambiguous 401.
        XCTAssertFalse(try store.isHeld(partition))
        XCTAssertEqual(try store.intents(for: partition), operations)
        XCTAssertTrue(model!.hasRetryableWork)
        try assertNotSynced()
        await model!.syncNow()
        try assertFinished(operations)
        XCTAssertEqual(model!.syncStatus?.label, "All synced")
    }

    func testMidBatchCommitReplaysPrefixOnceAndKeepsDependentOrder() async throws {
        let operations = try day(seed: 1)
        transport.script("/mobile/v1/push", [.online, .midBatch, .airplane, .airplane])
        try await expectRetryablePush()
        XCTAssertNotNil(try store.ack(for: operations[0].requestId, in: partition))
        XCTAssertNil(try store.ack(for: operations[1].requestId, in: partition))
        XCTAssertEqual(transport.ledger.order, operations.prefix(3).map { $0.requestId.uuidString.lowercased() })
        XCTAssertNil(try store.ack(for: operations[2].requestId, in: partition))
        XCTAssertEqual(transport.ledger.partialCommits, 1)
        try assertNotSynced()
        try restart()
        transport.script("/mobile/v1/push", [.duplicate])
        try await XCTUnwrap(engine).push(store: store, partition: partition)
        try assertFinished(operations)
    }

    func testPullDeltaFaultsAndRestartPreserveCursorAndQueuedWork() async throws {
        let operations = try day(seed: 1)
        transport.script("/mobile/v1/pull", [.airplane, .airplane, .airplane])
        do { try await XCTUnwrap(engine).pull(store: store, partition: partition); XCTFail("Offline pull") }
        catch { XCTAssertEqual(error as? VisitSyncClient.Failure, .retryable) }
        XCTAssertEqual(try store.cursor(for: partition), "cursor-0")
        transport.script("/mobile/v1/pull", [.duplicate, .lostAck, .lostAck, .lostAck])
        do { try await XCTUnwrap(engine).pull(store: store, partition: partition); XCTFail("Lost second-page response") }
        catch { XCTAssertEqual(error as? VisitSyncClient.Failure, .retryable) }
        XCTAssertEqual(try store.cursor(for: partition), "cursor-1", "Only successfully applied pages advance the cursor")
        XCTAssertNil(try store.deltaValue(entity: "visit", id: "remote-visit", for: partition))
        try restart()
        transport.script("/mobile/v1/pull", [.duplicate])
        try await XCTUnwrap(engine).pull(store: store, partition: partition)
        XCTAssertEqual(try store.cursor(for: partition), "cursor-2")
        XCTAssertNotNil(try store.deltaValue(entity: "visit", id: "remote-visit", for: partition))
        XCTAssertNil(try store.deltaValue(entity: "visit", id: "deleted-visit", for: partition))
        XCTAssertEqual(try store.intents(for: partition), operations)
        try assertNotSynced()
        XCTAssertTrue(transport.ledger.violations.isEmpty)
    }

    func testBootstrapPageFaultAndRestartNeverPromotePartialSnapshot() async throws {
        let operations = try day(seed: 1)
        let oldExpiry = try store.leaseExpiry(for: partition)
        var first = try object(bootstrapPage())
        first["nextPageCursor"] = "page-2"
        first["syncCursor"] = NSNull()
        first["plannedVisits"] = []
        first["callSheets"] = []
        first["outlets"] = [["id": "replacement", "name": "Replacement store", "routeId": NSNull()]]
        var second = first
        second["page"] = 2
        second["nextPageCursor"] = NSNull()
        second["syncCursor"] = "new-bootstrap-cursor"
        second["outlets"] = []
        transport.setBootstrap([try bytes(first), try bytes(second)])
        transport.script("/mobile/v1/bootstrap", [.online, .airplane])
        do { _ = try await bootstrap().run(deviceId: partition.deviceId, subject: partition.subject, store: store, previous: partition)
            XCTFail("Incomplete bootstrap cannot promote")
        } catch { XCTAssertEqual(error as? MobileError, .offline) }
        XCTAssertEqual(try store.cursor(for: partition), "cursor-0")
        XCTAssertEqual(try store.outlets(for: partition).map(\.id), ["outlet-1", "outlet-2"])
        XCTAssertEqual(try store.snapshot(for: partition)?.callSheets.count, 2)
        XCTAssertEqual(try store.leaseExpiry(for: partition), oldExpiry)
        XCTAssertEqual(try store.intents(for: partition), operations)
        try restart()
        transport.script("/mobile/v1/bootstrap", [.duplicate, .duplicate])
        let verified = try await bootstrap().run(deviceId: partition.deviceId, subject: partition.subject,
            expectedEmployeeId: "profile-1", store: store, previous: partition)
        XCTAssertEqual(verified, partition)
        XCTAssertEqual(try store.cursor(for: partition), "new-bootstrap-cursor")
        XCTAssertEqual(try store.outlets(for: partition).map(\.id), ["replacement"])
        XCTAssertEqual(try store.snapshot(for: partition)?.callSheets.count, 0)
        XCTAssertEqual(try store.intents(for: partition), operations)
        try assertNotSynced()
    }
}

/// A deterministic, thread-safe transport/server oracle layered on existing StubURLProtocol.
/// Like mobile/push.applyOne, idempotency compares canonical operation bytes by clientRequestId.
/// Duplicate delivery is to the server (not extra results in an invalid push.response envelope).
private final class ChaosTransport: Sendable {
    enum Fault: String, Hashable, Sendable {
        case online, airplane, lostAck, duplicate, midBatch, unauthorized, revoked, rebootstrap, unavailable
    }
    struct Commit: Sendable {
        let bytes: Data
        let ack: ServerAck
        let count: Int
    }
    struct Ledger: Sendable {
        var commits: [String: Commit] = [:]
        var order: [String] = []
        var attempts: [String: [Data]] = [:]
        var violations: [String] = []
        var faults: [Fault] = []
        var partialCommits = 0
        var pauses = 0
        /// MCP call rules mirrored from mobile/push: server visit ID → planned stop ("" when unplanned).
        var visitPlans: [String: String] = [:]
        var closed = Set<String>()
        var outcomes: [String] = []
    }
    private struct State: Sendable {
        var seed: UInt64
        var scripts: [String: [Fault]] = [:]
        var randomPushes = 0
        var pauseNew = false
        var nonce = 0
        var bootstrap: [Data]
        var responded = Set<String>()
        var ledger = Ledger()
        mutating func next() -> UInt64 {
            // SplitMix64, overflow intentional. No Swift randomized Hasher/RNG dependency.
            seed &+= 0x9e3779b97f4a7c15
            var value = seed
            value = (value ^ (value >> 30)) &* 0xbf58476d1ce4e5b9
            value = (value ^ (value >> 27)) &* 0x94d049bb133111eb
            return value ^ (value >> 31)
        }
        mutating func fault(_ path: String) -> Fault {
            if var script = scripts[path], !script.isEmpty {
                let result = script.removeFirst()
                scripts[path] = script
                return result
            }
            if path == "/mobile/v1/push", randomPushes > 0 {
                randomPushes -= 1
                return [.airplane, .lostAck, .duplicate, .midBatch][Int(next() % 4)]
            }
            return .online
        }
    }
    private let state: Mutex<State>
    private let serverTime: Int64
    private let jwt: String
    init(seed: UInt64, now: Date, bootstrap: [Data]) {
        state = Mutex(State(seed: seed, bootstrap: bootstrap))
        serverTime = Int64(now.timeIntervalSince1970 * 1000)
        jwt = StubHTTP.jwt(exp: Date().timeIntervalSince1970 + 900)
    }
    var ledger: Ledger { state.withLock { $0.ledger } }
    func install() { StubURLProtocol.install { [self] in handle($0) } }
    func script(_ path: String, _ faults: [Fault]) { state.withLock { $0.scripts[path] = faults } }
    func randomizePushes(_ count: Int) { state.withLock { $0.randomPushes = count } }
    func setBootstrap(_ pages: [Data]) { state.withLock { $0.bootstrap = pages } }
    func pauseNewPushes() { state.withLock { $0.pauseNew = true } }
    func resume() { state.withLock { $0.pauseNew = false } }

    func handle(_ request: StubURLProtocol.Recorded) -> StubURLProtocol.Outcome {
        state.withLock { state in
            if request.path == "/api/auth/convex/token" { return .reply(.json(200, ["token": jwt])) }
            if request.path == "/api/mutation" {
                state.nonce += 1
                return .reply(.json(200, ["status": "success", "value": [
                    "nonce": String(format: "00000000-0000-4000-8000-%012x", state.nonce),
                    "expiresAt": serverTime + 60_000]]))
            }
            if request.path == "/api/query" {
                return .reply(.json(200, ["status": "success", "value": ["_id": "profile-1", "authSubject": "issuer|seller"]]))
            }
            guard request.path.hasPrefix("/mobile/v1/") else { return .fail(.badURL) }
            let fault = state.fault(request.path)
            state.ledger.faults.append(fault)
            switch fault {
            case .unauthorized: return .reply(.json(401, ["type": "error.response", "contractVersion": 1,
                "serverTime": serverTime, "error": ["code": "unauthorized", "message": "Test proof refused", "retryable": false]]))
            case .revoked: return .reply(.json(403, ["type": "error.response", "contractVersion": 1,
                "serverTime": serverTime, "error": ["code": "device_revoked", "message": "Test revocation", "retryable": false]]))
            case .rebootstrap: return .reply(.json(409, ["type": "error.response", "contractVersion": 1,
                "serverTime": serverTime, "error": ["code": "rebootstrap_required", "message": "Test scope change", "retryable": false]]))
            case .unavailable: return .reply(.init(status: 503))
            default: break
            }
            do {
                let body = try JSONSerialization.jsonObject(with: request.body) as? [String: Any] ?? [:]
                if request.path == "/mobile/v1/push" {
                    guard let operations = body["operations"] as? [[String: Any]], !operations.isEmpty else {
                        throw StoreError.invalidInput
                    }
                    for op in operations {
                        if let id = op["clientRequestId"] as? String {
                            state.ledger.attempts[id, default: []].append(try JSONSerialization.data(withJSONObject: op, options: [.sortedKeys]))
                        }
                    }
                    if fault == .airplane { return .fail(.notConnectedToInternet) } // no server receipt/commit
                    let containsNew = operations.contains { state.ledger.commits[$0["clientRequestId"] as? String ?? ""] == nil }
                    let prefix = fault == .midBatch ? max(1, operations.count / 2) : operations.count
                    var results: [[String: Any]] = []
                    for op in operations.prefix(prefix) {
                        let result = try apply(op, state: &state)
                        results.append(result)
                        if fault == .duplicate {
                            let again = try apply(op, state: &state)
                            if !NSDictionary(dictionary: result).isEqual(to: again) {
                                state.ledger.violations.append("Duplicate delivery changed its acknowledgement")
                            }
                        }
                    }
                    if fault == .midBatch {
                        if prefix < operations.count { state.ledger.partialCommits += 1 }
                        return .fail(.networkConnectionLost)
                    }
                    if fault == .lostAck { return .fail(.networkConnectionLost) } // commits persist, client receives nothing
                    let reply = StubURLProtocol.Reply.json(200, ["type": "push.response", "contractVersion": 1,
                        "serverTime": serverTime, "results": results])
                    if state.pauseNew && containsNew {
                        state.ledger.pauses += 1
                        return .delayed(reply)
                    }
                    for op in operations { if let id = op["clientRequestId"] as? String { state.responded.insert(id) } }
                    return .reply(reply)
                }
                if fault == .airplane { return .fail(.notConnectedToInternet) }
                if request.path == "/mobile/v1/bootstrap" {
                    let index = body["pageCursor"] == nil ? 0 : 1
                    guard state.bootstrap.indices.contains(index) else { throw StoreError.invalidInput }
                    if fault == .lostAck || fault == .midBatch { return .fail(.networkConnectionLost) }
                    return .reply(.init(status: 200, body: state.bootstrap[index]))
                }
                if request.path == "/mobile/v1/pull" {
                    let cursor = body["cursor"] as? String
                    let first = cursor == "cursor-0"
                    let changes: [[String: Any]] = first ? [] : [
                        ["seq": 1, "entity": "visit", "id": "remote-visit", "revision": 1, "op": "upsert", "value": ["status": "completed"]],
                        ["seq": 2, "entity": "visit", "id": "deleted-visit", "revision": 2, "op": "tombstone"]]
                    if fault == .lostAck || fault == .midBatch { return .fail(.networkConnectionLost) }
                    return .reply(.json(200, ["type": "pull.response", "contractVersion": 1, "serverTime": serverTime,
                        "changes": fault == .duplicate ? changes + changes : changes,
                        "nextCursor": first ? "cursor-1" : "cursor-2", "hasMore": first]))
                }
                return .fail(.badURL)
            } catch {
                state.ledger.violations.append("Invalid test request: \(error)")
                return .fail(.badServerResponse)
            }
        }
    }
    private func apply(_ op: [String: Any], state: inout State) throws -> [String: Any] {
        guard let id = op["clientRequestId"] as? String, let kind = op["kind"] as? String,
              let payload = op["payload"] as? [String: Any] else { throw StoreError.invalidInput }
        let bytes = try JSONSerialization.data(withJSONObject: op, options: [.sortedKeys])
        var result: [String: Any] = ["kind": kind, "clientRequestId": id]
        if let previous = state.ledger.commits[id] {
            guard previous.bytes == bytes else {
                result["status"] = "conflict"; result["code"] = "conflict"
                return result
            }
            result["status"] = "accepted"
            result["ack"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(previous.ack))
            return result
        }
        let dependencies = op["dependsOn"] as? [String] ?? []
        if kind != "visit.checkIn" {
            guard let dependency = dependencies.first, let initial = state.ledger.commits[dependency],
                  state.responded.contains(dependency), payload["visitId"] as? String == initial.ack.entityId else {
                state.ledger.violations.append("Dependent operation arrived before check-in ack/visitId: \(id)")
                result["status"] = "rejected"; result["code"] = "dependency_missing"
                return result
            }
        }
        let entityId = kind == "visit.activity" ? "activity-\(id)" :
            (kind == "visit.checkIn" ? "visit-\(id)" : payload["visitId"] as? String ?? "")
        applyCallRules(kind: kind, payload: payload, visit: kind == "visit.checkIn" ? entityId : payload["visitId"] as? String ?? "",
                       ledger: &state.ledger)
        let ack = ServerAck(entityId: entityId, eventIds: ["event-\(id)"], serverTime: serverTime + Int64(state.ledger.order.count))
        state.ledger.commits[id] = Commit(bytes: bytes, ack: ack, count: 1)
        state.ledger.order.append(id)
        result["status"] = "accepted"
        result["ack"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ack))
        return result
    }
    private static let plannedOrder = ["planned-1", "planned-2"]
    /// The phone must never send what mobile/push would refuse: a second open call, a planned stop
    /// out of plan order or twice, a "no sale" close without a reason, or work on a closed call.
    private func applyCallRules(kind: String, payload: [String: Any], visit: String, ledger: inout Ledger) {
        switch kind {
        case "visit.checkIn":
            if ledger.visitPlans.keys.contains(where: { !ledger.closed.contains($0) }) {
                ledger.violations.append("call_open: check-in \(visit) while a call is open")
            }
            let planned = payload["plannedVisitId"] as? String ?? ""
            if !planned.isEmpty {
                if ledger.visitPlans.values.contains(planned) { ledger.violations.append("Second check-in for \(planned)") }
                for earlier in Self.plannedOrder.prefix(while: { $0 != planned })
                where !ledger.visitPlans.contains(where: { $0.value == earlier && ledger.closed.contains($0.key) }) {
                    ledger.violations.append("mcp_order: \(planned) before \(earlier) was closed")
                }
            }
            ledger.visitPlans[visit] = planned
        case "visit.checkOut":
            let outcome = payload["outcome"] as? String ?? ""
            let reason = payload["reasonCode"] as? String ?? ""
            if !(outcome == "completed" || (outcome == "nonproductive" && !reason.isEmpty)) {
                ledger.violations.append("Invalid close \(outcome)/\(reason)")
            }
            if ledger.visitPlans[visit] == nil || !ledger.closed.insert(visit).inserted {
                ledger.violations.append("Close for an unknown or already closed call")
            }
            ledger.outcomes.append("\(ledger.visitPlans[visit] ?? "?")|\(outcome)|\(reason)")
        default:
            if ledger.closed.contains(visit) { ledger.violations.append("Activity after the call closed") }
        }
    }
}
