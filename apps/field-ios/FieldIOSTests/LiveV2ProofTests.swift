import Foundation
import XCTest
@testable import FieldIOS

/// Opt-in, owner-authorized live sign-in on the physical phone. The proof login is copied into this app's
/// own container as a private file, read once and deleted before any network call; it is never typed by
/// UI automation, printed, logged or compiled in. Biometric unlock is never enabled.
@MainActor
final class LiveV2ProofTests: XCTestCase {
    private var docs: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }

    /// Writes this install's device public key (not secret) for the administrator registration step.
    func testLiveExportPublicKey() throws {
        guard ProcessInfo.processInfo.environment["SUNPRIDE_V2_LIVE"] == "1" else { throw XCTSkip("Opt-in live proof") }
        let service = Bundle.main.bundleIdentifier ?? "com.sunpride.field.dev"
        let key = try DeviceKeys.loadOrCreate(store: KeychainStore(service: service))
        try NativeV2.bytes(["publicKeySpki": key.publicKeyBase64, "keyId": RequestSigner.bodyDigest(key.publicKeySPKI),
                           "app": "field-ios"]).write(to: docs.appending(path: "v2-proof-key.json"), options: .atomic)
    }

    func testLiveSignInFromPrivateFile() async throws {
        guard ProcessInfo.processInfo.environment["SUNPRIDE_V2_LIVE"] == "1" else { throw XCTSkip("Opt-in live proof") }
        struct Login: Decodable { let email: String; let password: String }
        let file = docs.appending(path: "v2-proof.json")
        let login: Login
        do { login = try JSONDecoder().decode(Login.self, from: Data(contentsOf: file)) }
        catch { try? FileManager.default.removeItem(at: file); throw error }
        try FileManager.default.removeItem(at: file)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))

        let model = AppModel.live(environment: try AppEnvironment.bundled(Bundle(for: AppModel.self)))
        // Never call launch() here: a Face ID-sealed session left by an earlier run would show the system
        // prompt. Signing out first forgets any session (sealed or ordinary) without prompting.
        await model.signOut()
        await model.signIn(email: login.email, password: login.password)
        model.biometrics?.decline() // Face ID stays OFF for proof accounts
        XCTAssertEqual(model.biometrics?.enabled ?? false, false)
        XCTAssertTrue(model.signedIn, "live sign-in (credentials deliberately not printed)")
        let state: [String: Any] = ["signedIn": model.signedIn, "phone": model.pill.label, "faceID": model.biometrics?.enabled ?? false]
        try NativeV2.bytes(state).write(to: docs.appending(path: "v2-proof-state.json"), options: .atomic)
        model.enrollment.signedOut() // stop this process's polling; the persisted session stays
    }
}
