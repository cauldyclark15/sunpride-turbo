import XCTest
@testable import FieldIOS

/// IOS-020 supervisor Team view: wire decode, live/saved/refused loading, wording and the encrypted cache.
@MainActor
final class TeamSummaryTests: XCTestCase {
    private let day = "2026-10-05"
    private let now = Date(timeIntervalSince1970: 1_791_170_000) // 2026-10-05 ~11:13 Manila

    private func summaryJSON(day: String? = nil, directOnly: Bool = true, extra: String = "") -> String {
        """
        {"status":"success","value":{"serviceDate":"\(day ?? self.day)","generatedAt":1791170000000,"dayCloseAt":1791208800000,
        "directOnly":\(directOnly),"truncated":false,"openExceptions":1,"totalExceptions":2\(extra),
        "people":[{"profileId":"p1","name":"Ana Reyes","employeeCode":null,"positionLabel":"CDS","channel":"general_trade",
          "orgUnitId":"u1","direct":true,"planned":6,"plannedDone":3,"done":4,"productive":2,"nonproductive":1,"unplanned":1,
          "inProgress":false,"outOfSequence":1,"openExceptions":1,"lateSync":0,"firstCheckInAt":1791160000000,
          "lastCheckOutAt":1791165000000,"lastActivityAt":null}],
        "exceptions":[{"id":"location:1","kind":"location","open":true,"profileId":"p1","personName":"Ana Reyes",
          "outletCode":"O1","outletName":"Stub Outlet","at":1791160000000,"event":"check_in","result":"outside",
          "distanceMeters":412.4,"sequence":null,"after":null,"reason":null,"decisionStatus":null},
          {"id":"sequence:2","kind":"out_of_sequence","open":false,"profileId":"p1","personName":"Ana Reyes",
          "outletCode":"O2","outletName":"Next Outlet","at":null,"event":null,"result":null,"distanceMeters":null,
          "sequence":3,"after":1,"reason":"Store closed early","decisionStatus":"approved_exception"}]}}
        """
    }
    private func decoded(_ json: String) throws -> TeamSummary {
        try XCTUnwrap(ConvexFunctions.decode(Data(json.utf8), statusCode: 200) as TeamSummary?)
    }

    private final class MemoryCache: TeamCache {
        var rows: [String: (body: Data, savedAt: Int64)] = [:]
        var writes = 0
        func read(key: String) -> (body: Data, savedAt: Int64)? { rows[key] }
        func write(key: String, body: Data, savedAt: Int64) { writes += 1; rows[key] = (body, savedAt) }
    }

    // MARK: Wire

    func testDecodesServerSummaryAndIgnoresExtraFields() throws {
        let summary = try decoded(summaryJSON()).validated()
        XCTAssertEqual(summary.people.map(\.name), ["Ana Reyes"])
        XCTAssertEqual(summary.people.first?.lastActivityAt, nil)
        XCTAssertEqual(summary.exceptions.first?.distanceMeters, 412.4)
        XCTAssertEqual(summary.exceptions.last?.decisionStatus, "approved_exception")
        XCTAssertEqual(summary.openExceptions, 1)
    }

