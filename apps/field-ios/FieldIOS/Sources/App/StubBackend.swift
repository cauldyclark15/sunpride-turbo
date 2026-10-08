#if DEBUG
import CryptoKit
import Foundation
import Synchronization

/// DEBUG-only fake backend for UI tests, enabled by the launch environment `FIELD_STUB_BACKEND=<scenario>`.
/// It intercepts every request of the app's own URLSession, so the real AuthClient / ConvexFunctions /
/// Enrollment code runs unchanged; bind proofs are verified with the enrolled public key like the server does.
/// Scenarios: `unregistered` (never registered), `registers` (admin registers after the first lookup),
/// `revoked`, `supervisor` (registered manager with a team; IOS-020). No real account, token or network is involved.
final class StubBackend: URLProtocol {
    static let environmentKey = "FIELD_STUB_BACKEND"
    private static let state = Mutex<(scenario: String, lookups: Int, bound: Bool, nonce: String?, key: String?, supervisor: Bool)>(
        ("unregistered", 0, false, nil, nil, false))

    static var scenario: String? { ProcessInfo.processInfo.environment[environmentKey] }
    /// IOS-020: `FIELD_STUB_TEAM_REFUSE_AFTER=n` answers the first n team reads, then refuses every later
    /// one (a supervisor whose access is withdrawn mid-session).
    private static let teamReads = Mutex(0)
    private static var teamRefuseAfter: Int? { ProcessInfo.processInfo.environment["FIELD_STUB_TEAM_REFUSE_AFTER"].flatMap(Int.init) }

    static func configure(scenario: String) {
        state.withLock { $0 = (scenario, 0, scenario == "online", nil, nil, scenario == "supervisor") }
    }

