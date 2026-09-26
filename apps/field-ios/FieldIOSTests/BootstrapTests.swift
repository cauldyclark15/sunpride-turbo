import CryptoKit
import XCTest
@testable import FieldIOS

@MainActor
final class BootstrapTests: XCTestCase {
    private var directory: URL!
    private var secrets: KeychainStore!
    private var store: EncryptedFieldStore!
    private var auth: AuthClient!
    private var http: HTTPClient!
    private var key: SoftwareDeviceKey!
    private let subject = "issuer|seller"
    private let device = "device-1"

    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "json"))
        return try Data(contentsOf: url)
    }
    private func json(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    private func altered(_ name: String, _ change: (inout [String: Any]) -> Void) throws -> Data {
        var object = try json(fixture(name)); change(&object)
        return try JSONSerialization.data(withJSONObject: object)
    }
    override func setUp() async throws {
        try await super.setUp()
        directory = FileManager.default.temporaryDirectory.appending(path: "bootstrap-\(UUID().uuidString)")
        secrets = KeychainStore(service: "com.sunpride.bootstrap.tests.\(UUID().uuidString)")
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        http = StubHTTP.client()
        auth = AuthClient(site: StubHTTP.site, store: secrets, http: http)
        key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        try secrets.save(Data("session".utf8), for: StoreAccount.session)
    }
    override func tearDown() async throws {
        store.close()
        try? secrets.delete("db")
        try? secrets.delete(StoreAccount.session)
        try? FileManager.default.removeItem(at: directory)
        try await super.tearDown()
    }
    private func client() -> BootstrapClient {
        BootstrapClient(site: StubHTTP.site, auth: auth,
            registry: ConvexDeviceRegistry(functions: ConvexFunctions(url: StubHTTP.cloud, auth: auth, http: http)),
            http: http, key: key)
    }
    private func protocolStub(_ page: Data, next: Data? = nil, page2Status: Int = 200,
                              firstStatus: Int = 200) {
        let jwt = StubHTTP.jwt(exp: Date().timeIntervalSince1970 + 900)
        StubURLProtocol.install { request in
            if request.path == "/api/auth/convex/token" { return .reply(.json(200, ["token": jwt])) }
            if request.path == "/api/mutation" {
                return .reply(.json(200, ["status": "success", "value": [
                    "nonce": UUID().uuidString.lowercased(), "expiresAt": 1_790_380_860_000]]))
            }
            if request.path == "/mobile/v1/bootstrap" {
                let fields = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any]
                if fields?["pageCursor"] != nil { return .reply(.init(status: page2Status, body: next ?? Data())) }
                return .reply(.init(status: firstStatus, body: page))
            }
            return .fail(.badURL)
        }
    }

    func testSharedFixturesRoundTripAndStrictNulls() throws {
        let request = try JSONDecoder().decode(BootstrapV1.Request.self, from: fixture("bootstrap-request"))
        XCTAssertEqual(request.deviceId, "device-1")
        XCTAssertEqual(request.limit, 50)
        XCTAssertEqual(try JSONDecoder().decode(BootstrapV1.Request.self, from: JSONEncoder().encode(request)).deviceId, request.deviceId)
        for name in ["bootstrap-response", "bootstrap-next-page"] {
            let value = try JSONDecoder().decode(BootstrapV1.Page.self, from: fixture(name))
            let roundTrip = try JSONDecoder().decode(BootstrapV1.Page.self, from: JSONEncoder().encode(value))
            XCTAssertEqual(roundTrip.nextPageCursor, value.nextPageCursor)
            XCTAssertEqual(roundTrip.plannedVisits.first?.id, "planned-1")
        }
        for name in ["error-device-revoked", "error-invalid-cursor", "error-rebootstrap-required", "error-version-unsupported"] {
            let value = try JSONDecoder().decode(BootstrapV1.Failure.self, from: fixture(name))
            let roundTrip = try JSONDecoder().decode(BootstrapV1.Failure.self, from: JSONEncoder().encode(value))
            XCTAssertEqual(roundTrip.error.code, value.error.code)
        }
        let unknown = try JSONDecoder().decode(BootstrapV1.PushResultEnvelope.self, from: fixture("unknown-response-enum"))
        XCTAssertEqual(unknown.results.first?.status.rawValue, "future_pending")
        XCTAssertFalse(unknown.results.first?.isAccepted ?? true)
        let roundTripUnknown = try JSONDecoder().decode(BootstrapV1.PushResultEnvelope.self, from: JSONEncoder().encode(unknown))
        XCTAssertEqual(roundTripUnknown.results.first?.status.rawValue, "future_pending")
        XCTAssertThrowsError(try JSONDecoder().decode(BootstrapV1.Page.self, from: Data("{\"type\":".utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(BootstrapV1.Page.self, from: altered("bootstrap-response") { $0.removeValue(forKey: "route") }))
        XCTAssertThrowsError(try JSONDecoder().decode(BootstrapV1.Page.self, from: altered("bootstrap-response") { $0["plannedVisits"] = NSNull() }))
        XCTAssertThrowsError(try JSONDecoder().decode(BootstrapV1.Page.self, from: altered("bootstrap-response") { $0["contractVersion"] = 2 }))
        XCTAssertThrowsError(try JSONDecoder().decode(BootstrapV1.Page.self, from: altered("bootstrap-response") { $0["syncCursor"] = NSNull() }))
        XCTAssertThrowsError(try JSONDecoder().decode(BootstrapV1.Page.self, from: altered("bootstrap-response") { $0["appConfig"] = NSNull() }))
    }

    func testTwoPagesSignedFreshChallengesAndAtomicPromotion() async throws {
        let first = try fixture("bootstrap-next-page"), second = try fixture("bootstrap-response")
        protocolStub(first, next: try altered("bootstrap-response") {
            $0["page"] = 2; $0["plannedVisits"] = []; $0["outlets"] = []
        })
        let partition = try await client().run(deviceId: device, subject: subject, store: store)
        XCTAssertEqual(try store.cursor(for: partition), "opaque-start")
        XCTAssertEqual(try store.todayVisits("2026-09-26", for: partition).count, 1)
        XCTAssertEqual(try store.outlets(for: partition).first?.name, "Outlet One")
        let requests = StubURLProtocol.requests(to: "/mobile/v1/bootstrap")
        XCTAssertEqual(requests.count, 2)
        let challenges = StubURLProtocol.requests(to: "/api/mutation")
        XCTAssertEqual(challenges.count, 2)
        XCTAssertNotEqual(requests[0].headers["x-mobile-nonce"], requests[1].headers["x-mobile-nonce"])
        for request in requests {
            let headers = Dictionary(uniqueKeysWithValues: request.headers.map { ($0.key.lowercased(), $0.value) })
            let digest = RequestSigner.bodyDigest(request.body)
            XCTAssertEqual(headers["x-mobile-body-digest"], digest)
            XCTAssertEqual(headers["x-mobile-contract-version"], "1")
            XCTAssertEqual(headers["x-mobile-device-id"], device)
            XCTAssertEqual(headers["x-mobile-app"], "IOS")
            XCTAssertTrue(headers["authorization"]?.hasPrefix("Bearer ") == true)
            let nonce = try XCTUnwrap(headers["x-mobile-nonce"])
            let timestamp = try XCTUnwrap(headers["x-mobile-timestamp"])
            XCTAssertEqual(timestamp, "1790380830000") // challenge expiry - 30s, not local clock
            let signature = try XCTUnwrap(headers["x-mobile-signature"])
            let canonical = "POST|/mobile/v1/bootstrap|\(digest)|\(nonce)|\(timestamp)"
            XCTAssertTrue(DeviceKeys.verify(signatureBase64: signature, message: Data(canonical.utf8), spkiBase64: key.publicKeyBase64))
            XCTAssertNotNil((try json(request.body))["deviceId"])
        }
    }

    func testPageTwoFailureLeavesPreviousSnapshotAndCursor() async throws {
        let original = try JSONDecoder().decode(BootstrapV1.Page.self, from: fixture("bootstrap-response"))
        let p = try StorePartition(subject: subject, deviceId: device, scope: original.scope.fingerprint)
        let snapshot = StoreSnapshot(employee: original.employee, visits: original.plannedVisits,
            outlets: [.init(id: "outlet-1", name: "Old saved outlet", routeId: nil)], customers: [], route: nil, tasks: [])
        try store.saveSnapshot(snapshot, cursor: "old-cursor", leaseExpiresAt: original.appConfig.offlineLeaseExpiresAt,
                               cacheExpiresAt: original.appConfig.cacheExpiresAt, for: p)
        protocolStub(try fixture("bootstrap-next-page"), next: Data("{\"partial\"".utf8))
        do { _ = try await client().run(deviceId: device, subject: subject, store: store, previous: p); XCTFail("must fail") }
        catch { XCTAssertEqual(error as? BootstrapClient.Failure, .invalidResponse) }
        XCTAssertEqual(try store.cursor(for: p), "old-cursor")
        XCTAssertEqual(try store.outlets(for: p).first?.name, "Old saved outlet")
        XCTAssertEqual(try store.leaseExpiry(for: p), original.appConfig.offlineLeaseExpiresAt)
    }

    func testJWT401RefreshOnceAndFreshProof() async throws {
        let page = try fixture("bootstrap-response")
        let jwt = StubHTTP.jwt(exp: Date().timeIntervalSince1970 + 900)
        StubURLProtocol.install { request in
            switch request.path {
            case "/api/auth/convex/token": return .reply(.json(200, ["token": jwt]))
            case "/api/mutation": return .reply(.json(200, ["status": "success", "value": [
                "nonce": UUID().uuidString.lowercased(), "expiresAt": Date().timeIntervalSince1970 * 1000 + 60_000]]))
            case "/mobile/v1/bootstrap":
                let nonce = request.headers.first { $0.key.lowercased() == "x-mobile-nonce" }?.value ?? ""
                return .reply(.init(status: nonce.isEmpty ? 500 : 401, body: page))
            default: return .fail(.badURL)
            }
        }
        do { _ = try await client().run(deviceId: device, subject: subject, store: store); XCTFail("must fail") }
        catch { XCTAssertEqual(error as? BootstrapClient.Failure, .unauthorized) }
        XCTAssertEqual(StubURLProtocol.requests(to: "/mobile/v1/bootstrap").count, 2)
        XCTAssertEqual(StubURLProtocol.requests(to: "/api/auth/convex/token").count, 2)
        XCTAssertEqual(StubURLProtocol.requests(to: "/api/mutation").count, 2)
    }

    func test401RefreshThenSucceedsOnce() async throws {
        let jwt = StubHTTP.jwt(exp: Date().timeIntervalSince1970 + 900)
        let page = try fixture("bootstrap-response")
        StubURLProtocol.install { request in
            switch request.path {
            case "/api/auth/convex/token": return .reply(.json(200, ["token": jwt]))
            case "/api/mutation": return .reply(.json(200, ["status": "success", "value": [
                "nonce": UUID().uuidString.lowercased(), "expiresAt": Date().timeIntervalSince1970 * 1000 + 60_000]]))
            case "/mobile/v1/bootstrap":
                let isFirst = StubURLProtocol.requests(to: "/mobile/v1/bootstrap").count == 1
                return .reply(.init(status: isFirst ? 401 : 200, body: isFirst ? Data() : page))
            default: return .fail(.badURL)
            }
        }
        let p = try await client().run(deviceId: device, subject: subject, store: store)
        XCTAssertEqual(try store.cursor(for: p), "opaque-start")
        XCTAssertEqual(StubURLProtocol.requests(to: "/mobile/v1/bootstrap").count, 2)
        XCTAssertEqual(StubURLProtocol.requests(to: "/api/mutation").count, 2)
        XCTAssertEqual(StubURLProtocol.requests(to: "/api/auth/convex/token").count, 2)
    }

    func test409RestartsAndRevokedHoldsOnlyItsPartition() async throws {
        let p = try StorePartition(subject: subject, deviceId: device, scope: "scope-v1")
        let other = try StorePartition(subject: "issuer|other", deviceId: device, scope: "scope-v1")
        let page = try JSONDecoder().decode(BootstrapV1.Page.self, from: fixture("bootstrap-response"))
        let snap = StoreSnapshot(employee: page.employee, visits: page.plannedVisits, outlets: page.outlets,
                                 customers: [], route: nil, tasks: [])
        for partition in [p, other] {
            try store.saveSnapshot(snap, cursor: "prior", leaseExpiresAt: page.appConfig.offlineLeaseExpiresAt,
                                   cacheExpiresAt: page.appConfig.cacheExpiresAt, for: partition)
        }
        protocolStub(try fixture("error-device-revoked"), firstStatus: 403)
        do { _ = try await client().run(deviceId: device, subject: subject, store: store, previous: p); XCTFail("must fail") }
        catch { XCTAssertEqual(error as? BootstrapClient.Failure, .phoneRemoved) }
        XCTAssertTrue(try store.isHeld(p))
        XCTAssertFalse(try store.isHeld(other))
        XCTAssertNil(try store.cursor(for: p))
        XCTAssertEqual(try store.outlets(for: p).count, 1)
        protocolStub(try fixture("error-rebootstrap-required"), firstStatus: 409)
        do { _ = try await client().run(deviceId: device, subject: subject, store: store, previous: p); XCTFail("must fail") }
        catch { XCTAssertEqual(error as? BootstrapClient.Failure, .restartRequired) }
        XCTAssertEqual(StubURLProtocol.requests(to: "/mobile/v1/bootstrap").count, 2)
        try store.releaseHeld(subject: subject, deviceId: device)
        XCTAssertFalse(try store.isHeld(p))
        XCTAssertFalse(try store.isHeld(other))
    }

    func test409ThenFreshStartSucceedsAndInvalidCursorRestarts() async throws {
        let jwt = StubHTTP.jwt(exp: Date().timeIntervalSince1970 + 900)
        let failure = try fixture("error-invalid-cursor"), success = try fixture("bootstrap-response")
        StubURLProtocol.install { request in
            switch request.path {
            case "/api/auth/convex/token": return .reply(.json(200, ["token": jwt]))
            case "/api/mutation": return .reply(.json(200, ["status": "success", "value": [
                "nonce": UUID().uuidString.lowercased(), "expiresAt": Date().timeIntervalSince1970 * 1000 + 60_000]]))
            case "/mobile/v1/bootstrap":
                return .reply(.init(status: StubURLProtocol.requests(to: "/mobile/v1/bootstrap").count == 1 ? 409 : 200,
                                    body: StubURLProtocol.requests(to: "/mobile/v1/bootstrap").count == 1 ? failure : success))
            default: return .fail(.badURL)
            }
        }
        let p = try await client().run(deviceId: device, subject: subject, store: store)
        XCTAssertEqual(try store.cursor(for: p), "opaque-start")
        XCTAssertEqual(StubURLProtocol.requests(to: "/mobile/v1/bootstrap").count, 2)
    }

    func testVersionAndServerFailureAreFailClosed() async throws {
        let p = try StorePartition(subject: subject, deviceId: device, scope: "scope-v1")
        let page = try JSONDecoder().decode(BootstrapV1.Page.self, from: fixture("bootstrap-response"))
        try store.saveSnapshot(StoreSnapshot(employee: page.employee, visits: page.plannedVisits,
            outlets: page.outlets, customers: [], route: nil, tasks: []), cursor: "prior",
            leaseExpiresAt: page.appConfig.offlineLeaseExpiresAt, cacheExpiresAt: page.appConfig.cacheExpiresAt, for: p)
        protocolStub(try fixture("error-version-unsupported"), firstStatus: 400)
        do { _ = try await client().run(deviceId: device, subject: subject, store: store, previous: p); XCTFail("must fail") }
        catch { XCTAssertEqual(error as? BootstrapClient.Failure, .updateRequired) }
        protocolStub(Data(), firstStatus: 503)
        do { _ = try await client().run(deviceId: device, subject: subject, store: store, previous: p); XCTFail("must fail") }
        catch { XCTAssertEqual(error as? BootstrapClient.Failure, .retryable) }
        XCTAssertEqual(try store.cursor(for: p), "prior")
        XCTAssertEqual(try store.todayVisits("2026-09-26", for: p).count, 1)
    }

    func testManilaBoundaryAndExpiredLease() throws {
        XCTAssertEqual(BootstrapClient.manilaDay(Date(timeIntervalSince1970: 1_790_351_999)), "2026-09-25")
        XCTAssertEqual(BootstrapClient.manilaDay(Date(timeIntervalSince1970: 1_790_352_000)), "2026-09-26")
        let p = try StorePartition(subject: subject, deviceId: device, scope: "scope")
        let snap = StoreSnapshot(employee: .init(id: "p", role: "sales", orgUnitId: "u"),
                                 visits: [], outlets: [], customers: [], route: nil, tasks: [])
        try store.saveSnapshot(snap, cursor: "c", leaseExpiresAt: 1_790_380_800_000,
                               cacheExpiresAt: 1_790_380_800_000, for: p)
        XCTAssertTrue(try store.isLeaseValid(now: Date(timeIntervalSince1970: 1_790_380_799), for: p))
        XCTAssertFalse(try store.isLeaseValid(now: Date(timeIntervalSince1970: 1_790_380_800), for: p))
    }
}
