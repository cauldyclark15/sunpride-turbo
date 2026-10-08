import CryptoKit
import LocalAuthentication
import Synchronization
import XCTest
@testable import FieldIOS

/// The sealed Keychain item of the fake prompt (Sendable so the vault's teardown closure can delete it).
final class SealedBox: Sendable {
    private let value = Mutex<Data?>(nil)
    var data: Data? { value.withLock { $0 } }
    func set(_ data: Data?) { value.withLock { $0 = data } }
}

/// The system prompt + biometry-bound Keychain item, scripted. With an empty script the prompt waits until
/// the test resolves `pending`, which is how late answers (after sign-out, another sign-in) are exercised.
@MainActor
final class FakeBiometricCrypto: BiometricCrypto {
    let sealed = SealedBox()
    var kind: BiometryKind = .faceID
    var available: BiometricAvailability = .available
    var script: [BiometricPromptOutcome] = []
    var readOverride: BiometricReadOutcome?
    var writeFails = false
    private(set) var prompts = 0
    var pending: CheckedContinuation<BiometricPromptOutcome, Never>?

    func availability() -> BiometricAvailability { available }
    func authenticate(reason: String) async -> BiometricPromptOutcome {
        prompts += 1
        if !script.isEmpty { return script.removeFirst() }
        return await withCheckedContinuation { pending = $0 }
    }
    func write(_ token: Data, context: BiometricContext) throws {
        if writeFails { throw SecureStoreError.keychain(errSecIO) }
        sealed.set(token)
    }
    func read(context: BiometricContext) -> BiometricReadOutcome {
        if let readOverride { return readOverride }
        return sealed.data.map { .done($0) } ?? .invalidated
    }
    func deleteSealed() throws { sealed.set(nil) }
    func resolve(_ outcome: BiometricPromptOutcome) {
        let continuation = pending
        pending = nil
        continuation?.resume(returning: outcome)
    }
    func waitForPrompt() async {
        for _ in 0..<1000 where pending == nil { await Task.yield() }
    }
}

/// Keychain stand-in whose writes/removals can be refused while old data stays readable.
final class FlakyStore: SecretStore, @unchecked Sendable {
    let inner = InMemoryStore()
    var failSave: Set<String> = []
    var failDelete: Set<String> = []
    var failRead: Set<String> = []
    func read(_ account: String) throws -> Data? {
        if failRead.contains(account) { throw SecureStoreError.keychain(errSecIO) }
        return try inner.read(account)
    }
    func save(_ data: Data, for account: String) throws {
        if failSave.contains(account) { throw SecureStoreError.keychain(errSecIO) }
        try inner.save(data, for: account)
    }
    func delete(_ account: String) throws {
        if failDelete.contains(account) { throw SecureStoreError.keychain(errSecIO) }
        try inner.delete(account)
    }
}

@MainActor
final class BiometricSignInTests: XCTestCase {
    private var plain: FlakyStore!
    private var crypto: FakeBiometricCrypto!
    private var vault: LockableSessionStore!
    private var gate: BiometricGate!
    private var auth: AuthClient!
    private let clock = TestClock()

    override func setUp() async throws {
        try await super.setUp()
        plain = FlakyStore()
        crypto = FakeBiometricCrypto()
        relaunch()
        installBackend()
    }

    /// A new process: fresh in-memory session, same Keychain.
    private func relaunch() {
        let sealed = crypto.sealed
        vault = LockableSessionStore(plain: plain, memory: SessionMemory()) { sealed.set(nil) }
        gate = BiometricGate(vault: vault, crypto: crypto)
        auth = AuthClient(site: StubHTTP.site, store: vault, http: StubHTTP.client(), now: clock.closure)
    }

    private func installBackend(exchangeStatus: Int = 200) {
        let exp = clock.now.timeIntervalSince1970 + 900
        StubURLProtocol.install { request in
            switch request.path {
            case "/api/auth/sign-in/email":
                let body = (try? JSONSerialization.jsonObject(with: request.body) as? [String: String]) ?? [:]
                return .reply(.json(200, ["token": "session-\(body["email"] ?? "x")"]))
            case "/api/auth/convex/token":
                return exchangeStatus == 200 ? .reply(.json(200, ["token": StubHTTP.jwt(exp: exp)]))
                    : .reply(.json(exchangeStatus, ["error": "nope"]))
            case "/api/auth/sign-out": return .reply(.json(200, ["success": true]))
            default: return .reply(.init(status: 404))
            }
        }
    }

