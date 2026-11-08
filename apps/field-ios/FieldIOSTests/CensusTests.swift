import CryptoKit
import UIKit
import XCTest
@testable import FieldIOS

/// SP-0164: the shared duplicate rules (every vector of `census-duplicates.json`).
final class CensusDuplicatesTests: XCTestCase {
    private func fixture() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "census-duplicates", withExtension: "json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }
    private func number(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

    func testStopwordsMatchTheFixture() throws {
        let rules = try XCTUnwrap(fixture()["rules"] as? [String: Any])
        XCTAssertEqual(Set(try XCTUnwrap(rules["stopwords"] as? [String])), CensusDuplicates.stopwords)
    }

    func testNameTokenVectors() throws {
        let vectors = try XCTUnwrap(fixture()["nameTokenVectors"] as? [[String: Any]])
        XCTAssertFalse(vectors.isEmpty)
        for v in vectors {
            let name = try XCTUnwrap(v["name"] as? String)
            XCTAssertEqual(CensusDuplicates.nameTokens(name), Set(try XCTUnwrap(v["tokens"] as? [String])), name)
        }
    }

    func testPhoneKeyVectors() throws {
        let vectors = try XCTUnwrap(fixture()["phoneKeyVectors"] as? [[String: Any]])
        XCTAssertFalse(vectors.isEmpty)
        for v in vectors {
            let phone = try XCTUnwrap(v["phone"] as? String)
            XCTAssertEqual(CensusDuplicates.phoneKey(phone), v["key"] as? String, phone)
        }
    }

    func testEveryPairVector() throws {
        let vectors = try XCTUnwrap(fixture()["pairVectors"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(vectors.count, 9)
        for v in vectors {
            let label = v["label"] as? String ?? "?"
            let q = try XCTUnwrap(v["query"] as? [String: Any]), e = try XCTUnwrap(v["existing"] as? [String: Any])
            let expect = try XCTUnwrap(v["expect"] as? [String: Any])
            let query = CensusDuplicates.Query(name: q["name"] as! String, phone: q["phone"] as? String,
                latitude: number(q["latitude"]), longitude: number(q["longitude"]), placeId: q["placeId"] as? String)
            let existing = CensusDuplicates.Existing(name: e["name"] as! String, phone: e["phone"] as? String,
                latitude: number(e["latitude"]), longitude: number(e["longitude"]), placeId: e["placeId"] as? String)
            let m = CensusDuplicates.match(query, existing)
            XCTAssertEqual(m.isCandidate, expect["isCandidate"] as? Bool, label)
            XCTAssertEqual(m.reasons, expect["reasons"] as? [String], label)
            XCTAssertEqual(m.distanceMeters, number(expect["distanceMeters"]), label)
            XCTAssertEqual(m.nameSimilarity, try XCTUnwrap(number(expect["nameSimilarity"])), label)
        }
    }

    func testScoreSortCapAndMerge() {
        let q = CensusDuplicates.Query(name: "Aling Nena Sari-Sari Store", phone: "0917 123 4567", latitude: 10.3157, longitude: 123.8854)
        var existing = [CensusDuplicates.Existing(id: "near", name: "ALING NENA STORE", latitude: 10.31585, longitude: 123.88545),
                        CensusDuplicates.Existing(id: "phone", name: "Other", phone: "+63 917-123-4567", latitude: 10.4, longitude: 123.95),
                        CensusDuplicates.Existing(id: "far", name: "Bebot", latitude: 10.5, longitude: 123.9)]
        for i in 0..<12 { existing.append(.init(id: "n\(i)", name: "JM \(i)", latitude: 10.3157 + Double(i) * 0.00005, longitude: 123.8854)) }
        let found = CensusDuplicates.candidates(q, among: existing)
        XCTAssertEqual(found.count, 10, "at most 10")
        XCTAssertEqual(found.first?.id, "near")
        XCTAssertEqual(found.first?.score, 80 + 30, "very close (≤25 m) + full name match")
        XCTAssertEqual(found[1].id, "phone"); XCTAssertEqual(found[1].score, 90)
        XCTAssertFalse(found.contains { $0.id == "far" })
        let server = [CensusCandidate(kind: "capture", id: "cap", name: "Nena", address: nil, latitude: nil, longitude: nil,
                                      distanceMeters: nil, reasons: ["phone"], score: 90),
                      CensusCandidate(kind: "outlet", id: "near", name: "ALING NENA STORE", address: "x", latitude: nil, longitude: nil,
                                      distanceMeters: 17.6, reasons: ["nearby", "name"], score: 110)]
        let merged = CensusDuplicates.merge(local: found, server: server)
        XCTAssertEqual(merged.filter { $0.id == "near" }.count, 1, "deduplicated by id")
        XCTAssertEqual(merged.first { $0.id == "near" }?.address, "x", "server copy wins")
        XCTAssertEqual(merged.prefix(3).map(\.id), ["near", "phone", "cap"], "phone 90 with a distance before unknown distance")
        XCTAssertEqual(CensusDuplicates.reasonText(["phone", "nearby", "name", "place"]),
                       "Same phone number · Very close by · Same name nearby · Same place on Google")
    }
}

/// SP-0164: the `census.capture` payload, config parsing and the offline queue.
@MainActor
final class CensusCaptureTests: XCTestCase {
    private var directory: URL!
    private var secrets: KeychainStore!
    private var store: EncryptedFieldStore!
    private var partition: StorePartition!
    private var model: AppModel!
    private var clock: TestClock!
    private static let channel = "6f1d2c3b-0000-4000-8000-00000000c001"
    private static let sub = "6f1d2c3b-0000-4000-8000-00000000c002"

    override func setUp() async throws {
        try await super.setUp()
        clock = TestClock(Date())
        directory = FileManager.default.temporaryDirectory.appending(path: "census-\(UUID().uuidString)")
        secrets = KeychainStore(service: "com.sunpride.field.census.tests.\(UUID().uuidString)")
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        partition = try StorePartition(subject: "test|seller", deviceId: "phone", scope: "scope")
        let expiry = Int64(clock.now.addingTimeInterval(3_600).timeIntervalSince1970 * 1000)
        try store.saveSnapshot(.init(employee: .init(id: "seller", role: "sales", orgUnitId: "unit"), visits: [],
            outlets: [.init(id: "o1", name: "Aling Nena Store", routeId: nil, address: "Near the chapel",
                            location: .init(latitude: 10.31585, longitude: 123.88545))],
            customers: [], route: nil, tasks: []),
            cursor: "cursor", leaseExpiresAt: expiry, cacheExpiresAt: expiry, for: partition)
        try secrets.save(Data("test-session".utf8), for: StoreAccount.session)
        let registry = FakeRegistry()
        registry.lastMine = .success(MineResult(deviceId: "phone", status: "active", bound: true, allowedApp: "field-ios"))
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        model = AppModel(auth: AuthClient(site: StubHTTP.site, store: secrets, http: StubHTTP.client()),
            registry: registry, store: secrets, localStore: store, now: clock.closure) { key }
        await model.launch()
        _ = try model.storage(for: partition)
        model.refreshToday()
    }
    override func tearDown() async throws {
        model.enrollment.signedOut()
        model = nil
        store.close()
        try? secrets.delete("db")
        try? secrets.delete(StoreAccount.session)
        try? FileManager.default.removeItem(at: directory)
        try await super.tearDown()
    }

    private func jpeg() -> Data {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 48)).image { c in
            UIColor.gray.setFill(); c.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
        }
        return CensusPhoto.jpeg(image)!
    }
    private func fix(accuracy: Double = 12, ageMs: Int64 = 1_000, mock: Bool = false) throws -> VisitLocation {
        try VisitLocation(latitude: 10.3157, longitude: 123.8854, accuracyMeters: accuracy,
                          fixTime: Int64(clock.now.timeIntervalSince1970 * 1000) - ageMs, mockSignal: mock)
    }
    private func draft() throws -> CensusCapture.Draft {
        var d = CensusCapture.Draft()
        d.name = " Aling Nena Sari-Sari Store "; d.address = "8 Osmeña Blvd"; d.ownerName = "Nena"; d.ownerPhone = "0917 123 4567"
        d.channelId = Self.channel; d.subchannelId = Self.sub; d.estimatedClass = "C"
        d.location = .gps(try fix()); d.photo = jpeg()
        return d
    }

    func testGpsPayloadShape() throws {
        var d = try draft()
        d.landmark = "beside the chapel"; d.acknowledgedDuplicateIds = ["o1"]
        d.resolved = PlaceAddress(formattedAddress: "8 Osmeña Blvd, Cebu City", street: "8 Osmeña Blvd", city: "Cebu City")
        let p = try CensusCapture.payload(d, now: clock.now)
        XCTAssertEqual(p["name"] as? String, "Aling Nena Sari-Sari Store", "trimmed")
        XCTAssertEqual(p["locationSource"] as? String, "gps")
        XCTAssertNil(p["batchId"], "default batch: batchId omitted")
        XCTAssertNil(p["placeId"])
        let l = try XCTUnwrap(p["location"] as? [String: Any])
        XCTAssertEqual(l["accuracyMeters"] as? Double, 12)
        XCTAssertEqual(l["mockSignal"] as? Bool, false)
        XCTAssertEqual(l["provider"] as? String, "fused")
        XCTAssertEqual(p["landmark"] as? String, "beside the chapel")
        XCTAssertEqual(p["acknowledgedDuplicateIds"] as? [String], ["o1"])
        XCTAssertEqual((p["addressComponents"] as? [String: String])?["city"], "Cebu City")
        XCTAssertNil((p["addressComponents"] as? [String: Any])?["barangay"], "missing parts are omitted")
        XCTAssertEqual(p["formattedAddress"] as? String, "8 Osmeña Blvd, Cebu City")
        XCTAssertTrue(CensusCapture.validStored(p, now: clock.now))
        let intent = try CensusCapture.intent(p)
        let op = try XCTUnwrap(JSONSerialization.jsonObject(with: intent.operationJSON) as? [String: Any])
        XCTAssertEqual(op["kind"] as? String, "census.capture")
        XCTAssertEqual(op["clientRequestId"] as? String, p["captureId"] as? String)
        let wire = try NativeV2.operation(op)
        XCTAssertEqual(wire["opType"] as? String, "census.capture")
        XCTAssertEqual((wire["clientTime"] as? Int64), p["deviceTime"] as? Int64)
    }

    func testPlacesPayloadCarriesThePlaceAndNoGpsRules() throws {
        var d = try draft()
        d.batchId = "6f1d2c3b-0000-4000-8000-00000000b001"
        d.location = .places(PlaceDetails(placeId: "ChIJ-1", address: PlaceAddress(formattedAddress: "SM Seaside"), latitude: 10.28, longitude: 123.88))
        let p = try CensusCapture.payload(d, now: clock.now)
        XCTAssertEqual(p["locationSource"] as? String, "places")
        XCTAssertEqual(p["placeId"] as? String, "ChIJ-1")
        XCTAssertEqual(p["batchId"] as? String, "6f1d2c3b-0000-4000-8000-00000000b001")
        let l = try XCTUnwrap(p["location"] as? [String: Any])
        XCTAssertEqual(Set(l.keys), ["latitude", "longitude"])
        XCTAssertTrue(CensusCapture.validStored(p, now: clock.now))
    }

    func testRefusesWeakMockOldFixesAndBadInput() throws {
        func refused(_ change: (inout CensusCapture.Draft) throws -> Void) throws -> CensusCapture.Failure? {
            var d = try draft(); try change(&d)
            do { _ = try CensusCapture.payload(d, now: clock.now); return nil } catch { return error as? CensusCapture.Failure }
        }
        XCTAssertEqual(try refused { $0.location = .gps(try fix(accuracy: 50)) }, .location, "must be under 50 m")
        XCTAssertNil(try refused { $0.location = .gps(try fix(accuracy: 49.9)) })
        XCTAssertEqual(try refused { $0.location = .gps(try fix(mock: true)) }, .location)
        XCTAssertEqual(try refused { $0.location = .gps(try fix(ageMs: 121_000)) }, .location, "fix within 2 min")
        XCTAssertEqual(try refused { $0.location = nil }, .location)
        XCTAssertEqual(try refused { $0.photo = nil }, .photo)
        XCTAssertEqual(try refused { $0.photo = Data([0xFF, 0xD8] + [UInt8](repeating: 0, count: 160 * 1024) + [0xFF, 0xD9]) }, .photo, "≤ 160 KiB")
        XCTAssertEqual(try refused { $0.photo = Data("not a jpeg".utf8) }, .photo)
        XCTAssertEqual(try refused { $0.name = "  " }, .details)
        XCTAssertEqual(try refused { $0.ownerPhone = "12-34" }, .phone)
        XCTAssertEqual(try refused { $0.subchannelId = nil }, .channel)
        XCTAssertEqual(try refused { $0.batchId = "not-a-uuid" }, .batch)
        XCTAssertEqual(try refused { $0.landmark = String(repeating: "x", count: 201) }, .landmark)
    }

    func testBoundedPhotoFromALargeCameraImage() {
        let big = UIGraphicsImageRenderer(size: CGSize(width: 4000, height: 3000)).image { c in
            for i in 0..<300 { UIColor(hue: CGFloat(i) / 300, saturation: 1, brightness: 1, alpha: 1).setFill()
                c.fill(CGRect(x: i * 13 % 4000, y: i * 7 % 3000, width: 97, height: 61)) }
        }
        let data = CensusPhoto.jpeg(big)
        XCTAssertNotNil(data)
        XCTAssertLessThanOrEqual(data?.count ?? .max, 160 * 1024)
        XCTAssertTrue(CensusCapture.isJpeg(data ?? Data()))
    }

    func testConfigParsingAndBatchPickerRule() throws {
        let old = try CensusConfig(json: Data(#"{"batches":[{"id":"b1","name":"North"}],"channels":[{"id":"c1","label":"GT","data":{}}],"subchannels":[{"id":"s1","label":"Sari","data":{"channelId":"c1"}},{"id":"s2","label":"Other","data":{"channelId":"c2"}}]}"#.utf8))
        XCTAssertFalse(old.supportsGathering); XCTAssertFalse(old.addressSearch); XCTAssertTrue(old.showsBatchPicker)
        XCTAssertEqual(old.subchannels(of: "c1").map(\.id), ["s1"])
        XCTAssertEqual(old.subchannels(of: nil), [])
        let new = try CensusConfig(json: Data(#"{"batches":[{"id":"b1","name":"Ongoing"}],"channels":[],"subchannels":[],"defaultBatch":{"id":"b1","name":"Ongoing"},"addressSearch":true}"#.utf8))
        XCTAssertTrue(new.supportsGathering); XCTAssertTrue(new.addressSearch); XCTAssertFalse(new.showsBatchPicker)
        let two = try CensusConfig(json: Data(#"{"batches":[{"id":"b1","name":"A"},{"id":"b2","name":"B"}],"channels":[],"subchannels":[],"defaultBatch":{"id":"b1","name":"A"}}"#.utf8))
        XCTAssertTrue(two.showsBatchPicker, "more than one batch: picker shown")
        let none = try CensusConfig(json: Data(#"{"batches":[],"channels":[],"subchannels":[],"defaultBatch":null}"#.utf8))
        XCTAssertTrue(none.supportsGathering); XCTAssertTrue(none.showsBatchPicker, "no default batch: shown as today")
    }

    func testPlaceAddressFromWire() throws {
        let a = try XCTUnwrap(PlaceAddress(wire: ["formattedAddress": "12 Rizal St, Brgy Uno, Cebu City",
            "components": ["street": "12 Rizal St", "barangay": "Brgy Uno", "city": "Cebu City", "province": NSNull()]]))
        XCTAssertEqual(a.addressLine, "12 Rizal St, Brgy Uno, Cebu City")
        XCTAssertEqual(a.areaLine, "Brgy Uno, Cebu City")
        XCTAssertNil(a.province)
        XCTAssertEqual(Set(a.components.keys), ["street", "barangay", "city"])
        XCTAssertNil(PlaceAddress(wire: ["components": [:]]))
    }

    func testQueuesOfflineInTheEncryptedOutboxAndShowsSaved() throws {
        try model.queueCensus(try draft())
        let pending = try store.pendingOutbox(for: partition)
        XCTAssertEqual(pending.map(\.intent.kind), ["census.capture"])
        XCTAssertEqual(model.censusCaptures().map(\.name), ["Aling Nena Sari-Sari Store"])
        XCTAssertEqual(model.censusCaptures().first?.state, "Saved on phone · waiting to send")
        XCTAssertEqual(model.syncStatus?.queued, 1)
        // The visit flow is unaffected: no visit starts from a store capture.
        XCTAssertTrue(model.visits.allSatisfy { $0.startedAt == nil })
    }

    func testStoreRefusesAnIncompleteOrDependentCapture() throws {
        var p = try CensusCapture.payload(try draft(), now: clock.now)
        p["photoJpegBase64"] = ""
        XCTAssertThrowsError(try store.enqueue(try CensusCapture.intent(p), for: partition, now: clock.now))
        let good = try CensusCapture.payload(try draft(), now: clock.now)
        let id = try XCTUnwrap(good["captureId"] as? String)
        let dependent: [String: Any] = ["clientRequestId": id, "kind": "census.capture", "dependsOn": [UUID().uuidString.lowercased()], "payload": good]
        let intent = VisitIntent(requestId: UUID(uuidString: id)!, kind: "census.capture",
                                 operationJSON: try JSONSerialization.data(withJSONObject: dependent))
        XCTAssertThrowsError(try store.enqueue(intent, for: partition, now: clock.now))
        // Day access closed: refused like visits.
        clock.advance(7_200)
        var late = try draft(); late.location = .gps(try fix())
        XCTAssertThrowsError(try model.queueCensus(late)) { XCTAssertEqual($0 as? StoreError, .leaseExpired) }
    }

    func testLocalDuplicateUsesThePhonesOutlets() throws {
        let existing = model.censusExisting
        XCTAssertEqual(existing.map(\.id), ["o1"])
        let found = CensusDuplicates.candidates(.init(name: "Aling Nena Sari-Sari Store", phone: nil, latitude: 10.3157, longitude: 123.8854),
                                                among: existing)
        XCTAssertEqual(found.first?.id, "o1")
        XCTAssertEqual(found.first?.reasons, ["nearby", "name"])
    }

    func testConfigIsSavedAndUsedOfflineAndDroppedOnRefusal() async throws {
        let service = FakeCensusService()
        model.censusServiceOverride = service
        service.configResult = .success(Data(#"{"batches":[],"channels":[],"subchannels":[],"defaultBatch":null,"addressSearch":false}"#.utf8))
        var result = await model.loadCensusConfig()
        XCTAssertNotNil(result.config); XCTAssertFalse(result.saved)
        service.configResult = .failure(CensusServiceError.offline)
        result = await model.loadCensusConfig()
        XCTAssertNotNil(result.config, "offline: the saved setup"); XCTAssertTrue(result.saved)
        service.configResult = .failure(MobileError.rejected("forbidden"))
        result = await model.loadCensusConfig()
        XCTAssertNil(result.config)
        service.configResult = .failure(CensusServiceError.offline)
        result = await model.loadCensusConfig()
        XCTAssertNil(result.config, "a refusal drops the saved copy")
    }

    func testServerServiceMapsStatusesToPlainOutcomes() async throws {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        StubURLProtocol.install { r in
            func err(_ status: Int, _ code: String) -> StubURLProtocol.Outcome {
                .reply(.json(status, ["version": 2, "serverTime": now, "error": ["code": code, "retryable": false, "action": "none"]]))
            }
            switch r.path {
            case "/api/auth/refresh":
                return .reply(.json(200, ["version": 2, "serverTime": now, "accessToken": "t", "accessExpiresAt": now + 900_000]))
            case "/api/v1/places/autocomplete": return err(503, "places_unavailable")
            case "/api/v1/places/details": return err(502, "places_unavailable")
            case "/api/v1/places/reverse": return err(404, "not_found")
            case "/api/v1/masters/census/duplicate-check": return err(404, "not_found")
            case "/api/v1/masters/census-config": return .fail(.notConnectedToInternet)
            default: return err(404, "not_found")
            }
        }
        let auth = AuthClient(site: StubHTTP.site, store: secrets, http: StubHTTP.client())
        let service = ServerCensusService(api: ServerAPI(url: StubHTTP.site, auth: auth, http: StubHTTP.client()))
        func failure(_ work: () async throws -> Void) async -> Error? { do { try await work(); return nil } catch { return error } }
        let session = UUID()
        var e = await failure { _ = try await service.autocomplete(input: "Rizal", session: session, near: (10.3, 123.9)) }
        XCTAssertEqual(e as? CensusServiceError, .unavailable("Address search is not set up."))
        let ask = try XCTUnwrap(StubURLProtocol.rawRequests.last { $0.path == "/api/v1/places/autocomplete" })
        XCTAssertEqual(ask.method, "GET")
        XCTAssertTrue(ask.headers["Authorization"]?.hasPrefix("Bearer ") == true, "our API with the normal bearer")
        e = await failure { _ = try await service.details(placeId: "p", session: session) }
        XCTAssertEqual(e as? CensusServiceError, .unavailable("Address search is not available right now."))
        let reversed = try await service.reverse(latitude: 10.3, longitude: 123.9)
        XCTAssertNil(reversed, "Google has nothing: no address, not an error")
        e = await failure { _ = try await service.duplicateCheck(["name": "x"]) }
        XCTAssertEqual(e as? CensusServiceError, .unsupported, "older server: skip the online check")
        e = await failure { _ = try await service.config() }
        XCTAssertEqual(e as? CensusServiceError, .offline)
        XCTAssertFalse(StubURLProtocol.rawRequests.contains { $0.headers.values.contains { $0.contains("maps.googleapis") } || ($0.path.contains("maps")) },
                       "phones never call Google directly")
    }
}

@MainActor
final class FakeCensusService: CensusService {
    var configResult: Result<Data, Error> = .failure(CensusServiceError.offline)
    var sessions: [UUID] = []
    func config() async throws -> Data { try configResult.get() }
    func autocomplete(input: String, session: UUID, near: (Double, Double)?) async throws -> [PlacePrediction] { sessions.append(session); return [] }
    func details(placeId: String, session: UUID) async throws -> PlaceDetails { throw CensusServiceError.offline }
    func reverse(latitude: Double, longitude: Double) async throws -> PlaceAddress? { nil }
    func duplicateCheck(_ body: [String: Any]) async throws -> [CensusCandidate] { [] }
}