    @MainActor
    static func makeModel(environment: AppEnvironment, scenario: String) -> AppModel {
        configure(scenario: scenario)
        let service = "com.sunpride.field.stub.ui"
        let plain = KeychainStore(service: service)
        if scenario != "offline" && scenario != "online" {
            // A fresh UI-test scenario starts from an empty encrypted stub partition. Only
            // offline/online relaunch scenarios deliberately preserve the prior outbox.
            let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appending(path: "FieldStoreStub", directoryHint: .isDirectory)
            try? FileManager.default.removeItem(at: directory)
            try? plain.delete("storage.sqlcipher.v1")
            try? plain.delete(SealedPhotoFiles.keyAccount)
            try? plain.delete(StoreAccount.session)
            try? plain.delete(StoreAccount.deviceId)
            try? plain.delete(StoreAccount.credentialId)
            try? plain.delete("field.lastVerifiedPartition")
            try? plain.delete(LockableSessionStore.lockAccount)
            try? plain.delete(StubBiometricCrypto.sealedAccount)
            try? KeychainBiometricCrypto.deleteItems(service: service)
        }
        // SP-0133: `FIELD_STUB_BIOMETRIC=available|cancel|changed|slow|real` (unset = no Face ID on this
        // "phone", so other UI tests never see the offer). `real` uses the system prompt and Keychain.
        let mode = ProcessInfo.processInfo.environment[StubBiometricCrypto.environmentKey]
        let crypto: any BiometricCrypto = mode == "real" ? KeychainBiometricCrypto(service: service)
            : StubBiometricCrypto(mode: mode, store: plain)
        let store = LockableSessionStore(plain: plain, memory: SessionMemory()) {
            try plain.delete(StubBiometricCrypto.sealedAccount)
            try KeychainBiometricCrypto.deleteItems(service: service)
        }
        let http = HTTPClient(session: URLSession(configuration: HTTPClient.makeConfiguration(protocolClasses: [StubBackend.self])))
        let auth = AuthClient(site: environment.siteURL, store: store, http: http)
        let functions = ConvexFunctions(url: environment.convexURL, auth: auth, http: http)
        return AppModel(auth: auth, registry: ConvexDeviceRegistry(functions: functions), store: store,
                        pollInterval: .seconds(2), site: environment.siteURL, functions: functions, http: http,
                        biometrics: BiometricGate(vault: store, crypto: crypto)) {
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
            return (200, [:], json(["redirect": false, "token": "stub-session-token", "user": ["id": "stub-user"]]))
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
            let supervisorRole = state.withLock { s in s.nonce = nil; return s.supervisor }
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let today = BootstrapClient.manilaDay(Date())
            let tomorrow = BootstrapClient.manilaDay(Date().addingTimeInterval(86_400))
            let close = Int64(FieldDay.nextClose(after: Date(timeIntervalSince1970: Double(now) / 1000)).timeIntervalSince1970 * 1000)
            return (200, [:], json([
                "type": "bootstrap.response", "contractVersion": 1, "serverTime": now,
                "permissions": ["visit.read", "visit.record"],
                "employee": ["id": "profile-1", "role": supervisorRole ? "manager" : "sales", "orgUnitId": "unit-1"],
                "scope": ["fingerprint": "stub-scope-1", "orgUnitIds": ["unit-1"]],
                "appConfig": ["offlineLeaseExpiresAt": close, "cacheExpiresAt": close,
                              "orderCaptureEnabled": false, "priceAvailability": "unavailable", "promotionsAvailability": "unavailable"],
                "plannedVisits": [["id": "planned-stub-1", "outletId": "outlet-stub-1", "serviceDate": today,
                                   "planId": "plan-stub-1", "planVersion": 1, "intents": ["audit"], "sequence": 0],
                                  ["id": "planned-stub-2", "outletId": "outlet-stub-2", "serviceDate": today,
                                   "planId": "plan-stub-1", "planVersion": 1, "intents": ["audit"], "sequence": 1],
                                  // Tomorrow's call shows in the customer detail's planned visits, not on Today.
                                  ["id": "planned-stub-1-next", "outletId": "outlet-stub-1", "serviceDate": tomorrow,
                                   "planId": "plan-stub-1", "planVersion": 1, "intents": ["merchandise_check"], "sequence": 0]],
                // Stub fix is (0, 0): outlet 1 sits ~500 m away; outlet 2 has no pin or address.
                "outlets": [["id": "outlet-stub-1", "name": "Stub Outlet", "routeId": NSNull(), "code": "STUB-1",
                             "customerId": "customer-stub-1", "address": "1 Stub Street",
                             "latitude": 0.0, "longitude": 0.0045],
                            ["id": "outlet-stub-2", "name": "Next Stub Outlet", "routeId": NSNull()],
                            ["id": "outlet-stub-extra", "name": "Extra Stub Outlet", "routeId": NSNull()]],
                "localCustomers": [["id": "customer-stub-1", "code": "C-STUB-1"]], "route": NSNull(),
                "tasks": [["id": "task-stub-1", "kind": "price_survey", "required": true]], "productCatalog": [],
                "callSheets": [["outletId": "outlet-stub-1", "revision": 1,
                    "header": ["accountName": "Stub Outlet", "address": NSNull(), "buyerName": "Stub Buyer",
                        "contactNumber": "0917 555 0101", "accountInCharge": NSNull(), "receivingInCharge": NSNull(),
                        "distributorName": NSNull(), "distributorSchedule": NSNull(), "foc": NSNull(), "pricing": NSNull()],
                    "lines": [["productId": "product-stub-1", "code": "SUNP-001", "name": "Sunpride Hotdog 1kg",
                               "uom": "PC", "barcode": NSNull(), "pricing": "₱189.00"]]]],
                "orderTerms": [["outletId": "outlet-stub-1",
                    "priceList": ["id": "sample-list", "code": "SAMPLE-GT", "name": "General Trade (sample)",
                                  "currency": "PHP", "sample": true],
                    "lines": [["productId": "product-stub-1", "uom": "PC", "unitPriceMinor": 18_900],
                              ["productId": "product-stub-1", "uom": "CS", "unitPriceMinor": 105_325]]]],
                // IOS-011: office figures for outlet 1; outlet 2's account is shared outside the plan.
                "accountSummaries": [
                    ["outletId": "outlet-stub-1", "asOfDate": today, "availability": "available",
                     "creditLimitMinor": 5_000_000,
                     "sales": ["from": BootstrapClient.manilaDay(Date().addingTimeInterval(-90 * 86_400)), "to": today,
                               "complete": true, "orders": 9, "amountMinor": 4_825_050,
                               "recentOrders": 3, "recentAmountMinor": 1_590_000,
                               "lastOrderDate": today, "lastOrderAmountMinor": 530_000],
                     "openOrders": ["count": 1, "amountMinor": 410_000]],
                    ["outletId": "outlet-stub-2", "asOfDate": today, "availability": "withheld",
                     "creditLimitMinor": NSNull(), "sales": NSNull(), "openOrders": NSNull()]],
                "page": 1, "nextPageCursor": NSNull(), "syncCursor": "stub-cursor",
                "dayTarget": ["dailyCalls": 30, "productivePct": 85, "sourceRef": "stub-memo"],
                "daySales": ["amountMinor": 175_050, "orders": 2, "targetMinor": 500_000],
                "photoTypes": [["code": "storefront", "label": "Store front"], ["code": "shelf_display", "label": "Shelf and display"],
                               ["code": "other", "label": "Other"]],
                // IOS-013: planned "audit" stays optional-only so plan-flow tests can end completed;
                // an unplanned Merchandise purpose requires the merchandising form.
                "activityRules": [
                    ["intent": "audit", "version": "stub-rules-1",
                     "activities": [["kind": "inventory_check", "required": false], ["kind": "merchandising", "required": false]]],
                    ["intent": "merchandise", "version": "stub-rules-1",
                     "activities": [["kind": "merchandising", "required": true], ["kind": "price_check", "required": false]]],
                    ["intent": "complaint", "version": "stub-rules-1", "activities": [["kind": "note", "required": true]]]
                ]
            ]))
        case "/api/storage/upload":
            // IOS-016: the signed storage URL; the stub only checks that JPEG bytes arrived.
            guard EvidencePhotos.isJpeg(body), headers["Content-Type"] == EvidencePhotos.mime else { return (400, [:], Data()) }
            return (200, [:], json(["storageId": "stub-storage-\(UUID().uuidString.lowercased())"]))
        case "/mobile/v1/push", "/mobile/v1/pull":
            let h = Dictionary(uniqueKeysWithValues: headers.map { ($0.key.lowercased(), $0.value) })
            let nonce = h["x-mobile-nonce"] ?? "", timestamp = h["x-mobile-timestamp"] ?? ""
            let digest = RequestSigner.bodyDigest(body)
            let message = "POST|\(path)|\(digest)|\(nonce)|\(timestamp)"
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
            if path == "/mobile/v1/pull" {
                return (200, [:], json(["type": "pull.response", "contractVersion": 1, "serverTime": now,
                    "changes": [], "nextCursor": "stub-cursor-next", "hasMore": false]))
            }
            let envelope = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
            let operations = envelope?["operations"] as? [[String: Any]] ?? []
            guard !operations.isEmpty, operations.count <= 20 else { return (400, [:], Data()) }
            let results = operations.map { op -> [String: Any] in
                let kind = op["kind"] as? String ?? ""
                return ["kind": kind, "clientRequestId": op["clientRequestId"] ?? "",
                    "status": "accepted", "ack": ["entityId": kind == "visit.activity" ? "stub-activity-1" : "stub-visit-1",
                        "eventIds": ["stub-event-1"], "serverTime": now]]
            }
            return (200, [:], json(["type": "push.response", "contractVersion": 1, "serverTime": now, "results": results]))
        default:
            return (404, [:], Data())
        }
    }

