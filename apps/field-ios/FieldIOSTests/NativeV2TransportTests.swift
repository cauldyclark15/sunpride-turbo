import CryptoKit
import XCTest
@testable import FieldIOS

/// Actual v2 envelopes and routes, WITHOUT the legacy-fixture regression harness.
@MainActor
final class NativeV2TransportTests: XCTestCase {
    #if DEBUG
    func testDebugBackendExercisesRealV2AuthEnrollmentAndBootstrap() async throws {
        StubBackend.configure(scenario: "registers")
        let secrets = KeychainStore(service: "com.sunpride.v2.stubproof.\(UUID().uuidString)")
        let http = HTTPClient(session: URLSession(configuration: HTTPClient.makeConfiguration(protocolClasses: [StubBackend.self])))
        let auth = AuthClient(site: StubHTTP.site, store: secrets, http: http)
        let functions = ServerAPI(url: StubHTTP.site, auth: auth, http: http)
        let registry = ServerDeviceRegistry(functions: functions)
        try await auth.signIn(email: "seller@example.test", password: "correct-horse")
        let key = try auth.signingKey()
        let enrollment = Enrollment(registry: registry, store: secrets)
        await enrollment.start { key }
        await enrollment.check()
        guard case .ready(let deviceId) = enrollment.state else { return XCTFail("Stub enrollment: \(String(describing: enrollment.state))") }
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let store = try EncryptedFieldStore(url: directory.appending(path: "store.sqlite"), secrets: secrets)
        defer { store.close(); try? FileManager.default.removeItem(at: directory); enrollment.signedOut() }
        let bootstrap = BootstrapClient(site: StubHTTP.site, auth: auth, registry: registry, http: http, key: key)
        let partition = try await bootstrap.run(deviceId: deviceId, subject: "stub-issuer|seller", expectedEmployeeId: "profile-1", store: store)
        XCTAssertEqual(try store.snapshot(for: partition)?.visits.count, 3)
        XCTAssertEqual(partition.scope, "bun-v2:stub-scope-1")
        let model = AppModel(auth: auth, registry: registry, store: secrets, site: StubHTTP.site,
            functions: functions, http: http, localStore: store) { key }
        await model.signIn(email: "seller@example.test", password: "correct-horse")
        await model.syncNow()
        XCTAssertTrue(model.visits.contains { $0.outlet == "Stub Outlet" }, "AppModel bootstrap: \(model.syncMessage ?? "no error")")

        // Live walk counterexample: an ended call sat "Waiting" on an online phone until the app was reopened.
        // With upload-soon on (the live app's setting), queued work is sent while the app stays open.
        model.uploadSoonAfterQueue = .milliseconds(50)
        let first = try XCTUnwrap(model.visits.filter(\.planned).min { ($0.sequence ?? 0) < ($1.sequence ?? 0) })
        try model.queueCheckIn(first, unplannedReason: nil, location: nil)
        let active = partition
        XCTAssertEqual(try store.pendingOutbox(for: active).count, 1, "queued locally first")
        for _ in 0..<100 where try store.pendingOutbox(for: active).count > 0 { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertEqual(try store.pendingOutbox(for: active).count, 0, "sent without reopening the app: \(model.syncMessage ?? "-")")
        XCTAssertNotNil(try store.ack(for: try XCTUnwrap(store.intents(for: active).first).requestId, in: active))
    }
    #endif
    private let device = "10000000-0000-4000-8000-000000000001"
    private let id = "20000000-0000-4000-8000-000000000001"
    private func result(status: String = "applied", retryable: Bool = false) throws -> Data {
        try NativeV2.bytes(["version": 2, "serverTime": 1000, "results": [["clientOpId": id,
            "opType": "visit.checkIn", "status": status, "code": NSNull(), "retryable": retryable,
            "ack": ["entityId": "visit", "eventIds": ["event"], "movementId": NSNull(), "serverTime": 900]]]])
    }
    private func snapshot(scope: String = "unit", projection: String = "field.bundle", mode: String = "snapshot", expires: Int = 2000) throws -> Data {
        try NativeV2.bytes(["version": 2, "serverTime": 1000, "snapshotId": "snapshot", "nextPageCursor": NSNull(),
            "nextCursor": "cursor", "hasMore": false, "bundles": [["scopeId": scope, "scopeFingerprint": "fingerprint",
                "projection": projection, "params": ["dayFrom": "2026-10-20"], "mode": mode, "complete": true,
                "authorization": ["grantId": "grant", "epoch": "epoch", "expiresAt": expires],
                "offlineLease": ["expiresAt": expires], "data": [:], "changes": []]]])
    }
    func testPullHasExplicitNullsAndClosedV2ScopeRequest() throws {
        let body = try NativeV2.object(NativeV2.pull(deviceId: device, scopeId: "unit", projection: "field.bundle", params: ["dayFrom": "2026-10-20"]))
        XCTAssertEqual(body["version"] as? Int, 2); XCTAssertEqual(body["app"] as? String, "field-ios")
        XCTAssertTrue(body["since"] is NSNull); XCTAssertTrue(body["pageCursor"] is NSNull)
        XCTAssertNil(body["contractVersion"]); XCTAssertNil(body["type"])
        let scope = try XCTUnwrap((body["scopes"] as? [[String: Any]])?.first)
        XCTAssertEqual(scope["scopeId"] as? String, "unit"); XCTAssertEqual(scope["projection"] as? String, "field.bundle")
    }
    func testDeltaAndSnapshotContinuationCannotInventFreshCursor() throws {
        let delta = try NativeV2.object(NativeV2.pull(deviceId: device, scopeId: "unit", projection: "field.bundle", params: [:], since: "durable-cursor", limit: 50))
        XCTAssertEqual(delta["since"] as? String, "durable-cursor"); XCTAssertTrue(delta["pageCursor"] is NSNull)
        let page = try NativeV2.object(NativeV2.pull(deviceId: device, scopeId: "unit", projection: "field.bundle", params: [:], page: "page-2"))
        XCTAssertEqual(page["pageCursor"] as? String, "page-2"); XCTAssertTrue(page["since"] is NSNull)
    }
    func testOperationRetainsUUIDTimestampPayloadAndDependencies() throws {
        let input: [String: Any] = ["kind": "visit.activity", "clientRequestId": id, "dependsOn": [device],
            "payload": ["visitId": "accepted-visit", "deviceTime": 1234, "activity": ["kind": "note", "text": "Cebu · café"]]]
        let before = try NativeV2.bytes(input)
        let op = try NativeV2.operation(input)
        XCTAssertEqual(op["clientOpId"] as? String, id); XCTAssertEqual(op["clientTime"] as? Int64, 1234)
        XCTAssertEqual(op["dependsOn"] as? [String], [device])
        XCTAssertEqual(try NativeV2.bytes(input), before, "Never rewrite the persisted local intent")
        XCTAssertEqual(try NativeV2.bytes(op["payload"]!), try NativeV2.bytes(input["payload"]!))
    }
    func testOperationRefusesMissingDurableTimeOrMalformedUUID() {
        for op: [String: Any] in [["kind": "visit.activity", "clientRequestId": id, "payload": [:]],
            ["kind": "visit.activity", "clientRequestId": "bad", "payload": ["deviceTime": 1234]]] {
            XCTAssertThrowsError(try NativeV2.operation(op))
        }
    }
    func testAppliedAndDuplicateUseOriginalDurableAck() throws {
        for status in ["applied", "duplicate"] {
            let normalized = try JSONDecoder().decode(BootstrapV1.PushResultEnvelope.self, from: NativeV2.legacyResults(result(status: status)))
            XCTAssertEqual(normalized.results[0].status.rawValue, "accepted")
            XCTAssertEqual(normalized.results[0].ack?.serverTime, 900)
            XCTAssertEqual(normalized.results[0].clientRequestId, id)
        }
    }
    func testRetryableOperationRefusalDoesNotBecomeTerminalReview() {
        XCTAssertThrowsError(try NativeV2.legacyResults(result(status: "rejected", retryable: true))) {
            XCTAssertEqual($0 as? VisitSyncClient.Failure, .retryable)
        }
    }
    func testUnknownOutcomeStaysUnknownNeverAccepted() throws {
        let result = try JSONDecoder().decode(BootstrapV1.PushResultEnvelope.self, from: NativeV2.legacyResults(result(status: "new-status")))
        XCTAssertFalse(result.results[0].isAccepted)
        XCTAssertEqual(result.results[0].status.rawValue, "new-status")
    }
    func testBundleRejectsForeignScopeWrongProjectionOrWrongMode() throws {
        XCTAssertThrowsError(try NativeV2.bundle(snapshot(scope: "foreign"), scopeId: "unit", projection: "field.bundle", mode: "snapshot"))
        XCTAssertThrowsError(try NativeV2.bundle(snapshot(projection: "team.summary"), scopeId: "unit", projection: "field.bundle", mode: "snapshot"))
        XCTAssertThrowsError(try NativeV2.bundle(snapshot(mode: "delta"), scopeId: "unit", projection: "field.bundle", mode: "snapshot"))
    }
    func testExpiredGrantDoesNotRenewCacheAuthority() throws {
        XCTAssertThrowsError(try NativeV2.bundle(snapshot(expires: 999), scopeId: "unit", projection: "field.bundle", mode: "snapshot"))
    }
    func testVersionAndMalformedEnvelopeFailClosed() throws {
        XCTAssertThrowsError(try NativeV2.validate(NativeV2.bytes(["version": 1])))
        XCTAssertThrowsError(try NativeV2.validate(Data("not JSON".utf8)))
        XCTAssertThrowsError(try NativeV2.legacyResults(NativeV2.bytes(["version": 2, "results": []])))
    }
    func testExplicitWithdrawalsAndUnknownErrorsAreSafeCodesOnly() throws {
        let failure = NativeFailure.decode(try NativeV2.bytes(["version": 2, "error": ["code": "scope_withdrawn", "action": "hold", "retryable": false]]), status: 403)
        XCTAssertTrue(failure.withdraws)
        let unknown = NativeFailure.decode(try NativeV2.bytes(["error": ["code": "secret detail", "message": "private body"]]), status: 403)
        XCTAssertEqual(unknown.code, "request_refused"); XCTAssertFalse(String(describing: unknown).contains("private body"))
    }
    func testV2SignatureBindsExactBodyAndRouteAndUsesServerClock() throws {
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        let body = try NativeV2.pull(deviceId: device, scopeId: "unit", projection: "field.bundle", params: [:])
        let nonce = UUID().uuidString.lowercased()
        let challenge = ChallengeResult(nonce: nonce, expiresAt: 61000, serverTime: 1000)
        let proof = try RequestSigner(key: key).sign(path: "/api/sync/pull", body: body, deviceId: device, nonce: nonce, timestamp: challenge.proofTime())
        XCTAssertEqual(proof.headers["x-device-id"], device); XCTAssertEqual(proof.headers["x-device-timestamp"], "1000")
        XCTAssertTrue(DeviceKeys.verify(signatureBase64: proof.headers["x-device-signature"]!, message: Data(proof.canonical.utf8), spkiBase64: key.publicKeyBase64))
        XCTAssertFalse(DeviceKeys.verify(signatureBase64: proof.headers["x-device-signature"]!, message: Data(proof.canonical.replacingOccurrences(of: "/api/sync/pull", with: "/api/sync/push").utf8), spkiBase64: key.publicKeyBase64))
        XCTAssertThrowsError(try RequestSigner(key: key).sign(path: "/mobile/v1/pull", body: body, deviceId: device, nonce: nonce, timestamp: 1000))
    }
}
