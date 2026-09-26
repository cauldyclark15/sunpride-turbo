#if DEBUG
import CryptoKit
import Foundation
import Synchronization

/// DEBUG-only fake backend for UI tests, enabled by the launch environment `FIELD_STUB_BACKEND=<scenario>`.
/// It intercepts every request of the app's own URLSession, so the real AuthClient / ConvexFunctions /
/// Enrollment code runs unchanged; bind proofs are verified with the enrolled public key like the server does.
/// Scenarios: `unregistered` (never registered), `registers` (admin registers after the first lookup),
/// `revoked`. No real account, token or network is involved.
final class StubBackend: URLProtocol {
    static let environmentKey = "FIELD_STUB_BACKEND"
    private static let state = Mutex<(scenario: String, lookups: Int, bound: Bool, nonce: String?, key: String?)>(
        ("unregistered", 0, false, nil, nil))

    static var scenario: String? { ProcessInfo.processInfo.environment[environmentKey] }

    static func configure(scenario: String) {
        state.withLock { $0 = (scenario, 0, false, nil, nil) }
    }

    @MainActor
    static func makeModel(environment: AppEnvironment, scenario: String) -> AppModel {
        configure(scenario: scenario)
        let store = KeychainStore(service: "com.sunpride.field.stub.ui")
        if scenario != "offline" {
            try? store.delete(StoreAccount.session)
            try? store.delete(StoreAccount.deviceId)
            try? store.delete(StoreAccount.credentialId)
            try? store.delete("field.lastVerifiedPartition")
        }
        let http = HTTPClient(session: URLSession(configuration: HTTPClient.makeConfiguration(protocolClasses: [StubBackend.self])))
        let auth = AuthClient(site: environment.siteURL, store: store, http: http)
        let functions = ConvexFunctions(url: environment.convexURL, auth: auth, http: http)
        return AppModel(auth: auth, registry: ConvexDeviceRegistry(functions: functions), store: store,
                        pollInterval: .seconds(2), site: environment.siteURL, functions: functions, http: http) {
            try DeviceKeys.loadOrCreate(store: store)
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let path = request.url?.path ?? ""
        if Self.scenario == "offline" && (path == "/api/query" || path == "/api/mutation" || path.hasPrefix("/mobile/v1/")) {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let body = Self.body(of: request)
        let (status, headers, payload) = Self.respond(path: path, body: body, headers: request.allHTTPHeaderFields ?? [:])
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: headers.merging(["Content-Type": "application/json"]) { a, _ in a })!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }

    private static func body(of request: URLRequest) -> Data {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }

    private static func json(_ object: Any) -> Data { (try? JSONSerialization.data(withJSONObject: object)) ?? Data() }

    private static func fakeJWT() -> String {
        let segment: (Any) -> String = { json($0).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "") }
        let exp = Int(Date().timeIntervalSince1970) + 900
        return "\(segment(["alg": "none"])).\(segment(["aud": "convex", "exp": exp])).stub"
    }