    private func signIn(_ who: String = "a") async throws {
        try await auth.signIn(email: who, password: "pw-secret")
        gate.passwordSignedIn()
    }

    private func turnOn() async throws {
        try await signIn()
        crypto.script = [.done(BiometricContext(nil))]
        await gate.enable()
        XCTAssertTrue(gate.enabled)
    }

    func testPasswordSignInOffersFaceIDAndNeverStoresThePassword() async throws {
        try await signIn()
        XCTAssertTrue(gate.offer)
        XCTAssertEqual(gate.step, .open)
        XCTAssertEqual(plain.inner.accounts, [StoreAccount.session])
        for account in plain.inner.accounts {
            XCTAssertFalse(String(decoding: try XCTUnwrap(plain.inner.read(account)), as: UTF8.self).contains("pw-secret"))
        }
        crypto.available = .notEnrolled
        try await signIn("b")
        XCTAssertFalse(gate.offer, "no offer without an enrolled face or finger")
    }

    func testTurnOnMovesSessionUnderBiometricsAndRelaunchIsLockedUntilThePrompt() async throws {
        try await turnOn()
        XCTAssertEqual(crypto.prompts, 1)
        XCTAssertEqual(crypto.sealed.data, Data("session-a".utf8))
        XCTAssertNil(try plain.inner.read(StoreAccount.session), "ordinary copy removed")
        XCTAssertEqual(try plain.inner.read(LockableSessionStore.lockAccount), LockableSessionStore.biometricMarker)
        XCTAssertTrue(auth.hasSession, "still signed in for this process")
        XCTAssertFalse(gate.offer)

        relaunch()
        XCTAssertEqual(gate.step, .locked)
        XCTAssertFalse(auth.hasSession, "nothing opens the session without the prompt")
        crypto.script = [.done(BiometricContext(nil))]
        await gate.unlock()
        XCTAssertEqual(gate.step, .open)
        XCTAssertEqual(gate.unlocks, 1)
        XCTAssertTrue(auth.hasSession)
        let token = try await auth.convexToken()
        XCTAssertFalse(token.value.isEmpty)
        XCTAssertEqual(StubURLProtocol.requests(to: "/api/auth/convex/token").last?.headers["Authorization"], "Bearer session-a")
    }

    func testCancelGoesToPasswordScreenWithRetry() async throws {
        try await turnOn()
        relaunch()
        crypto.script = [.cancelled]
        await gate.unlock()
        XCTAssertEqual(gate.step, .password)
        XCTAssertNil(gate.message)
        XCTAssertTrue(gate.canRetry)
        XCTAssertFalse(auth.hasSession)
        crypto.script = [.done(BiometricContext(nil))]
        await gate.unlock()
        XCTAssertEqual(gate.step, .open)
        XCTAssertTrue(auth.hasSession)
    }

    func testChangedFaceOrFingerForcesPasswordAndForgetsTheSealedSession() async throws {
        try await turnOn()
        relaunch()
        crypto.script = [.done(BiometricContext(nil))]
        crypto.readOverride = .invalidated
        await gate.unlock()
        XCTAssertEqual(gate.step, .password)
        XCTAssertEqual(gate.message, "Face ID on this phone changed. Sign in with your password, then turn Face ID sign-in on again in Account.")
        XCTAssertFalse(gate.enabled)
        XCTAssertFalse(gate.canRetry)
        XCTAssertNil(crypto.sealed.data)
        XCTAssertNil(try plain.inner.read(LockableSessionStore.lockAccount))
        relaunch()
        XCTAssertEqual(gate.step, .open)
        XCTAssertFalse(auth.hasSession, "the password is required")

        // The prompt itself can report the enrollment is gone (all faces removed).
        try await turnOn()
        relaunch()
        crypto.readOverride = nil
        crypto.script = [.invalidated]
        await gate.unlock()
        XCTAssertFalse(gate.enabled)
        XCTAssertNotNil(gate.message)
    }

