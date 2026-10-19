import XCTest
@testable import FieldIOS

@MainActor
final class AuthClientTests: XCTestCase {
    private var store: InMemoryStore!
    private var clock: TestClock!
    override func setUp() async throws { store = InMemoryStore(); clock = TestClock() }
    private func makeAuth() -> AuthClient { AuthClient(site: StubHTTP.site, store: store, http: StubHTTP.client(), now: clock.closure) }
    nonisolated static func credentials(session: Any = "session-abc", access: Any = "opaque-access", time: Double = 1_800_000_000_000) -> [String: Any] {
        ["version": 2, "serverTime": time, "sessionToken": session, "sessionExpiresAt": time + 604_800_000,
         "accessToken": access, "accessExpiresAt": time + 900_000]
    }
    private func happy(status: Int = 200) {
        let time = clock.now.timeIntervalSince1970 * 1000
        StubURLProtocol.install { request in
            if request.path == "/api/auth/sign-out" { return .reply(.json(200, ["version": 2, "revoked": true])) }
            return .reply(.json(status, Self.credentials(time: time)))
        }
    }
    func testSignInStoresSessionAndOpaqueAccessWithoutExchange() async throws {
        happy(); let auth = makeAuth()
        try await auth.signIn(email: "  seller@example.com ", password: "pw-123")
        XCTAssertEqual(try store.read(StoreAccount.session), Data("session-abc".utf8))
        XCTAssertEqual(auth.cachedTokenExpiry, clock.now.addingTimeInterval(900))
        let token = try await auth.bearerToken()
        XCTAssertEqual(token.value, "opaque-access")
        XCTAssertEqual(StubURLProtocol.rawRequests.count, 1)
    }
    func testNativeSignInHasVersionAppAndDeviceKeyButNoCookiesOrOrigin() async throws {
        happy(); try await makeAuth().signIn(email: " a@b.c ", password: "test-pass")
        let request = try XCTUnwrap(StubURLProtocol.rawRequests.first)
        XCTAssertEqual(request.path, "/api/auth/sign-in"); XCTAssertEqual(request.method, "POST")
        XCTAssertNil(request.headers["Origin"]); XCTAssertNil(request.headers["Cookie"])
        let value = try NativeV2.object(request.body)
        XCTAssertEqual(value["version"] as? Int, 2); XCTAssertEqual(value["app"] as? String, "field-ios")
        XCTAssertEqual(value["email"] as? String, "a@b.c")
        let key = try XCTUnwrap(value["deviceKey"] as? [String: String])
        XCTAssertEqual(key["keyId"], RequestSigner.bodyDigest(try XCTUnwrap(Data(base64Encoded: key["publicKeySpki"]!))))
        XCTAssertFalse(store.accounts.contains("password"))
    }
    func testWrongPasswordIsClearAndStoresNothing() async {
        happy(status: 401); let auth = makeAuth()
        await XCTAssertThrowsMobileError(try await auth.signIn(email: "a@b.c", password: "bad"), .invalidCredentials)
        XCTAssertFalse(auth.hasSession)
    }
    func testServerErrorsAndForbiddenAndRateLimit() async {
        for (status, error) in [(500, MobileError.server), (503, .server), (403, .signInRefused), (429, .rateLimited)] {
            happy(status: status)
            await XCTAssertThrowsMobileError(try await makeAuth().signIn(email: "a@b.c", password: "bad"), error)
        }
    }
    func testCookiesAndLegacyTokenHeaderCannotOverrideV2Body() async throws {
        StubURLProtocol.install { _ in .reply(.json(200, Self.credentials(), headers: ["Set-Cookie": "bad", "set-auth-token": "not-used"])) }
        try await makeAuth().signIn(email: "a@b.c", password: "x")
        XCTAssertEqual(try store.read(StoreAccount.session), Data("session-abc".utf8))
    }
    func testLegacySuccessWithoutV2FailsClosed() async {
        StubURLProtocol.install { _ in .reply(.json(200, ["token": "old-session"])) }
        await XCTAssertThrowsMobileError(try await makeAuth().signIn(email: "a@b.c", password: "x"), .invalidResponse)
        XCTAssertFalse(makeAuth().hasSession)
    }
    func testMissingSessionFailsClosed() async {
        var value = Self.credentials(); value.removeValue(forKey: "sessionToken")
        let reply = StubURLProtocol.Reply.json(200, value)
        StubURLProtocol.install { _ in .reply(reply) }
        await XCTAssertThrowsMobileError(try await makeAuth().signIn(email: "a@b.c", password: "x"), .invalidResponse)
    }
    func testMalformedSessionTokensAreRejectedWithoutLeaking() async {
        for token: Any in ["", "has space", "has\nnewline", String(repeating: "x", count: 4097), 123, NSNull(), ["nested": "token"]] {
            let reply = StubURLProtocol.Reply.json(200, Self.credentials(session: token))
            StubURLProtocol.install { _ in .reply(reply) }
            await XCTAssertThrowsMobileError(try await makeAuth().signIn(email: "a@b.c", password: "x"), .invalidResponse)
            XCTAssertFalse(makeAuth().hasSession)
        }
    }
    func testMalformedAccessIsRejectedBeforePersistingSession() async {
        for token: Any in ["", "bad token", 123, NSNull()] {
            let reply = StubURLProtocol.Reply.json(200, Self.credentials(access: token))
            StubURLProtocol.install { _ in .reply(reply) }
            await XCTAssertThrowsMobileError(try await makeAuth().signIn(email: "a@b.c", password: "x"), .invalidResponse)
            XCTAssertFalse(makeAuth().hasSession)
        }
    }
    func testHTTPConfigurationDisablesCookieAndCacheStorage() {
        let c = HTTPClient.makeConfiguration()
        XCTAssertNil(c.httpCookieStorage); XCTAssertFalse(c.httpShouldSetCookies)
        XCTAssertEqual(c.httpCookieAcceptPolicy, .never); XCTAssertNil(c.urlCache)
    }
    func testOfflineSignIn() async {
        for code in [URLError.Code.notConnectedToInternet, .timedOut] {
            StubURLProtocol.install { _ in .fail(code) }
            await XCTAssertThrowsMobileError(try await makeAuth().signIn(email: "a@b.c", password: "x"), .offline)
        }
    }
    func testAccessIsCachedThenRefreshedBeforeExpiry() async throws {
        happy(); let auth = makeAuth(); try await auth.signIn(email: "a@b.c", password: "x")
        let first = try await auth.bearerToken(); let again = try await auth.bearerToken()
        XCTAssertEqual(first.value, again.value)
        clock.advance(841)
        let time = clock.now.timeIntervalSince1970 * 1000
        StubURLProtocol.install { _ in .reply(.json(200, Self.credentials(access: "second-opaque", time: time))) }
        let next = try await auth.bearerToken(); XCTAssertNotEqual(first.value, next.value)
        let request = try XCTUnwrap(StubURLProtocol.rawRequests.first)
        XCTAssertEqual(request.path, "/api/auth/refresh"); XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.headers["Authorization"], "Bearer session-abc")
        XCTAssertEqual(try NativeV2.object(request.body)["app"] as? String, "field-ios")
    }
    func testConcurrentRefreshCoalesces() async throws {
        try store.save(Data("session-abc".utf8), for: StoreAccount.session)
        StubURLProtocol.install { _ in .delayed(.json(200, Self.credentials())) }
        let auth = makeAuth()
        async let a = auth.bearerToken(); async let b = auth.bearerToken()
        let values = try await [a, b]
        XCTAssertEqual(values[0].value, values[1].value)
        XCTAssertEqual(StubURLProtocol.rawRequests.count, 1)
    }
    func testRejectedSessionOnRefreshWipesKeychain() async throws {
        happy(); let auth = makeAuth(); try await auth.signIn(email: "a@b.c", password: "x")
        StubURLProtocol.install { _ in .reply(.json(401, ["version": 2, "error": ["code": "session_invalid"]])) }
        await XCTAssertThrowsMobileError(try await auth.bearerToken(forceRefresh: true), .sessionExpired)
        XCTAssertFalse(auth.hasSession); XCTAssertNil(auth.cachedTokenExpiry)
    }
    func testMalformedOrExpiredAccessIsRejectedAndServerFailureRetainsSession() async throws {
        try store.save(Data("session-abc".utf8), for: StoreAccount.session); let auth = makeAuth()
        for expired in [false, true] {
            var value = Self.credentials()
            if expired { value["accessExpiresAt"] = value["serverTime"] } else { value.removeValue(forKey: "accessExpiresAt") }
            let reply = StubURLProtocol.Reply.json(200, value)
            StubURLProtocol.install { _ in .reply(reply) }
            await XCTAssertThrowsMobileError(try await auth.bearerToken(), .invalidResponse)
        }
        StubURLProtocol.install { _ in .reply(.json(502, [:])) }
        await XCTAssertThrowsMobileError(try await auth.bearerToken(), .server)
        XCTAssertTrue(auth.hasSession)
    }
    func testNoSessionMeansNotSignedIn() async {
        StubURLProtocol.install { _ in .reply(.json(200, [:])) }
        await XCTAssertThrowsMobileError(try await makeAuth().bearerToken(), .notSignedIn)
        XCTAssertTrue(StubURLProtocol.rawRequests.isEmpty)
    }
    func testSignOutWipesKeychainAndMemoryAndCallsServer() async throws {
        happy(); let auth = makeAuth(); try await auth.signIn(email: "a@b.c", password: "x")
        let acknowledged = await auth.signOut(); XCTAssertTrue(acknowledged)
        XCTAssertFalse(auth.hasSession); XCTAssertNil(auth.cachedTokenExpiry)
        let request = try XCTUnwrap(StubURLProtocol.rawRequests.last)
        XCTAssertEqual(request.headers["Authorization"], "Bearer session-abc")
        XCTAssertEqual(try NativeV2.object(request.body)["version"] as? Int, 2)
    }
    func testOfflineSignOutStillWipesLocally() async throws {
        happy(); let auth = makeAuth(); try await auth.signIn(email: "a@b.c", password: "x")
        StubURLProtocol.install { _ in .fail(.notConnectedToInternet) }
        let acknowledged = await auth.signOut(); XCTAssertFalse(acknowledged); XCTAssertFalse(auth.hasSession)
    }
    func testExpiryUsesServerTTLDespitePhoneClockSkew() async throws {
        StubURLProtocol.install { _ in .reply(.json(200, Self.credentials(time: 1_000_000))) }
        let auth = makeAuth(); try await auth.signIn(email: "a@b.c", password: "x")
        XCTAssertEqual(auth.cachedTokenExpiry, clock.now.addingTimeInterval(900))
    }
    func testFrozenJWTExpiryDecodingRemainsForLegacyFixtures() {
        XCTAssertEqual(AuthClient.expiry(ofJWT: StubHTTP.jwt(exp: 1_900_000_000)), Date(timeIntervalSince1970: 1_900_000_000))
        XCTAssertNil(AuthClient.expiry(ofJWT: "a.b")); XCTAssertNil(AuthClient.expiry(ofJWT: "a.!!!.c"))
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func next() -> Int { lock.withLock { value += 1; return value } }
}

@MainActor
func XCTAssertThrowsMobileError<T>(_ expression: @autoclosure () async throws -> T, _ expected: MobileError,
                                   file: StaticString = #filePath, line: UInt = #line) async {
    do {
        _ = try await expression()
        XCTFail("Expected \(expected)", file: file, line: line)
    } catch let error as MobileError {
        XCTAssertEqual(error, expected, file: file, line: line)
    } catch {
        XCTFail("Unexpected \(error)", file: file, line: line)
    }
}