    private static func respond(path: String, body: Data, headers: [String: String]) -> (Int, [String: String], Data) {
        switch path {
        case "/api/auth/sign-in/email":
            let fields = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
            guard fields?["password"] as? String == "correct-horse" else { return (401, [:], json(["code": "INVALID"])) }
            return (200, ["set-auth-token": "stub-session-token"], json(["redirect": false]))
        case "/api/auth/convex/token":
            return (200, [:], json(["token": fakeJWT()]))
        case "/api/auth/sign-out":
            return (200, [:], json(["success": true]))
        case "/api/query", "/api/mutation":
            let call = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
            let args = call?["args"] as? [String: Any] ?? [:]
            return (200, [:], json(function(call?["path"] as? String ?? "", args: args)))
        case "/mobile/v1/bootstrap":
            let h = Dictionary(uniqueKeysWithValues: headers.map { ($0.key.lowercased(), $0.value) })
            let nonce = h["x-mobile-nonce"] ?? "", timestamp = h["x-mobile-timestamp"] ?? ""
            let digest = RequestSigner.bodyDigest(body)
            let message = "POST|/mobile/v1/bootstrap|\(digest)|\(nonce)|\(timestamp)"
            let valid = state.withLock { s in
                s.bound && s.nonce == nonce && s.key.map {
                    DeviceKeys.verify(signatureBase64: h["x-mobile-signature"] ?? "",
                                      message: Data(message.utf8), spkiBase64: $0)
                } == true
            }
            guard valid, h["x-mobile-body-digest"] == digest,
                  h["x-mobile-contract-version"] == "1" else { return (401, [:], json(["code": "unauthorized"])) }
            state.withLock { $0.nonce = nil }
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let today = BootstrapClient.manilaDay(Date())
            return (200, [:], json([
                "type": "bootstrap.response", "contractVersion": 1, "serverTime": now,
                "permissions": ["visit.read", "visit.record"],
                "employee": ["id": "profile-1", "role": "sales", "orgUnitId": "unit-1"],
                "scope": ["fingerprint": "stub-scope-1", "orgUnitIds": ["unit-1"]],
                "appConfig": ["offlineLeaseExpiresAt": now + 86_400_000, "cacheExpiresAt": now + 86_400_000,
                              "orderCaptureEnabled": false, "priceAvailability": "unavailable", "promotionsAvailability": "unavailable"],
                "plannedVisits": [["id": "planned-stub-1", "outletId": "outlet-stub-1", "serviceDate": today,
                                   "planId": "plan-stub-1", "planVersion": 1, "intents": ["audit"]]],
                "outlets": [["id": "outlet-stub-1", "name": "Stub Outlet", "routeId": NSNull()]],
                "localCustomers": [], "route": NSNull(), "tasks": [], "productCatalog": [],
                "page": 1, "nextPageCursor": NSNull(), "syncCursor": "stub-cursor"
            ]))
        default:
            return (404, [:], Data())
        }
    }

    private static func function(_ name: String, args: [String: Any]) -> [String: Any] {
        state.withLock { s in
            switch name {
            case "domains/profiles:current":
                return ["status": "success", "value": ["_id": "profile-1", "authSubject": "stub-issuer|seller"]]
            case "mobile/devices:mine":
                s.lookups += 1
                s.key = args["publicKey"] as? String
                let registered = s.scenario == "revoked" || (s.scenario == "registers" && s.lookups > 1)
                guard registered else { return ["status": "success", "value": NSNull()] }
                return ["status": "success", "value": [
                    "deviceId": "stub-device-1", "status": s.scenario == "revoked" ? "revoked" : "active",
                    "bound": s.bound, "allowedApp": "IOS"]]
            case "mobile/devices:challenge":
                let nonce = UUID().uuidString.lowercased()
                s.nonce = nonce
                return ["status": "success", "value": ["nonce": nonce, "expiresAt": Date().timeIntervalSince1970 * 1000 + 60_000]]
            case "mobile/devices:bind":
                guard let key = s.key, let nonce = s.nonce, args["nonce"] as? String == nonce,
                      let credential = args["credentialId"] as? String, let proof = args["proof"] as? String,
                      let timestamp = (args["timestamp"] as? NSNumber)?.int64Value,
                      DeviceKeys.verify(signatureBase64: proof,
                                        message: Data("BIND|stub-device-1|\(credential)|\(nonce)|\(timestamp)".utf8),
                                        spkiBase64: key) else {
                    return ["status": "error", "errorMessage": "Uncaught ConvexError: Invalid device proof"]
                }
                s.nonce = nil
                s.bound = true
                return ["status": "success", "value": ["bindingStatus": "bound"]]
            default:
                return ["status": "error", "errorMessage": "Could not find function"]
            }
        }
    }
}
#endif
