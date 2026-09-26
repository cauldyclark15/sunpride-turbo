import Foundation
import Security
import SQLCipher

/// Opaque identity from the authenticated device context, never from a cached employee profile.
struct StorePartition: Hashable, Sendable {
    let subject: String
    let deviceId: String
    let scope: String // bootstrap scope.fingerprint

    init(subject: String, deviceId: String, scope: String) throws {
        guard !subject.isEmpty, !deviceId.isEmpty, !scope.isEmpty else { throw StoreError.invalidInput }
        self.subject = subject
        self.deviceId = deviceId
        self.scope = scope
    }
}

struct StoreSnapshot: Sendable {
    struct Employee: Codable, Sendable { let id: String; let role: String; let orgUnitId: String }
    struct Visit: Codable, Sendable {
        let id: String; let outletId: String; let serviceDate: String
        let planId: String; let planVersion: Int; let intents: [String]
    }
    struct Outlet: Codable, Sendable { let id: String; let name: String; let routeId: String? }
    struct Customer: Codable, Sendable { let id: String; let code: String }
    struct Route: Codable, Sendable { let id: String; let code: String }
    struct Task: Codable, Sendable { let id: String; let kind: String; let required: Bool }
    let employee: Employee
    let visits: [Visit]
    let outlets: [Outlet]
    let customers: [Customer]
    let route: Route?
    let tasks: [Task]
}

/// Exact serialized v1 operation is immutable after enqueue. Caller supplies a UUID, including for check-in.
struct VisitIntent: Sendable, Equatable {
    let requestId: UUID
    let kind: String
    let operationJSON: Data
}

struct OutboxItem: Sendable, Equatable {
    let intent: VisitIntent
    let sequence: Int64
}

struct ReviewItem: Sendable, Equatable {
    let intent: VisitIntent
    let code: String
}

struct ServerAck: Codable, Sendable, Equatable {
    let entityId: String
    let eventIds: [String]
    let serverTime: Int64 // epoch milliseconds
}

struct SyncHealth: Codable, Sendable, Equatable {
    let lastSuccessfulSyncAt: Int64?
    let lastErrorCode: String?
}

enum StoreError: Error, Equatable {
    case invalidInput, missingKey, invalidKey, notEncrypted, database, leaseExpired, heldForReview
    case unknownIntent, alreadyResolved, unsupportedVersion
}

/// All methods are confined to MainActor, including SQLite connection lifetime. No network or UI work in a transaction.
@MainActor
protocol FieldLocalStore: AnyObject {
    func saveSnapshot(_ snapshot: StoreSnapshot, cursor: String, leaseExpiresAt: Int64, cacheExpiresAt: Int64, for partition: StorePartition) throws
    func todayVisits(_ date: String, for partition: StorePartition) throws -> [StoreSnapshot.Visit]
    func outlets(for partition: StorePartition) throws -> [StoreSnapshot.Outlet]
    func snapshot(for partition: StorePartition) throws -> StoreSnapshot?
    func enqueue(_ intent: VisitIntent, for partition: StorePartition, now: Date) throws
    func pendingOutbox(for partition: StorePartition) throws -> [OutboxItem]
    func reviewOutbox(for partition: StorePartition) throws -> [ReviewItem]
    func recordAck(_ ack: ServerAck, for requestId: UUID, in partition: StorePartition) throws
    func recordRejection(code: String, for requestId: UUID, in partition: StorePartition) throws
    func ack(for requestId: UUID, in partition: StorePartition) throws -> ServerAck?
    func cursor(for partition: StorePartition) throws -> String?
    func setCursor(_ cursor: String?, for partition: StorePartition) throws
    func leaseExpiry(for partition: StorePartition) throws -> Int64?
    func cacheExpiry(for partition: StorePartition) throws -> Int64?
    func isLeaseValid(now: Date, for partition: StorePartition) throws -> Bool
    func syncHealth(for partition: StorePartition) throws -> SyncHealth?
    func setSyncHealth(_ health: SyncHealth, for partition: StorePartition) throws
    func holdForReview(_ partition: StorePartition) throws
}