    func testTooManyTriesKeepsFaceIDOnAndFailureGoesToPassword() async throws {
        try await turnOn()
        relaunch()
        crypto.script = [.lockedOut]
        await gate.unlock()
        XCTAssertEqual(gate.step, .password)
        XCTAssertEqual(gate.message, BiometricGate.lockedOut)
        XCTAssertTrue(gate.enabled)
        XCTAssertTrue(gate.canRetry)
        crypto.script = [.failed]
        await gate.unlock()
        XCTAssertEqual(gate.message, "Couldn't use Face ID. Sign in with your password.")
    }

    func testNotInteractiveStaysLockedSilently() async throws {
        try await turnOn()
        relaunch()
        crypto.script = [.notInteractive]
        await gate.unlock()
        XCTAssertEqual(gate.step, .locked)
        XCTAssertNil(gate.message)
        XCTAssertFalse(gate.busy)
    }

    func testAccountToggleOffReturnsSessionWithoutPromptAndClearsSealedItem() async throws {
        try await turnOn()
        let prompts = crypto.prompts
        gate.disable()
        XCTAssertFalse(gate.enabled)
        XCTAssertEqual(crypto.prompts, prompts)
        XCTAssertNil(crypto.sealed.data)
        XCTAssertNil(try plain.inner.read(LockableSessionStore.lockAccount))
        XCTAssertEqual(try plain.inner.read(StoreAccount.session), Data("session-a".utf8))
        relaunch()
        XCTAssertEqual(gate.step, .open)
        XCTAssertTrue(auth.hasSession)
    }

    func testToggleOffWhileLockedSignsOut() async throws {
        try await turnOn()
        relaunch()
        gate.disable()
        XCTAssertFalse(gate.enabled)
        relaunch()
        XCTAssertFalse(auth.hasSession)
        XCTAssertTrue(plain.inner.accounts.isEmpty)
    }

    func testSignOutClearsSessionSealedItemAndLock() async throws {
        try await turnOn()
        await auth.signOut()
        gate.signedOut()
        XCTAssertFalse(auth.hasSession)
        XCTAssertFalse(gate.enabled)
        XCTAssertNil(crypto.sealed.data)
        XCTAssertTrue(plain.inner.accounts.isEmpty)
        relaunch()
        XCTAssertEqual(gate.step, .open)
        XCTAssertFalse(auth.hasSession)
    }

    func testServerRefusingTheSessionAlsoForgetsFaceID() async throws {
        try await turnOn()
        auth.invalidateToken()
        installBackend(exchangeStatus: 401)
        do { _ = try await auth.convexToken(); XCTFail("expected sessionExpired") } catch {}
        XCTAssertNil(crypto.sealed.data)
        relaunch()
        XCTAssertFalse(auth.hasSession)
        XCTAssertEqual(gate.step, .open)
    }

    func testLateUnlockAfterSignOutNeverRestoresTheOldAccount() async throws {
        try await turnOn()
        relaunch()
        let unlocking = Task { await gate.unlock() }
        await crypto.waitForPrompt()
        gate.usePassword()
        try await signIn("b")
        crypto.resolve(.done(BiometricContext(nil)))
        await unlocking.value
        XCTAssertEqual(vault.readSession(), "session-b")
        XCTAssertEqual(gate.unlocks, 0)

        // …and after a sign-out.
        try await turnOn()
        relaunch()
        let late = Task { await gate.unlock() }
        await crypto.waitForPrompt()
        try vault.wipe()
        gate.signedOut()
        crypto.resolve(.done(BiometricContext(nil)))
        await late.value
        XCTAssertFalse(auth.hasSession)
        XCTAssertEqual(gate.unlocks, 0)
    }

    func testLateSuccessAfterUsePasswordForTheSameSessionStillOpens() async throws {
        try await turnOn()
        relaunch()
        let unlocking = Task { await gate.unlock() }
        await crypto.waitForPrompt()
        gate.usePassword()
        XCTAssertEqual(gate.step, .password)
        crypto.resolve(.done(BiometricContext(nil)))
        await unlocking.value
        XCTAssertEqual(gate.step, .open)
        XCTAssertTrue(auth.hasSession)
    }