    func testRejectsMalformedSummaries() throws {
        // Missing required field.
        XCTAssertThrowsError(try ConvexFunctions.decode(Data(#"{"status":"success","value":{"serviceDate":"x"}}"#.utf8),
                                                        statusCode: 200) as TeamSummary?)
        // Fractional count.
        let fractional = summaryJSON().replacingOccurrences(of: #""planned":6"#, with: #""planned":6.5"#)
        XCTAssertThrowsError(try ConvexFunctions.decode(Data(fractional.utf8), statusCode: 200) as TeamSummary?)
        // Negative count and impossible totals are structural failures.
        let negative = try decoded(summaryJSON().replacingOccurrences(of: #""lateSync":0"#, with: #""lateSync":-1"#))
        XCTAssertThrowsError(try negative.validated())
        let totals = try decoded(summaryJSON().replacingOccurrences(of: #""totalExceptions":2"#, with: #""totalExceptions":1"#))
        XCTAssertThrowsError(try totals.validated())
    }

    func testOfferedOnlyToRolesTheServerLetsReadTheTeam() {
        for role in ["manager", "super_admin", "admin", "analyst", "viewer"] { XCTAssertTrue(TeamRepository.offered(role: role), role) }
        for role in ["sales", "operations", "approver", "", "MANAGER"] { XCTAssertFalse(TeamRepository.offered(role: role), role) }
        XCTAssertFalse(TeamRepository.offered(role: nil))
    }

    // MARK: Loading

    func testLiveSummaryIsSavedThenShownOfflineForTheSameFilterOnly() async throws {
        let cache = MemoryCache()
        let live = try decoded(summaryJSON())
        let view = await TeamRepository.load(serviceDate: day, directOnly: true, cache: cache, now: now) { live }
        XCTAssertEqual(view, TeamView(summary: live))
        XCTAssertNotNil(cache.rows[TeamRepository.key(serviceDate: day, directOnly: true)])

        let offline = await TeamRepository.load(serviceDate: day, directOnly: true, unavailable: "Offline", cache: cache, now: now) {
            XCTFail("no fetch while offline"); return nil
        }
        XCTAssertEqual(offline.summary, live)
        XCTAssertTrue(offline.saved)
        XCTAssertTrue(offline.message?.hasPrefix("Offline — showing team saved at ") == true, offline.message ?? "")

        let whole = await TeamRepository.load(serviceDate: day, directOnly: false, cache: cache, now: now) { throw MobileError.offline }
        XCTAssertNil(whole.summary, "a direct-reports copy is never shown for the whole area")
        XCTAssertEqual(whole.message, "Offline. Connect and try again.")
    }

    func testRefusalOrEndedSessionNeverShowsSavedData() async throws {
        let cache = MemoryCache()
        let live = try decoded(summaryJSON())
        _ = await TeamRepository.load(serviceDate: day, directOnly: true, cache: cache, now: now) { live }

        let refused = await TeamRepository.load(serviceDate: day, directOnly: true, cache: cache, now: now) {
            throw MobileError.rejected("Not authorized")
        }
        XCTAssertEqual(refused, TeamView(notAllowed: true, message: "Team view isn't available for your account."))
        for error in [MobileError.sessionExpired, .notSignedIn, .unauthorized] {
            let view = await TeamRepository.load(serviceDate: day, directOnly: true, cache: cache, now: now) { throw error }
            XCTAssertEqual(view, TeamView(message: "Sign in again to see your team."))
        }
    }

    func testWrongDayFilterOrNullAnswerFallsBackToSavedCopy() async throws {
        let cache = MemoryCache()
        let live = try decoded(summaryJSON())
        _ = await TeamRepository.load(serviceDate: day, directOnly: true, cache: cache, now: now) { live }
        let writes = cache.writes
        for answer in [try decoded(summaryJSON(day: "2026-10-04")), try decoded(summaryJSON(directOnly: false)), nil] {
            let view = await TeamRepository.load(serviceDate: day, directOnly: true, cache: cache, now: now) { answer }
            XCTAssertEqual(view.summary, live)
            XCTAssertTrue(view.saved)
            XCTAssertTrue(view.message?.hasPrefix("Couldn't read the latest team update") == true)
        }
        XCTAssertEqual(cache.writes, writes, "a bad answer is never saved")
        let server = await TeamRepository.load(serviceDate: day, directOnly: true, cache: MemoryCache(), now: now) { throw MobileError.server }
        XCTAssertEqual(server, TeamView(message: "The server is unavailable. Connect and try again."))
    }

    // MARK: Wording

    func testFixedWording() throws {
        let summary = try decoded(summaryJSON()).validated()
        let ana = try XCTUnwrap(summary.people.first)
        XCTAssertEqual(TeamText.headline(summary), "1 person · 3 of 6 planned calls done · 1 to review")
        XCTAssertEqual(TeamText.coverage(ana), "3 of 6 planned · 2 productive · 1 unplanned")
        XCTAssertEqual(TeamText.flags(ana), "1 to review · 1 out of order · 1 nonproductive")
        XCTAssertEqual(TeamText.status(ana, now: summary.dayCloseAt - 1, dayCloseAt: summary.dayCloseAt), "Between calls")
        XCTAssertEqual(TeamText.status(ana, now: summary.dayCloseAt, dayCloseAt: summary.dayCloseAt), "Day closed")
        let location = summary.exceptions[0], order = summary.exceptions[1]
        XCTAssertEqual(TeamText.kind(location, now: 0, dayCloseAt: 1), "Outside the store radius")
        XCTAssertEqual(TeamText.detail(location), "Ana Reyes · Stub Outlet · 412 m away · Needs review on the web")
        XCTAssertEqual(TeamText.kind(order, now: 0, dayCloseAt: 1), "Out of MCP order")
        XCTAssertEqual(TeamText.detail(order), "Ana Reyes · Next Outlet · stop 3 after 1 · Store closed early · Approved")
    }

    // MARK: Encrypted cache

    private var directory: URL!
    private var secrets: KeychainStore!
    override func setUp() async throws {
        try await super.setUp()
        directory = FileManager.default.temporaryDirectory.appending(path: "team-store-\(UUID().uuidString)", directoryHint: .isDirectory)
        secrets = KeychainStore(service: "com.sunpride.field.team.tests.\(UUID().uuidString)")
    }
    override func tearDown() async throws {
        try? secrets.delete("db")
        try? FileManager.default.removeItem(at: directory)
        try await super.tearDown()
    }
    private func seededStore(_ partitions: StorePartition...) throws -> EncryptedFieldStore {
        let store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        for p in partitions {
            try store.saveSnapshot(StoreSnapshot(employee: .init(id: "profile-1", role: "manager", orgUnitId: "unit-1"),
                                                 visits: [], outlets: [], customers: [], route: nil, tasks: []),
                                   cursor: "c", leaseExpiresAt: 1, cacheExpiresAt: 1, for: p)
        }
        return store
    }

    func testStoreCacheIsPartitionedPrunedByDayAndPurgedOnSignOut() throws {
        let a = try StorePartition(subject: "issuer|manager", deviceId: "phone-1", scope: "scope-1")
        let b = try StorePartition(subject: "issuer|other", deviceId: "phone-1", scope: "scope-1")
        let store = try seededStore(a, b)
        let entity = TeamRepository.cacheEntity
        try store.putLocalCache(entity: entity, key: "2026-10-04|direct", body: Data("old".utf8), savedAt: 1, keepPrefix: "2026-10-04|", for: a)
        try store.putLocalCache(entity: entity, key: "2026-10-05|direct", body: Data("TeamCacheMarker".utf8), savedAt: 2,
                                keepPrefix: "2026-10-05|", for: a)
        try store.putLocalCache(entity: entity, key: "2026-10-05|all", body: Data("all".utf8), savedAt: 3, keepPrefix: "2026-10-05|", for: a)
        XCTAssertNil(try store.localCache(entity: entity, key: "2026-10-04|direct", for: a), "yesterday pruned")
        XCTAssertEqual(try store.localCache(entity: entity, key: "2026-10-05|direct", for: a)?.body, Data("TeamCacheMarker".utf8))
        XCTAssertEqual(try store.localCache(entity: entity, key: "2026-10-05|all", for: a)?.savedAt, 3)
        XCTAssertNil(try store.localCache(entity: entity, key: "2026-10-05|direct", for: b), "another person's partition sees nothing")
        // Reserved entity and key/prefix agreement are enforced.
        XCTAssertThrowsError(try store.putLocalCache(entity: "visit", key: "2026-10-05|direct", body: Data("x".utf8), savedAt: 1,
                                                     keepPrefix: "2026-10-05|", for: a))
        XCTAssertThrowsError(try store.putLocalCache(entity: entity, key: "2026-10-04|direct", body: Data("x".utf8), savedAt: 1,
                                                     keepPrefix: "2026-10-05|", for: a))
        // Ciphertext on disk.
        for suffix in ["", "-wal"] {
            if let raw = try? Data(contentsOf: URL(fileURLWithPath: directory.appending(path: "field.sqlite").path + suffix)) {
                XCTAssertNil(raw.range(of: Data("TeamCacheMarker".utf8)))
            }
        }
        // QSR-010 sign-out purge drops the saved team with the rest of the server cache.
        try store.purgeAllCachesForReview()
        XCTAssertNil(try store.localCache(entity: entity, key: "2026-10-05|direct", for: a))
    }

    func testHeldOrNeverBootstrappedPartitionSavesNothing() throws {
        let held = try StorePartition(subject: "issuer|manager", deviceId: "phone-1", scope: "scope-1")
        let fresh = try StorePartition(subject: "issuer|manager", deviceId: "phone-1", scope: "scope-2")
        let store = try seededStore(held)
        try store.holdForReview(held)
        for p in [held, fresh] {
            try store.putLocalCache(entity: TeamRepository.cacheEntity, key: "2026-10-05|direct", body: Data("x".utf8), savedAt: 1,
                                    keepPrefix: "2026-10-05|", for: p)
            XCTAssertNil(try store.localCache(entity: TeamRepository.cacheEntity, key: "2026-10-05|direct", for: p))
        }
    }
}
