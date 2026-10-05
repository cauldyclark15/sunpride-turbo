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
        func clear() { rows = [:] }
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

    /// Release counterexample: success (both filters) -> refusal -> offline must show nothing for either filter.
    func testRefusalErasesBothFiltersSoOfflineShowsNothing() async throws {
        for error in [MobileError.rejected("Not authorized"), .sessionExpired, .notSignedIn, .unauthorized] {
            let cache = MemoryCache()
            let direct = try decoded(summaryJSON()), all = try decoded(summaryJSON(directOnly: false))
            _ = await TeamRepository.load(serviceDate: day, directOnly: true, cache: cache, now: now) { direct }
            _ = await TeamRepository.load(serviceDate: day, directOnly: false, cache: cache, now: now) { all }
            XCTAssertEqual(cache.rows.count, 2)
            _ = await TeamRepository.load(serviceDate: day, directOnly: true, cache: cache, now: now) { throw error }
            XCTAssertTrue(cache.rows.isEmpty, "\(error)")
            for directOnly in [true, false] {
                let offline = await TeamRepository.load(serviceDate: day, directOnly: directOnly, unavailable: "Offline",
                                                        cache: cache, now: now) { nil }
                XCTAssertEqual(offline, TeamView(message: "Offline. Connect and try again."), "\(error) \(directOnly)")
                let down = await TeamRepository.load(serviceDate: day, directOnly: directOnly, cache: cache, now: now) {
                    throw MobileError.server
                }
                XCTAssertNil(down.summary, "\(error) \(directOnly)")
            }
            // Only a new successful answer saves again.
            _ = await TeamRepository.load(serviceDate: day, directOnly: true, cache: cache, now: now) { direct }
            let back = await TeamRepository.load(serviceDate: day, directOnly: true, unavailable: "Offline", cache: cache, now: now) { nil }
            XCTAssertEqual(back.summary, direct)
        }
    }

    // MARK: Withdrawal when erasing fails (release counterexample)

    /// Rows whose erase fails while reads and writes still succeed.
    private final class StubbornRows: TeamRowStore {
        var rows: [String: (body: Data, savedAt: Int64)] = [:]
        var clearAttempts = 0
        func read(key: String) throws -> (body: Data, savedAt: Int64)? { rows[key] }
        func write(key: String, body: Data, savedAt: Int64) throws { rows[key] = (body, savedAt) }
        func clear() throws { clearAttempts += 1; throw StoreError.invalidInput }
    }
    private final class MemoryGrants: TeamGrantStore {
        var tokens: [String: String] = [:]
        func token(key: String) -> String? { tokens[key] }
        func grant(key: String, token: String, keepPrefix: String) {
            tokens = tokens.filter { $0.key.hasPrefix(keepPrefix) }; tokens[key] = token
        }
        func revokeAll() { tokens = [:] }
    }

    private func offlineView(_ cache: TeamCache, directOnly: Bool) async -> TeamView {
        await TeamRepository.load(serviceDate: day, directOnly: directOnly, unavailable: "Offline", cache: cache, now: now) { nil }
    }

    func testRefusalWithFailedEraseStaysWithdrawnInSessionAndAfterRelaunch() async throws {
        for error in [MobileError.rejected("Insufficient permission"), .sessionExpired, .notSignedIn, .unauthorized] {
            let rows = StubbornRows(), grants = MemoryGrants()
            let direct = try decoded(summaryJSON()), all = try decoded(summaryJSON(directOnly: false))
            let session = GuardedTeamCache(rows: rows, grants: grants, latch: TeamSessionLatch(), keepPrefix: "\(day)|")
            _ = await TeamRepository.load(serviceDate: day, directOnly: true, cache: session, now: now) { direct }
            _ = await TeamRepository.load(serviceDate: day, directOnly: false, cache: session, now: now) { all }
            let v1 = await offlineView(session, directOnly: false)
            XCTAssertEqual(v1.summary, all, "saved before the refusal")
            _ = await TeamRepository.load(serviceDate: day, directOnly: true, cache: session, now: now) { throw error }
            XCTAssertEqual(rows.clearAttempts, 1)
            XCTAssertEqual(rows.rows.count, 2, "erase failed; the rows are still readable")
            // Same session, then a relaunch (fresh latch) on the same rows and grants.
            let relaunch = GuardedTeamCache(rows: rows, grants: grants, latch: TeamSessionLatch(), keepPrefix: "\(day)|")
            for cache in [session, relaunch] {
                for directOnly in [true, false, true] {
                    let v2 = await offlineView(cache, directOnly: directOnly)
                    XCTAssertEqual(v2, TeamView(message: "Offline. Connect and try again."),
                                   "\(error) \(directOnly)")
                    let down = await TeamRepository.load(serviceDate: day, directOnly: directOnly, cache: cache, now: now) {
                        throw MobileError.server
                    }
                    XCTAssertNil(down.summary, "\(error) \(directOnly)")
                }
            }
        }
    }

    func testLiveAnswerForOneFilterNeverRenewsTheOther() async throws {
        let rows = StubbornRows(), grants = MemoryGrants(), latch = TeamSessionLatch()
        let session = GuardedTeamCache(rows: rows, grants: grants, latch: latch, keepPrefix: "\(day)|")
        let direct = try decoded(summaryJSON()), all = try decoded(summaryJSON(directOnly: false))
        _ = await TeamRepository.load(serviceDate: day, directOnly: true, cache: session, now: now) { direct }
        _ = await TeamRepository.load(serviceDate: day, directOnly: false, cache: session, now: now) { all }
        _ = await TeamRepository.load(serviceDate: day, directOnly: true, cache: session, now: now) { throw MobileError.rejected("x") }
        // A new live Direct reports answer (even an empty team) renews Direct reports only.
        let renewed = try TeamSummary(serviceDate: day, generatedAt: direct.generatedAt, dayCloseAt: direct.dayCloseAt, directOnly: true,
                                      truncated: false, people: [], openExceptions: 0, totalExceptions: 0, exceptions: []).validated()
        _ = await TeamRepository.load(serviceDate: day, directOnly: true, cache: session, now: now) { renewed }
        let relaunch = GuardedTeamCache(rows: rows, grants: grants, latch: TeamSessionLatch(), keepPrefix: "\(day)|")
        for cache in [session, relaunch] {
            let v3 = await offlineView(cache, directOnly: true)
            XCTAssertEqual(v3.summary, renewed)
            let v4 = await offlineView(cache, directOnly: false)
            XCTAssertNil(v4.summary, "the old whole-area copy stays withdrawn")
        }
        // Only a live whole-area answer brings that filter back.
        _ = await TeamRepository.load(serviceDate: day, directOnly: false, cache: session, now: now) { all }
        let v5 = await offlineView(session, directOnly: false)
        XCTAssertEqual(v5.summary, all)
    }

    func testOldOrForeignRowsWithoutAMatchingGrantAreNeverShown() async throws {
        let rows = StubbornRows(), grants = MemoryGrants()
        let cache = GuardedTeamCache(rows: rows, grants: grants, latch: TeamSessionLatch(), keepPrefix: "\(day)|")
        let key = TeamRepository.key(serviceDate: day, directOnly: true)
        rows.rows[key] = (Data(summaryJSON().utf8), 1) // pre-upgrade row with no token
        XCTAssertNil(cache.read(key: key))
        rows.rows[key] = (GuardedTeamCache.wrap(UUID().uuidString, Data("{}".utf8)), 1)
        grants.tokens[key] = UUID().uuidString // a different token
        XCTAssertNil(cache.read(key: key))
    }

    /// The production adapters: real SQLCipher rows (erase forced to fail) and UserDefaults grants.
    func testProductionAdaptersWithdrawAcrossRelaunchWhenEraseFails() async throws {
        let a = try StorePartition(subject: "issuer|manager", deviceId: "phone-1", scope: "scope-1")
        let other = try StorePartition(subject: "issuer|other", deviceId: "phone-1", scope: "scope-1")
        let store = try seededStore(a, other)
        let suite = "team.grants.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        func cache(_ p: StorePartition, latch: TeamSessionLatch) -> GuardedTeamCache {
            let rows = FieldStoreTeamRows(store: store, partition: p, keepPrefix: "\(day)|")
            rows.eraseFails = true
            return GuardedTeamCache(rows: rows, grants: DefaultsTeamGrants(defaults: defaults, partition: p), latch: latch,
                                    keepPrefix: "\(day)|")
        }
        let direct = try decoded(summaryJSON()), all = try decoded(summaryJSON(directOnly: false))
        let session = cache(a, latch: TeamSessionLatch()), bystander = cache(other, latch: TeamSessionLatch())
        _ = await TeamRepository.load(serviceDate: day, directOnly: true, cache: session, now: now) { direct }
        _ = await TeamRepository.load(serviceDate: day, directOnly: false, cache: session, now: now) { all }
        _ = await TeamRepository.load(serviceDate: day, directOnly: true, cache: bystander, now: now) { direct }
        _ = await TeamRepository.load(serviceDate: day, directOnly: true, cache: session, now: now) { throw MobileError.unauthorized }
        XCTAssertNotNil(try store.localCache(entity: TeamRepository.cacheEntity, key: "\(day)|all", for: a), "erase failed")
        for directOnly in [true, false] {
            let relaunched = await offlineView(cache(a, latch: TeamSessionLatch()), directOnly: directOnly)
            XCTAssertNil(relaunched.summary, "\(directOnly)")
        }
        let theirs = await offlineView(cache(other, latch: TeamSessionLatch()), directOnly: true)
        XCTAssertEqual(theirs.summary, direct, "another account's grant is untouched")
        // A live Direct reports answer renews only that filter, also after relaunch.
        _ = await TeamRepository.load(serviceDate: day, directOnly: true, cache: session, now: now) { direct }
        let directBack = await offlineView(cache(a, latch: TeamSessionLatch()), directOnly: true)
        XCTAssertEqual(directBack.summary, direct)
        let allStill = await offlineView(cache(a, latch: TeamSessionLatch()), directOnly: false)
        XCTAssertNil(allStill.summary)
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
        // A refusal erases every saved team row of this partition only, even when held.
        try store.putLocalCache(entity: entity, key: "2026-10-05|direct", body: Data("b".utf8), savedAt: 4, keepPrefix: "2026-10-05|", for: b)
        try store.holdForReview(a)
        try store.clearLocalCache(entity: entity, for: a)
        XCTAssertNil(try store.localCache(entity: entity, key: "2026-10-05|direct", for: a))
        XCTAssertNil(try store.localCache(entity: entity, key: "2026-10-05|all", for: a))
        XCTAssertEqual(try store.localCache(entity: entity, key: "2026-10-05|direct", for: b)?.body, Data("b".utf8))
        XCTAssertThrowsError(try store.clearLocalCache(entity: "visit", for: a))
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
