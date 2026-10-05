import CryptoKit
import Foundation

/// IOS-020 supervisor view: the server's `supervision/mobile:team` summary of direct-report coverage
/// and the day's exceptions. Scope is enforced on the server (people.read + visit.read in the caller's
/// current organizational subtree, direct reports unless the whole subtree is asked for); this file only
/// decodes, caches and words what the server returned. Same rules as Android AND-020.
struct TeamPerson: Codable, Equatable, Identifiable {
    let profileId: String
    let name: String
    let positionLabel: String?
    let channel: String
    let direct: Bool
    let planned: Int
    let plannedDone: Int
    let done: Int
    let productive: Int
    let nonproductive: Int
    let unplanned: Int
    let inProgress: Bool
    let outOfSequence: Int
    let openExceptions: Int
    let lateSync: Int
    let firstCheckInAt: Int64?
    let lastCheckOutAt: Int64?
    let lastActivityAt: Int64?
    var id: String { profileId }
}

struct TeamException: Codable, Equatable, Identifiable {
    let id: String
    let kind: String
    let open: Bool
    let profileId: String
    let personName: String
    let outletCode: String
    let outletName: String
    let at: Int64?
    let result: String?
    let distanceMeters: Double?
    let sequence: Int?
    let after: Int?
    let reason: String?
    let decisionStatus: String?
}

struct TeamSummary: Codable, Equatable {
    let serviceDate: String
    let generatedAt: Int64
    let dayCloseAt: Int64
    let directOnly: Bool
    let truncated: Bool
    let people: [TeamPerson]
    let openExceptions: Int
    let totalExceptions: Int
    let exceptions: [TeamException]

    /// Structural checks a Codable decode can't express; any failure is a wire failure.
    func validated() throws -> TeamSummary {
        let counts = [openExceptions, totalExceptions] + people.flatMap {
            [$0.planned, $0.plannedDone, $0.done, $0.productive, $0.nonproductive, $0.unplanned,
             $0.outOfSequence, $0.openExceptions, $0.lateSync]
        }
        let times = [generatedAt, dayCloseAt] + people.flatMap { [$0.firstCheckInAt, $0.lastCheckOutAt, $0.lastActivityAt].compactMap { $0 } }
            + exceptions.compactMap(\.at)
        guard !serviceDate.isEmpty, counts.allSatisfy({ $0 >= 0 }), times.allSatisfy({ $0 >= 0 }),
              openExceptions <= totalExceptions, exceptions.count <= totalExceptions,
              people.allSatisfy({ !$0.profileId.isEmpty && !$0.name.isEmpty }),
              exceptions.allSatisfy({ !$0.id.isEmpty && !$0.kind.isEmpty && !$0.profileId.isEmpty }),
              exceptions.allSatisfy({ $0.distanceMeters.map { $0.isFinite && $0 >= 0 } ?? true }) else {
            throw TeamWireFailure()
        }
        return self
    }
}

/// What the Team screen shows: a summary (live or saved), or a fixed explanation.
struct TeamView: Equatable {
    var summary: TeamSummary? = nil
    var saved = false
    var notAllowed = false
    var message: String? = nil
}

struct TeamWireFailure: Error {}

/// Where the last good summary is kept (encrypted store, per verified partition).
@MainActor
protocol TeamCache {
    func read(key: String) -> (body: Data, savedAt: Int64)?
    func write(key: String, body: Data, savedAt: Int64)
    /// Forget every saved summary (both filters, every day): access was refused or the session ended.
    func clear()
}

/// The encrypted rows behind a `TeamCache`; reading, writing and erasing can each fail on their own.
@MainActor
protocol TeamRowStore {
    func read(key: String) throws -> (body: Data, savedAt: Int64)?
    func write(key: String, body: Data, savedAt: Int64) throws
    func clear() throws
}

/// Durable per-filter grants kept apart from the rows. A saved row is shown only while its own filter's
/// grant still names the row's token, so a refusal that revokes the grants withdraws every saved copy
/// even when erasing the rows fails, and that holds across relaunch.
@MainActor
protocol TeamGrantStore {
    func token(key: String) -> String?
    /// Grant `key` to `token`, dropping this partition's grants outside `keepPrefix` (other days).
    func grant(key: String, token: String, keepPrefix: String)
    /// Revoke every team grant of this account on this phone (all devices, scopes, filters and days).
    func revokeAll()
}

/// In-session withdrawal: after a refusal no saved copy is read until that same filter gets a new live
/// answer; a live answer for one filter never renews another.
@MainActor
final class TeamSessionLatch {
    private var refused = false
    private var renewed: Set<String> = []
    func allows(_ key: String) -> Bool { !refused || renewed.contains(key) }
    func deny() { refused = true; renewed = [] }
    func renew(_ key: String) { if refused { renewed.insert(key) } }
}

