import XCTest
@testable import OfficeIOS

/// Fixtures are real responses captured from a lane API (see Fixtures/README.md); tokens are redacted.
enum Fixture {
    static func data(_ name: String) throws -> Data {
        let bundle = Bundle(for: BundleToken.self)
        let url = try XCTUnwrap(bundle.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")
            ?? bundle.url(forResource: name, withExtension: "json"), "missing fixture \(name)")
        return try Data(contentsOf: url)
    }
    final class BundleToken {}
}

@MainActor
final class FormatTests: XCTestCase {
    func testPesosFromCentavos() {
        XCTAssertEqual(Format.peso(292_111_056), "₱2,921,111")
        XCTAssertEqual(Format.peso(105_352_292, cents: true), "₱1,053,522.92")
        XCTAssertEqual(Format.peso(-5_000), "\u{2212}₱50")
        XCTAssertEqual(Format.peso(0), "₱0")
        XCTAssertEqual(Format.peso(nil), "—")
        XCTAssertEqual(Format.pesoCompact(292_111_056), "₱2.9M")
        XCTAssertEqual(Format.pesoCompact(85_000_000), "₱850K")
        XCTAssertEqual(Format.pesoCompact(90_000), "₱900")
    }

    func testPercentDeltaAndCounts() {
        XCTAssertEqual(Format.pct(83.8), "83.8%")
        XCTAssertEqual(Format.pct(nil), "—")
        XCTAssertEqual(Format.delta(-21.4), "\u{2212}21.4%")
        XCTAssertEqual(Format.delta(12), "+12.0%")
        XCTAssertNil(Format.delta(nil))
        XCTAssertEqual(Format.count(1418), "1,418")
        XCTAssertEqual(Format.count(70.0508), "70.1")
        XCTAssertEqual(Format.kpi(2, unit: "count"), "2")
        XCTAssertEqual(Format.kpi(100, unit: "pct"), "100.0%")
    }

    func testManilaDatesNotDeviceTime() {
        // 2026-11-07 17:30 UTC is already Sunday 8 Nov 01:30 in Manila.
        let ms = Date(timeIntervalSince1970: 1_794_072_600).timeIntervalSince1970 * 1000
        XCTAssertEqual(Format.day(Format.date(ms: ms)), Format.day(iso: "2026-11-08"))
        XCTAssertEqual(Format.manilaToday(Format.date(ms: ms)), "2026-11-08")
        XCTAssertEqual(Format.time(ms: ms).replacingOccurrences(of: "\u{202F}", with: " "), "1:30 AM")
        XCTAssertTrue(Format.day(iso: "2026-11-08").contains("8"))
        XCTAssertTrue(Format.day(iso: "2026-11-08").contains("Nov"))
    }

    func testAgesInPlainWords() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let ms = { (seconds: Double) in (1_000_000 - seconds) * 1000 }
        XCTAssertEqual(Format.age(since: ms(10), now: now), "just now")
        XCTAssertEqual(Format.age(since: ms(300), now: now), "5 min")
        XCTAssertEqual(Format.age(since: ms(3 * 3600), now: now), "3 h")
        XCTAssertEqual(Format.age(since: ms(3 * 86400), now: now), "3 days")
        XCTAssertEqual(Format.ago(ms(300), now: now), "5 min ago")
        XCTAssertEqual(Format.ago(ms(1), now: now), "just now")
    }

    func testStatusWordsHaveNoCodes() {
        XCTAssertEqual(Format.words("on_route"), "On the road")
        XCTAssertEqual(Format.words("no_plan"), "No plan today")
        XCTAssertEqual(Format.words("review_needed"), "Needs a decision")
        XCTAssertEqual(Format.words("partially_received"), "Partly received")
        XCTAssertEqual(Format.words("some_new_state"), "Some new state")
        XCTAssertEqual(Tone.of("behind"), .watch)
        XCTAssertEqual(Tone.of("high"), .bad)
        XCTAssertEqual(Tone.of("ok"), .good)
    }

    func testServerOriginRules() {
        XCTAssertNotNil(AppEnvironment.parse("https://sunpride.cauldnclark.com"))
        XCTAssertNotNil(AppEnvironment.parse("http://127.0.0.1:4620"))
        XCTAssertNil(AppEnvironment.parse("http://sunpride.cauldnclark.com"))
        XCTAssertNil(AppEnvironment.parse("https://user:pw@sunpride.cauldnclark.com"))
        XCTAssertNil(AppEnvironment.parse("https://sunpride.cauldnclark.com/api"))
        XCTAssertNil(AppEnvironment.parse(""))
    }
}