/// SQLCipher 4 database. Keychain loss with an existing file is an error, never a new plaintext DB.
@MainActor
final class EncryptedFieldStore: FieldLocalStore {
    nonisolated(unsafe) private var db: OpaquePointer?
    let url: URL
    private let secrets: SecretStore
    private let keyAccount: String
    #if DEBUG
    var failAfterIntentInsert = false
    #endif

    init(url: URL, secrets: SecretStore = KeychainStore(), keyAccount: String = "storage.sqlcipher.v1") throws {
        self.url = url
        self.secrets = secrets
        self.keyAccount = keyAccount
        let fm = FileManager.default
        let directory = url.deletingLastPathComponent()
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        try Self.protect(directory)
        let exists = fm.fileExists(atPath: url.path)
        let key: Data
        if let saved = try secrets.read(keyAccount) {
            guard saved.count == 32 else { throw StoreError.invalidKey }
            key = saved
        } else {
            guard !exists else { throw StoreError.missingKey }
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw StoreError.invalidKey }
            key = Data(bytes)
            try secrets.save(key, for: keyAccount)
        }
        do {
            guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else { throw StoreError.database }
            // SQLCipher's SPM module does not expose sqlite3_key without SQLITE_HAS_CODEC in the importer.
            // Raw 256-bit key syntax avoids a PBKDF password; never print the SQL or key.
            let hex = key.map { String(format: "%02x", $0) }.joined()
            try exec("PRAGMA key = \"x'\(hex)'\"")
            guard try scalar("PRAGMA cipher_version") != nil else { throw StoreError.notEncrypted }
            // Forces key verification before any schema/migration writes. Never use a plaintext fallback.
            _ = try scalar("SELECT count(*) FROM sqlite_master")
            try exec("PRAGMA journal_mode=WAL")
            guard try scalar("PRAGMA journal_mode")?.lowercased() == "wal" else { throw StoreError.database }
            try exec("PRAGMA synchronous=FULL")
            try exec("PRAGMA foreign_keys=ON")
            try exec("PRAGMA temp_store=MEMORY")
            try migrate()
            try protectFiles()
        } catch {
            if db != nil { sqlite3_close(db); db = nil }
            throw error
        }
    }

    deinit { if db != nil { sqlite3_close(db) } }
    func close() { if db != nil { sqlite3_close(db); db = nil } }

    private static func protect(_ url: URL) throws {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var target = url
        try target.setResourceValues(values)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
    }

    private func protectFiles() throws {
        for suffix in ["", "-wal", "-shm"] {
            let file = URL(fileURLWithPath: url.path + suffix)
            if FileManager.default.fileExists(atPath: file.path) { try Self.protect(file) }
        }
    }

    private func exec(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw StoreError.database }
    }
    private func scalar(_ sql: String) throws -> String? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw StoreError.invalidKey }
        defer { sqlite3_finalize(statement) }
        let result = sqlite3_step(statement)
        guard result == SQLITE_ROW || result == SQLITE_DONE else { throw StoreError.invalidKey }
        if result == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) { return String(cString: text) }
        return nil
    }

    private enum Value { case text(String), integer(Int64), blob(Data), null }
    private func query<T>(_ sql: String, _ values: [Value] = [], _ row: (OpaquePointer) throws -> T) throws -> [T] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw StoreError.database }
        defer { sqlite3_finalize(statement) }
        for (index, value) in values.enumerated() {
            let i = Int32(index + 1)
            let rc: Int32
            switch value {
            case .text(let string):
                rc = string.withCString { sqlite3_bind_text(statement, i, $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
            case .integer(let number): rc = sqlite3_bind_int64(statement, i, number)
            case .blob(let data): rc = data.withUnsafeBytes { sqlite3_bind_blob(statement, i, $0.baseAddress, Int32($0.count), unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
            case .null: rc = sqlite3_bind_null(statement, i)
            }
            guard rc == SQLITE_OK else { throw StoreError.database }
        }
        var result: [T] = []
        while true {
            switch sqlite3_step(statement) {
            case SQLITE_ROW: result.append(try row(statement))
            case SQLITE_DONE: return result
            default: throw StoreError.database
            }
        }
    }
    private func run(_ sql: String, _ values: [Value] = []) throws {
        _ = try query(sql, values) { _ in () }
    }
    private static func text(_ row: OpaquePointer, _ column: Int32) -> String {
        guard let bytes = sqlite3_column_text(row, column) else { return "" }
        return String(cString: bytes)
    }
    private static func data(_ row: OpaquePointer, _ column: Int32) -> Data {
        guard let bytes = sqlite3_column_blob(row, column) else { return Data() }
        return Data(bytes: bytes, count: Int(sqlite3_column_bytes(row, column)))
    }
    private func transaction(_ work: () throws -> Void) throws {
        try exec("BEGIN IMMEDIATE")
        do { try work(); try exec("COMMIT") }
        catch { try? exec("ROLLBACK"); throw error }
    }
    private func p(_ partition: StorePartition) -> [Value] {
        [.text(partition.subject), .text(partition.deviceId), .text(partition.scope)]
    }
    private static let predicate = "subject=? AND device=? AND scope=?"
    private static let createV1 = """
        CREATE TABLE IF NOT EXISTS partitions (
          subject TEXT NOT NULL, device TEXT NOT NULL, scope TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 0, cursor TEXT, lease_expiry INTEGER,
          cache_expiry INTEGER, health BLOB, held INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(subject,device,scope));
        CREATE TABLE IF NOT EXISTS snapshot (
          subject TEXT NOT NULL, device TEXT NOT NULL, scope TEXT NOT NULL,
          generation INTEGER NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
          service_date TEXT, body BLOB NOT NULL,
          PRIMARY KEY(subject,device,scope,generation,kind,id));
        CREATE INDEX IF NOT EXISTS snapshot_today ON snapshot(subject,device,scope,generation,kind,service_date);
        CREATE TABLE IF NOT EXISTS intents (
          subject TEXT NOT NULL, device TEXT NOT NULL, scope TEXT NOT NULL,
          request_id TEXT NOT NULL, kind TEXT NOT NULL, body BLOB NOT NULL,
          PRIMARY KEY(subject,device,scope,request_id));
        CREATE TABLE IF NOT EXISTS outbox (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          subject TEXT NOT NULL, device TEXT NOT NULL, scope TEXT NOT NULL,
          request_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
          rejection_code TEXT,
          UNIQUE(subject,device,scope,request_id));
        CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(subject,device,scope,status,sequence);
        CREATE TABLE IF NOT EXISTS acks (
          subject TEXT NOT NULL, device TEXT NOT NULL, scope TEXT NOT NULL,
          request_id TEXT NOT NULL, body BLOB NOT NULL,
          PRIMARY KEY(subject,device,scope,request_id));
        """
    private func migrate() throws {
        guard let raw = try scalar("PRAGMA user_version"), let version = Int(raw), version <= 1 else { throw StoreError.unsupportedVersion }
        if version == 1 { return }
        try transaction {
            if version == 0 {
                // Legacy v0 pilot table has durable request IDs; copy, never generate replacement UUIDs.
                let legacy = try scalar("SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_intents'") != nil
                try exec(Self.createV1)
                if legacy {
                    try exec("INSERT OR IGNORE INTO partitions(subject,device,scope) SELECT DISTINCT subject,device,scope FROM legacy_intents")
                    try exec("INSERT INTO intents(subject,device,scope,request_id,kind,body) SELECT subject,device,scope,request_id,kind,body FROM legacy_intents")
                    try exec("INSERT INTO outbox(subject,device,scope,request_id) SELECT subject,device,scope,request_id FROM legacy_intents ORDER BY rowid")
                    try exec("DROP TABLE legacy_intents")
                }
            }
            try exec("PRAGMA user_version=1")
        }
    }

    private func ensure(_ partition: StorePartition) throws {
        try run("INSERT OR IGNORE INTO partitions(subject,device,scope) VALUES (?,?,?)", p(partition))
    }
    private func state(_ partition: StorePartition) throws -> (Int64, Bool)? {
        try query("SELECT generation,held FROM partitions WHERE \(Self.predicate)", p(partition)) {
            (sqlite3_column_int64($0, 0), sqlite3_column_int64($0, 1) != 0)
        }.first
    }
    private func encode<T: Encodable>(_ value: T) throws -> Value { .blob(try JSONEncoder().encode(value)) }
    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T { try JSONDecoder().decode(type, from: data) }

    func saveSnapshot(_ snapshot: StoreSnapshot, cursor: String, leaseExpiresAt: Int64, cacheExpiresAt: Int64, for partition: StorePartition) throws {
        guard !cursor.isEmpty, leaseExpiresAt > 0, cacheExpiresAt > 0 else { throw StoreError.invalidInput }
        // Pre-encode before BEGIN. Every page must already have been verified by the caller.
        var rows: [(String, String, String?, Value)] = []
        rows.append(("employee", snapshot.employee.id, nil, try encode(snapshot.employee)))
        for v in snapshot.visits { rows.append(("visit", v.id, v.serviceDate, try encode(v))) }
        for v in snapshot.outlets { rows.append(("outlet", v.id, nil, try encode(v))) }
        for v in snapshot.customers { rows.append(("customer", v.id, nil, try encode(v))) }
        if let route = snapshot.route { rows.append(("route", route.id, nil, try encode(route))) }
        for v in snapshot.tasks { rows.append(("task", v.id, nil, try encode(v))) }
        guard rows.allSatisfy({ !$0.1.isEmpty }) else { throw StoreError.invalidInput }
        try transaction {
            try ensure(partition)
            let generation = (try state(partition)?.0 ?? 0) + 1
            for (kind, id, date, body) in rows {
                try run("INSERT INTO snapshot(subject,device,scope,generation,kind,id,service_date,body) VALUES (?,?,?,?,?,?,?,?)",
                        p(partition) + [.integer(generation), .text(kind), .text(id), date.map(Value.text) ?? .null, body])
            }
            try run("UPDATE partitions SET generation=?,cursor=?,lease_expiry=?,cache_expiry=?,held=0 WHERE \(Self.predicate)",
                    [.integer(generation), .text(cursor), .integer(leaseExpiresAt), .integer(cacheExpiresAt)] + p(partition))
            try run("DELETE FROM snapshot WHERE \(Self.predicate) AND generation<>?", p(partition) + [.integer(generation)])
            // Intents, outbox, acks and sync health are deliberately untouched.
        }
        try protectFiles()
    }
    private func entities<T: Decodable>(_ type: T.Type, kind: String, partition: StorePartition, date: String? = nil) throws -> [T] {
        guard let (generation, _) = try state(partition), generation > 0 else { return [] }
        let sql = "SELECT body FROM snapshot WHERE \(Self.predicate) AND generation=? AND kind=?" + (date == nil ? "" : " AND service_date=?") + " ORDER BY id"
        return try query(sql, p(partition) + [.integer(generation), .text(kind)] + (date.map { [.text($0)] } ?? [])) {
            try decode(type, Self.data($0, 0))
        }
    }
    func todayVisits(_ date: String, for partition: StorePartition) throws -> [StoreSnapshot.Visit] {
        try entities(StoreSnapshot.Visit.self, kind: "visit", partition: partition, date: date)
    }
    func outlets(for partition: StorePartition) throws -> [StoreSnapshot.Outlet] {
        try entities(StoreSnapshot.Outlet.self, kind: "outlet", partition: partition)
    }
    func snapshot(for partition: StorePartition) throws -> StoreSnapshot? {
        guard let employee = try entities(StoreSnapshot.Employee.self, kind: "employee", partition: partition).first else { return nil }
        return try StoreSnapshot(employee: employee,
            visits: entities(StoreSnapshot.Visit.self, kind: "visit", partition: partition),
            outlets: outlets(for: partition),
            customers: entities(StoreSnapshot.Customer.self, kind: "customer", partition: partition),
            route: entities(StoreSnapshot.Route.self, kind: "route", partition: partition).first,
            tasks: entities(StoreSnapshot.Task.self, kind: "task", partition: partition))
    }
    func leaseExpiry(for partition: StorePartition) throws -> Int64? {
        try query("SELECT lease_expiry FROM partitions WHERE \(Self.predicate)", p(partition)) {
            sqlite3_column_type($0, 0) == SQLITE_NULL ? nil : sqlite3_column_int64($0, 0)
        }.first ?? nil
    }
    func cacheExpiry(for partition: StorePartition) throws -> Int64? {
        try query("SELECT cache_expiry FROM partitions WHERE \(Self.predicate)", p(partition)) {
            sqlite3_column_type($0, 0) == SQLITE_NULL ? nil : sqlite3_column_int64($0, 0)
        }.first ?? nil
    }
    func isLeaseValid(now: Date, for partition: StorePartition) throws -> Bool {
        guard let expiry = try leaseExpiry(for: partition) else { return false }
        return now.timeIntervalSince1970 * 1000 < Double(expiry)
    }
    func enqueue(_ intent: VisitIntent, for partition: StorePartition, now: Date) throws {
        guard ["visit.checkIn", "visit.activity", "visit.checkOut"].contains(intent.kind),
              !intent.operationJSON.isEmpty else { throw StoreError.invalidInput }
        // Validate a single immutable serialized operation; no financial/unsupported kinds.
        guard let json = try? JSONSerialization.jsonObject(with: intent.operationJSON) as? [String: Any],
              json["kind"] as? String == intent.kind,
              json["clientRequestId"] as? String == intent.requestId.uuidString.lowercased(),
              json["payload"] is [String: Any] else { throw StoreError.invalidInput }
        try transaction {
            guard try isLeaseValid(now: now, for: partition) else { throw StoreError.leaseExpired }
            guard try state(partition)?.1 == false else { throw StoreError.heldForReview }
            try run("INSERT INTO intents(subject,device,scope,request_id,kind,body) VALUES (?,?,?,?,?,?)",
                    p(partition) + [.text(intent.requestId.uuidString.lowercased()), .text(intent.kind), .blob(intent.operationJSON)])
            #if DEBUG
            if failAfterIntentInsert { throw StoreError.database }
            #endif
            try run("INSERT INTO outbox(subject,device,scope,request_id) VALUES (?,?,?,?)",
                    p(partition) + [.text(intent.requestId.uuidString.lowercased())])
        }
        try protectFiles()
    }
    func pendingOutbox(for partition: StorePartition) throws -> [OutboxItem] {
        try query("SELECT o.sequence,i.request_id,i.kind,i.body FROM outbox o JOIN intents i ON i.subject=o.subject AND i.device=o.device AND i.scope=o.scope AND i.request_id=o.request_id WHERE o.subject=? AND o.device=? AND o.scope=? AND o.status='pending' ORDER BY o.sequence", p(partition)) { row in
            guard let uuid = UUID(uuidString: Self.text(row, 1)) else { throw StoreError.database }
            return OutboxItem(intent: VisitIntent(requestId: uuid, kind: Self.text(row, 2), operationJSON: Self.data(row, 3)), sequence: sqlite3_column_int64(row, 0))
        }
    }
    func reviewOutbox(for partition: StorePartition) throws -> [ReviewItem] {
        try query("SELECT i.request_id,i.kind,i.body,o.rejection_code FROM outbox o JOIN intents i ON i.subject=o.subject AND i.device=o.device AND i.scope=o.scope AND i.request_id=o.request_id WHERE o.subject=? AND o.device=? AND o.scope=? AND o.status='rejected' ORDER BY o.sequence", p(partition)) { row in
            guard let uuid = UUID(uuidString: Self.text(row, 0)) else { throw StoreError.database }
            return ReviewItem(intent: VisitIntent(requestId: uuid, kind: Self.text(row, 1), operationJSON: Self.data(row, 2)), code: Self.text(row, 3))
        }
    }
    func recordAck(_ ack: ServerAck, for requestId: UUID, in partition: StorePartition) throws {
        guard !ack.entityId.isEmpty, ack.serverTime > 0 else { throw StoreError.invalidInput }
        let id = requestId.uuidString.lowercased()
        try transaction {
            let status = try outcome(id, partition)
            guard status == "pending" else { throw status == nil ? StoreError.unknownIntent : StoreError.alreadyResolved }
            try run("INSERT INTO acks(subject,device,scope,request_id,body) VALUES (?,?,?,?,?)", p(partition) + [.text(id), try encode(ack)])
            try run("UPDATE outbox SET status='done' WHERE \(Self.predicate) AND request_id=? AND EXISTS (SELECT 1 FROM acks WHERE \(Self.predicate) AND request_id=?)",
                    p(partition) + [.text(id)] + p(partition) + [.text(id)])
        }
    }
    func recordRejection(code: String, for requestId: UUID, in partition: StorePartition) throws {
        guard !code.isEmpty else { throw StoreError.invalidInput }
        let id = requestId.uuidString.lowercased()
        try transaction {
            let status = try outcome(id, partition)
            guard status == "pending" else { throw status == nil ? StoreError.unknownIntent : StoreError.alreadyResolved }
            try run("UPDATE outbox SET status='rejected',rejection_code=? WHERE \(Self.predicate) AND request_id=?", [.text(code)] + p(partition) + [.text(id)])
        }
    }
    private func outcome(_ id: String, _ partition: StorePartition) throws -> String? {
        try query("SELECT status FROM outbox WHERE \(Self.predicate) AND request_id=?", p(partition) + [.text(id)]) { Self.text($0, 0) }.first
    }
    func ack(for requestId: UUID, in partition: StorePartition) throws -> ServerAck? {
        try query("SELECT body FROM acks WHERE \(Self.predicate) AND request_id=?", p(partition) + [.text(requestId.uuidString.lowercased())]) {
            try decode(ServerAck.self, Self.data($0, 0))
        }.first
    }
    func cursor(for partition: StorePartition) throws -> String? {
        try query("SELECT cursor FROM partitions WHERE \(Self.predicate)", p(partition)) {
            sqlite3_column_type($0, 0) == SQLITE_NULL ? nil : Self.text($0, 0)
        }.first ?? nil
    }
    func setCursor(_ cursor: String?, for partition: StorePartition) throws {
        try transaction {
            try ensure(partition)
            try run("UPDATE partitions SET cursor=? WHERE \(Self.predicate)", [cursor.map(Value.text) ?? .null] + p(partition))
        }
    }
    func syncHealth(for partition: StorePartition) throws -> SyncHealth? {
        try query("SELECT health FROM partitions WHERE \(Self.predicate) AND health IS NOT NULL", p(partition)) {
            try decode(SyncHealth.self, Self.data($0, 0))
        }.first
    }
    func setSyncHealth(_ health: SyncHealth, for partition: StorePartition) throws {
        try transaction {
            try ensure(partition)
            try run("UPDATE partitions SET health=? WHERE \(Self.predicate)", [try encode(health)] + p(partition))
        }
    }
    /// Sign-out/revocation: preserve all durable evidence, stop new intents and hide it from other partitions.
    func holdForReview(_ partition: StorePartition) throws {
        try run("UPDATE partitions SET held=1,cursor=NULL WHERE \(Self.predicate)", p(partition))
    }

    #if DEBUG
    /// Migration harness only. Creates an encrypted pre-v1 fixture with a caller-owned durable UUID.
    static func createLegacyV0(url: URL, secrets: SecretStore, keyAccount: String,
                               partition: StorePartition, intent: VisitIntent) throws {
        // Initialize an encrypted file, then recreate the v0 schema under its existing key.
        let store = try EncryptedFieldStore(url: url, secrets: secrets, keyAccount: keyAccount)
        try store.transaction {
            try store.exec("DROP TABLE acks; DROP TABLE outbox; DROP TABLE intents; DROP TABLE snapshot; DROP TABLE partitions")
            try store.exec("CREATE TABLE legacy_intents(subject TEXT,device TEXT,scope TEXT,request_id TEXT,kind TEXT,body BLOB)")
            try store.run("INSERT INTO legacy_intents VALUES(?,?,?,?,?,?)", store.p(partition) + [.text(intent.requestId.uuidString.lowercased()), .text(intent.kind), .blob(intent.operationJSON)])
            try store.exec("PRAGMA user_version=0")
        }
        store.close()
    }
    #endif
}