/// The production `TeamCache`: rows tagged with a fresh random token per live answer, shown only when the
/// session latch allows that filter AND the durable grant for that filter matches the row's token.
@MainActor
struct GuardedTeamCache: TeamCache {
    let rows: TeamRowStore
    let grants: TeamGrantStore
    let latch: TeamSessionLatch
    let keepPrefix: String

    func read(key: String) -> (body: Data, savedAt: Int64)? {
        guard latch.allows(key), let granted = grants.token(key: key),
              let hit = try? rows.read(key: key), case let (token, body)? = Self.unwrap(hit.body), token == granted else { return nil }
        return (body, hit.savedAt)
    }

    func write(key: String, body: Data, savedAt: Int64) {
        let token = UUID().uuidString
        guard (try? rows.write(key: key, body: Self.wrap(token, body), savedAt: savedAt)) != nil else { return }
        grants.grant(key: key, token: token, keepPrefix: keepPrefix)
        latch.renew(key)
    }

    func clear() {
        latch.deny()
        grants.revokeAll()
        try? rows.clear()
    }

    static func wrap(_ token: String, _ body: Data) -> Data { Data(token.utf8) + Data([0x0A]) + body }
    static func unwrap(_ data: Data) -> (String, Data)? {
        guard let cut = data.firstIndex(of: 0x0A), let token = String(data: data[data.startIndex..<cut], encoding: .utf8),
              UUID(uuidString: token) != nil else { return nil }
        return (token, Data(data[data.index(after: cut)...]))
    }
}

/// Team rows in the encrypted field store, in one verified partition.
@MainActor
final class FieldStoreTeamRows: TeamRowStore {
    let store: any FieldLocalStore
    let partition: StorePartition
    let keepPrefix: String
    /// Tests only: make erasing fail while reads still succeed.
    var eraseFails = false
    init(store: any FieldLocalStore, partition: StorePartition, keepPrefix: String) {
        self.store = store; self.partition = partition; self.keepPrefix = keepPrefix
    }
    func read(key: String) throws -> (body: Data, savedAt: Int64)? {
        try store.localCache(entity: TeamRepository.cacheEntity, key: key, for: partition)
    }
    func write(key: String, body: Data, savedAt: Int64) throws {
        try store.putLocalCache(entity: TeamRepository.cacheEntity, key: key, body: body, savedAt: savedAt,
                                keepPrefix: keepPrefix, for: partition)
    }
    func clear() throws {
        if eraseFails { throw StoreError.invalidInput }
        try store.clearLocalCache(entity: TeamRepository.cacheEntity, for: partition)
    }
}

/// Team grants in UserDefaults (only random tokens under hashed names; no team data). Separate from the
/// encrypted store so one failing store can't keep a withdrawn copy readable.
@MainActor
struct DefaultsTeamGrants: TeamGrantStore {
    let defaults: UserDefaults
    let partition: StorePartition

    private var account: String { "field.team.grants." + Self.hash(partition.subject) }
    private var prefix: String { Self.hash("\(partition.deviceId)|\(partition.scope)") + "#" }
    private var all: [String: String] { defaults.dictionary(forKey: account) as? [String: String] ?? [:] }

    func token(key: String) -> String? { all[prefix + key] }
    func grant(key: String, token: String, keepPrefix: String) {
        var next = all.filter { !$0.key.hasPrefix(prefix) || $0.key.hasPrefix(prefix + keepPrefix) }
        next[prefix + key] = token
        defaults.set(next, forKey: account)
    }
    func revokeAll() { defaults.removeObject(forKey: account) }