@MainActor
final class DecodingTests: XCTestCase {
    func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try APIClient.decode(T.self, Fixture.data(name))
    }

    func testMeCapabilities() throws {
        let manager = try decode(Me.self, "me")
        XCTAssertEqual(manager.profile?.role, "manager")
        XCTAssertTrue(manager.capabilities.contains("report.read"))
        XCTAssertTrue(manager.capabilities.contains("inventory.count.approve"))
        let viewer = try decode(Me.self, "me-viewer")
        XCTAssertTrue(viewer.capabilities.contains("report.read"))
        XCTAssertFalse(viewer.capabilities.contains("inventory.count.approve"))
    }

    func testTodayAndReports() throws {
        let today = try decode(TodayResponse.self, "today")
        XCTAssertEqual(today.kpis.count, 8)
        XCTAssertEqual(today.kpis.first?.unit, "php")
        XCTAssertFalse(today.exceptions.isEmpty)
        XCTAssertEqual(today.field.people.count, 12)
        XCTAssertFalse(today.trend.isEmpty)
        XCTAssertFalse(try decode(SalesResponse.self, "sales").rows.isEmpty)
        XCTAssertFalse(try decode(VansResponse.self, "vans").rows.isEmpty)
        let money = try decode(MoneyResponse.self, "money")
        XCTAssertGreaterThan(money.aging.current, 0)
        XCTAssertFalse(try decode(CoverageResponse.self, "coverage").rows.isEmpty)
    }

    func testDecideInbox() throws {
        let inbox = try decode(DecideInbox.self, "decide-inbox")
        XCTAssertEqual(inbox.total, inbox.items.count)
        XCTAssertEqual(inbox.openCount, inbox.items.filter(\.canDecide).count)
        let item = try XCTUnwrap(inbox.items.first)
        XCTAssertEqual(item.kind, "count_review")
        XCTAssertEqual(inbox.kinds["count_review"], "Count review")
        XCTAssertFalse(item.makerChecker.isEmpty)
    }

    func testStores() throws {
        let stores = try decode(StoresResponse.self, "stores")
        XCTAssertEqual(stores.rows.count, 50)
        XCTAssertNotNil(stores.next)
        XCTAssertEqual(stores.kpis.first?.key, "universe")
        let store = try decode(StoreResponse.self, "store")
        XCTAssertEqual(store.store.id, stores.rows.first?.storeId)
        XCTAssertFalse(store.orders.isEmpty)
        let pins = try decode(StorePins.self, "store-pins")
        XCTAssertEqual(pins.items.count, 100)
        XCTAssertTrue(pins.items.contains { $0.outletId == store.store.id })
        _ = try decode(CensusQueue.self, "census-queue")
    }

    func testStock() throws {
        let product = try decode(Valuation.self, "valuation-product")
        XCTAssertFalse(product.rows.isEmpty)
        XCTAssertNotNil(product.totals.costValueCentavos)
        let one = try decode(Valuation.self, "valuation-one-place")
        XCTAssertTrue(one.rows.allSatisfy { $0.locationName == "Sample Cebu depot" })
        XCTAssertFalse(try decode([InventoryLocation].self, "locations").isEmpty)
        _ = try decode(TransferList.self, "transfers")
        let counts = try decode(CountsMine.self, "counts-mine")
        XCTAssertFalse(counts.toReview.isEmpty)
    }

    func testStorePOSAndIssues() throws {
        XCTAssertFalse(try decode(StorePOSWorkspace.self, "storepos-workspace").registers.isEmpty)
        _ = try decode(TillDays.self, "storepos-days")
        _ = try decode(ZReadings.self, "z-readings")
        _ = try decode(ReceiptsList.self, "receipts")
        let board = try decode(IssuesBoard.self, "issues-board")
        XCTAssertNotNil(board.summary)
    }

    func testFlexNumberReadsBigintStrings() throws {
        struct W: Decodable { let a: FlexNumber; let b: FlexNumber }
        let w = try JSONDecoder().decode(W.self, from: Data(#"{"a":"5000","b":12.5}"#.utf8))
        XCTAssertEqual(w.a.value, 5000)
        XCTAssertEqual(w.b.value, 12.5)
    }

    func testServerWordsReachThePerson() throws {
        let refused = APIClient.failure(status: 422, data: try Fixture.data("decide-act-refused"))
        XCTAssertEqual(refused, .refused("Say why you are rejecting this, in a few words"))
        XCTAssertEqual(APIClient.failure(status: 401, data: try Fixture.data("signin-wrong-password")), .sessionExpired)
        XCTAssertEqual(APIClient.failure(status: 503, data: Data()), .server)
        XCTAssertEqual(APIClient.failure(status: 403, data: Data()), .notAllowed)
    }
}

@MainActor
final class DecideRulesTests: XCTestCase {
    func item(chargeTo: Bool = false) throws -> DecideItem {
        let inbox = try APIClient.decode(DecideInbox.self, Fixture.data("decide-inbox"))
        let base = try XCTUnwrap(inbox.items.first)
        guard chargeTo else { return base }
        let json = try XCTUnwrap(String(data: Fixture.data("decide-inbox"), encoding: .utf8))
            .replacingOccurrences(of: #""needs":{}"#, with: #""needs":{"chargeTo":true}"#)
        return try XCTUnwrap(APIClient.decode(DecideInbox.self, Data(json.utf8)).items.first)
    }

    func testRejectNeedsAReason() throws {
        let i = try item()
        XCTAssertEqual(DecideRules.problems(item: i, verdict: "reject", reason: " ok ", chargeTo: ""),
                       ["Say why you are rejecting this, in a few words."])
        XCTAssertTrue(DecideRules.problems(item: i, verdict: "reject", reason: "Recount the top shelf", chargeTo: "").isEmpty)
        XCTAssertTrue(DecideRules.problems(item: i, verdict: "approve", reason: "", chargeTo: "").isEmpty)
    }

    func testDifferencesNeedSomeoneToCarryThem() throws {
        let i = try item(chargeTo: true)
        XCTAssertEqual(DecideRules.problems(item: i, verdict: "approve", reason: "", chargeTo: "").count, 1)
        let body = DecideRules.body(item: i, verdict: "approve", reason: " fine ", chargeTo: "carrier", key: "k1")
        XCTAssertEqual(body["chargeTo"] as? String, "carrier")
        XCTAssertEqual(body["reason"] as? String, "fine")
        XCTAssertEqual(body["idempotencyKey"] as? String, "k1")
        XCTAssertNil(DecideRules.body(item: i, verdict: "reject", reason: "no", chargeTo: "carrier", key: "k")["chargeTo"])
    }

    func testLabelsInTheWordsOfTheKind() {
        XCTAssertEqual(DecideRules.labels(kind: "count_review").approve, "Approve count")
        XCTAssertEqual(DecideRules.labels(kind: "transfer_variance").reject, "Send back for a recount")
        XCTAssertEqual(DecideRules.labels(kind: "cash_variance", forced: true).approve, "Accept the close")
        XCTAssertEqual(DecideRules.labels(kind: "anything").approve, "Approve")
    }
}

/// URLProtocol stub: no network in unit tests.
final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, Data))?
    nonisolated(unsafe) static var requests: [URLRequest] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var r = request
        if r.httpBody == nil, let stream = r.httpBodyStream {
            stream.open(); var data = Data(); var buf = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let n = stream.read(&buf, maxLength: buf.count); if n <= 0 { break }; data.append(buf, count: n) }
            stream.close(); r.httpBody = data
        }
        Self.requests.append(r)
        let (status, data) = Self.handler?(r) ?? (500, Data())
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: r.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
final class AuthTests: XCTestCase {
    let origin = URL(string: "https://sunpride.example")!
    var store: InMemoryStore!
    var http: HTTPTransport!