    /// IOS-020 fixture: two direct reports (one with an open location exception) and, for the whole
    /// area, a third person under another unit.
    private static func teamSummary(day: String, directOnly: Bool) -> [String: Any] {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let close = Int64((FieldDay.close(serviceDay: day) ?? Date()).timeIntervalSince1970 * 1000)
        func person(_ id: String, _ name: String, planned: Int, done: Int, productive: Int, open: Int, direct: Bool,
                    inProgress: Bool = false) -> [String: Any] {
            ["profileId": id, "name": name, "employeeCode": NSNull(), "positionLabel": "CDS", "channel": "general_trade",
             "orgUnitId": direct ? "unit-1" : "unit-2", "direct": direct, "planned": planned, "plannedDone": done,
             "done": done, "productive": productive, "nonproductive": done - productive, "unplanned": 0,
             "inProgress": inProgress, "outOfSequence": 0, "openExceptions": open, "lateSync": 0,
             "firstCheckInAt": done > 0 || inProgress ? now - 3_600_000 : NSNull(), "lastCheckOutAt": NSNull(),
             "lastActivityAt": NSNull()]
        }
        var people = [person("profile-ana", "Ana Reyes", planned: 6, done: 3, productive: 2, open: 1, direct: true, inProgress: true),
                      person("profile-ben", "Ben Cruz", planned: 5, done: 0, productive: 0, open: 0, direct: true)]
        if !directOnly { people.append(person("profile-cara", "Cara Lim", planned: 4, done: 4, productive: 4, open: 0, direct: false)) }
        let exceptions: [[String: Any]] = [
            ["id": "location:ex-1", "kind": "location", "open": true, "profileId": "profile-ana", "personName": "Ana Reyes",
             "outletCode": "STUB-1", "outletName": "Stub Outlet", "at": now - 1_800_000, "event": "check_in",
             "result": "outside", "distanceMeters": 412.4, "sequence": NSNull(), "after": NSNull(), "reason": NSNull(),
             "decisionStatus": NSNull()],
            ["id": "sequence:ex-2", "kind": "out_of_sequence", "open": false, "profileId": "profile-ana", "personName": "Ana Reyes",
             "outletCode": "STUB-2", "outletName": "Next Stub Outlet", "at": now - 900_000, "event": NSNull(),
             "result": NSNull(), "distanceMeters": NSNull(), "sequence": 3, "after": 1, "reason": "Store closed early",
             "decisionStatus": "approved_exception"]]
        return ["serviceDate": day, "generatedAt": now, "dayCloseAt": close, "directOnly": directOnly, "truncated": false,
                "people": people, "openExceptions": 1, "totalExceptions": exceptions.count, "exceptions": exceptions]
    }