    private static func hash(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

enum TeamRepository {
    static let path = "supervision/mobile:team"
    static let cacheEntity = "local.team"
    static let signInAgain = "Sign in again to see your team."
    struct Args: Encodable, Equatable { let serviceDate: String; let directOnly: Bool }

    /// Roles the server lets read the team (people.read ∩ visit.read). A UI hint only; the server decides.
    static let supervisorRoles: Set<String> = ["manager", "super_admin", "admin", "analyst", "viewer"]
    static func offered(role: String?) -> Bool { role.map(supervisorRoles.contains) ?? false }

    static func key(serviceDate: String, directOnly: Bool) -> String { "\(serviceDate)|\(directOnly ? "direct" : "all")" }
    static func keepPrefix(serviceDate: String) -> String { "\(serviceDate)|" }

    /// Fetch live and save; when the server can't be reached, show today's saved summary for the same
    /// filter. A server refusal or an ended session never shows saved data (access may have been withdrawn)
    /// and erases every saved summary, so a later offline open, relaunch or filter switch can't bring it
    /// back; only a new successful server answer saves again.
    @MainActor
    static func load(serviceDate: String, directOnly: Bool, unavailable: String? = nil, cache: TeamCache, now: Date,
                     fetch: () async throws -> TeamSummary?) async -> TeamView {
        let key = key(serviceDate: serviceDate, directOnly: directOnly)
        if let unavailable { return saved(cache, key, unavailable) }
        do {
            guard let summary = try await fetch()?.validated(),
                  summary.serviceDate == serviceDate, summary.directOnly == directOnly else { throw TeamWireFailure() }
            if let body = try? JSONEncoder().encode(summary) {
                cache.write(key: key, body: body, savedAt: Int64(now.timeIntervalSince1970 * 1000))
            }
            return TeamView(summary: summary)
        } catch MobileError.rejected {
            cache.clear()
            return TeamView(notAllowed: true, message: "Team view isn't available for your account.")
        } catch MobileError.sessionExpired, MobileError.notSignedIn, MobileError.unauthorized {
            cache.clear()
            return TeamView(message: signInAgain)
        } catch MobileError.offline {
            return saved(cache, key, "Offline")
        } catch MobileError.server {
            return saved(cache, key, "The server is unavailable")
        } catch is CancellationError {
            return saved(cache, key, "Update cancelled")
        } catch {
            return saved(cache, key, "Couldn't read the latest team update")
        }
    }

    @MainActor
    private static func saved(_ cache: TeamCache, _ key: String, _ reason: String) -> TeamView {
        guard let hit = cache.read(key: key),
              let summary = try? JSONDecoder().decode(TeamSummary.self, from: hit.body).validated() else {
            return TeamView(message: "\(reason). Connect and try again.")
        }
        return TeamView(summary: summary, saved: true,
                        message: "\(reason) — showing team saved at \(clock(hit.savedAt))")
    }

    static func clock(_ at: Int64) -> String { FieldDay.closeTimeLabel(Date(timeIntervalSince1970: Double(at) / 1000)) }
}

/// Fixed plain-language wording; server text is never shown except person/outlet names and reasons.
enum TeamText {
    static func headline(_ s: TeamSummary) -> String {
        let planned = s.people.reduce(0) { $0 + $1.planned }
        let done = s.people.reduce(0) { $0 + $1.plannedDone }
        let people = s.people.count == 1 ? "1 person" : "\(s.people.count) people"
        return "\(people) · \(done) of \(planned) planned calls done · \(s.openExceptions) to review"
    }

    static func status(_ p: TeamPerson, now: Int64, dayCloseAt: Int64) -> String {
        if p.inProgress { return "In a call" }
        if p.planned > 0 && p.plannedDone >= p.planned { return "Route done" }
        if p.done == 0 && p.firstCheckInAt == nil { return now >= dayCloseAt ? "No calls" : "Not started" }
        return now >= dayCloseAt ? "Day closed" : "Between calls"
    }

    static func coverage(_ p: TeamPerson) -> String {
        (["\(p.plannedDone) of \(p.planned) planned", "\(p.productive) productive"]
            + (p.unplanned > 0 ? ["\(p.unplanned) unplanned"] : [])).joined(separator: " · ")
    }

    static func flags(_ p: TeamPerson) -> String {
        [p.openExceptions > 0 ? "\(p.openExceptions) to review" : nil,
         p.outOfSequence > 0 ? "\(p.outOfSequence) out of order" : nil,
         p.nonproductive > 0 ? "\(p.nonproductive) nonproductive" : nil,
         p.lateSync > 0 ? "\(p.lateSync) late sync" : nil].compactMap { $0 }.joined(separator: " · ")
    }

    static func kind(_ e: TeamException, now: Int64, dayCloseAt: Int64) -> String {
        switch e.kind {
        case "location": e.result == "unreliable" ? "Location unreliable" : "Outside the store radius"
        case "out_of_sequence": "Out of MCP order"
        case "unplanned": "Unplanned call"
        case "nonproductive": "Nonproductive call"
        case "rescheduled": "Rescheduled"
        case "cancelled": "Cancelled"
        case "not_visited": now >= dayCloseAt ? "Not visited" : "Not visited yet"
        default: "Exception"
        }
    }

    static func detail(_ e: TeamException) -> String {
        let distance = e.kind == "location" ? e.distanceMeters.map { "\(Int($0.rounded())) m away" } : nil
        let order = e.kind == "out_of_sequence" ? e.sequence.flatMap { s in e.after.map { "stop \(s) after \($0)" } } : nil
        let reason = e.reason.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        let decision: String? = if e.open { "Needs review on the web" }
            else if e.decisionStatus == "approved_exception" { "Approved" }
            else if e.decisionStatus == "rejected" { "Rejected" }
            else if e.decisionStatus != nil { "Decided" }
            else { nil }
        return [e.personName, e.outletName, distance, order, reason, decision].compactMap { $0 }
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
