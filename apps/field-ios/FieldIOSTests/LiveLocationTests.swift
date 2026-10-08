import CryptoKit
import XCTest
@testable import FieldIOS

/// SP-0138: work-day live location — policy, cadence, wire shape, encrypted buffer, signed upload, controller.
@MainActor
final class LiveLocationTests: XCTestCase {
    private var directory: URL!
    private var secrets: KeychainStore!
    private var store: EncryptedFieldStore!
    private var partition: StorePartition!

    override func setUp() async throws {
        try await super.setUp()
        directory = FileManager.default.temporaryDirectory.appending(path: "live-location-\(UUID().uuidString)")
        secrets = KeychainStore(service: "com.sunpride.live.tests.\(UUID().uuidString)")
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        partition = try StorePartition(subject: "issuer|seller", deviceId: "device-1", scope: "scope-1")
    }
    override func tearDown() async throws {
        store.close()
        try? secrets.delete("db")
        try? secrets.delete(StoreAccount.session)
        try? FileManager.default.removeItem(at: directory)
        try await super.tearDown()
    }

    /// Manila wall-clock instant on 2026-10-08.
    private func manila(_ hour: Int, _ minute: Int = 0, day: Int = 8) -> Date {
        var parts = DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute)
        parts.timeZone = FieldDay.timeZone
        return FieldDay.calendar.date(from: parts)!
    }
    private func fix(_ north: Double = 0, speed: Double? = nil, at: Date = Date()) -> LiveFix {
        LiveFix(latitude: 10.3157 + north / 111_195, longitude: 123.8854, accuracyMeters: 8,
                speedMetersPerSecond: speed, headingDegrees: 90, mockLocation: false, timestamp: at)!
    }
    private func fixture(_ name: String) throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    // MARK: Policy

    func testWorkHoursAreFiveAmToTenPmManila() {
        XCTAssertFalse(LiveLocationPolicy.withinWorkHours(manila(4, 59)))
        XCTAssertTrue(LiveLocationPolicy.withinWorkHours(manila(5)))
        XCTAssertTrue(LiveLocationPolicy.withinWorkHours(manila(21, 59)))
        XCTAssertFalse(LiveLocationPolicy.withinWorkHours(manila(22)))
    }

    func testDecisionSharesOnlyDuringAnOpenWorkDayWithConsent() {
        let now = manila(10)
        let open = WorkDay(serviceDate: "2026-10-08", startedAt: 1)
        func decide(signedIn: Bool = true, ready: Bool = true, held: Bool = false, consent: LocationConsent = .accepted,
                    day: WorkDay? = open, at: Date? = nil) -> LiveSharingDecision {
            .decide(signedIn: signedIn, ready: ready, held: held, consent: consent, day: day, now: at ?? now)
        }
        XCTAssertEqual(decide(), .share)
        XCTAssertEqual(decide(signedIn: false), .off(.notSignedIn))
        XCTAssertEqual(decide(ready: false), .off(.phoneNotReady))
        XCTAssertEqual(decide(held: true), .off(.held))
        XCTAssertEqual(decide(consent: .unanswered), .off(.noConsent))
        XCTAssertEqual(decide(consent: .declined), .off(.noConsent))
        XCTAssertEqual(decide(day: nil), .off(.dayNotStarted))
        XCTAssertEqual(decide(day: WorkDay(serviceDate: "2026-10-07", startedAt: 1)), .off(.dayNotStarted))
        XCTAssertEqual(decide(day: WorkDay(serviceDate: "2026-10-08", startedAt: 1, endedAt: 2, endReason: .endDay)), .off(.dayEnded))
        XCTAssertEqual(decide(at: manila(22, 1)), .off(.outsideHours))
    }

    func testSamplerCadenceMovingStillAndServerSpacing() {
        let t0 = manila(9)
        let last = PingSampler.Last(fix: fix(), at: t0)
        XCTAssertEqual(PingSampler.trigger(last: nil, fix: fix(), now: t0), .start)
        // Never under the server's 10 s spacing, even after a big move.
        XCTAssertNil(PingSampler.trigger(last: last, fix: fix(200), now: t0.addingTimeInterval(9)))
        XCTAssertEqual(PingSampler.trigger(last: last, fix: fix(60), now: t0.addingTimeInterval(11)), .moving)
        // Moving slowly within 50 m: once a minute.
        XCTAssertNil(PingSampler.trigger(last: last, fix: fix(20, speed: 2), now: t0.addingTimeInterval(59)))
        XCTAssertEqual(PingSampler.trigger(last: last, fix: fix(20, speed: 2), now: t0.addingTimeInterval(60)), .moving)
        // Still: every 5 minutes.
        XCTAssertNil(PingSampler.trigger(last: last, fix: fix(5), now: t0.addingTimeInterval(299)))
        XCTAssertEqual(PingSampler.trigger(last: last, fix: fix(5), now: t0.addingTimeInterval(300)), .still)
    }

    // MARK: Wire

    func testPingWireMatchesTheSharedContractFixture() throws {
        let pings = try XCTUnwrap(fixture("location-request")["pings"] as? [[String: Any]])
        XCTAssertEqual(try fixture("location-request")["type"] as? String, "location.request")
        let third = pings[2]
        let source = try XCTUnwrap(LiveFix(latitude: third["latitude"] as! Double, longitude: third["longitude"] as! Double,
            accuracyMeters: (third["accuracyMeters"] as! NSNumber).doubleValue,
            speedMetersPerSecond: (third["speedMetersPerSecond"] as! NSNumber).doubleValue,
            headingDegrees: (third["headingDegrees"] as! NSNumber).doubleValue, mockLocation: false, timestamp: Date()))
        let ping = LivePing(clientPingId: UUID(uuidString: third["clientPingId"] as! String)!, fix: source,
            at: Date(timeIntervalSince1970: (third["recordedAt"] as! NSNumber).doubleValue / 1000),
            trigger: .moving, batteryPercent: nil, visitId: nil)
        XCTAssertEqual(ping.wireObject as NSDictionary, third as NSDictionary)
        // With a visit: the same keys as the fixture's first ping (visitId present, nulls explicit).
        let first = pings[0]
        let withVisit = LivePing(fix: source, at: Date(), trigger: .start, batteryPercent: 84, visitId: "visit-cebu-001")
        XCTAssertEqual(Set(withVisit.wireObject.keys), Set(first.keys))
        XCTAssertEqual(withVisit.wireObject["provider"] as? String, "fused")
        XCTAssertEqual(Set(ping.wireObject.keys), Set(first.keys).subtracting(["visitId"]))
        // The response fixture decodes per ping.
        let results = try XCTUnwrap(fixture("location-response")["results"] as? [[String: Any]])
        XCTAssertEqual(results.map { $0["status"] as? String }, ["accepted", "duplicate", "rejected"])
    }

    func testFixRejectsInvalidCoordinatesAndNullsUnknownMotion() {
        XCTAssertNil(LiveFix(latitude: 91, longitude: 0, accuracyMeters: 5, speedMetersPerSecond: nil, headingDegrees: nil,
                             mockLocation: false, timestamp: Date()))
        XCTAssertNil(LiveFix(latitude: 0, longitude: 0, accuracyMeters: -1, speedMetersPerSecond: nil, headingDegrees: nil,
                             mockLocation: false, timestamp: Date()))
        let odd = LiveFix(latitude: 0, longitude: 0, accuracyMeters: 5, speedMetersPerSecond: -1, headingDegrees: 400,
                          mockLocation: true, timestamp: Date())!
        XCTAssertNil(odd.speedMetersPerSecond)
        XCTAssertNil(odd.headingDegrees)
        let ping = LivePing(fix: odd, at: Date(), trigger: .still, batteryPercent: 140, visitId: String(repeating: "x", count: 65))
        XCTAssertTrue(ping.wireObject["speedMetersPerSecond"] is NSNull)
        XCTAssertTrue(ping.wireObject["batteryPercent"] is NSNull)
        XCTAssertNil(ping.wireObject["visitId"])
        XCTAssertEqual(ping.wireObject["mockLocation"] as? Bool, true)
        XCTAssertNil(LivePing.batteryPercent(level: -1))
        XCTAssertEqual(LivePing.batteryPercent(level: 0.837), 84)
    }

    // MARK: Encrypted buffer

    func testBufferIsOrderedPartitionedAndRefusedWhenHeld() throws {
        let other = try StorePartition(subject: "issuer|other", deviceId: "device-1", scope: "scope-1")
        let later = LivePing(fix: fix(), at: manila(9, 5), trigger: .moving, batteryPercent: 50, visitId: nil)
        let earlier = LivePing(fix: fix(), at: manila(9), trigger: .start, batteryPercent: 51, visitId: nil)
        try store.enqueuePing(later, for: partition)
        try store.enqueuePing(earlier, for: partition)
        try store.enqueuePing(earlier, for: partition) // Same ID: stored once.
        try store.enqueuePing(LivePing(fix: fix(), at: manila(9), trigger: .start, batteryPercent: nil, visitId: nil), for: other)
        XCTAssertEqual(try store.pendingPings(for: partition, limit: 100), [earlier, later])
        XCTAssertEqual(try store.pingCount(for: other), 1)
        try store.removePings([earlier.clientPingId], for: partition)
        XCTAssertEqual(try store.pendingPings(for: partition, limit: 100), [later])
        try store.dropPings(recordedBefore: later.recordedAt + 1, for: partition)
        XCTAssertEqual(try store.pingCount(for: partition), 0)
        XCTAssertEqual(try store.pingCount(for: other), 1)
        try store.holdForReview(partition)
        XCTAssertThrowsError(try store.enqueuePing(later, for: partition))
        XCTAssertThrowsError(try store.startWorkDay("2026-10-08", at: 1, for: partition))
    }

    func testWorkDayStartsEndsAndReopens() throws {
        XCTAssertNil(try store.workDay("2026-10-08", for: partition))
        let day = try store.startWorkDay("2026-10-08", at: 100, for: partition)
        XCTAssertTrue(day.isOpen)
        try store.startWorkDay("2026-10-08", at: 200, for: partition)
        XCTAssertEqual(try store.workDay("2026-10-08", for: partition)?.startedAt, 100)
        try store.endWorkDay("2026-10-08", at: 300, reason: .endDay, for: partition)
        try store.endWorkDay("2026-10-08", at: 400, reason: .signOut, for: partition) // First end wins.
        XCTAssertEqual(try store.workDay("2026-10-08", for: partition),
                       WorkDay(serviceDate: "2026-10-08", startedAt: 100, endedAt: 300, endReason: .endDay))
        XCTAssertTrue(try store.startWorkDay("2026-10-08", at: 500, for: partition).isOpen)
    }

    func testV7ToV8MigrationKeepsDataAndAddsLiveTables() throws {
        try store.setSyncHealth(SyncHealth(lastSuccessfulSyncAt: 1_760_000_000_000, lastErrorCode: nil), for: partition)
        try store.prepareLegacyV7()
        XCTAssertEqual(store.schemaVersion, 7)
        store.close()
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        XCTAssertEqual(store.schemaVersion, 8)
        XCTAssertEqual(try store.syncHealth(for: partition)?.lastSuccessfulSyncAt, 1_760_000_000_000)
        try store.enqueuePing(LivePing(fix: fix(), at: Date(), trigger: .start, batteryPercent: nil, visitId: nil), for: partition)
        XCTAssertEqual(try store.pingCount(for: partition), 1)
        // Pings are encrypted at rest with the rest of the database.
        store.close()
        let bytes = try Data(contentsOf: directory.appending(path: "field.sqlite"))
        XCTAssertNil(bytes.range(of: Data("location_pings".utf8)))
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
    }

    // MARK: Signed upload

    private func client(http: HTTPClient, key: SoftwareDeviceKey) throws -> VisitSyncClient {
        try secrets.save(Data("session".utf8), for: StoreAccount.session)
        let auth = AuthClient(site: StubHTTP.site, store: secrets, http: http)
        return VisitSyncClient(site: StubHTTP.site, auth: auth,
            registry: ConvexDeviceRegistry(functions: ConvexFunctions(url: StubHTTP.cloud, auth: auth, http: http)),
            http: http, key: key)
    }
    private func install(_ location: @escaping @Sendable (StubURLProtocol.Recorded) -> StubURLProtocol.Outcome) {
        let jwt = StubHTTP.jwt(exp: Date().timeIntervalSince1970 + 900)
        StubURLProtocol.install { request in
            switch request.path {
            case "/api/auth/convex/token": return .reply(.json(200, ["token": jwt]))
            case "/api/mutation": return .reply(.json(200, ["status": "success", "value": [
                "nonce": UUID().uuidString.lowercased(), "expiresAt": Date().timeIntervalSince1970 * 1000 + 60_000]]))
            default: return location(request)
            }
        }
    }

    func testUploadSignsBatchAndRemovesEveryAnsweredPing() async throws {
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        let now = Date()
        let pings = (0..<3).map { LivePing(fix: fix(Double($0) * 60), at: now.addingTimeInterval(Double($0) * 60 - 600),
                                            trigger: $0 == 0 ? .start : .moving, batteryPercent: 70, visitId: nil) }
        for ping in pings { try store.enqueuePing(ping, for: partition) }
        install { request in
            let body = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any]
            let sent = body?["pings"] as? [[String: Any]] ?? []
            let statuses = ["accepted", "duplicate", "rejected"]
            return .reply(.json(200, ["type": "location.response", "contractVersion": 1, "serverTime": 1_800_000_000_000,
                "results": sent.enumerated().map { index, ping in
                    var result: [String: Any] = ["clientPingId": ping["clientPingId"]!, "status": statuses[index % 3]]
                    if index % 3 == 2 { result["code"] = "too_frequent" }
                    return result
                }]))
        }
        let rejected = try await client(http: StubHTTP.client(), key: key).pushLocation(store: store, partition: partition)
        XCTAssertEqual(rejected, ["too_frequent"])
        XCTAssertEqual(try store.pingCount(for: partition), 0)
        let request = try XCTUnwrap(StubURLProtocol.requests(to: "/mobile/v1/location").first)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        XCTAssertEqual(body["type"] as? String, "location.request")
        XCTAssertEqual(body["deviceId"] as? String, "device-1")
        XCTAssertEqual((body["pings"] as? [[String: Any]])?.map { $0["clientPingId"] as? String },
                       pings.map { $0.clientPingId.uuidString.lowercased() })
        let headers = Dictionary(uniqueKeysWithValues: request.headers.map { ($0.key.lowercased(), $0.value) })
        let digest = RequestSigner.bodyDigest(request.body)
        XCTAssertEqual(headers["x-mobile-body-digest"], digest)
        let message = "POST|/mobile/v1/location|\(digest)|\(headers["x-mobile-nonce"]!)|\(headers["x-mobile-timestamp"]!)"
        XCTAssertTrue(DeviceKeys.verify(signatureBase64: try XCTUnwrap(headers["x-mobile-signature"]),
                                        message: Data(message.utf8), spkiBase64: key.publicKeyBase64))
    }

    func testUploadKeepsPingsOnFailureOrMismatchAndSkipsHeld() async throws {
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        let ping = LivePing(fix: fix(), at: Date().addingTimeInterval(-60), trigger: .start, batteryPercent: nil, visitId: nil)
        try store.enqueuePing(ping, for: partition)
        // A result for some other ping is not an answer for this one.
        install { _ in .reply(.json(200, ["type": "location.response", "contractVersion": 1, "serverTime": 1,
            "results": [["clientPingId": UUID().uuidString.lowercased(), "status": "accepted"]]])) }
        let sync = try client(http: StubHTTP.client(), key: key)
        do { try await sync.pushLocation(store: store, partition: partition); XCTFail("mismatch accepted") }
        catch VisitSyncClient.Failure.invalidResponse {}
        XCTAssertEqual(try store.pendingPings(for: partition, limit: 10), [ping])
        install { _ in .fail(.notConnectedToInternet) }
        do { try await sync.pushLocation(store: store, partition: partition); XCTFail("offline accepted") }
        catch VisitSyncClient.Failure.retryable {}
        XCTAssertEqual(try store.pendingPings(for: partition, limit: 10), [ping])
        // A buffered ping older than the server's 7-day limit is dropped on the phone instead of sent.
        let stale = LivePing(fix: fix(), at: Date().addingTimeInterval(-8 * 86_400), trigger: .still, batteryPercent: nil, visitId: nil)
        try store.enqueuePing(stale, for: partition)
        try store.holdForReview(partition)
        install { _ in XCTFail("held partition uploaded"); return .fail(.badServerResponse) }
        try await sync.pushLocation(store: store, partition: partition)
        XCTAssertEqual(try store.pingCount(for: partition), 2)
    }

    // MARK: Controller

    @MainActor private final class FakeSource: LiveLocationSource {
        var onFix: ((LiveFix) -> Void)?
        var onAuthorization: ((LiveAuthorization) -> Void)?
        var authorization: LiveAuthorization = .notDetermined
        var grant: LiveAuthorization = .always
        var lastFix: LiveFix?
        var running = false
        var permissionRequests = 0
        var lowPower = false
        /// Core Location may already hold a fix and deliver it from inside `start()`.
        var fixOnStart: LiveFix?
        func requestPermission() { permissionRequests += 1; authorization = grant; onAuthorization?(grant) }
        func start() { running = true; if let fixOnStart { send(fixOnStart) } }
        func stop() { running = false }
        func setLowPower(_ low: Bool) { lowPower = low }
        func batteryPercent() -> Int? { 77 }
        func send(_ fix: LiveFix) { lastFix = fix; onFix?(fix) }
    }
    @MainActor private final class MemoryConsents: LocationConsentStore {
        var saved: [String: LocationConsent] = [:]
        func consent(subject: String) -> LocationConsent { saved[subject] ?? .unanswered }
        func setConsent(_ consent: LocationConsent, subject: String, at: Date) { saved[subject] = consent }
    }
    private final class Clock { var now: Date; init(_ now: Date) { self.now = now } }
    private final class Uploads { var count = 0 }
    /// Lets fire-and-forget upload tasks started by fixes finish before counting.
    private func drain() async { for _ in 0..<20 { await Task.yield() } }

    private func controller(at clock: Clock, source: FakeSource, consents: MemoryConsents = MemoryConsents(),
                            uploads: Uploads = Uploads()) -> LiveLocationController {
        let live = LiveLocationController(source: source, consents: consents, now: { clock.now })
        live.upload = { uploads.count += 1 }
        live.update(.init(signedIn: true, ready: true, partition: partition, store: store))
        return live
    }

    func testStartDayAsksConsentOnceThenSharesAndSamples() throws {
        let clock = Clock(manila(8)), source = FakeSource()
        let live = controller(at: clock, source: source)
        XCTAssertEqual(live.status, .off(.noConsent))
        live.startDay()
        XCTAssertTrue(live.consentRequested)
        XCTAssertNil(try store.workDay("2026-10-08", for: partition))
        live.answerConsent(true)
        XCTAssertFalse(live.consentRequested)
        XCTAssertEqual(live.consent, .accepted)
        XCTAssertTrue(try XCTUnwrap(store.workDay("2026-10-08", for: partition)).isOpen)
        XCTAssertTrue(source.running)
        XCTAssertEqual(live.status, .sharing(alwaysAllowed: true))
        source.send(fix(at: clock.now))
        clock.now += 30
        source.send(fix(20, at: clock.now)) // Still within 50 m and 5 min: skipped.
        clock.now += 30
        source.send(fix(80, speed: 3, at: clock.now))
        XCTAssertEqual(try store.pendingPings(for: partition, limit: 10).map(\.trigger), [.start, .moving])
        clock.now += 300
        live.tick()
        let pings = try store.pendingPings(for: partition, limit: 10)
        XCTAssertEqual(pings.map(\.trigger), [.start, .moving, .still])
        XCTAssertEqual(pings.last?.batteryPercent, 77)
        XCTAssertEqual(live.waiting, 3)
        XCTAssertTrue(source.lowPower)
    }

    func testAFixDeliveredDuringStartIsRecorded() throws {
        let clock = Clock(manila(7)), source = FakeSource(), consents = MemoryConsents()
        consents.saved[partition.subject] = .accepted
        source.fixOnStart = fix(at: clock.now)
        let live = controller(at: clock, source: source, consents: consents)
        live.startDay()
        XCTAssertEqual(try store.pendingPings(for: partition, limit: 10).map(\.trigger), [.start])
        XCTAssertEqual(live.lastPingAt, clock.now)
    }

    func testFirstCallStartOpensTheDayOnlyWithConsent() throws {
        let clock = Clock(manila(9)), source = FakeSource(), consents = MemoryConsents()
        consents.saved[partition.subject] = .declined
        let live = controller(at: clock, source: source, consents: consents)
        live.callStarted()
        XCTAssertFalse(live.consentRequested)
        XCTAssertNil(try store.workDay("2026-10-08", for: partition))
        XCTAssertFalse(source.running)
        XCTAssertEqual(live.status, .off(.noConsent))
        consents.saved[partition.subject] = .accepted
        live.update(.init(signedIn: true, ready: true, partition: partition, store: store))
        live.callStarted()
        XCTAssertTrue(source.running)
        // Another account on this phone has not answered.
        XCTAssertEqual(consents.consent(subject: "issuer|other"), .unanswered)
    }

    func testEndDayRecordsStopStopsSharingAndUploads() async throws {
        let clock = Clock(manila(16)), source = FakeSource(), consents = MemoryConsents(), uploads = Uploads()
        consents.saved[partition.subject] = .accepted
        let live = controller(at: clock, source: source, consents: consents, uploads: uploads)
        live.startDay()
        source.send(fix(at: clock.now))
        clock.now += 5
        await drain()
        let before = uploads.count
        await live.endDay()
        XCTAssertFalse(source.running)
        XCTAssertEqual(live.status, .off(.dayEnded))
        XCTAssertEqual(try store.pendingPings(for: partition, limit: 10).map(\.trigger), [.start, .stop])
        XCTAssertEqual(try store.workDay("2026-10-08", for: partition)?.endReason, .endDay)
        XCTAssertEqual(uploads.count, before + 1)
        // A later fix is ignored: sharing never runs after End day.
        source.send(fix(500, at: clock.now + 60))
        XCTAssertEqual(try store.pingCount(for: partition), 2)
    }

    func testTenPmCloseEndsTheDayAndNothingSharesOutsideHours() throws {
        let clock = Clock(manila(21, 50)), source = FakeSource(), consents = MemoryConsents()
        consents.saved[partition.subject] = .accepted
        let live = controller(at: clock, source: source, consents: consents)
        live.startDay()
        XCTAssertTrue(source.running)
        clock.now = manila(22, 5)
        live.tick()
        XCTAssertFalse(source.running)
        XCTAssertEqual(try store.workDay("2026-10-08", for: partition)?.endReason, .dailyClose)
        XCTAssertEqual(live.status, .off(.dayEnded))
        source.send(fix(at: clock.now))
        XCTAssertEqual(try store.pingCount(for: partition), 0)
        // Early morning: Start day records the day but does not share before 5 AM.
        clock.now = manila(4, 30, day: 9)
        live.startDay()
        XCTAssertFalse(source.running)
        XCTAssertEqual(live.status, .off(.outsideHours))
    }

    func testDeniedPermissionShowsLocationOffAndNeverRuns() throws {
        let clock = Clock(manila(10)), source = FakeSource(), consents = MemoryConsents()
        source.grant = .denied
        consents.saved[partition.subject] = .accepted
        let live = controller(at: clock, source: source, consents: consents)
        live.startDay()
        XCTAssertEqual(live.status, .permissionOff)
        XCTAssertFalse(source.running)
        // While Using only: shares, with the hint to allow Always.
        source.authorization = .whenInUse
        source.onAuthorization?(.whenInUse)
        XCTAssertEqual(live.status, .sharing(alwaysAllowed: false))
        XCTAssertTrue(source.running)
    }

    func testSignOutStopsSharingWithoutWaitingForTheNetwork() async throws {
        let clock = Clock(manila(11)), source = FakeSource(), consents = MemoryConsents(), uploads = Uploads()
        consents.saved[partition.subject] = .accepted
        let live = controller(at: clock, source: source, consents: consents, uploads: uploads)
        live.startDay()
        source.send(fix(at: clock.now))
        clock.now += 20
        await drain()
        let before = uploads.count
        await live.signingOut()
        XCTAssertFalse(source.running)
        XCTAssertEqual(live.status, .off(.notSignedIn))
        XCTAssertEqual(try store.workDay("2026-10-08", for: partition)?.endReason, .signOut)
        XCTAssertEqual(try store.pendingPings(for: partition, limit: 10).map(\.trigger), [.start, .stop])
        await drain()
        XCTAssertEqual(uploads.count, before) // No upload on sign-out.
        source.send(fix(300, at: clock.now + 60))
        XCTAssertEqual(try store.pingCount(for: partition), 2)
    }

    func testConsentStoreKeepsOnlyAHashOfTheSubject() {
        let suite = "live-consent-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let consents = DefaultsLocationConsentStore(defaults: defaults)
        XCTAssertEqual(consents.consent(subject: "issuer|seller"), .unanswered)
        consents.setConsent(.accepted, subject: "issuer|seller", at: Date())
        XCTAssertEqual(consents.consent(subject: "issuer|seller"), .accepted)
        XCTAssertEqual(consents.consent(subject: "issuer|other"), .unanswered)
        let saved = defaults.dictionaryRepresentation().description
        XCTAssertFalse(saved.contains("seller"))
    }

    func testConsentTextSaysWhatWhenWhoAndHowLong() {
        XCTAssertTrue(LocationConsentText.what.contains("battery"))
        XCTAssertTrue(LocationConsentText.when.contains("10 PM"))
        XCTAssertTrue(LocationConsentText.when.contains("Never outside work"))
        XCTAssertTrue(LocationConsentText.who.contains("90 days"))
        XCTAssertTrue(LocationConsentText.choice.contains("still works"))
    }
}
