import CoreLocation
import CryptoKit
import XCTest
@testable import FieldIOS

@MainActor
final class VisitSyncTests: XCTestCase {
    private var directory: URL!
    private var secrets: KeychainStore!
    private var store: EncryptedFieldStore!
    private var auth: AuthClient!
    private var http: HTTPClient!
    private var key: SoftwareDeviceKey!
    private var partition: StorePartition!
    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "json")))
    }
    private func object(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    override func setUp() async throws {
        try await super.setUp()
        directory = FileManager.default.temporaryDirectory.appending(path: "visit-sync-\(UUID().uuidString)")
        secrets = KeychainStore(service: "com.sunpride.visit.tests.\(UUID().uuidString)")
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        try secrets.save(Data("session".utf8), for: StoreAccount.session)
        http = StubHTTP.client()
        auth = AuthClient(site: StubHTTP.site, store: secrets, http: http)
        key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        partition = try StorePartition(subject: "issuer|seller", deviceId: "device-1", scope: "scope-1")
        let snapshot = StoreSnapshot(employee: .init(id: "employee-1", role: "sales", orgUnitId: "unit-1"),
            visits: [.init(id: "planned-1", outletId: "outlet-1", serviceDate: BootstrapClient.manilaDay(Date()),
                           planId: "plan-1", planVersion: 1, intents: ["merchandise"])],
            outlets: [.init(id: "outlet-1", name: "Test outlet", routeId: nil)], customers: [], route: nil, tasks: [])
        let expiry = Int64(Date().timeIntervalSince1970 * 1000) + 600_000
        try store.saveSnapshot(snapshot, cursor: "cursor-0", leaseExpiresAt: expiry, cacheExpiresAt: expiry, for: partition)
    }
    override func tearDown() async throws {
        store.close()
        try? secrets.delete("db")
        try? secrets.delete(StoreAccount.session)
        try? FileManager.default.removeItem(at: directory)
        try await super.tearDown()
    }
    private func client() -> VisitSyncClient {
        VisitSyncClient(site: StubHTTP.site, auth: auth,
            registry: ConvexDeviceRegistry(functions: ConvexFunctions(url: StubHTTP.cloud, auth: auth, http: http)),
            http: http, key: key)
    }
    private func checkIn() throws -> VisitIntent {
        let op = try XCTUnwrap((object(fixture("push-request"))["operations"] as? [[String: Any]])?.first)
        let id = try XCTUnwrap(UUID(uuidString: op["clientRequestId"] as? String ?? ""))
        let intent = VisitIntent(requestId: id, kind: "visit.checkIn",
            operationJSON: try JSONSerialization.data(withJSONObject: op, options: [.sortedKeys]))
        try store.enqueue(intent, for: partition, now: Date())
        return intent
    }
    private func install(_ response: @escaping @Sendable (StubURLProtocol.Recorded) -> StubURLProtocol.Outcome) {
        let jwt = StubHTTP.jwt(exp: Date().timeIntervalSince1970 + 900)
        StubURLProtocol.install { request in
            switch request.path {
            case "/api/auth/convex/token": return .reply(.json(200, ["token": jwt]))
            case "/api/mutation": return .reply(.json(200, ["status": "success", "value": [
                "nonce": UUID().uuidString.lowercased(), "expiresAt": Date().timeIntervalSince1970 * 1000 + 60_000]]))
            default: return response(request)
            }
        }
    }
    nonisolated private static func accepted(_ request: StubURLProtocol.Recorded) -> StubURLProtocol.Outcome {
        guard let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              let ops = body["operations"] as? [[String: Any]] else { return .fail(.badServerResponse) }
        return .reply(.json(200, ["type": "push.response", "contractVersion": 1,
            "serverTime": 1_800_000_000_000, "results": ops.map { op in
                ["kind": op["kind"]!, "clientRequestId": op["clientRequestId"]!, "status": "accepted",
                 "ack": ["entityId": "server-visit-1", "eventIds": ["event-1"], "serverTime": 1_800_000_000_000]] as [String: Any]
            }]))
    }
    func testSharedPushAndPullFixturesDecode() throws {
        for name in ["push-request", "push-planned-request"] {
            let operations = try XCTUnwrap(object(fixture(name))["operations"] as? [[String: Any]])
            XCTAssertGreaterThanOrEqual(operations.count, 2)
        }
        let response = try JSONDecoder().decode(BootstrapV1.PushResultEnvelope.self, from: fixture("push-response"))
        XCTAssertTrue(response.results[0].isAccepted)
        XCTAssertEqual(try JSONDecoder().decode(BootstrapV1.PushResultEnvelope.self,
            from: fixture("push-conflict-response")).results[0].status.rawValue, "conflict")
        XCTAssertEqual(try object(fixture("pull-request"))["limit"] as? Int, 10)
        let changes = try XCTUnwrap(object(fixture("pull-response"))["changes"] as? [[String: Any]])
        XCTAssertEqual(changes.count, 2)
    }
    func testOfflineEnqueuePushThenAckAndFreshProof() async throws {
        let intent = try checkIn()
        XCTAssertEqual(try store.pendingOutbox(for: partition).count, 1)
        install { request in Self.accepted(request) }
        try await client().push(store: store, partition: partition)
        XCTAssertTrue(try store.pendingOutbox(for: partition).isEmpty)
        XCTAssertEqual(try store.ack(for: intent.requestId, in: partition)?.entityId, "server-visit-1")
        let request = try XCTUnwrap(StubURLProtocol.requests(to: "/mobile/v1/push").first)
        let headers = Dictionary(uniqueKeysWithValues: request.headers.map { ($0.key.lowercased(), $0.value) })
        let digest = RequestSigner.bodyDigest(request.body)
        XCTAssertEqual(headers["x-mobile-body-digest"], digest)
        let proof = try XCTUnwrap(headers["x-mobile-signature"])
        let message = "POST|/mobile/v1/push|\(digest)|\(headers["x-mobile-nonce"]!)|\(headers["x-mobile-timestamp"]!)"
        XCTAssertTrue(DeviceKeys.verify(signatureBase64: proof, message: Data(message.utf8), spkiBase64: key.publicKeyBase64))
    }
    func testUncertainAcceptanceReplaysSameOperationBytesAndKey() async throws {
        let intent = try checkIn()
        let attempts = Counter()
        install { request in
            let index = attempts.next()
            return index == 1 ? .fail(.networkConnectionLost) : Self.accepted(request)
        }
        try await client().push(store: store, partition: partition)
        let requests = StubURLProtocol.requests(to: "/mobile/v1/push")
        XCTAssertEqual(requests.count, 2)
        let ops = try requests.map { request -> Data in
            let body = try object(request.body)
            return try JSONSerialization.data(withJSONObject: (body["operations"] as! [Any])[0], options: [.sortedKeys])
        }
        XCTAssertEqual(ops[0], ops[1])
        XCTAssertEqual(ops[0], intent.operationJSON)
        XCTAssertNotEqual(requests[0].headers["x-mobile-nonce"], requests[1].headers["x-mobile-nonce"])
        XCTAssertEqual(try store.ack(for: intent.requestId, in: partition)?.eventIds, ["event-1"])
    }
    func testCrashBeforeLocalAckReopensAndReplaysFrozenBytes() async throws {
        let original = try checkIn()
        install { request in request.path == "/mobile/v1/push" ? .fail(.networkConnectionLost) : .fail(.badURL) }
        do { try await client().push(store: store, partition: partition); XCTFail("uncertain transport") }
        catch { XCTAssertEqual(error as? VisitSyncClient.Failure, .retryable) }
        let before = try XCTUnwrap(StubURLProtocol.requests(to: "/mobile/v1/push").first)
        store.close()
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        XCTAssertEqual(try store.pendingOutbox(for: partition).first?.intent.operationJSON, original.operationJSON)
        install { request in Self.accepted(request) } // stored server ack for that same key
        try await client().push(store: store, partition: partition)
        let after = try XCTUnwrap(StubURLProtocol.requests(to: "/mobile/v1/push").first)
        XCTAssertEqual(try object(before.body)["operations"] as? [[String: Any]] != nil, true)
        let firstOp = try JSONSerialization.data(withJSONObject: XCTUnwrap(object(before.body)["operations"] as? [Any]).first!, options: [.sortedKeys])
        let secondOp = try JSONSerialization.data(withJSONObject: XCTUnwrap(object(after.body)["operations"] as? [Any]).first!, options: [.sortedKeys])
        XCTAssertEqual(firstOp, secondOp)
        XCTAssertEqual(try store.ack(for: original.requestId, in: partition)?.entityId, "server-visit-1")
    }
    func testConflictUnsupportedDependencyAndUnknownFreeze() async throws {
        let initial = try checkIn()
        var altered = try object(initial.operationJSON)
        var changedPayload = try XCTUnwrap(altered["payload"] as? [String: Any])
        changedPayload["intents"] = ["audit"]
        altered["payload"] = changedPayload
        let changed = VisitIntent(requestId: initial.requestId, kind: initial.kind,
            operationJSON: try JSONSerialization.data(withJSONObject: altered))
        XCTAssertThrowsError(try store.enqueue(changed, for: partition, now: Date()),
            "same UUID with altered payload cannot replace the locally frozen operation")
        let responses = ["conflict", "unsupported_operation", "dependency_missing", "future_pending"]
        for (index, status) in responses.enumerated() {
            let current: VisitIntent
            if index == 0 { current = initial }
            else {
                let id = UUID()
                let op: [String: Any] = ["kind": "visit.checkIn", "clientRequestId": id.uuidString.lowercased(),
                    "payload": ["clientVisitId": UUID().uuidString.lowercased(), "plannedVisitId": NSNull(),
                        "outletId": "outlet-1", "serviceDate": "2026-09-26", "deviceTime": 1_800_000_000_000,
                        "location": NSNull(), "intents": [], "unplannedReason": "Diagnostic"]]
                current = VisitIntent(requestId: id, kind: "visit.checkIn", operationJSON: try JSONSerialization.data(withJSONObject: op))
                try store.enqueue(current, for: partition, now: Date())
            }
            let code = status == "future_pending" ? "future" : status
            let response: [String: Any] = ["type": "push.response", "contractVersion": 1,
                "serverTime": 1_800_000_000_000, "results": [["kind": current.kind,
                    "clientRequestId": current.requestId.uuidString.lowercased(),
                    "status": status == "conflict" || status == "future_pending" ? status : "rejected", "code": code]]]
            let encoded = try JSONSerialization.data(withJSONObject: response)
            install { _ in .reply(.init(status: 200, body: encoded)) }
            try await client().push(store: store, partition: partition)
            XCTAssertTrue(try store.reviewOutbox(for: partition).contains(where: { $0.intent.requestId == current.requestId }))
        }
        XCTAssertTrue(try store.pendingOutbox(for: partition).isEmpty)
    }
    func testDeferredNoteCheckoutMaterializeAfterCheckInAck() async throws {
        let initial = try checkIn()
        let note = try DiagnosticOperation.note("Offline note", checkIn: initial.requestId, visitId: nil)
        let checkout = try DiagnosticOperation.checkOut(outcome: "completed", reason: nil, checkIn: initial.requestId, visitId: nil)
        try store.enqueueDeferred(note, for: partition, now: Date())
        try store.enqueueDeferred(checkout, for: partition, now: Date())
        install { request in Self.accepted(request) }
        try await client().push(store: store, partition: partition)
        let requests = StubURLProtocol.requests(to: "/mobile/v1/push")
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(((try object(requests[0].body))["operations"] as? [Any])?.count, 1)
        let operations = try XCTUnwrap(object(requests[1].body)["operations"] as? [[String: Any]])
        XCTAssertEqual(operations.count, 2)
        XCTAssertEqual((operations[0]["payload"] as? [String: Any])?["visitId"] as? String, "server-visit-1")
        XCTAssertEqual((operations[1]["dependsOn"] as? [String])?.first, initial.requestId.uuidString.lowercased())
        XCTAssertEqual(try store.ack(for: checkout.requestId, in: partition)?.entityId, "server-visit-1")
    }
    func testRejectedCheckInFreezesDependents() async throws {
        let initial = try checkIn()
        let checkout = try DiagnosticOperation.checkOut(outcome: "completed", reason: nil, checkIn: initial.requestId, visitId: nil)
        try store.enqueueDeferred(checkout, for: partition, now: Date())
        install { request in
            let op = ((try? JSONSerialization.jsonObject(with: request.body) as? [String: Any])?["operations"] as? [[String: Any]])?.first
            return .reply(.json(200, ["type": "push.response", "contractVersion": 1, "serverTime": 1_800_000_000_000,
                "results": [["kind": "visit.checkIn", "clientRequestId": op?["clientRequestId"] ?? "",
                    "status": "rejected", "code": "invalid_plan"]]]))
        }
        try await client().push(store: store, partition: partition)
        XCTAssertEqual(try store.reviewOutbox(for: partition).count, 2)
        XCTAssertEqual(try store.reviewOutbox(for: partition).last?.code, "dependency_missing")
        XCTAssertEqual(StubURLProtocol.requests(to: "/mobile/v1/push").count, 1)
    }
    func testBatchCapAndOrder() async throws {
        var ids: [String] = []
        for _ in 0..<25 {
            let id = UUID(); ids.append(id.uuidString.lowercased())
            let op: [String: Any] = ["kind": "visit.checkIn", "clientRequestId": id.uuidString.lowercased(),
                "payload": ["clientVisitId": UUID().uuidString.lowercased()]]
            try store.enqueue(.init(requestId: id, kind: "visit.checkIn", operationJSON: JSONSerialization.data(withJSONObject: op)), for: partition, now: Date())
        }
        install { request in Self.accepted(request) }
        try await client().push(store: store, partition: partition)
        let batches = try StubURLProtocol.requests(to: "/mobile/v1/push").map { request in
            try XCTUnwrap(object(request.body)["operations"] as? [[String: Any]])
        }
        XCTAssertEqual(batches.map(\.count), [20, 5])
        XCTAssertEqual(batches.flatMap { $0.compactMap { $0["clientRequestId"] as? String } }, ids)
    }
    func testPullEmptyPageAdvancesThenTombstoneAndPreservesPending() async throws {
        let initial = try checkIn()
        let calls = Counter()
        install { request in
            if request.path != "/mobile/v1/pull" { return .fail(.badURL) }
            let index = calls.next()
            return .reply(.json(200, ["type": "pull.response", "contractVersion": 1,
                "serverTime": 1_800_000_000_000,
                "changes": index == 1 ? [] : [["seq": 2, "entity": "visit", "id": "other-visit", "revision": 2, "op": "tombstone"]],
                "nextCursor": "cursor-\(index)", "hasMore": index == 1]))
        }
        try await client().pull(store: store, partition: partition)
        let cursors = try StubURLProtocol.requests(to: "/mobile/v1/pull").map { request in
            try XCTUnwrap(object(request.body)["cursor"] as? String)
        }
        XCTAssertEqual(cursors, ["cursor-0", "cursor-1"])
        XCTAssertEqual(try store.cursor(for: partition), "cursor-2")
        XCTAssertNil(try store.deltaValue(entity: "visit", id: "other-visit", for: partition))
        XCTAssertEqual(try store.pendingOutbox(for: partition).first?.intent.requestId, initial.requestId)
    }
    func testPull409RequiresRebootstrapWithoutDeletingOutbox() async throws {
        let initial = try checkIn()
        let response = try fixture("error-rebootstrap-required")
        install { _ in .reply(.init(status: 409, body: response)) }
        do { try await client().pull(store: store, partition: partition); XCTFail("expected 409") }
        catch { XCTAssertEqual(error as? VisitSyncClient.Failure, .rebootstrap) }
        try store.holdForReview(partition)
        XCTAssertTrue(try store.pendingOutbox(for: partition).isEmpty)
        XCTAssertEqual(try store.heldOutbox(for: partition).first?.intent.requestId, initial.requestId)
        XCTAssertNil(try store.cursor(for: partition))
    }
    func testDiagnosticFactoryEnqueuesOffline() throws {
        let location = try VisitLocation(CLLocation(latitude: 0, longitude: 0))
        let op = try DiagnosticOperation.checkIn(plannedId: "planned-1", outletId: "outlet-1",
            day: BootstrapClient.manilaDay(Date()), intents: ["merchandise"], reason: nil, location: location)
        try store.enqueue(op, for: partition, now: Date())
        XCTAssertEqual(try store.pendingOutbox(for: partition).first?.intent.requestId, op.requestId)
    }
    func testDeltaDoesNotOverwritePendingVisitAndTombstoneIsTransactional() throws {
        let initial = try checkIn()
        try store.recordAck(ServerAck(entityId: "visit-1", eventIds: ["event-1"], serverTime: 1_800_000_000_000),
                            for: initial.requestId, in: partition)
        let note = try DiagnosticOperation.note("Still pending", checkIn: initial.requestId, visitId: "visit-1")
        try store.enqueue(note, for: partition, now: Date())
        let changes = try JSONDecoder().decode(DeltaFixture.self, from: fixture("pull-response")).changes
        try store.applyDelta(changes, nextCursor: "cursor-1", for: partition)
        XCTAssertNil(try store.deltaValue(entity: "visit", id: "visit-1", for: partition))
        XCTAssertNil(try store.deltaValue(entity: "visit", id: "visit-2", for: partition))
        XCTAssertEqual(try store.cursor(for: partition), "cursor-1")
        try store.recordAck(ServerAck(entityId: "activity-1", eventIds: ["event-2"], serverTime: 1_800_000_000_001),
                            for: note.requestId, in: partition)
        try store.applyDelta(changes, nextCursor: "cursor-2", for: partition)
        XCTAssertNotNil(try store.deltaValue(entity: "visit", id: "visit-1", for: partition))
        XCTAssertNil(try store.deltaValue(entity: "visit", id: "visit-2", for: partition))
    }
    private struct DeltaFixture: Decodable { let changes: [DeltaChange] }
    func testScopeChangeLeavesOldPartitionHeld() throws {
        let initial = try checkIn()
        try store.holdForReview(partition)
        let newScope = try StorePartition(subject: partition.subject, deviceId: partition.deviceId, scope: "new-scope")
        let snapshot = try XCTUnwrap(store.snapshot(for: partition))
        let expiry = Int64(Date().timeIntervalSince1970 * 1000) + 600_000
        try store.saveSnapshot(snapshot, cursor: "new-cursor", leaseExpiresAt: expiry, cacheExpiresAt: expiry, for: newScope)
        try store.releaseHeld(newScope)
        XCTAssertTrue(try store.isHeld(partition))
        XCTAssertEqual(try store.heldOutbox(for: partition).first?.intent.requestId, initial.requestId)
        XCTAssertTrue(try store.pendingOutbox(for: newScope).isEmpty)
    }
}
