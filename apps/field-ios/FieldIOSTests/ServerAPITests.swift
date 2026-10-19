import CryptoKit
import XCTest
@testable import FieldIOS

@MainActor
final class ServerAPITests: XCTestCase {
    private var store: InMemoryStore!
    private var clock: TestClock!
    private var auth: AuthClient!
    private var functions: ServerAPI!
    override func setUp() async throws {
        store = InMemoryStore(); clock = TestClock()
        try store.save(Data("session-xyz".utf8), for: StoreAccount.session)
        let http = StubHTTP.client()
        auth = AuthClient(site: StubHTTP.site, store: store, http: http, now: clock.closure)
        functions = ServerAPI(url: StubHTTP.site, auth: auth, http: http)
    }
    private func install(_ handler: @escaping @Sendable (StubURLProtocol.Recorded) -> StubURLProtocol.Outcome) {
        let clock = clock!
        StubURLProtocol.install { request in
            if request.path == "/api/auth/refresh" {
                return .reply(.json(200, AuthClientTests.credentials(access: "access-\(clock.now.timeIntervalSince1970)", time: clock.now.timeIntervalSince1970 * 1000)))
            }
            return handler(request)
        }
    }
    nonisolated static func me(device: Any = NSNull()) -> [String: Any] {
        ["version": 2, "serverTime": 1_800_000_000_000,
         "profile": ["id": "p1", "subject": "user:p1"], "scope": ["id": "unit-1", "fingerprint": "fp", "epoch": "epoch"], "device": device]
    }
    func testMineUsesMeWithHashedKeyHeadersAndNoURLCredentials() async throws {
        let spki = P256.Signing.PrivateKey().publicKey.derRepresentation
        install { _ in .reply(.json(200, Self.me(device: ["id": "d1", "status": "active", "bound": false, "allowedApp": "field-ios"]))) }
        let result = try await ServerDeviceRegistry(functions: functions).mine(publicKey: spki.base64EncodedString())
        XCTAssertEqual(result?.deviceId, "d1"); XCTAssertEqual(result?.allowedApp, "field-ios")
        let request = try XCTUnwrap(StubURLProtocol.rawRequests.last)
        XCTAssertEqual(request.path, "/api/me"); XCTAssertEqual(request.method, "GET"); XCTAssertTrue(request.body.isEmpty)
        XCTAssertEqual(request.headers["X-App"], "field-ios")
        XCTAssertEqual(request.headers["X-Device-Key-Id"], RequestSigner.bodyDigest(spki))
        XCTAssertNil(request.headers["Origin"])
    }
    func testNullDeviceDecodesToNil() async throws {
        install { _ in .reply(.json(200, Self.me())) }
        let result = try await ServerDeviceRegistry(functions: functions).mine(publicKey: "aw==")
        XCTAssertNil(result)
    }
    func testChallengeUsesV2RouteAndServerTime() async throws {
        install { _ in .reply(.json(200, ["version": 2, "nonce": "n", "serverTime": 1000, "expiresAt": 61_000])) }
        let result = try await ServerDeviceRegistry(functions: functions).challenge(deviceId: "d1")
        XCTAssertEqual(try result.proofTime(), 1000)
        let request = try XCTUnwrap(StubURLProtocol.rawRequests.last)
        XCTAssertEqual(request.path, "/api/devices/challenge")
        XCTAssertEqual(try NativeV2.object(request.body)["version"] as? Int, 2)
    }
    func testBindPreservesExactProofAndAttestation() async throws {
        install { _ in .reply(.json(200, ["version": 2, "bindingStatus": "bound"])) }
        let result = try await ServerDeviceRegistry(functions: functions).bind(.init(deviceId: "d", credentialId: "c", attestation: .init(format: "f", keyId: nil), nonce: "n", timestamp: 123, proof: "signature"))
        XCTAssertEqual(result.bindingStatus, "bound")
        let request = try XCTUnwrap(StubURLProtocol.rawRequests.last)
        XCTAssertEqual(request.path, "/api/devices/bind")
        let body = try NativeV2.object(request.body)
        XCTAssertEqual(body["proof"] as? String, "signature"); XCTAssertEqual(body["timestamp"] as? Int, 123)
        XCTAssertEqual(body["attestation"] as? [String: String], ["format": "f"])
    }
    func testProfileSubjectComesFromAuthenticatedMe() async throws {
        struct Identity: Decodable { let _id: String; let authSubject: String }
        install { _ in .reply(.json(200, Self.me())) }
        let value: Identity? = try await functions.query("domains/profiles:current", [String: String]())
        XCTAssertEqual(value?._id, "p1"); XCTAssertEqual(value?.authSubject, "user:p1")
    }
    func testRateLimitRemainsBackoffSignal() async {
        install { _ in .reply(.json(429, ["version": 2, "error": ["code": "rate_limited", "retryable": true, "action": "retry"]])) }
        await XCTAssertThrowsMobileError(try await ServerDeviceRegistry(functions: functions).challenge(deviceId: "d"), .rateLimited)
    }
    func testErrorNeverDisplaysArbitraryServerText() async {
        install { _ in .reply(.json(403, ["version": 2, "error": ["code": "untrusted-secret", "message": "sensitive body"]])) }
        await XCTAssertThrowsMobileError(try await ServerDeviceRegistry(functions: functions).challenge(deviceId: "d"), .rejected("request_refused"))
    }
    func testWithdrawalMapsToDenialForCacheGrantRevocation() async {
        install { _ in .reply(.json(403, ["version": 2, "error": ["code": "scope_withdrawn", "action": "hold", "retryable": false]])) }
        await XCTAssertThrowsMobileError(try await ServerDeviceRegistry(functions: functions).challenge(deviceId: "d"), .rejected("forbidden"))
    }
    func testSingleRetryRefreshesOpaqueCredentialAfter401() async throws {
        let count = Counter()
        install { _ in count.next() == 1 ? .reply(.json(401, [:])) : .reply(.json(200, Self.me())) }
        _ = try await ServerDeviceRegistry(functions: functions).mine(publicKey: "aw==")
        XCTAssertEqual(StubURLProtocol.rawRequests.filter { $0.path == "/api/me" }.count, 2)
        XCTAssertEqual(StubURLProtocol.rawRequests.filter { $0.path == "/api/auth/refresh" }.count, 2)
    }
    func testSecond401StopsWithoutLooping() async {
        install { _ in .reply(.json(401, [:])) }
        await XCTAssertThrowsMobileError(try await ServerDeviceRegistry(functions: functions).mine(publicKey: "aw=="), .unauthorized)
        XCTAssertEqual(StubURLProtocol.rawRequests.filter { $0.path == "/api/me" }.count, 2)
    }
    func testExpiredAccessRefreshedBeforeCall() async throws {
        install { _ in .reply(.json(200, Self.me())) }
        let registry = ServerDeviceRegistry(functions: functions)
        _ = try await registry.mine(publicKey: "aw=="); _ = try await registry.mine(publicKey: "aw==")
        XCTAssertEqual(StubURLProtocol.rawRequests.filter { $0.path == "/api/auth/refresh" }.count, 1)
        clock.advance(960)
        _ = try await registry.mine(publicKey: "aw==")
        XCTAssertEqual(StubURLProtocol.rawRequests.filter { $0.path == "/api/auth/refresh" }.count, 2)
    }
    func testMalformedAndServerFailuresFailClosed() async {
        for value: [String: Any] in [["status": "success", "value": NSNull()], ["version": 99]] {
            let reply = StubURLProtocol.Reply.json(200, value)
            install { _ in .reply(reply) }
            await XCTAssertThrowsMobileError(try await ServerDeviceRegistry(functions: functions).mine(publicKey: "aw=="), .invalidResponse)
        }
    }
    func testOfflineCall() async {
        StubURLProtocol.install { _ in .fail(.networkConnectionLost) }
        await XCTAssertThrowsMobileError(try await ServerDeviceRegistry(functions: functions).mine(publicKey: "aw=="), .offline)
    }
}
