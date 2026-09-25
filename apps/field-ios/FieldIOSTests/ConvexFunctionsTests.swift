import XCTest
@testable import FieldIOS

@MainActor
final class ConvexFunctionsTests: XCTestCase {
    private var store: InMemoryStore!
    private var clock: TestClock!
    private var auth: AuthClient!
    private var functions: ConvexFunctions!

    override func setUp() async throws {
        try await super.setUp()
        store = InMemoryStore()
        clock = TestClock()
        try store.save(Data("session-xyz".utf8), for: StoreAccount.session)
        let http = StubHTTP.client()
        auth = AuthClient(site: StubHTTP.site, store: store, http: http, now: clock.closure)
        functions = ConvexFunctions(url: StubHTTP.cloud, auth: auth, http: http)
    }

    private func tokenReply(marker: String) -> StubURLProtocol.Outcome {
        .reply(.json(200, ["token": StubHTTP.jwt(exp: clock.now.timeIntervalSince1970 + 900, marker: marker)]))
    }

    func testQueryEncodesEnvelopeAndDecodesValue() async throws {
        let token = StubHTTP.jwt(exp: clock.now.timeIntervalSince1970 + 900, marker: "one")
        StubURLProtocol.install { request -> StubURLProtocol.Outcome in
            if request.path == "/api/auth/convex/token" {
                return .reply(.json(200, ["token": token]))
            }
            return .reply(.json(200, ["status": "success", "value": [
                "deviceId": "d1", "status": "active", "bound": false, "allowedApp": "IOS"], "logLines": []]))
        }
        let result = try await ConvexDeviceRegistry(functions: functions).mine(publicKey: "PUB+/=")
        XCTAssertEqual(result, MineResult(deviceId: "d1", status: "active", bound: false, allowedApp: "IOS"))

        let call = try XCTUnwrap(StubURLProtocol.requests(to: "/api/query").first)
        XCTAssertEqual(call.method, "POST")
        XCTAssertEqual(call.headers["Authorization"], "Bearer \(token)")
        XCTAssertNil(call.headers["Origin"])
        let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: call.body) as? [String: Any])
        XCTAssertEqual(envelope["path"] as? String, "mobile/devices:mine")
        XCTAssertEqual(envelope["format"] as? String, "json")
        XCTAssertEqual(envelope["args"] as? [String: String], ["publicKey": "PUB+/=", "app": "IOS"])
    }

    func testNullValueDecodesToNil() async throws {
        let exp = clock.now.timeIntervalSince1970 + 900
        StubURLProtocol.install { request -> StubURLProtocol.Outcome in
            if request.path == "/api/auth/convex/token" { return .reply(.json(200, ["token": StubHTTP.jwt(exp: exp)])) }
            return .reply(.json(200, ["status": "success", "value": NSNull()]))
        }
        let result = try await ConvexDeviceRegistry(functions: functions).mine(publicKey: "k")
        XCTAssertNil(result)
    }

    func testMutationPathsAndBindArgsEncoding() async throws {
        let exp = clock.now.timeIntervalSince1970 + 900
        StubURLProtocol.install { request -> StubURLProtocol.Outcome in
            switch request.path {
            case "/api/auth/convex/token":
                return .reply(.json(200, ["token": StubHTTP.jwt(exp: exp)]))
            case "/api/mutation":
                let envelope = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any]
                let path = envelope?["path"] as? String
                let value: [String: Any] = path == "mobile/devices:bind"
                    ? ["bindingStatus": "bound"]
                    : ["nonce": "n", "expiresAt": 1]
                return .reply(.json(200, ["status": "success", "value": value]))
            default:
                return .reply(.init(status: 404))
            }
        }
        let registry = ConvexDeviceRegistry(functions: functions)
        let challenge = try await registry.challenge(deviceId: "d1")
        XCTAssertEqual(challenge, ChallengeResult(nonce: "n", expiresAt: 1))
        let bound = try await registry.bind(BindArgs(deviceId: "d1", credentialId: "c", attestation: .init(format: "f", keyId: nil),
                                                     nonce: "n", timestamp: 1_780_000_000_000, proof: "p"))
        XCTAssertEqual(bound.bindingStatus, "bound")

        let calls = StubURLProtocol.requests(to: "/api/mutation")
        XCTAssertEqual(calls.count, 2)
        let bind = try XCTUnwrap(JSONSerialization.jsonObject(with: calls[1].body) as? [String: Any])
        XCTAssertEqual(bind["path"] as? String, "mobile/devices:bind")
        let args = try XCTUnwrap(bind["args"] as? [String: Any])
        XCTAssertEqual((args["timestamp"] as? NSNumber)?.int64Value, 1_780_000_000_000, "timestamp must be an integer")
        XCTAssertEqual(args["attestation"] as? [String: String], ["format": "f"], "absent keyId is omitted, not null")
        XCTAssertEqual(Set(args.keys), ["deviceId", "credentialId", "attestation", "nonce", "timestamp", "proof"])
    }

    func testErrorEnvelopeBecomesRedactedRejection() async {
        let exp = clock.now.timeIntervalSince1970 + 900
        StubURLProtocol.install { request -> StubURLProtocol.Outcome in
            if request.path == "/api/auth/convex/token" { return .reply(.json(200, ["token": StubHTTP.jwt(exp: exp)])) }
            return .reply(.json(560, ["status": "error",
                                      "errorMessage": "[Request ID: 123] Server Error\nUncaught ConvexError: Device unavailable\n    at handler (x.ts:1)"]))
        }
        await XCTAssertThrowsMobileError(try await ConvexDeviceRegistry(functions: functions).challenge(deviceId: "d"),
                                         .rejected("Device unavailable"))
    }

    func testStructuredConvexErrorDataPreferred() throws {
        let data = try JSONSerialization.data(withJSONObject: ["status": "error", "errorMessage": "x", "errorData": "Device scope changed"])
        XCTAssertThrowsError(try ConvexFunctions.decode(data, statusCode: 200) as String?) { error in
            XCTAssertEqual(error as? MobileError, .rejected("Device scope changed"))
        }
    }

    func testMalformedAndServerFailures() throws {
        XCTAssertThrowsError(try ConvexFunctions.decode(Data("nope".utf8), statusCode: 200) as String?) {
            XCTAssertEqual($0 as? MobileError, .invalidResponse)
        }
        XCTAssertThrowsError(try ConvexFunctions.decode(Data("{\"status\":\"weird\"}".utf8), statusCode: 200) as String?) {
            XCTAssertEqual($0 as? MobileError, .invalidResponse)
        }
        XCTAssertThrowsError(try ConvexFunctions.decode(Data(), statusCode: 502) as String?) {
            XCTAssertEqual($0 as? MobileError, .server)
        }
        XCTAssertThrowsError(try ConvexFunctions.decode(Data("{\"status\":\"success\",\"value\":{\"wrong\":1}}".utf8),
                                                         statusCode: 200) as MineResult?) {
            XCTAssertEqual($0 as? MobileError, .invalidResponse)
        }
    }

    func testSingleRetryWithFreshJWTAfter401() async throws {
        let tokens = Counter()
        let calls = Counter()
        let exp = clock.now.timeIntervalSince1970 + 900
        StubURLProtocol.install { request -> StubURLProtocol.Outcome in
            if request.path == "/api/auth/convex/token" {
                return .reply(.json(200, ["token": StubHTTP.jwt(exp: exp, marker: "t\(tokens.next())")]))
            }
            return calls.next() == 1 ? .reply(.json(401, [:])) : .reply(.json(200, ["status": "success", "value": NSNull()]))
        }
        _ = try await ConvexDeviceRegistry(functions: functions).mine(publicKey: "k")
        let queries = StubURLProtocol.requests(to: "/api/query")
        XCTAssertEqual(queries.count, 2)
        XCTAssertEqual(StubURLProtocol.requests(to: "/api/auth/convex/token").count, 2)
        XCTAssertNotEqual(queries[0].headers["Authorization"], queries[1].headers["Authorization"])
        XCTAssertEqual(queries[1].body, queries[0].body, "retry resends identical bytes")
    }

    func testSecond401StopsWithoutLooping() async {
        let exp = clock.now.timeIntervalSince1970 + 900
        StubURLProtocol.install { request -> StubURLProtocol.Outcome in
            if request.path == "/api/auth/convex/token" { return .reply(.json(200, ["token": StubHTTP.jwt(exp: exp)])) }
            return .reply(.json(401, [:]))
        }
        await XCTAssertThrowsMobileError(try await ConvexDeviceRegistry(functions: functions).mine(publicKey: "k"), .unauthorized)
        XCTAssertEqual(StubURLProtocol.requests(to: "/api/query").count, 2)
    }

    func testExpiredJWTRefreshedBeforeCall() async throws {
        let tokens = Counter()
        let clock = self.clock!
        StubURLProtocol.install { request -> StubURLProtocol.Outcome in
            if request.path == "/api/auth/convex/token" {
                return .reply(.json(200, ["token": StubHTTP.jwt(exp: clock.now.timeIntervalSince1970 + 900, marker: "t\(tokens.next())")]))
            }
            return .reply(.json(200, ["status": "success", "value": NSNull()]))
        }
        let registry = ConvexDeviceRegistry(functions: functions)
        _ = try await registry.mine(publicKey: "k")
        _ = try await registry.mine(publicKey: "k")
        XCTAssertEqual(StubURLProtocol.requests(to: "/api/auth/convex/token").count, 1)
        clock.advance(16 * 60)
        _ = try await registry.mine(publicKey: "k")
        XCTAssertEqual(StubURLProtocol.requests(to: "/api/auth/convex/token").count, 2)
    }

    func testOfflineCall() async {
        StubURLProtocol.install { _ in .fail(.networkConnectionLost) }
        await XCTAssertThrowsMobileError(try await ConvexDeviceRegistry(functions: functions).mine(publicKey: "k"), .offline)
    }
}