    private static func function(_ name: String, args: [String: Any]) -> [String: Any] {
        state.withLock { s in
            switch name {
            case "domains/profiles:current":
                return ["status": "success", "value": ["_id": "profile-1", "authSubject": "stub-issuer|seller"]]
            case "analytics/suggested_orders:forOutlet":
                guard args["outletId"] as? String == "outlet-stub-1",
                      let day = args["asOfDate"] as? String else {
                    return ["status": "error", "errorMessage": "Outlet not available"]
                }
                return ["status": "success", "value": [
                    "version": "suggested-order/v1/2026-10-05", "asOfDate": day,
                    "coverDays": 8, "leadTimeDays": 1, "leadTimeProvisional": true,
                    "nextVisit": ["days": 7], "outlet": ["outletId": "outlet-stub-1"],
                    "lines": [["productId": "product-stub-1", "code": "SUNP-001", "name": "Sunpride Hotdog 1kg",
                        "unit": "PC", "status": "suggest", "suggestedQuantity": 8,
                        "reasons": ["Bought 84 PC in 84 days: 1 a day", "Cover 8 day(s) (7 to next visit + 1 lead time): 8 needed"]]]]]
            case "mobile/devices:mine":
                s.lookups += 1
                s.key = args["publicKey"] as? String
                let registered = s.scenario == "revoked" || s.scenario == "online" || s.scenario == "supervisor" ||
                    (s.scenario == "registers" && s.lookups > 1)
                guard registered else { return ["status": "success", "value": NSNull()] }
                return ["status": "success", "value": [
                    "deviceId": "stub-device-1", "status": s.scenario == "revoked" ? "revoked" : "active",
                    "bound": s.bound, "allowedApp": "IOS"]]
            case "mobile/devices:challenge":
                let nonce = UUID().uuidString.lowercased()
                s.nonce = nonce
                return ["status": "success", "value": ["nonce": nonce, "expiresAt": Date().timeIntervalSince1970 * 1000 + 60_000]]
            case "visits/evidence:generateUploadUrl":
                return ["status": "success", "value": [
                    "url": "https://stub-storage.invalid/api/storage/upload", "uploadTokenRef": "stub-claim-1"]]
            case "visits/evidence:attach":
                guard args["visitId"] as? String == "stub-visit-1", args["source"] as? String == "mobile",
                      EvidencePhotos.offered([]).contains(where: { $0.code == args["photoType"] as? String }) else {
                    return ["status": "error", "errorMessage": "Uncaught ConvexError: invalid_request", "errorData": "invalid_request"]
                }
                return ["status": "success", "value": ["evidenceId": "stub-evidence-1"]]
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
            case "supervision/mobile:team":
                // The server refuses a field seller (no people.read); the stub mirrors that refusal.
                let reads = teamReads.withLock { $0 += 1; return $0 }
                guard s.supervisor, let day = args["serviceDate"] as? String, reads <= (teamRefuseAfter ?? .max) else {
                    return ["status": "error", "errorMessage": "Uncaught ConvexError: Not authorized", "errorData": "Not authorized"]
                }
                return ["status": "success", "value": teamSummary(day: day, directOnly: args["directOnly"] as? Bool ?? true)]
            default:
                return ["status": "error", "errorMessage": "Could not find function"]
            }
        }
    }
}

/// DEBUG UI-test stand-in for the system prompt (SP-0133). The "sealed" token sits in the stub Keychain
/// service without biometric protection; it never holds a real session.
@MainActor
final class StubBiometricCrypto: BiometricCrypto {
    nonisolated static let environmentKey = "FIELD_STUB_BIOMETRIC"
    nonisolated static let sealedAccount = "stub.biometric.sealed"
    private let mode: String?
    private let store: SecretStore
    init(mode: String?, store: SecretStore) { self.mode = mode; self.store = store }

    var kind: BiometryKind { .faceID }
    func availability() -> BiometricAvailability { mode == nil ? .unavailable : .available }
    func authenticate(reason: String) async -> BiometricPromptOutcome {
        switch mode {
        case "cancel": return .cancelled
        case "slow": try? await Task.sleep(for: .seconds(4)); return .done(BiometricContext(nil))
        case nil: return .failed
        default: return .done(BiometricContext(nil))
        }
    }
    func write(_ token: Data, context: BiometricContext) throws { try store.save(token, for: Self.sealedAccount) }
    func read(context: BiometricContext) -> BiometricReadOutcome {
        if mode == "changed" { return .invalidated }
        guard let data = (try? store.read(Self.sealedAccount)) ?? nil else { return .invalidated }
        return .done(data)
    }
    func deleteSealed() throws { try store.delete(Self.sealedAccount) }
}
#endif
