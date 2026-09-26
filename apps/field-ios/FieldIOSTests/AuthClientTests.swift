import XCTest
@testable import FieldIOS

@MainActor
final class AuthClientTests: XCTestCase {
    private var store: InMemoryStore!
    private var clock: TestClock!

    override func setUp() async throws {
        try await super.setUp()
        store = InMemoryStore()
        clock = TestClock()
    }

    private func makeAuth() -> AuthClient {
        AuthClient(site: StubHTTP.site, store: store, http: StubHTTP.client(), now: clock.closure)
    }

    /// Header-path backend: sign-in sets `set-auth-token`; token exchange returns a 15-minute JWT.
    private func installHappyBackend(signInStatus: Int = 200, tokenMarker: @escaping @Sendable () -> String = { "a" }) {
        let exp = clock.now.timeIntervalSince1970 + 900
        StubURLProtocol.install { request -> StubURLProtocol.Outcome in
            switch request.path {
            case "/api/auth/sign-in/email":
                return .reply(.json(signInStatus, ["user": ["id": "u"]],
                                    headers: signInStatus == 200 ? ["set-auth-token": "session-abc"] : [:]))
            case "/api/auth/convex/token":
                return .reply(.json(200, ["token": StubHTTP.jwt(exp: exp, marker: tokenMarker())]))
            case "/api/auth/sign-out":
                return .reply(.json(200, ["success": true]))
            default:
                return .reply(.init(status: 404))
            }
        }
    }

