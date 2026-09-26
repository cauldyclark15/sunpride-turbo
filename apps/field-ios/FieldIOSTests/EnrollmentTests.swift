import CryptoKit
import XCTest
@testable import FieldIOS

@MainActor
final class FakeRegistry: DeviceRegistry {
    var mineResults: [Result<MineResult?, MobileError>] = []
    var lastMine: Result<MineResult?, MobileError> = .success(nil)
    var challengeResult: Result<ChallengeResult, MobileError> = .success(ChallengeResult(nonce: "30000000-0000-4000-8000-000000000003", expiresAt: 1e15))
    var bindError: MobileError?
    private(set) var mineCalls: [String] = []
    private(set) var challengeCalls: [String] = []
    private(set) var bindCalls: [BindArgs] = []

    func mine(publicKey: String) async throws -> MineResult? {
        mineCalls.append(publicKey)
        // Queued answers first; afterwards `lastMine` repeats forever.
        let result = mineResults.isEmpty ? lastMine : mineResults.removeFirst()
        return try result.get()
    }
    func challenge(deviceId: String) async throws -> ChallengeResult {
        challengeCalls.append(deviceId)
        return try challengeResult.get()
    }
    func bind(_ args: BindArgs) async throws -> BindResult {
        bindCalls.append(args)
        if let bindError { throw bindError }
        return BindResult(bindingStatus: "bound")
    }
}

@MainActor
final class EnrollmentTests: XCTestCase {
    private let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
    private let clock = TestClock(Date(timeIntervalSince1970: 1_780_000_000))
    private var store: InMemoryStore!
    private var registry: FakeRegistry!

    override func setUp() async throws {
        try await super.setUp()
        store = InMemoryStore()
        registry = FakeRegistry()
    }

    private func makeEnrollment(poll: Duration = .seconds(3600)) -> Enrollment {
        Enrollment(registry: registry, store: store, pollInterval: poll, now: clock.closure)
    }

    private func device(_ status: String = "active", bound: Bool = false, app: String = "IOS") -> MineResult {
        MineResult(deviceId: "dev-1", status: status, bound: bound, allowedApp: app)
    }

    func testNotRegisteredThenRegisteredThenBound() async throws {
        let enrollment = makeEnrollment()
        registry.mineResults = [.success(nil), .success(device())]
        await enrollment.start { key }
        XCTAssertEqual(enrollment.state, .notRegistered)
        XCTAssertTrue(enrollment.isPolling, "waits for the admin by polling")
        XCTAssertEqual(registry.mineCalls, [key.publicKeyBase64], "looks up with the exact SPKI base64")

        await enrollment.check()
        XCTAssertEqual(enrollment.state, .ready(deviceId: "dev-1"))
        XCTAssertFalse(enrollment.isPolling)
        XCTAssertEqual(registry.challengeCalls, ["dev-1"])
        let bind = try XCTUnwrap(registry.bindCalls.first)
        XCTAssertEqual(bind.deviceId, "dev-1")
        XCTAssertEqual(bind.nonce, "30000000-0000-4000-8000-000000000003")
        XCTAssertEqual(bind.timestamp, 999_999_999_970_000) // server challenge midpoint, not TestClock
        XCTAssertEqual(bind.attestation, Attestation(format: "ios-ephemeral-test-only", keyId: nil))
        XCTAssertNotNil(UUID(uuidString: bind.credentialId))
        let message = "BIND|dev-1|\(bind.credentialId)|\(bind.nonce)|\(bind.timestamp)"
        XCTAssertTrue(DeviceKeys.verify(signatureBase64: bind.proof, message: Data(message.utf8), spkiBase64: key.publicKeyBase64))
        XCTAssertEqual(enrollment.persistedDeviceId, "dev-1")
    }

    func testAlreadyBoundIsReadyWithoutRebinding() async {
        registry.lastMine = .success(device(bound: true))
        let enrollment = makeEnrollment()
        await enrollment.start { key }
        XCTAssertEqual(enrollment.state, .ready(deviceId: "dev-1"))
        XCTAssertTrue(registry.challengeCalls.isEmpty)
    }

