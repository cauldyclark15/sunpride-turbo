import CryptoKit
import XCTest
@testable import FieldIOS

/// Proves the Swift signer against the frozen cross-language vectors in
/// packages/domain-contracts/fixtures/mobile-v1/crypto/request-proof.json (bundled by path, never copied).
final class RequestSignerTests: XCTestCase {
    struct Fixture {
        let spki: String
        let privateScalar: Data
        let vectors: [[String: Any]]
        let tampered: [String: Any]
    }

    private func fixture() throws -> Fixture {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "request-proof", withExtension: "json"),
                                "request-proof.json must be bundled from packages/domain-contracts")
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        // The TEST-ONLY private JWK key name is looked up by prefix so no secret-like literal lives here.
        let jwk = try XCTUnwrap(root.first { $0.key.hasPrefix("privateKeyJwk") }?.value as? [String: Any])
        let d = try XCTUnwrap(jwk["d"] as? String)
        return Fixture(spki: try XCTUnwrap(root["publicKeySpkiBase64"] as? String),
                       privateScalar: try XCTUnwrap(Self.base64URL(d)),
                       vectors: try XCTUnwrap(root["vectors"] as? [[String: Any]]),
                       tampered: try XCTUnwrap(root["tampered"] as? [String: Any]))
    }

    private static func base64URL(_ text: String) -> Data? {
        var value = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        value += String(repeating: "=", count: (4 - value.count % 4) % 4)
        return Data(base64Encoded: value)
    }

    private func fixtureKey(_ fixture: Fixture) throws -> SoftwareDeviceKey {
        SoftwareDeviceKey(key: try P256.Signing.PrivateKey(rawRepresentation: fixture.privateScalar), storage: .ephemeralTest)
    }

    func testFixtureHasAllExpectedVectors() throws {
        let names = try fixture().vectors.compactMap { $0["name"] as? String }
        XCTAssertEqual(Set(names), ["high-bit-DER-sign-byte", "short-scalar-DER-leading-zero", "utf8-body"])
    }

    func testSPKIExportMatchesFrozenServerFormat() throws {
        let fixture = try fixture()
        let key = try fixtureKey(fixture)
        // CryptoKit's DER SPKI is byte-identical to WebCrypto's `exportKey("spki")` that the server imports.
        XCTAssertEqual(key.publicKeyBase64, fixture.spki)
        XCTAssertEqual(key.publicKeySPKI.count, 91)
    }

    func testSPKIRoundTripForFreshKeys() throws {
        for _ in 0..<20 {
            let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
            let decoded = try P256.Signing.PublicKey(derRepresentation: try XCTUnwrap(Data(base64Encoded: key.publicKeyBase64)))
            XCTAssertEqual(decoded.rawRepresentation, key.key.publicKey.rawRepresentation)
            XCTAssertEqual(decoded.derRepresentation.base64EncodedString(), key.publicKeyBase64)
            XCTAssertEqual(key.publicKeySPKI.prefix(27), Data([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce,
                                                               0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d,
                                                               0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04]))
        }
    }

    func testAllFrozenVectorsDigestCanonicalAndSignature() throws {
        let fixture = try fixture()
        for vector in fixture.vectors {
            let name = vector["name"] as? String ?? "?"
            let body = Data(try XCTUnwrap(vector["bodyUtf8"] as? String).utf8)
            let path = try XCTUnwrap(vector["path"] as? String)
            let nonce = try XCTUnwrap(vector["nonce"] as? String)
            let timestamp = try XCTUnwrap((vector["timestamp"] as? NSNumber)?.int64Value)
            let canonical = try XCTUnwrap(vector["canonical"] as? String)
            let p1363 = try XCTUnwrap(vector["signatureP1363Base64"] as? String)
            let der = try XCTUnwrap(vector["signatureDerBase64"] as? String)

            XCTAssertEqual(body.base64EncodedString(), vector["bodyBase64"] as? String, name)
            XCTAssertEqual(RequestSigner.bodyDigest(body), vector["bodyDigestHex"] as? String, name)
            XCTAssertEqual(RequestSigner.canonical(method: "POST", path: path, bodyDigest: RequestSigner.bodyDigest(body),
                                                   nonce: nonce, timestamp: timestamp), canonical, name)
            // The frozen (WebCrypto-produced) P1363 signature verifies with CryptoKit and equals the DER form.
            XCTAssertTrue(DeviceKeys.verify(signatureBase64: p1363, message: Data(canonical.utf8), spkiBase64: fixture.spki), name)
            let signature = try P256.Signing.ECDSASignature(rawRepresentation: try XCTUnwrap(Data(base64Encoded: p1363)))
            XCTAssertEqual(signature.derRepresentation.base64EncodedString(), der, name)

            // Our signer, with the fixture key, reproduces the digest/canonical/headers and a valid P1363 proof.
            let signed = try RequestSigner(key: try fixtureKey(fixture))
                .sign(path: path, body: body, deviceId: "test-device", nonce: nonce, timestamp: timestamp)
            XCTAssertEqual(signed.canonical, canonical, name)
            XCTAssertEqual(signed.headers["x-mobile-body-digest"], vector["bodyDigestHex"] as? String, name)
            XCTAssertEqual(signed.headers["x-mobile-nonce"], nonce, name)
            XCTAssertEqual(signed.headers["x-mobile-timestamp"], String(timestamp), name)
            XCTAssertEqual(signed.headers["x-mobile-device-id"], "test-device", name)
            XCTAssertEqual(signed.headers["x-mobile-app"], "IOS", name)
            XCTAssertEqual(signed.headers["x-mobile-contract-version"], "1", name)
            let ours = try XCTUnwrap(signed.headers["x-mobile-signature"])
            XCTAssertEqual(Data(base64Encoded: ours)?.count, 64, name)
            XCTAssertTrue(DeviceKeys.verify(signatureBase64: ours, message: Data(canonical.utf8), spkiBase64: fixture.spki), name)
        }
    }

    func testTamperedBodyFailsVerification() throws {
        let fixture = try fixture()
        let sourceName = try XCTUnwrap(fixture.tampered["sourceVector"] as? String)
        let source = try XCTUnwrap(fixture.vectors.first { $0["name"] as? String == sourceName })
        let tamperedBody = Data(try XCTUnwrap(fixture.tampered["bodyUtf8"] as? String).utf8)
        let digest = RequestSigner.bodyDigest(tamperedBody)
        XCTAssertNotEqual(digest, source["bodyDigestHex"] as? String)
        let canonical = RequestSigner.canonical(method: "POST", path: try XCTUnwrap(source["path"] as? String),
                                                bodyDigest: digest, nonce: try XCTUnwrap(source["nonce"] as? String),
                                                timestamp: try XCTUnwrap((source["timestamp"] as? NSNumber)?.int64Value))
        let original = try XCTUnwrap(source["signatureP1363Base64"] as? String)
        XCTAssertFalse(DeviceKeys.verify(signatureBase64: original, message: Data(canonical.utf8), spkiBase64: fixture.spki))
    }

    func testEveryAlteredFieldFailsVerification() throws {
        let fixture = try fixture()
        for vector in fixture.vectors {
            let canonical = try XCTUnwrap(vector["canonical"] as? String)
            let signature = try XCTUnwrap(vector["signatureP1363Base64"] as? String)
            var parts = canonical.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
            for index in parts.indices {
                let saved = parts[index]
                parts[index] = saved + "0"
                XCTAssertFalse(DeviceKeys.verify(signatureBase64: signature, message: Data(parts.joined(separator: "|").utf8),
                                                 spkiBase64: fixture.spki))
                parts[index] = saved
            }
            // A flipped signature byte, a DER-encoded signature and a foreign key all fail.
            var raw = try XCTUnwrap(Data(base64Encoded: signature))
            raw[10] ^= 0x01
            XCTAssertFalse(DeviceKeys.verify(signatureBase64: raw.base64EncodedString(), message: Data(canonical.utf8),
                                             spkiBase64: fixture.spki))
            XCTAssertFalse(DeviceKeys.verify(signatureBase64: try XCTUnwrap(vector["signatureDerBase64"] as? String),
                                             message: Data(canonical.utf8), spkiBase64: fixture.spki))
            let other = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest).publicKeyBase64
            XCTAssertFalse(DeviceKeys.verify(signatureBase64: signature, message: Data(canonical.utf8), spkiBase64: other))
        }
    }

    func testSignerRejectsUnsupportedInputs() throws {
        let signer = RequestSigner(key: SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest))
        let nonce = "10000000-0000-4000-8000-000000000001"
        XCTAssertThrowsError(try signer.sign(path: "/mobile/v1/other", body: Data(), deviceId: "d", nonce: nonce, timestamp: 1))
        XCTAssertThrowsError(try signer.sign(path: "/mobile/v1/pull", body: Data(), deviceId: "d", nonce: "not-a-uuid", timestamp: 1))
        XCTAssertThrowsError(try signer.sign(path: "/mobile/v1/pull", body: Data(), deviceId: "", nonce: nonce, timestamp: 1))
        XCTAssertThrowsError(try signer.sign(path: "/mobile/v1/pull", body: Data(), deviceId: "d", nonce: nonce, timestamp: 0))
    }

    func testBuiltRequestCarriesExactBodyAndBearer() throws {
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        let body = Data(#"{"type":"pull.request","contractVersion":1,"deviceId":"dev1","cursor":"c","limit":50}"#.utf8)
        let request = try RequestSigner(key: key).request(site: StubHTTP.site, path: "/mobile/v1/pull", body: body,
                                                          deviceId: "dev1", nonce: "20000000-0000-4000-8000-000000000002",
                                                          timestamp: 1_780_000_000_123, jwt: Redacted("jwt-value"))
        XCTAssertEqual(request.url?.absoluteString, "https://unit-test.convex.site/mobile/v1/pull")
        XCTAssertEqual(request.httpBody, body)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer jwt-value")
        XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
        let canonical = "POST|/mobile/v1/pull|\(RequestSigner.bodyDigest(body))|20000000-0000-4000-8000-000000000002|1780000000123"
        XCTAssertTrue(DeviceKeys.verify(signatureBase64: try XCTUnwrap(request.value(forHTTPHeaderField: "x-mobile-signature")),
                                        message: Data(canonical.utf8), spkiBase64: key.publicKeyBase64))
    }

    func testBindMessageFormat() {
        XCTAssertEqual(RequestSigner.bindMessage(deviceId: "dev", credentialId: "cred", nonce: "n", timestamp: 42),
                       "BIND|dev|cred|n|42")
    }

    func testFingerprintIsShortAndStable() {
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        XCTAssertEqual(key.fingerprint, key.fingerprint)
        XCTAssertEqual(key.fingerprint.count, 19) // 4 groups of 4 hex, 3 separators
        XCTAssertEqual(DeviceKeys.fingerprint(spki: key.publicKeySPKI), key.fingerprint)
    }
}