    func testLateTurnOnAfterAnotherSignInNeverSealsTheOldAccount() async throws {
        try await signIn("a")
        let enabling = Task { await gate.enable() }
        await crypto.waitForPrompt()
        try await signIn("b")
        crypto.resolve(.done(BiometricContext(nil)))
        await enabling.value
        XCTAssertNil(crypto.sealed.data, "never written for the old account")
        XCTAssertFalse(gate.enabled)
        XCTAssertNil(try plain.inner.read(LockableSessionStore.lockAccount))
        XCTAssertEqual(vault.readSession(), "session-b")
    }

    func testTurnOnFailuresLeaveThePasswordSessionWorking() async throws {
        try await signIn()
        crypto.writeFails = true
        crypto.script = [.done(BiometricContext(nil))]
        await gate.enable()
        XCTAssertFalse(gate.enabled)
        XCTAssertEqual(gate.message, "Couldn't turn on Face ID sign-in. Try again from Account.")
        XCTAssertEqual(vault.readSession(), "session-a")

        crypto.writeFails = false
        plain.failSave = [LockableSessionStore.lockAccount]
        crypto.script = [.done(BiometricContext(nil))]
        await gate.enable()
        XCTAssertFalse(gate.enabled)
        XCTAssertNil(crypto.sealed.data)
        XCTAssertEqual(vault.readSession(), "session-a")
        relaunch()
        XCTAssertEqual(vault.readSession(), "session-a")

        plain.failSave = []
        crypto.script = [.cancelled]
        await gate.enable()
        XCTAssertFalse(gate.enabled)
        XCTAssertNil(gate.message)
    }

    func testSignOutWhoseOrdinaryRemovalFailsNeverReopensTheAccount() async throws {
        try await signIn()
        plain.failDelete = [StoreAccount.session]
        await auth.signOut()
        XCTAssertNotNil(try plain.inner.read(StoreAccount.session), "the refused removal kept the copy")
        XCTAssertEqual(try plain.inner.read(LockableSessionStore.lockAccount), LockableSessionStore.signedOutMarker)
        XCTAssertFalse(auth.hasSession)
        relaunch()
        XCTAssertFalse(auth.hasSession, "the marker hides the kept copy after a restart")
        XCTAssertEqual(gate.step, .open)

        plain.failDelete = []
        try await signIn("b")
        XCTAssertEqual(vault.readSession(), "session-b")
        XCTAssertNil(try plain.inner.read(LockableSessionStore.lockAccount))
    }

    func testPasswordSignInWhoseLockRemovalFailsRollsBack() async throws {
        try await turnOn()
        relaunch()
        plain.failDelete = [LockableSessionStore.lockAccount]
        do { try await auth.signIn(email: "b", password: "pw"); XCTFail("expected storage error") }
        catch { XCTAssertEqual(error as? MobileError, .storage) }
        XCTAssertNil(try plain.inner.read(StoreAccount.session), "new copy rolled back")
        XCTAssertFalse(auth.hasSession)
        XCTAssertNil(crypto.sealed.data, "the old biometric session never reopens")
    }

    func testUnreadableLockRecordFailsClosed() async throws {
        try await signIn()
        relaunch()
        plain.failRead = [LockableSessionStore.lockAccount]
        XCTAssertFalse(auth.hasSession)
    }

    func testOtherAccountsPassStraightThrough() throws {
        try vault.save(Data("device".utf8), for: StoreAccount.deviceId)
        XCTAssertEqual(try plain.inner.read(StoreAccount.deviceId), Data("device".utf8))
        try vault.delete(StoreAccount.deviceId)
        XCTAssertNil(try plain.inner.read(StoreAccount.deviceId))
    }