    func testRevokedStopsWithoutChallenge() async {
        registry.lastMine = .success(device("revoked", bound: true))
        let enrollment = makeEnrollment()
        await enrollment.start { key }
        XCTAssertEqual(enrollment.state, .removed)
        XCTAssertTrue(registry.challengeCalls.isEmpty)
        XCTAssertFalse(enrollment.isPolling)
    }

    func testSuspendedIsTreatedAsRemoved() async {
        registry.lastMine = .success(device("suspended"))
        let enrollment = makeEnrollment()
        await enrollment.start { key }
        XCTAssertEqual(enrollment.state, .removed)
        XCTAssertTrue(registry.challengeCalls.isEmpty)
    }

    func testReadyPhoneBecomesRemovedOnRelaunchCheck() async {
        let enrollment = makeEnrollment()
        registry.mineResults = [.success(device(bound: true)), .success(device("revoked", bound: true))]
        await enrollment.start { key }
        XCTAssertEqual(enrollment.state, .ready(deviceId: "dev-1"))
        await enrollment.check()
        XCTAssertEqual(enrollment.state, .removed)
    }

    func testPreviouslyKnownDeviceMissingIsRemoved() async throws {
        try store.save(Data("dev-1".utf8), for: StoreAccount.deviceId)
        registry.lastMine = .success(nil)
        let enrollment = makeEnrollment()
        await enrollment.start { key }
        XCTAssertEqual(enrollment.state, .removed)
    }

    func testWrongAppIsNotAccepted() async {
        registry.lastMine = .success(device(app: "ANDROID"))
        let enrollment = makeEnrollment()
        await enrollment.start { key }
        XCTAssertEqual(enrollment.state, .unverified)
        XCTAssertNotNil(enrollment.message)
        XCTAssertTrue(registry.challengeCalls.isEmpty)
    }

    func testOfflineOnLaunchIsUnverifiedNeverReady() async {
        registry.lastMine = .failure(.offline)
        let enrollment = makeEnrollment()
        await enrollment.start { key }
        XCTAssertEqual(enrollment.state, .unverified)
        XCTAssertEqual(enrollment.message, MobileError.offline.description)
        XCTAssertTrue(enrollment.isPolling)
    }

    func testFailedBindFallsBackAndRetriesWithFreshChallenge() async throws {
        registry.lastMine = .success(device())
        registry.bindError = .rejected("Device challenge expired or used")
        let enrollment = makeEnrollment()
        await enrollment.start { key }
        XCTAssertEqual(enrollment.state, .unverified)
        XCTAssertEqual(enrollment.message, MobileError.rejected("Device challenge expired or used").description)

        registry.bindError = nil
        await enrollment.check()
        XCTAssertEqual(enrollment.state, .ready(deviceId: "dev-1"))
        XCTAssertEqual(registry.challengeCalls.count, 2, "each bind attempt uses a new challenge")
        XCTAssertEqual(registry.bindCalls[0].credentialId, registry.bindCalls[1].credentialId, "credential ID is stable")
    }

    func testSkewedPhoneClockStillBindsUsingServerChallenge() async throws {
        registry.lastMine = .success(device())
        registry.challengeResult = .success(ChallengeResult(nonce: "nonce", expiresAt: 1_800_000_060_000))
        // TestClock is far behind the server; the proof must use the challenge midpoint.
        let enrollment = makeEnrollment()
        await enrollment.start { key }
        XCTAssertEqual(enrollment.state, .ready(deviceId: "dev-1"))
        XCTAssertEqual(try XCTUnwrap(registry.bindCalls.first).timestamp, 1_800_000_030_000)
    }

    func testMalformedChallengeIsNotSigned() async {
        registry.lastMine = .success(device())
        registry.challengeResult = .success(ChallengeResult(nonce: "n", expiresAt: .nan))
        let enrollment = makeEnrollment()
        await enrollment.start { key }
        XCTAssertTrue(registry.bindCalls.isEmpty)
        XCTAssertEqual(enrollment.state, .unverified)
    }

    func testSessionEndedDuringCheckSignalsSignOut() async {
        registry.lastMine = .failure(.sessionExpired)
        let enrollment = makeEnrollment()
        var ended = false
        enrollment.onSessionEnded = { ended = true }
        await enrollment.start { key }
        XCTAssertTrue(ended)
        XCTAssertEqual(enrollment.state, .signedOut)
    }

