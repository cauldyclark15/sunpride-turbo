import CryptoKit
import Foundation

/// The phone's enrolled P-256 signing key. Private material never leaves Secure Enclave / Keychain.
protocol DeviceSigningKey: Sendable {
    var storage: DeviceKeyStorage { get }
    /// DER SubjectPublicKeyInfo (id-ecPublicKey, prime256v1, uncompressed point) — 91 bytes.
    var publicKeySPKI: Data { get }
    /// ECDSA P-256 / SHA-256 over `message`, returned as IEEE P1363 raw `r||s` (64 bytes).
    func signP1363(_ message: Data) throws -> Data
}

enum DeviceKeyStorage: String, Sendable {
    case secureEnclave = "Secure Enclave"
    case simulatorKeychain = "Keychain software key (simulator, TEST ONLY)"
    case ephemeralTest = "Ephemeral in-memory key (TEST ONLY)"

    /// Recorded as unverified attestation metadata on bind; never claims verified hardware integrity.
    var attestationFormat: String {
        switch self {
        case .secureEnclave: "ios-secure-enclave-unverified"
        case .simulatorKeychain: "ios-simulator-keychain-test-only"
        case .ephemeralTest: "ios-ephemeral-test-only"
        }
    }
}

extension DeviceSigningKey {
    var publicKeyBase64: String { publicKeySPKI.base64EncodedString() }
    /// Short human check value: first 8 bytes of SHA-256(SPKI) as grouped hex, e.g. `3f9a·01bc·…`.
    var fingerprint: String { DeviceKeys.fingerprint(spki: publicKeySPKI) }
    func sign(_ text: String) throws -> String { try signP1363(Data(text.utf8)).base64EncodedString() }
}

struct SecureEnclaveDeviceKey: DeviceSigningKey {
    let key: SecureEnclave.P256.Signing.PrivateKey
    var storage: DeviceKeyStorage { .secureEnclave }
    var publicKeySPKI: Data { key.publicKey.derRepresentation }
    func signP1363(_ message: Data) throws -> Data { try key.signature(for: message).rawRepresentation }
}

struct SoftwareDeviceKey: DeviceSigningKey {
    let key: P256.Signing.PrivateKey
    let storage: DeviceKeyStorage
    var publicKeySPKI: Data { key.publicKey.derRepresentation }
    func signP1363(_ message: Data) throws -> Data { try key.signature(for: message).rawRepresentation }
}

enum DeviceKeys {
    /// Loads the enrolled key, creating one on first use. A real phone always uses the Secure Enclave;
    /// the software fallback exists only on the simulator (which has no enclave) and is labelled TEST ONLY.
    static func loadOrCreate(store: SecretStore) throws -> any DeviceSigningKey {
        if SecureEnclave.isAvailable {
            if let blob = try store.read(StoreAccount.secureEnclaveKey) {
                // The blob is an enclave-wrapped handle, useless off this device.
                return SecureEnclaveDeviceKey(key: try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob))
            }
            let key = try SecureEnclave.P256.Signing.PrivateKey()
            try store.save(key.dataRepresentation, for: StoreAccount.secureEnclaveKey)
            return SecureEnclaveDeviceKey(key: key)
        }
        #if targetEnvironment(simulator)
        if let raw = try store.read(StoreAccount.simulatorKey) {
            return SoftwareDeviceKey(key: try P256.Signing.PrivateKey(rawRepresentation: raw), storage: .simulatorKeychain)
        }
        let key = P256.Signing.PrivateKey()
        try store.save(key.rawRepresentation, for: StoreAccount.simulatorKey)
        return SoftwareDeviceKey(key: key, storage: .simulatorKeychain)
        #else
        throw MobileError.deviceKeyUnavailable
        #endif
    }

    static func fingerprint(spki: Data) -> String {
        let bytes = Array(SHA256.hash(data: spki).prefix(8))
        return stride(from: 0, to: bytes.count, by: 2)
            .map { String(format: "%02x%02x", bytes[$0], bytes[$0 + 1]) }
            .joined(separator: "·")
    }

    /// Verifies a base64 P1363 signature against a base64 SPKI key exactly as the server does
    /// (canonical base64, P-256 SPKI, 64-byte r||s). Used by tests and the DEBUG stub backend.
    static func verify(signatureBase64: String, message: Data, spkiBase64: String) -> Bool {
        guard let spki = Data(base64Encoded: spkiBase64), spki.base64EncodedString() == spkiBase64,
              let key = try? P256.Signing.PublicKey(derRepresentation: spki),
              let raw = Data(base64Encoded: signatureBase64), raw.base64EncodedString() == signatureBase64,
              raw.count == 64,
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: raw) else { return false }
        return key.isValidSignature(signature, for: message)
    }
}