    func testPromptErrorCodesMapToPlainOutcomes() {
        func name(_ outcome: BiometricPromptOutcome) -> String {
            switch outcome {
            case .done: "done"; case .cancelled: "cancelled"; case .invalidated: "invalidated"
            case .lockedOut: "lockedOut"; case .notInteractive: "notInteractive"; case .failed: "failed"
            }
        }
        let cases: [(LAError.Code?, String)] = [
            (.userCancel, "cancelled"), (.userFallback, "cancelled"), (.systemCancel, "cancelled"), (.appCancel, "cancelled"),
            (.biometryLockout, "lockedOut"), (.biometryNotEnrolled, "invalidated"), (.biometryNotAvailable, "invalidated"),
            (.passcodeNotSet, "invalidated"), (.notInteractive, "notInteractive"), (.authenticationFailed, "failed"), (nil, "failed"),
        ]
        for (code, expected) in cases {
            XCTAssertEqual(name(KeychainBiometricCrypto.outcome(for: code)), expected, "\(String(describing: code))")
        }
    }

    // MARK: AppModel wiring

    func testColdBackgroundLaunchNeverPromptsAndForegroundLaunchUnlocksFirst() async throws {
        try await turnOn()
        relaunch()
        let registry = FakeRegistry()
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        let model = AppModel(auth: auth, registry: registry, store: vault, biometrics: gate) { key }
        defer { model.enrollment.signedOut() }
        let prompts = crypto.prompts
        await model.launch(interactive: false)
        XCTAssertEqual(crypto.prompts, prompts)
        XCTAssertFalse(model.signedIn)
        XCTAssertEqual(gate.step, .locked)

        crypto.script = [.done(BiometricContext(nil))]
        await model.launch()
        XCTAssertEqual(crypto.prompts, prompts + 1)
        XCTAssertTrue(model.signedIn)

        await model.signOut()
        XCTAssertFalse(gate.enabled)
        XCTAssertNil(crypto.sealed.data)
        XCTAssertFalse(auth.hasSession)
    }

    func testCancelledLaunchShowsPasswordAndRetryOpensTheApp() async throws {
        try await turnOn()
        relaunch()
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        let model = AppModel(auth: auth, registry: FakeRegistry(), store: vault, biometrics: gate) { key }
        defer { model.enrollment.signedOut() }
        crypto.script = [.cancelled]
        await model.launch()
        XCTAssertFalse(model.signedIn)
        XCTAssertEqual(gate.step, .password)
        crypto.script = [.done(BiometricContext(nil))]
        await model.unlockWithBiometrics()
        XCTAssertTrue(model.signedIn)
    }

    func testModelPasswordSignInOffersFaceID() async throws {
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        let model = AppModel(auth: auth, registry: FakeRegistry(), store: vault, biometrics: gate) { key }
        defer { model.enrollment.signedOut() }
        await model.signIn(email: "a", password: "pw")
        XCTAssertTrue(model.signedIn)
        XCTAssertTrue(gate.offer)
    }
}

/// Runs only on a phone with Face ID / Touch ID enrolled (jc's iPhone); the simulator has none.
final class BiometricKeychainDeviceTests: XCTestCase {
    private let service = "com.sunpride.field.tests.biometric"

    @MainActor
    func testSealedItemNeedsCurrentBiometricsAndStaysOnThisDevice() throws {
        let crypto = KeychainBiometricCrypto(service: service)
        guard crypto.availability() == .available else {
            throw XCTSkip("No enrolled Face ID / Touch ID (simulator); verified on the physical iPhone.")
        }
        defer { try? KeychainBiometricCrypto.deleteItems(service: service) }
        try crypto.write(Data("test-only-not-a-session".utf8), context: BiometricContext(nil))
        let attributes = try XCTUnwrap(KeychainBiometricCrypto.sealedAttributes(service: service))
        XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String, kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        XCTAssertNotNil(attributes[kSecAttrAccessControl as String], "biometry access control attached")
        XCTAssertEqual((attributes[kSecAttrSynchronizable as String] as? NSNumber)?.boolValue ?? false, false)
        XCTAssertEqual(KeychainBiometricCrypto.readWithoutPrompt(service: service), errSecInteractionNotAllowed,
                       "the item cannot be read without Face ID / Touch ID")
        try KeychainBiometricCrypto.deleteItems(service: service)
        XCTAssertNil(KeychainBiometricCrypto.sealedAttributes(service: service))
    }
}