    func testKeyUnavailable() async {
        let enrollment = makeEnrollment()
        await enrollment.start { throw MobileError.deviceKeyUnavailable }
        XCTAssertNil(enrollment.key)
        XCTAssertEqual(enrollment.message, MobileError.deviceKeyUnavailable.description)
        XCTAssertTrue(registry.mineCalls.isEmpty)
    }

    func testAutoPollFindsRegistration() async throws {
        registry.mineResults = [.success(nil), .success(nil)]
        registry.lastMine = .success(device())
        let enrollment = makeEnrollment(poll: .milliseconds(50))
        await enrollment.start { key }
        XCTAssertEqual(enrollment.state, .notRegistered)
        for _ in 0..<100 where enrollment.state != .ready(deviceId: "dev-1") {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(enrollment.state, .ready(deviceId: "dev-1"))
        XCTAssertGreaterThanOrEqual(registry.mineCalls.count, 3)
        XCTAssertFalse(enrollment.isPolling)
    }

    func testSignedOutStopsPollingAndForgetsProgress() async throws {
        let enrollment = makeEnrollment(poll: .milliseconds(20))
        registry.lastMine = .success(device())
        registry.bindError = .offline
        await enrollment.start { key }
        XCTAssertNotNil(try store.read(StoreAccount.credentialId))
        enrollment.signedOut()
        XCTAssertEqual(enrollment.state, .signedOut)
        XCTAssertFalse(enrollment.isPolling)
        XCTAssertNil(enrollment.persistedDeviceId)
        XCTAssertNil(try store.read(StoreAccount.credentialId))
        let calls = registry.mineCalls.count
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(registry.mineCalls.count, calls)
    }
}

@MainActor
final class AppModelTests: XCTestCase {
    func testPillStatesFollowAuthAndEnrollment() async throws {
        let store = InMemoryStore()
        let registry = FakeRegistry()
        let clock = TestClock()
        StubURLProtocol.install { request -> StubURLProtocol.Outcome in
            switch request.path {
            case "/api/auth/sign-in/email": return .reply(.json(200, [:], headers: ["set-auth-token": "s"]))
            case "/api/auth/convex/token": return .reply(.json(200, ["token": StubHTTP.jwt(exp: clock.now.timeIntervalSince1970 + 900)]))
            default: return .reply(.json(200, [:]))
            }
        }
        let auth = AuthClient(site: StubHTTP.site, store: store, http: StubHTTP.client(), now: clock.closure)
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        let model = AppModel(auth: auth, registry: registry, store: store, pollInterval: .seconds(3600)) { key }
        XCTAssertEqual(model.pill.label, "Offline — not signed in")

        registry.lastMine = .success(nil)
        await model.signIn(email: "a@b.c", password: "p")
        XCTAssertEqual(model.pill.label, "Signed in — phone not registered")

        registry.lastMine = .success(MineResult(deviceId: "d", status: "active", bound: true, allowedApp: "IOS"))
        await model.enrollment.check()
        XCTAssertEqual(model.pill.label, "Ready")

        registry.lastMine = .success(MineResult(deviceId: "d", status: "revoked", bound: true, allowedApp: "IOS"))
        await model.enrollment.check()
        XCTAssertEqual(model.pill.label, "Phone removed")

        await model.signOut()
        XCTAssertEqual(model.pill.label, "Offline — not signed in")
        XCTAssertFalse(auth.hasSession)
        XCTAssertFalse(store.accounts.contains(StoreAccount.session))
    }

    func testWrongPasswordShowsClearError() async {
        StubURLProtocol.install { _ in .reply(.json(401, ["code": "INVALID_EMAIL_OR_PASSWORD"])) }
        let store = InMemoryStore()
        let auth = AuthClient(site: StubHTTP.site, store: store, http: StubHTTP.client())
        let model = AppModel(auth: auth, registry: FakeRegistry(), store: store) {
            SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        }
        await model.signIn(email: "a@b.c", password: "wrong")
        XCTAssertFalse(model.signedIn)
        XCTAssertEqual(model.signInError, "Incorrect email or password.")
    }
}
