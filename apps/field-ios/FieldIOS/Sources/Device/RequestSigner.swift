import CryptoKit
import Foundation

/// Signs `/api/sync/{pull,push}` and `/api/media/claims` requests exactly as `apps/api/src/core/devices.js`
/// verifies them:
///
///     POST|<path>|<lowercase sha256 hex of the raw body bytes>|<challenge nonce>|<epoch ms>
///
/// The body must be serialized once; the digest covers those exact bytes, which must be sent unchanged.
struct RequestSigner: Sendable {
    static let contractVersion = "2"
    static let app = "field-ios"
    static let signedPaths: Set<String> = ["/api/sync/pull", "/api/sync/push", "/api/media/claims"]

    struct SignedHeaders: Equatable, Sendable {
        let bodyDigest: String
        let canonical: String
        let headers: [String: String]
    }

    enum SignerError: Error, Equatable { case unsupportedPath, invalidNonce, invalidTimestamp, emptyDeviceId }

    let key: any DeviceSigningKey

    static func bodyDigest(_ body: Data) -> String {
        SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
    }

    static func canonical(method: String, path: String, bodyDigest: String, nonce: String, timestamp: Int64) -> String {
        "\(method)|\(path)|\(bodyDigest)|\(nonce)|\(timestamp)"
    }

    static func bindMessage(deviceId: String, credentialId: String, nonce: String, timestamp: Int64) -> String {
        "BIND|\(deviceId)|\(credentialId)|\(nonce)|\(timestamp)"
    }

    func sign(path: String, body: Data, deviceId: String, nonce: String, timestamp: Int64) throws -> SignedHeaders {
        guard Self.signedPaths.contains(path) else { throw SignerError.unsupportedPath }
        guard !deviceId.isEmpty else { throw SignerError.emptyDeviceId }
        guard nonce.range(of: #"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"#,
                          options: .regularExpression) != nil else { throw SignerError.invalidNonce }
        guard timestamp > 0, timestamp <= 9_007_199_254_740_991 else { throw SignerError.invalidTimestamp }
        let digest = Self.bodyDigest(body)
        let canonical = Self.canonical(method: "POST", path: path, bodyDigest: digest, nonce: nonce, timestamp: timestamp)
        let signature = try key.sign(canonical)
        return SignedHeaders(bodyDigest: digest, canonical: canonical, headers: [
            "Content-Type": "application/json",
            "x-mobile-contract-version": Self.contractVersion,
            "x-device-id": deviceId,
            "x-mobile-app": Self.app,
            "x-device-nonce": nonce,
            "x-device-timestamp": String(timestamp),
            "x-mobile-body-digest": digest,
            "x-device-signature": signature
        ])
    }

    /// Builds the full request (site URL + path, exact body bytes, proof headers and the access-token bearer).
    func request(site: URL, path: String, body: Data, deviceId: String, nonce: String, timestamp: Int64,
                 jwt: Redacted<String>) throws -> URLRequest {
        let signed = try sign(path: path, body: body, deviceId: deviceId, nonce: nonce, timestamp: timestamp)
        var request = URLRequest(url: site.appending(path: String(path.dropFirst())))
        request.httpMethod = "POST"
        request.httpBody = body
        for (name, value) in signed.headers { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue("Bearer \(jwt.value)", forHTTPHeaderField: "Authorization")
        return request
    }
}