    override func setUp() async throws {
        store = InMemoryStore()
        http = HTTPTransport(session: URLSession(configuration: HTTPTransport.configuration(protocolClasses: [StubProtocol.self])))
        StubProtocol.requests = []
    }

    func body(_ r: URLRequest) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: r.httpBody ?? Data()) as? [String: Any]) ?? [:]
    }

    func testSignInStoresOnlyTheSessionAndAsksAsTheOfficeApp() async throws {
        let signin = try Fixture.data("signin")
        StubProtocol.handler = { _ in (200, signin) }
        let auth = AuthClient(origin: origin, store: store, http: http)
        try await auth.signIn(email: " manager@sunpride.test ", password: "pw-12345678")
        let sent = try XCTUnwrap(StubProtocol.requests.first)
        XCTAssertEqual(sent.url?.path(), "/api/auth/sign-in")
        XCTAssertNil(sent.value(forHTTPHeaderField: "Origin"))
        XCTAssertEqual(body(sent)["app"] as? String, "office-ios")
        XCTAssertEqual(body(sent)["version"] as? Int, 2)
        XCTAssertEqual(body(sent)["email"] as? String, "manager@sunpride.test")
        XCTAssertNil(body(sent)["deviceKey"], "the office app never sends a device key")
        XCTAssertEqual(String(data: try XCTUnwrap(store.read(StoreAccount.session)), encoding: .utf8)?.hasPrefix("sps_"), true)
        XCTAssertTrue(auth.hasSession)
        XCTAssertNotNil(auth.cachedAccessExpiry)
        // The access token is served from memory without another request.
        let token = try await auth.bearer()
        XCTAssertTrue(token.hasPrefix("spa_"))
        XCTAssertEqual(StubProtocol.requests.count, 1)
    }

    func testWrongPasswordIsPlainWords() async throws {
        let wrong = try Fixture.data("signin-wrong-password")
        StubProtocol.handler = { _ in (401, wrong) }
        let auth = AuthClient(origin: origin, store: store, http: http)
        do { try await auth.signIn(email: "a@b.co", password: "x"); XCTFail("should refuse") } catch let e as OfficeError {
            XCTAssertEqual(e, .invalidCredentials)
            XCTAssertEqual(e.localizedDescription, "That email or password is not right.")
        }
        XCTAssertFalse(auth.hasSession)
    }

    func testRefreshUsesTheSessionBearerAndSharesOneFlight() async throws {
        let signin = try Fixture.data("signin")
        StubProtocol.handler = { _ in (200, signin) }
        try store.save(Data("sps_saved-session-token".utf8), for: StoreAccount.session)
        let auth = AuthClient(origin: origin, store: store, http: http)
        async let a = auth.bearer()
        async let b = auth.bearer()
        let (ta, tb) = try await (a, b)
        XCTAssertEqual(ta, tb)
        XCTAssertEqual(StubProtocol.requests.count, 1)
        let r = try XCTUnwrap(StubProtocol.requests.first)
        XCTAssertEqual(r.url?.path(), "/api/auth/refresh")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer sps_saved-session-token")
        XCTAssertEqual(body(r)["app"] as? String, "office-ios")
    }

    func testRefusedSessionSignsOutLocally() async throws {
        StubProtocol.handler = { _ in (401, Data(#"{"error":{"code":"session_invalid"}}"#.utf8)) }
        try store.save(Data("sps_old".utf8), for: StoreAccount.session)
        let auth = AuthClient(origin: origin, store: store, http: http)
        do { _ = try await auth.bearer(); XCTFail("should end the session") } catch let e as OfficeError {
            XCTAssertEqual(e, .sessionExpired)
        }
        XCTAssertNil(try store.read(StoreAccount.session))
    }

    func testAPIRetriesOnceAfter401WithAFreshToken() async throws {
        let signin = try Fixture.data("signin")
        let inbox = try Fixture.data("decide-inbox")
        var calls = 0
        StubProtocol.handler = { r in
            if r.url?.path() == "/api/auth/refresh" { return (200, signin) }
            calls += 1
            return calls == 1 ? (401, Data()) : (200, inbox)
        }
        try store.save(Data("sps_saved".utf8), for: StoreAccount.session)
        let auth = AuthClient(origin: origin, store: store, http: http)
        let api = APIClient(origin: origin, auth: auth, http: http)
        let result = try await api.get("api/v1/decide/inbox", as: DecideInbox.self)
        XCTAssertGreaterThan(result.total, 0)
        let refreshes = StubProtocol.requests.filter { $0.url?.path() == "/api/auth/refresh" }.count
        XCTAssertEqual(refreshes, 2)
        let get = try XCTUnwrap(StubProtocol.requests.last)
        XCTAssertEqual(get.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer spa_"), true)
        XCTAssertNil(get.value(forHTTPHeaderField: "Cookie"))
    }

    func testSignOutWipesLocallyEvenOffline() async throws {
        StubProtocol.handler = { _ in (500, Data()) }
        try store.save(Data("sps_x".utf8), for: StoreAccount.session)
        let auth = AuthClient(origin: origin, store: store, http: http)
        await auth.signOut()
        XCTAssertFalse(auth.hasSession)
    }
}