    func testSignInStoresSessionFromHeaderAndExchangesJWT() async throws {
        installHappyBackend()
        let auth = makeAuth()
        try await auth.signIn(email: "  seller@example.com ", password: "pw-123")

        XCTAssertEqual(try store.read(StoreAccount.session), Data("session-abc".utf8))
        XCTAssertTrue(auth.hasSession)
        XCTAssertEqual(auth.cachedTokenExpiry, clock.now.addingTimeInterval(900))

        let signIn = try XCTUnwrap(StubURLProtocol.requests(to: "/api/auth/sign-in/email").first)
        XCTAssertEqual(signIn.method, "POST")
        XCTAssertNil(signIn.headers["Origin"], "native sign-in must not send any Origin header")
        XCTAssertEqual(signIn.headers["Content-Type"], "application/json")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: signIn.body) as? [String: String])
        XCTAssertEqual(body, ["email": "seller@example.com", "password": "pw-123"])

        let exchange = try XCTUnwrap(StubURLProtocol.requests(to: "/api/auth/convex/token").first)
        XCTAssertEqual(exchange.method, "GET")
        XCTAssertEqual(exchange.headers["Authorization"], "Bearer session-abc")
        XCTAssertNil(exchange.headers["Origin"])
        // The password is never persisted anywhere.
        XCTAssertEqual(store.accounts, [StoreAccount.session])
    }

    func testWrongPasswordIsClearAndStoresNothing() async {
        installHappyBackend(signInStatus: 401)
        let auth = makeAuth()
        await XCTAssertThrowsMobileError(try await auth.signIn(email: "a@b.c", password: "bad"), .invalidCredentials)
        XCTAssertFalse(auth.hasSession)
        XCTAssertTrue(StubURLProtocol.requests(to: "/api/auth/convex/token").isEmpty)
    }

    func testServerErrorsAndForbiddenAndRateLimit() async {
        for (status, expected) in [(500, MobileError.server), (503, .server), (403, .signInRefused), (429, .rateLimited)] {
            installHappyBackend(signInStatus: status)
            let auth = makeAuth()
            await XCTAssertThrowsMobileError(try await auth.signIn(email: "a@b.c", password: "x"), expected)
            XCTAssertFalse(auth.hasSession)
        }
    }

    func testBodyTokenSignInStoresSessionAndExchangesJWTWithoutCookies() async throws {
        let exp = clock.now.timeIntervalSince1970 + 900
        StubURLProtocol.install { request in
            switch request.path {
            case "/api/auth/sign-in/email":
                return .reply(.json(200, ["redirect": false, "token": "body-session-abc", "user": ["id": "u"]],
                                    headers: ["Set-Cookie": "session=unwanted; HttpOnly; Secure"]))
            case "/api/auth/convex/token":
                return .reply(.json(200, ["token": StubHTTP.jwt(exp: exp)]))
            default: return .reply(.init(status: 404))
            }
        }
        let auth = makeAuth()
        try await auth.signIn(email: "seller@example.com", password: "pw-123")
        XCTAssertEqual(try store.read(StoreAccount.session), Data("body-session-abc".utf8))
        XCTAssertEqual(store.accounts, [StoreAccount.session])
        XCTAssertEqual(auth.cachedTokenExpiry, clock.now.addingTimeInterval(900))
        let signIn = try XCTUnwrap(StubURLProtocol.requests(to: "/api/auth/sign-in/email").first)
        XCTAssertNil(signIn.headers["Origin"])
        let exchange = try XCTUnwrap(StubURLProtocol.requests(to: "/api/auth/convex/token").first)
        XCTAssertEqual(exchange.headers["Authorization"], "Bearer body-session-abc")
        XCTAssertNil(exchange.headers["Cookie"])
    }

    func testHeaderWinsWhenBothTokensArePresent() async throws {
        let exp = clock.now.timeIntervalSince1970 + 900
        StubURLProtocol.install { request in
            switch request.path {
            case "/api/auth/sign-in/email":
                return .reply(.json(200, ["token": "body-session"], headers: ["set-auth-token": "header-session"]))
            case "/api/auth/convex/token":
                return .reply(.json(200, ["token": StubHTTP.jwt(exp: exp)]))
            default: return .reply(.init(status: 404))
            }
        }
        try await makeAuth().signIn(email: "a@b.c", password: "x")
        XCTAssertEqual(try store.read(StoreAccount.session), Data("header-session".utf8))
        XCTAssertEqual(StubURLProtocol.requests(to: "/api/auth/convex/token").first?.headers["Authorization"],
                       "Bearer header-session")
    }

    func testSuccessWithoutHeaderOrBodyTokenFails() async {
        StubURLProtocol.install { _ in .reply(.json(200, ["redirect": false, "user": ["id": "u"]])) }
        await XCTAssertThrowsMobileError(try await makeAuth().signIn(email: "a@b.c", password: "x"), .invalidResponse)
        XCTAssertFalse(makeAuth().hasSession)
        XCTAssertTrue(StubURLProtocol.requests(to: "/api/auth/convex/token").isEmpty)
    }

    func testMalformedBodyTokensAreRejectedWithoutLeaking() async {
        let malformed: [Any] = ["", "has space", "has\nnewline", String(repeating: "x", count: 4097),
                                123, NSNull(), ["nested": "token"]]
        for value in malformed {
            let reply = StubURLProtocol.Reply.json(200, ["token": value])
            StubURLProtocol.install { _ in .reply(reply) }
            let auth = makeAuth()
            do {
                try await auth.signIn(email: "a@b.c", password: "x")
                XCTFail("Malformed token accepted")
            } catch let error as MobileError {
                XCTAssertEqual(error, .invalidResponse)
                XCTAssertFalse(error.description.contains("has space"))
                XCTAssertFalse(String(reflecting: error).contains("has space"))
            } catch {
                XCTFail("Unexpected error type")
            }
            XCTAssertFalse(auth.hasSession)
            XCTAssertTrue(StubURLProtocol.requests(to: "/api/auth/convex/token").isEmpty)
        }
    }

    func testInvalidPresentHeaderDoesNotFallBackToBody() async {
        StubURLProtocol.install { _ in
            .reply(.json(200, ["token": "good-body"], headers: ["set-auth-token": "bad header"]))
        }
        await XCTAssertThrowsMobileError(try await makeAuth().signIn(email: "a@b.c", password: "x"), .invalidResponse)
        XCTAssertNil(try? store.read(StoreAccount.session))
    }

    func testHTTPConfigurationDisablesCookieAndCacheStorage() {
        let configuration = HTTPClient.makeConfiguration()
        XCTAssertNil(configuration.httpCookieStorage)
        XCTAssertFalse(configuration.httpShouldSetCookies)
        XCTAssertEqual(configuration.httpCookieAcceptPolicy, .never)
        XCTAssertNil(configuration.urlCache)
    }

    func testOfflineSignIn() async {
        StubURLProtocol.install { _ in .fail(.notConnectedToInternet) }
        let auth = makeAuth()
        await XCTAssertThrowsMobileError(try await auth.signIn(email: "a@b.c", password: "x"), .offline)
        StubURLProtocol.install { _ in .fail(.timedOut) }
        await XCTAssertThrowsMobileError(try await auth.signIn(email: "a@b.c", password: "x"), .offline)
        XCTAssertFalse(auth.hasSession)
    }

    func testJWTIsCachedThenRefreshedBeforeExpiry() async throws {
        let counter = Counter()
        installHappyBackend(tokenMarker: { "t\(counter.next())" })
        let auth = makeAuth()
        try await auth.signIn(email: "a@b.c", password: "x")
        let first = try await auth.convexToken()
        let again = try await auth.convexToken()
        XCTAssertEqual(first.value, again.value)
        XCTAssertEqual(StubURLProtocol.requests(to: "/api/auth/convex/token").count, 1)

        clock.advance(900 - AuthClient.refreshMargin + 1) // inside the refresh margin
        installHappyBackend(tokenMarker: { "t\(counter.next())" })
        let refreshed = try await auth.convexToken()
        XCTAssertNotEqual(refreshed.value, first.value)
        XCTAssertEqual(StubURLProtocol.requests(to: "/api/auth/convex/token").count, 1)
    }

    func testRejectedSessionOnExchangeWipesKeychain() async throws {
        installHappyBackend()
        let auth = makeAuth()
        try await auth.signIn(email: "a@b.c", password: "x")
        StubURLProtocol.install { _ in .reply(.json(401, ["code": "UNAUTHORIZED"])) }
        await XCTAssertThrowsMobileError(try await auth.convexToken(forceRefresh: true), .sessionExpired)
        XCTAssertFalse(auth.hasSession)
        XCTAssertNil(auth.cachedTokenExpiry)
    }

    func testMalformedOrExpiredJWTIsRejected() async throws {
        try store.save(Data("session".utf8), for: StoreAccount.session)
        let auth = makeAuth()
        StubURLProtocol.install { _ in .reply(.json(200, ["token": "not-a-jwt"])) }
        await XCTAssertThrowsMobileError(try await auth.convexToken(), .invalidResponse)
        let past = clock.now.timeIntervalSince1970 - 1
        StubURLProtocol.install { _ in .reply(.json(200, ["token": StubHTTP.jwt(exp: past)])) }
        await XCTAssertThrowsMobileError(try await auth.convexToken(), .invalidResponse)
        StubURLProtocol.install { _ in .reply(.json(502, [:])) }
        await XCTAssertThrowsMobileError(try await auth.convexToken(), .server)
        XCTAssertTrue(auth.hasSession, "transient failures keep the session")
    }

    func testNoSessionMeansNotSignedIn() async {
        StubURLProtocol.install { _ in .reply(.json(200, [:])) }
        await XCTAssertThrowsMobileError(try await makeAuth().convexToken(), .notSignedIn)
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testSignOutWipesKeychainAndMemoryAndCallsServer() async throws {
        installHappyBackend()
        let auth = makeAuth()
        try await auth.signIn(email: "a@b.c", password: "x")
        let acknowledged = await auth.signOut()
        XCTAssertTrue(acknowledged)
        XCTAssertFalse(auth.hasSession)
        XCTAssertNil(auth.cachedTokenExpiry)
        XCTAssertTrue(store.accounts.isEmpty)
        let signOut = try XCTUnwrap(StubURLProtocol.requests(to: "/api/auth/sign-out").first)
        XCTAssertEqual(signOut.method, "POST")
        XCTAssertEqual(signOut.headers["Authorization"], "Bearer session-abc")
        XCTAssertEqual(signOut.body, Data("{}".utf8))
    }

    func testOfflineSignOutStillWipesLocally() async throws {
        installHappyBackend()
        let auth = makeAuth()
        try await auth.signIn(email: "a@b.c", password: "x")
        StubURLProtocol.install { _ in .fail(.notConnectedToInternet) }
        let acknowledged = await auth.signOut()
        XCTAssertFalse(acknowledged)
        XCTAssertFalse(auth.hasSession)
        await XCTAssertThrowsMobileError(try await auth.convexToken(), .notSignedIn)
    }

    func testJWTExpiryDecoding() {
        XCTAssertEqual(AuthClient.expiry(ofJWT: StubHTTP.jwt(exp: 1_900_000_000)), Date(timeIntervalSince1970: 1_900_000_000))
        XCTAssertNil(AuthClient.expiry(ofJWT: "a.b"))
        XCTAssertNil(AuthClient.expiry(ofJWT: "a.!!!.c"))
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
