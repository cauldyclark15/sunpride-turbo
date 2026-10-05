import CryptoKit
import Synchronization
import XCTest
@testable import FieldIOS

/// IOS-020 release counterexamples through the real AppModel, ConvexFunctions decoding, SQLCipher store and
/// UserDefaults grants: a Team answer that was in flight across a scope change, sign-out or phone removal
/// must never be shown, saved or granted, even when the final account/scope/filter look the same again.
@MainActor
final class TeamAuthorizationEpochTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_791_170_000) // 2026-10-05 ~11:13 Manila
    private var day: String { BootstrapClient.manilaDay(now) }
    private var directory: URL!
    private var secrets: KeychainStore!
    private var store: EncryptedFieldStore!
    private var defaults: UserDefaults!
    private var suite = ""
    private var a: StorePartition!
    private var b: StorePartition!
    private let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
    private var model: AppModel?

    /// Each Team query takes the next scripted outcome; auth endpoints always succeed.
    private final class Script: Sendable {
        let queue = Mutex<[StubURLProtocol.Outcome]>([])
        func push(_ outcome: StubURLProtocol.Outcome) { queue.withLock { $0.append(outcome) } }
        func next() -> StubURLProtocol.Outcome {
            queue.withLock { $0.isEmpty ? .fail(.notConnectedToInternet) : $0.removeFirst() }
        }
    }
    /// Holds a reply until the test releases it.
    private final class Gate: Sendable {
        private let semaphore = DispatchSemaphore(value: 0)
        func wait() { semaphore.wait() }
        func open() { semaphore.signal() }
    }
    private let script = Script()

    override func setUp() async throws {
        try await super.setUp()
        directory = FileManager.default.temporaryDirectory.appending(path: "team-epoch-\(UUID().uuidString)", directoryHint: .isDirectory)
        secrets = KeychainStore(service: "com.sunpride.field.team.epoch.tests.\(UUID().uuidString)")
        suite = "team.epoch.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        a = try StorePartition(subject: "issuer|manager", deviceId: "device-1", scope: "scope-a")
        b = try StorePartition(subject: "issuer|manager", deviceId: "device-1", scope: "scope-b")
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        for p in [a!, b!] {
            try store.saveSnapshot(StoreSnapshot(employee: .init(id: "profile-1", role: "manager", orgUnitId: "unit-1"),
                                                 visits: [], outlets: [], customers: [], route: nil, tasks: []),
                                   cursor: "c", leaseExpiresAt: 1, cacheExpiresAt: 1, for: p)
        }
        let jwt = StubHTTP.jwt(exp: Date().timeIntervalSince1970 + 3600)
        let script = script
        StubURLProtocol.install { request in
            switch request.path {
            case "/api/auth/convex/token": return .reply(.json(200, ["token": jwt]))
            case "/api/query": return script.next()
            default: return .reply(.json(200, [:]))
            }
        }
    }

    override func tearDown() async throws {
        model?.enrollment.signedOut()
        model = nil
        StubURLProtocol.install { _ in .fail(.notConnectedToInternet) }
        defaults.removePersistentDomain(forName: suite)
        try? secrets.delete("db")
        try? secrets.delete(StoreAccount.session)
        try? FileManager.default.removeItem(at: directory)
        try await super.tearDown()
    }

    private func summaryReply(_ marker: String) -> StubURLProtocol.Reply {
        let json = """
        {"status":"success","value":{"serviceDate":"\(day)","generatedAt":1791170000000,"dayCloseAt":1791208800000,
        "directOnly":true,"truncated":false,"openExceptions":1,"totalExceptions":1,
        "people":[{"profileId":"p1","name":"\(marker) person","positionLabel":"CDS","channel":"general_trade","direct":true,
          "planned":6,"plannedDone":3,"done":4,"productive":2,"nonproductive":1,"unplanned":1,"inProgress":false,
          "outOfSequence":0,"openExceptions":1,"lateSync":0,"firstCheckInAt":1791160000000,"lastCheckOutAt":null,"lastActivityAt":null}],
        "exceptions":[{"id":"location:1","kind":"location","open":true,"profileId":"p1","personName":"\(marker) person",
          "outletCode":"O1","outletName":"\(marker) private store","at":1791160000000,"result":"outside","distanceMeters":412.4,
          "sequence":null,"after":null,"reason":null,"decisionStatus":null}]}}
        """
        return StubURLProtocol.Reply(status: 200, body: Data(json.utf8))
    }

    private func held(_ marker: String) -> Gate {
        let gate = Gate(), reply = summaryReply(marker)
        script.push(.held { gate.wait(); return reply })
        return gate
    }

    private func launchModel() async throws -> AppModel {
        try secrets.save(Data("test-session".utf8), for: StoreAccount.session)
        let registry = FakeRegistry()
        registry.lastMine = .success(MineResult(deviceId: "device-1", status: "active", bound: true, allowedApp: "IOS"))
        let auth = AuthClient(site: StubHTTP.site, store: secrets, http: StubHTTP.client())
        let functions = ConvexFunctions(url: StubHTTP.cloud, auth: auth, http: StubHTTP.client())
        let fixed = now, key = key
        // No site: sync stays idle, so only Team queries reach the network stub.
        let app = AppModel(auth: auth, registry: registry, store: secrets, functions: functions, localStore: store,
                           now: { fixed }) { key }
        app.teamGrantDefaults = defaults
        await app.launch()
        XCTAssertEqual(app.enrollment.state, .ready(deviceId: "device-1"))
        _ = try app.storage(for: a)
        model = app
        return app
    }

    private func waitForTeamQueries(_ count: Int) async {
        for _ in 0..<500 {
            if StubURLProtocol.requests(to: "/api/query").count >= count { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Team query never started")
    }

    /// A relaunch: fresh session latch, the real encrypted rows and UserDefaults grants, offline.
    private func relaunchedOffline(_ p: StorePartition, directOnly: Bool = true) async -> TeamView {
        let prefix = TeamRepository.keepPrefix(serviceDate: day)
        let cache = GuardedTeamCache(rows: FieldStoreTeamRows(store: store, partition: p, keepPrefix: prefix),
                                     grants: DefaultsTeamGrants(defaults: defaults, partition: p),
                                     latch: TeamSessionLatch(), keepPrefix: prefix)
        return await TeamRepository.load(serviceDate: day, directOnly: directOnly, unavailable: "Offline", cache: cache, now: now) { nil }
    }

    private func assertNothingKept(_ app: AppModel, _ p: StorePartition, file: StaticString = #filePath, line: UInt = #line) async throws {
        XCTAssertNil(app.team.summary, "stale answer published", file: file, line: line)
        XCTAssertNil(try store.localCache(entity: TeamRepository.cacheEntity, key: TeamRepository.key(serviceDate: day, directOnly: true), for: p),
                     "stale answer saved", file: file, line: line)
        let offline = await relaunchedOffline(p)
        XCTAssertNil(offline.summary, "stale answer readable after relaunch", file: file, line: line)
    }

    func testScopeChangeClearsPublishedTeam() async throws {
        let app = try await launchModel()
        script.push(.reply(summaryReply("Scope A")))
        await app.loadTeam(directOnly: true)
        XCTAssertEqual(app.team.summary?.people.first?.name, "Scope A person")
        _ = try app.storage(for: b)
        app.refreshToday()
        XCTAssertNil(app.team.summary, "scope A's team never stays on screen in scope B")
    }

    func testScopeABAOldAnswerIsNeitherShownNorSaved() async throws {
        let app = try await launchModel()
        let gate = held("Old A")
        let pending = Task { await app.loadTeam(directOnly: true) }
        await waitForTeamQueries(1)
        _ = try app.storage(for: b)
        _ = try app.storage(for: a)
        try store.releaseHeld(a) // as after a verified bootstrap back into A
        gate.open()
        await pending.value
        try await assertNothingKept(app, a)
        // A new live answer in A is shown and saved as usual.
        script.push(.reply(summaryReply("New A")))
        await app.loadTeam(directOnly: true)
        XCTAssertEqual(app.team.summary?.people.first?.name, "New A person")
        let offline = await relaunchedOffline(a)
        XCTAssertEqual(offline.summary?.people.first?.name, "New A person")
    }

    func testSignOutThenSameAccountRenewalRejectsPreSignOutAnswer() async throws {
        let app = try await launchModel()
        let gate = held("Before sign-out")
        let pending = Task { await app.loadTeam(directOnly: true) }
        await waitForTeamQueries(1)
        await app.signOut()
        try secrets.save(Data("test-session".utf8), for: StoreAccount.session)
        await app.launch()
        XCTAssertTrue(app.signedIn)
        _ = try app.storage(for: a)
        try store.releaseHeld(a)
        gate.open()
        await pending.value
        try await assertNothingKept(app, a)
    }

    func testPhoneRemovalDuringRequestNeverRepublishesTeam() async throws {
        let app = try await launchModel()
        let gate = held("Removed")
        let pending = Task { await app.loadTeam(directOnly: true) }
        await waitForTeamQueries(1)
        app.enrollment.markRemoved()
        await app.phoneStateChanged(.removed)
        gate.open()
        await pending.value
        XCTAssertNil(app.team.summary, "a removed phone never shows the team")
        let offline = await relaunchedOffline(a)
        XCTAssertNil(offline.summary)
    }
}
