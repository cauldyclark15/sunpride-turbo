import CryptoKit
import XCTest
@testable import FieldIOS

final class SecurityHygieneTests: XCTestCase {
    func testRedactedWrapperNeverPrints() {
        let secret = Redacted("eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJjb252ZXgifQ.c2ln")
        XCTAssertEqual("\(secret)", "<redacted>")
        XCTAssertEqual(String(describing: secret), "<redacted>")
        XCTAssertEqual(String(reflecting: secret), "<redacted>")
        var dumped = ""
        dump(secret, to: &dumped)
        XCTAssertFalse(dumped.contains("eyJ"), dumped)
    }

    func testRedactorScrubsTokensAndBearers() {
        let jwt = "eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJjb252ZXgifQ.c2lnbmF0dXJl"
        let samples = [
            "Authorization: Bearer abc.def-ghi",
            "failed with token=\(jwt)",
            "{\"token\":\"opaque-session-value\"}",
            "session: s3cr3t-value",
            "password=hunter2",
            "raw \(String(repeating: "A1b2", count: 12))"
        ]
        for sample in samples {
            let output = Redactor.redact(sample)
            XCTAssertTrue(output.contains("<redacted>"), output)
            for leaked in ["abc.def-ghi", jwt, "opaque-session-value", "s3cr3t-value", "hunter2", "A1b2A1b2A1b2"] {
                XCTAssertFalse(output.contains(leaked), "\(leaked) leaked in \(output)")
            }
        }
        XCTAssertEqual(Redactor.redact("Device unavailable"), "Device unavailable")
        XCTAssertLessThanOrEqual(Redactor.redact(String(repeating: "word ", count: 100)).count, 201)
    }

    func testErrorDescriptionsCarryNoSecrets() {
        let jwt = "eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJjb252ZXgifQ.c2lnbmF0dXJl"
        let rejected = MobileError.rejected(ConvexFunctions.reason("Uncaught ConvexError: bad bearer \(jwt)"))
        XCTAssertFalse(rejected.description.contains(jwt))
        XCTAssertFalse("\(rejected)".contains("eyJ"))
        let all: [MobileError] = [.invalidCredentials, .signInRefused, .rateLimited, .offline, .server, .notSignedIn,
                                  .sessionExpired, .unauthorized, .invalidResponse, .deviceKeyUnavailable, .storage]
        for error in all {
            XCTAssertFalse(error.description.isEmpty)
            XCTAssertFalse(error.description.lowercased().contains("bearer"))
        }
    }

    @MainActor
    func testTokensAbsentFromModelDescriptions() async throws {
        let store = InMemoryStore()
        let jwt = StubHTTP.jwt(exp: Date().timeIntervalSince1970 + 900, marker: "leakcheck")
        StubURLProtocol.install { request -> StubURLProtocol.Outcome in
            if request.path == "/api/auth/sign-in/email" {
                return .reply(.json(200, [:], headers: ["set-auth-token": "session-leakcheck"]))
            }
            return .reply(.json(200, ["token": jwt]))
        }
        let auth = AuthClient(site: StubHTTP.site, store: store, http: StubHTTP.client())
        try await auth.signIn(email: "a@b.c", password: "password-leakcheck")
        var dumped = ""
        dump(auth, to: &dumped)
        dump(try await auth.convexToken(), to: &dumped)
        for leaked in ["session-leakcheck", "password-leakcheck", jwt] {
            XCTAssertFalse(dumped.contains(leaked), "\(leaked) visible via reflection")
        }
    }
}

/// Real Keychain on the simulator, isolated by a unique service name.
final class KeychainStoreTests: XCTestCase {
    private var store: KeychainStore!

    override func setUp() {
        super.setUp()
        store = KeychainStore(service: "com.sunpride.field.tests.\(UUID().uuidString)")
    }

    override func tearDown() {
        for account in [StoreAccount.session, StoreAccount.simulatorKey, StoreAccount.deviceId, "probe"] {
            try? store.delete(account)
        }
        super.tearDown()
    }

    func testRoundTripAndDelete() throws {
        XCTAssertNil(try store.read("probe"))
        try store.save(Data("one".utf8), for: "probe")
        try store.save(Data("two".utf8), for: "probe")
        XCTAssertEqual(try store.read("probe"), Data("two".utf8))
        try store.delete("probe")
        XCTAssertNil(try store.read("probe"))
        XCTAssertNoThrow(try store.delete("probe"))
    }

    func testSessionItemIsThisDeviceOnlyAndNotSynchronizable() throws {
        try store.save(Data("s".utf8), for: StoreAccount.session)
        let attributes = try XCTUnwrap(try store.attributes(StoreAccount.session))
        XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String,
                       kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        let sync = attributes[kSecAttrSynchronizable as String]
        XCTAssertTrue(sync == nil || (sync as? NSNumber)?.boolValue == false)
    }

    @MainActor
    func testSignOutWipesKeychainSession() async throws {
        try store.save(Data("session-to-wipe".utf8), for: StoreAccount.session)
        StubURLProtocol.install { _ in .reply(.json(200, ["success": true])) }
        let auth = AuthClient(site: StubHTTP.site, store: store, http: StubHTTP.client())
        XCTAssertTrue(auth.hasSession)
        await auth.signOut()
        XCTAssertNil(try store.read(StoreAccount.session))
        XCTAssertFalse(auth.hasSession)
    }

    func testSimulatorKeyIsPersistedAndReloaded() throws {
        #if targetEnvironment(simulator)
        let first = try DeviceKeys.loadOrCreate(store: store)
        let second = try DeviceKeys.loadOrCreate(store: store)
        XCTAssertEqual(first.publicKeyBase64, second.publicKeyBase64)
        XCTAssertEqual(first.storage, SecureEnclave.isAvailable ? .secureEnclave : .simulatorKeychain)
        let signature = try first.sign("probe")
        XCTAssertTrue(DeviceKeys.verify(signatureBase64: signature, message: Data("probe".utf8), spkiBase64: second.publicKeyBase64))
        #else
        throw XCTSkip("Simulator-only")
        #endif
    }

    func testPublicKeyExportWritesOnlyPublicKey() throws {
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = try PublicKeyExport.write(publicKeyBase64: key.publicKeyBase64, directory: folder)
        XCTAssertEqual(url.lastPathComponent, "device-public-key.txt")
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), key.publicKeyBase64 + "\n")
        XCTAssertThrowsError(try PublicKeyExport.write(publicKeyBase64: key.key.rawRepresentation.base64EncodedString(),
                                                       directory: folder), "refuses anything that isn't a 91-byte SPKI")
    }
}
