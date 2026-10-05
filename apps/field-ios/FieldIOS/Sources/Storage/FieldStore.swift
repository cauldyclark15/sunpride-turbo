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
        let sequence: Int?
        init(id: String, outletId: String, serviceDate: String, planId: String, planVersion: Int,
             intents: [String], sequence: Int? = nil) {
            self.id = id; self.outletId = outletId; self.serviceDate = serviceDate
            self.planId = planId; self.planVersion = planVersion; self.intents = intents; self.sequence = sequence
        }
        /// Stable fallback for old feeds: an absent sequence uses the original list position.
        static func ordered(_ visits: [Visit]) -> [Visit] {
            visits.enumerated().sorted {
                let a = $0.element.sequence ?? $0.offset, b = $1.element.sequence ?? $1.offset
                return a == b ? $0.offset < $1.offset : a < b
            }.map(\.element)
        }
    }
    struct Coordinate: Codable, Sendable, Equatable { let latitude: Double; let longitude: Double }
    /// code/customerId/address/latitude/longitude are additive v1 route-screen fields; older feeds omit them.
    struct Outlet: Codable, Sendable {
        let id: String; let name: String; let routeId: String?
        var code: String? = nil
        var customerId: String? = nil
        var address: String? = nil
        /// Current verified pin, sent flat on the wire: both or neither.
        var latitude: Double? = nil
        var longitude: Double? = nil
        /// Additive v1 field (order association): territory of the signed planned visit, both or neither.
        var territoryId: String? = nil
        var territoryCode: String? = nil

        init(id: String, name: String, routeId: String?, code: String? = nil, customerId: String? = nil,
             address: String? = nil, location: Coordinate? = nil, territoryId: String? = nil, territoryCode: String? = nil) {
            self.id = id; self.name = name; self.routeId = routeId
            self.code = code; self.customerId = customerId; self.address = address
            latitude = location?.latitude; longitude = location?.longitude
            self.territoryId = territoryId; self.territoryCode = territoryCode
        }

        var location: Coordinate? {
            guard let latitude, let longitude else { return nil }
            return Coordinate(latitude: latitude, longitude: longitude)
        }
        /// Verified pin for the Start/End distance notice; nil when absent or out of range.
        var pin: OutletPin? { OutletPin(latitude: latitude, longitude: longitude) }
        var hasValidPinFields: Bool { (latitude == nil && longitude == nil) || pin != nil }
    }
    struct Customer: Codable, Sendable { let id: String; let code: String }
    struct Route: Codable, Sendable { let id: String; let code: String }
    struct Task: Codable, Sendable { let id: String; let kind: String; let required: Bool }
    /// Daily position standard (client memo; call answer 1: targets are per day, per route).
    struct DayTarget: Codable, Sendable, Equatable {
        var dailyCalls: Int? = nil
        var productivePct: Double? = nil
        var sourceRef: String? = nil
        /// Governed productive-call rule (server sfa/productive_call.ts); absent = any listed activity.
        var productiveCallRule: String? = nil
        var isValid: Bool {
            (dailyCalls.map { $0 >= 0 } ?? true) && (productivePct.map { $0.isFinite && (0...100).contains($0) } ?? true)
                && (sourceRef.map { !$0.isEmpty } ?? true) && (productiveCallRule.map { !$0.isEmpty } ?? true)
        }
    }
    /// Today's sales as the server counted them (Daily Sales Report rules), PHP centavos, as of
    /// the bootstrap's server time. Order capture is not on the phone, so this is the day's total.
    struct DaySales: Codable, Sendable, Equatable {
        let amountMinor: Int64
        let orders: Int
        var targetMinor: Int64? = nil
        /// Server time of the download (epoch ms); set by the phone, never read from the wire.
        var asOf: Int64? = nil
        var isValid: Bool { orders >= 0 && (targetMinor.map { $0 >= 0 } ?? true) }
    }
    let employee: Employee
    let visits: [Visit]
    let outlets: [Outlet]
    let customers: [Customer]
    let route: Route?
    let tasks: [Task]
    let callSheets: [CallSheet]
    let productCatalog: [BootstrapV1.Product]
    let inventoryAvailability: [BootstrapV1.InventoryAvailability]
    /// IOS-011 cached account figures, one per outlet; stored with the snapshot generation.
    let accountSummaries: [AccountSummary]
    var dayTarget: DayTarget? = nil
    var daySales: DaySales? = nil
    /// IOS-013 activity-form rules per visit intent, in server order; empty from older servers.
    var activityRules: [ActivityRule] = []
    /// IOS-016 photo types from the server; empty from older servers (the phone then offers defaults).
    var photoTypes: [PhotoType] = []

    init(employee: Employee, visits: [Visit], outlets: [Outlet], customers: [Customer],
         route: Route?, tasks: [Task], callSheets: [CallSheet] = [],
         productCatalog: [BootstrapV1.Product] = [], inventoryAvailability: [BootstrapV1.InventoryAvailability] = [],
         accountSummaries: [AccountSummary] = [],
         dayTarget: DayTarget? = nil, daySales: DaySales? = nil, activityRules: [ActivityRule] = [],
         photoTypes: [PhotoType] = []) {
        self.employee = employee; self.visits = visits; self.outlets = outlets
        self.customers = customers; self.route = route; self.tasks = tasks; self.callSheets = callSheets
        self.productCatalog = productCatalog; self.inventoryAvailability = inventoryAvailability
        self.accountSummaries = accountSummaries
        self.dayTarget = dayTarget; self.daySales = daySales; self.activityRules = activityRules
        self.photoTypes = photoTypes
    }
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

struct DeltaChange: Decodable, Sendable {
    let seq: Int64
    let entity: String
    let id: String
    let revision: Int64
    let op: String
    let value: Data?

    enum CodingKeys: String, CodingKey { case seq, entity, id, revision, op, value }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decode(Int64.self, forKey: .seq)
        entity = try c.decode(String.self, forKey: .entity)
        id = try c.decode(String.self, forKey: .id)
        revision = try c.decode(Int64.self, forKey: .revision)
        op = try c.decode(String.self, forKey: .op)
        if c.contains(.value) {
            let raw = try c.decode([String: JSONValue].self, forKey: .value)
            value = try JSONEncoder().encode(raw)
        } else { value = nil }
        let reference = ["product", "inventory"].contains(entity)
        // Reference rows share a high-water (possibly zero); it is not a deduplication key.
        // Unsupported entities still fail closed, as they did for visit/activity-only pulls.
        guard (reference ? seq >= 0 : seq > 0), revision > 0, !id.isEmpty,
              ["visit", "activity", "product", "inventory"].contains(entity),
              (op == "upsert" && value != nil) || (!reference && op == "tombstone" && value == nil) else {
            throw StoreError.invalidInput
        }
    }
}

/// Lossless enough for the narrow server projection, preserving null/numeric/string values.
indirect enum JSONValue: Codable {
    case string(String), integer(Int64), number(Double), bool(Bool), null, array([JSONValue]), object([String: JSONValue])
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Int64.self) { self = .integer(n) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .integer(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
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
    func catalog(for partition: StorePartition) throws -> [BootstrapV1.Product]
    func availability(productId: String, for partition: StorePartition) throws -> [BootstrapV1.InventoryAvailability]
    func snapshot(for partition: StorePartition) throws -> StoreSnapshot?
    func enqueue(_ intent: VisitIntent, for partition: StorePartition, now: Date) throws
    func enqueueDeferred(_ intent: VisitIntent, for partition: StorePartition, now: Date) throws
    func deferredOutbox(for partition: StorePartition) throws -> [OutboxItem]
    func materialize(_ requestId: UUID, visitId: String, in partition: StorePartition) throws
    func intent(for requestId: UUID, in partition: StorePartition) throws -> VisitIntent?
    func intents(for partition: StorePartition) throws -> [VisitIntent]
    func applyDelta(_ changes: [DeltaChange], nextCursor: String, for partition: StorePartition) throws
    func deltaValue(entity: String, id: String, for partition: StorePartition) throws -> Data?
    func pendingOutbox(for partition: StorePartition) throws -> [OutboxItem]
    func heldOutbox(for partition: StorePartition) throws -> [OutboxItem]
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
    /// QSR-010 confirmed revocation: hold, then drop this partition's server cache (keeps unsent evidence).
    func purgeCacheForReview(_ partition: StorePartition) throws
    /// QSR-010 sign-out: hold every partition and drop every server cache (keeps unsent evidence).
    func purgeAllCachesForReview() throws
    func releaseHeld(_ partition: StorePartition) throws
    func releaseHeld(subject: String, deviceId: String) throws
    func isHeld(_ partition: StorePartition) throws -> Bool
    func hasOtherHeldWork(for partition: StorePartition) throws -> Bool
    /// IOS-016: save one captured photo's metadata for an open call (after Start, before End).
    /// The sealed bytes must already be durable in `PhotoFiles` under the same local ID.
    func savePhoto(_ row: EvidencePhotoRow, for partition: StorePartition, now: Date) throws
    func photos(forCheckIn requestId: UUID, in partition: StorePartition) throws -> [EvidencePhotoRow]
    func pendingPhotos(for partition: StorePartition) throws -> [EvidencePhotoRow]
    func reviewPhotos(for partition: StorePartition) throws -> [EvidencePhotoRow]
    func markPhotoUploaded(_ localId: UUID, evidenceId: String, at: Int64, in partition: StorePartition) throws
    func reviewPhoto(_ localId: UUID, code: String, in partition: StorePartition) throws
    /// Returns the attempt count after this failed try.
    func countPhotoAttempt(_ localId: UUID, in partition: StorePartition) throws -> Int
    /// SP-0044 order drafts (local); a draft reaches the outbox only through `submitOrderDraft` (IOS-015).
    func orderDrafts(for partition: StorePartition) throws -> [OrderDraft]
    /// Insert or replace one draft after `OrderDraftRules.validate` inside the same transaction.
    func saveOrderDraft(_ draft: OrderDraft, for partition: StorePartition, now: Date) throws
    /// The salesperson discards their own unsent draft; a held partition stays frozen.
    func discardOrderDraft(_ draftId: String, for partition: StorePartition) throws
    /// IOS-015: queue the draft's own `order_intent` request and freeze the draft, in one transaction.
    /// The request is deferred until the check-in ack supplies the server visit ID.
    @discardableResult
    func submitOrderDraft(_ draftId: String, intent: VisitIntent, for partition: StorePartition, now: Date) throws -> OrderDraft
    /// Stored outbox state of one request: pending, deferred, done or "rejected:<code>"; nil if unknown.
    func requestState(for requestId: UUID, in partition: StorePartition) throws -> String?
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
    var failBeforeDeltaCursor = false
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
            // QSR-010: deleted cache rows are overwritten, not left in free pages.
            try exec("PRAGMA secure_delete=ON")
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
        CREATE TABLE IF NOT EXISTS delta (
          subject TEXT NOT NULL, device TEXT NOT NULL, scope TEXT NOT NULL,
          entity TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body BLOB,
          PRIMARY KEY(subject,device,scope,entity,id));
        """
    private func migrate() throws {
        guard let raw = try scalar("PRAGMA user_version"), let version = Int(raw), version <= 6 else { throw StoreError.unsupportedVersion }
        if version == 6 { return }
        try transaction {
            if version < 3 { try migrateToV3(from: version) }
            if version < 4 {
                // v4 (SP-0044): local order drafts, partitioned like every other row; no existing table changes.
                try exec("""
                    CREATE TABLE order_drafts (
                      subject TEXT NOT NULL, device TEXT NOT NULL, scope TEXT NOT NULL,
                      draft_id TEXT NOT NULL, client_visit_id TEXT NOT NULL, outlet_id TEXT NOT NULL,
                      created_at INTEGER NOT NULL, body BLOB NOT NULL,
                      PRIMARY KEY(subject,device,scope,draft_id));
                    """)
            }
            if version < 5 {
                // v5 (SP-0051): reference rows belong to the same account/device/scope and snapshot generation.
                try exec("""
                    CREATE TABLE reference_data (
                      subject TEXT NOT NULL, device TEXT NOT NULL, scope TEXT NOT NULL,
                      generation INTEGER NOT NULL, entity TEXT NOT NULL, id TEXT NOT NULL,
                      product_id TEXT NOT NULL, revision INTEGER NOT NULL, body BLOB NOT NULL,
                      PRIMARY KEY(subject,device,scope,generation,entity,id));
                    CREATE INDEX reference_product ON reference_data(subject,device,scope,generation,entity,product_id);
                    """)
            }
            // v6 (IOS-016): photo metadata. Bytes are sealed files; rows are evidence and are never
            // purged with the server cache (sign-out keeps them held for supervised review).
            try exec(Self.createPhotos + "PRAGMA user_version=6;")
        }
    }
    private static let createPhotos = """
        CREATE TABLE IF NOT EXISTS evidence_photos (
          subject TEXT NOT NULL, device TEXT NOT NULL, scope TEXT NOT NULL,
          local_id TEXT NOT NULL, check_in_request_id TEXT NOT NULL, photo_type TEXT NOT NULL,
          mime TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, captured_at INTEGER NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
          evidence_id TEXT, review_code TEXT, uploaded_at INTEGER,
          PRIMARY KEY(subject,device,scope,local_id));
        CREATE INDEX IF NOT EXISTS evidence_photos_state ON evidence_photos(subject,device,scope,state,captured_at);
        """
    private func migrateToV3(from version: Int) throws {
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
            if version == 1 { try exec("CREATE TABLE delta(subject TEXT NOT NULL,device TEXT NOT NULL,scope TEXT NOT NULL,entity TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,body BLOB,PRIMARY KEY(subject,device,scope,entity,id))") }
            // v3: Annex C stays in the SQLCipher database and participates in generation promotion.
            try exec("""
                CREATE TABLE call_sheets (
                  subject TEXT NOT NULL, device TEXT NOT NULL, scope TEXT NOT NULL,
                  generation INTEGER NOT NULL, outlet_id TEXT NOT NULL, body BLOB NOT NULL,
                  PRIMARY KEY(subject,device,scope,generation,outlet_id));
                """)
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
        // Account figures ride in the same generation rows, so they promote and expire with the plan.
        for v in snapshot.accountSummaries { rows.append(("account_summary", v.outletId, nil, try encode(v))) }
        if let target = snapshot.dayTarget { rows.append(("dayTarget", "today", nil, try encode(target))) }
        if let sales = snapshot.daySales { rows.append(("daySales", "today", nil, try encode(sales))) }
        // One row keeps the server's rule order; it rides the generic snapshot table (no migration).
        if !snapshot.activityRules.isEmpty { rows.append(("activityRules", "all", nil, try encode(snapshot.activityRules))) }
        if !snapshot.photoTypes.isEmpty { rows.append(("photoTypes", "all", nil, try encode(snapshot.photoTypes))) }
        guard rows.allSatisfy({ !$0.1.isEmpty }), snapshot.callSheets.allSatisfy(\.isValid),
              snapshot.callSheets.allSatisfy({ sheet in snapshot.outlets.contains { $0.id == sheet.outletId } }),
              Set(snapshot.accountSummaries.map(\.outletId)).count == snapshot.accountSummaries.count,
              snapshot.accountSummaries.allSatisfy({ $0.isValid && snapshot.outlets.map(\.id).contains($0.outletId) }) else { throw StoreError.invalidInput }
        guard snapshot.productCatalog.allSatisfy(\.isValid), snapshot.inventoryAvailability.allSatisfy(\.isValid) else {
            throw StoreError.invalidInput
        }
        let sheets = try snapshot.callSheets.map { ($0.outletId, try encode($0)) }
        var references: [(String, String, String, Int64, Value)] = []
        for product in snapshot.productCatalog {
            references.append(("product", product.id, product.id, product.revision ?? 0, try encode(product)))
        }
        for stock in snapshot.inventoryAvailability {
            references.append(("inventory", stock.id, stock.productId, stock.revision, try encode(stock)))
        }
        try transaction {
            try ensure(partition)
            let generation = (try state(partition)?.0 ?? 0) + 1
            for (kind, id, date, body) in rows {
                try run("INSERT INTO snapshot(subject,device,scope,generation,kind,id,service_date,body) VALUES (?,?,?,?,?,?,?,?)",
                        p(partition) + [.integer(generation), .text(kind), .text(id), date.map(Value.text) ?? .null, body])
            }
            for (outletId, body) in sheets {
                try run("INSERT INTO call_sheets(subject,device,scope,generation,outlet_id,body) VALUES (?,?,?,?,?,?)",
                        p(partition) + [.integer(generation), .text(outletId), body])
            }
            for (entity, id, productId, revision, body) in references {
                try writeReference(entity: entity, id: id, productId: productId, revision: revision,
                                   body: body, generation: generation, partition: partition, replacing: false)
            }
            try run("DELETE FROM reference_data WHERE \(Self.predicate) AND generation<>?", p(partition) + [.integer(generation)])
            try run("DELETE FROM call_sheets WHERE \(Self.predicate) AND generation<>?", p(partition) + [.integer(generation)])
            try run("UPDATE partitions SET generation=?,cursor=?,lease_expiry=?,cache_expiry=? WHERE \(Self.predicate)",
                    [.integer(generation), .text(cursor), .integer(leaseExpiresAt), .integer(cacheExpiresAt)] + p(partition))
            try run("DELETE FROM snapshot WHERE \(Self.predicate) AND generation<>?", p(partition) + [.integer(generation)])
            try run("DELETE FROM delta WHERE \(Self.predicate)", p(partition))
            // Intents, outbox, acks and sync health are deliberately untouched.
        }
        try protectFiles()
    }
    private func entities<T: Decodable>(_ type: T.Type, kind: String, partition: StorePartition, date: String? = nil) throws -> [T] {
        guard let (generation, _) = try state(partition), generation > 0 else { return [] }
        let sql = "SELECT body FROM snapshot WHERE \(Self.predicate) AND generation=? AND kind=?" + (date == nil ? "" : " AND service_date=?") + (kind == "visit" ? " ORDER BY rowid" : " ORDER BY id")
        return try query(sql, p(partition) + [.integer(generation), .text(kind)] + (date.map { [.text($0)] } ?? [])) {
            try decode(type, Self.data($0, 0))
        }
    }
    func todayVisits(_ date: String, for partition: StorePartition) throws -> [StoreSnapshot.Visit] {
        StoreSnapshot.Visit.ordered(try entities(StoreSnapshot.Visit.self, kind: "visit", partition: partition, date: date))
    }
    func outlets(for partition: StorePartition) throws -> [StoreSnapshot.Outlet] {
        try entities(StoreSnapshot.Outlet.self, kind: "outlet", partition: partition)
    }
    func callSheets(for partition: StorePartition) throws -> [CallSheet] {
        guard let (generation, _) = try state(partition), generation > 0 else { return [] }
        return try query("SELECT body FROM call_sheets WHERE \(Self.predicate) AND generation=? ORDER BY outlet_id",
                         p(partition) + [.integer(generation)]) { try decode(CallSheet.self, Self.data($0, 0)) }
    }
    private func referenceRows<T: Decodable>(_ type: T.Type, entity: String, partition: StorePartition,
                                             productId: String? = nil) throws -> [T] {
        guard let (generation, _) = try state(partition), generation > 0 else { return [] }
        return try query("SELECT body FROM reference_data WHERE \(Self.predicate) AND generation=? AND entity=?" +
                         (productId == nil ? "" : " AND product_id=?") + " ORDER BY id",
                         p(partition) + [.integer(generation), .text(entity)] + (productId.map { [.text($0)] } ?? [])) {
            try decode(type, Self.data($0, 0))
        }
    }
    func catalog(for partition: StorePartition) throws -> [BootstrapV1.Product] {
        try referenceRows(BootstrapV1.Product.self, entity: "product", partition: partition).sorted {
            $0.code == $1.code ? $0.id < $1.id : $0.code < $1.code
        }
    }
    func availability(productId: String, for partition: StorePartition) throws -> [BootstrapV1.InventoryAvailability] {
        try referenceRows(BootstrapV1.InventoryAvailability.self, entity: "inventory", partition: partition, productId: productId).sorted {
            $0.locationCode == $1.locationCode ? $0.id < $1.id : $0.locationCode < $1.locationCode
        }
    }
    private func writeReference(entity: String, id: String, productId: String, revision: Int64,
                                body: Value, generation: Int64, partition: StorePartition, replacing: Bool = true) throws {
        try run("INSERT " + (replacing ? "OR REPLACE " : "") +
                "INTO reference_data(subject,device,scope,generation,entity,id,product_id,revision,body) VALUES (?,?,?,?,?,?,?,?,?)",
                p(partition) + [.integer(generation), .text(entity), .text(id), .text(productId), .integer(revision), body])
    }
    func snapshot(for partition: StorePartition) throws -> StoreSnapshot? {
        guard let employee = try entities(StoreSnapshot.Employee.self, kind: "employee", partition: partition).first else { return nil }
        return try StoreSnapshot(employee: employee,
            visits: entities(StoreSnapshot.Visit.self, kind: "visit", partition: partition),
            outlets: outlets(for: partition),
            customers: entities(StoreSnapshot.Customer.self, kind: "customer", partition: partition),
            route: entities(StoreSnapshot.Route.self, kind: "route", partition: partition).first,
            tasks: entities(StoreSnapshot.Task.self, kind: "task", partition: partition),
            callSheets: callSheets(for: partition), productCatalog: catalog(for: partition),
            inventoryAvailability: referenceRows(BootstrapV1.InventoryAvailability.self, entity: "inventory", partition: partition),
            accountSummaries: entities(AccountSummary.self, kind: "account_summary", partition: partition),
            dayTarget: entities(StoreSnapshot.DayTarget.self, kind: "dayTarget", partition: partition).first,
            daySales: entities(StoreSnapshot.DaySales.self, kind: "daySales", partition: partition).first,
            activityRules: activityRules(for: partition),
            photoTypes: entities([PhotoType].self, kind: "photoTypes", partition: partition).first ?? [])
    }
    func activityRules(for partition: StorePartition) throws -> [ActivityRule] {
        try entities([ActivityRule].self, kind: "activityRules", partition: partition).first ?? []
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
            try validateOpenCall(intent, partition)
            try validateActivityRules(intent, partition)
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
    /// A dependent action cannot be a wire operation until the server returns the check-in's
    /// opaque visit ID. Save its local template and UUID atomically; materialize once before send.
    func enqueueDeferred(_ intent: VisitIntent, for partition: StorePartition, now: Date) throws {
        guard ["visit.activity", "visit.checkOut"].contains(intent.kind),
              let object = try? JSONSerialization.jsonObject(with: intent.operationJSON) as? [String: Any],
              object["kind"] as? String == intent.kind,
              object["clientRequestId"] as? String == intent.requestId.uuidString.lowercased(),
              let deps = object["dependsOn"] as? [String], deps.count == 1,
              UUID(uuidString: deps[0]) != nil,
              let payload = object["payload"] as? [String: Any], payload["visitId"] == nil else { throw StoreError.invalidInput }
        try transaction {
            guard try isLeaseValid(now: now, for: partition) else { throw StoreError.leaseExpired }
            guard try state(partition)?.1 == false else { throw StoreError.heldForReview }
            try validateOpenCall(intent, partition)
            try validateActivityRules(intent, partition)
            try run("INSERT INTO intents(subject,device,scope,request_id,kind,body) VALUES (?,?,?,?,?,?)",
                    p(partition) + [.text(intent.requestId.uuidString.lowercased()), .text(intent.kind), .blob(intent.operationJSON)])
            try run("INSERT INTO outbox(subject,device,scope,request_id,status) VALUES (?,?,?,?,'deferred')",
                    p(partition) + [.text(intent.requestId.uuidString.lowercased())])
        }
        try protectFiles()
    }
    /// IOS-017, inside the enqueue transaction: once a call's End is queued (or accepted) the visit
    /// is final on this phone — no activity may be added and it cannot end twice. A server-rejected
    /// End does not close the call.
    private func validateOpenCall(_ item: VisitIntent, _ partition: StorePartition) throws {
        guard item.kind == "visit.activity" || item.kind == "visit.checkOut",
              let dependency = item.dependencies.first, let checkInId = UUID(uuidString: dependency),
              let checkIn = try intent(for: checkInId, in: partition), checkIn.kind == "visit.checkIn" else { return }
        let rejected = Set(try reviewOutbox(for: partition).map { $0.intent.requestId })
        guard VisitCompletion.isOpen(checkIn, intents: try intents(for: partition), rejected: rejected) else {
            throw StoreError.invalidInput
        }
    }
    /// IOS-013, inside the enqueue transaction: a structured form must match its wire shape and the
    /// account's call-sheet products, and a "completed" End needs every capturable required form
    /// recorded for its call. Notes, call sheets and not-productive Ends keep their own checks.
    private func validateActivityRules(_ item: VisitIntent, _ partition: StorePartition) throws {
        guard item.kind == "visit.activity" || item.kind == "visit.checkOut", let payload = item.payload else { return }
        let activity = payload["activity"] as? [String: Any]
        if item.kind == "visit.activity" {
            // IOS-015: an order is queued only by `submitOrderDraft`, bound to its unsent draft.
            if activity?["kind"] as? String == OrderSubmission.kind { throw StoreError.invalidInput }
            guard let kind = activity?["kind"] as? String, ActivityRules.structuredForms.contains(kind) else { return }
        } else if payload["outcome"] as? String != "completed" { return }
        guard let dependency = item.dependencies.first, let checkInId = UUID(uuidString: dependency),
              let checkIn = try intent(for: checkInId, in: partition), checkIn.kind == "visit.checkIn",
              let outletId = checkIn.payload?["outletId"] as? String else {
            if item.kind == "visit.checkOut" { return } // The call guards own an End without a Start.
            throw StoreError.invalidInput
        }
        let sheet = try callSheets(for: partition).first { $0.outletId == outletId }
        if item.kind == "visit.activity", let activity {
            do { try ActivityForms.validate(activity, sheet: sheet) } catch { throw StoreError.invalidInput }
            return
        }
        let rejected = Set(try reviewOutbox(for: partition).map { $0.intent.requestId })
        let missing = ActivityRules.missingForEnd(checkIn: checkIn, rules: try activityRules(for: partition),
                                                  intents: try intents(for: partition), rejected: rejected, sheet: sheet)
        guard missing.isEmpty else { throw StoreError.invalidInput }
    }
    func deferredOutbox(for partition: StorePartition) throws -> [OutboxItem] {
        try query("SELECT o.sequence,i.request_id,i.kind,i.body FROM outbox o JOIN intents i ON i.subject=o.subject AND i.device=o.device AND i.scope=o.scope AND i.request_id=o.request_id WHERE o.subject=? AND o.device=? AND o.scope=? AND o.status='deferred' ORDER BY o.sequence", p(partition)) { row in
            guard let uuid = UUID(uuidString: Self.text(row, 1)) else { throw StoreError.database }
            return OutboxItem(intent: VisitIntent(requestId: uuid, kind: Self.text(row, 2), operationJSON: Self.data(row, 3)), sequence: sqlite3_column_int64(row, 0))
        }
    }
    func intent(for requestId: UUID, in partition: StorePartition) throws -> VisitIntent? {
        try query("SELECT kind,body FROM intents WHERE \(Self.predicate) AND request_id=?", p(partition) + [.text(requestId.uuidString.lowercased())]) {
            VisitIntent(requestId: requestId, kind: Self.text($0, 0), operationJSON: Self.data($0, 1))
        }.first
    }
    func intents(for partition: StorePartition) throws -> [VisitIntent] {
        try query("SELECT i.request_id,i.kind,i.body FROM intents i JOIN outbox o ON o.subject=i.subject AND o.device=i.device AND o.scope=i.scope AND o.request_id=i.request_id WHERE i.subject=? AND i.device=? AND i.scope=? ORDER BY o.sequence", p(partition)) {
            guard let id = UUID(uuidString: Self.text($0, 0)) else { throw StoreError.database }
            return VisitIntent(requestId: id, kind: Self.text($0, 1), operationJSON: Self.data($0, 2))
        }
    }
    func materialize(_ requestId: UUID, visitId: String, in partition: StorePartition) throws {
        guard !visitId.isEmpty, let intent = try intent(for: requestId, in: partition),
              var object = try JSONSerialization.jsonObject(with: intent.operationJSON) as? [String: Any],
              var payload = object["payload"] as? [String: Any], payload["visitId"] == nil else { throw StoreError.invalidInput }
        payload["visitId"] = visitId
        object["payload"] = payload
        let bytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        try transaction {
            guard try outcome(requestId.uuidString.lowercased(), partition) == "deferred" else { throw StoreError.alreadyResolved }
            try run("UPDATE intents SET body=? WHERE \(Self.predicate) AND request_id=?", [.blob(bytes)] + p(partition) + [.text(requestId.uuidString.lowercased())])
            try run("UPDATE outbox SET status='pending' WHERE \(Self.predicate) AND request_id=?", p(partition) + [.text(requestId.uuidString.lowercased())])
        }
    }
    func applyDelta(_ changes: [DeltaChange], nextCursor: String, for partition: StorePartition) throws {
        guard !nextCursor.isEmpty else { throw StoreError.invalidInput }
        try transaction {
            guard let (generation, _) = try state(partition) else { throw StoreError.invalidInput }
            for change in changes {
                if ["product", "inventory"].contains(change.entity) {
                    try applyReference(change, generation: generation, partition: partition)
                    continue
                }
                let existing = try query("SELECT revision FROM delta WHERE \(Self.predicate) AND entity=? AND id=?", p(partition) + [.text(change.entity), .text(change.id)]) { sqlite3_column_int64($0, 0) }.first ?? 0
                guard change.revision > existing else { continue }
                let pending = try query("SELECT i.body FROM intents i JOIN outbox o ON o.subject=i.subject AND o.device=i.device AND o.scope=i.scope AND o.request_id=i.request_id WHERE i.subject=? AND i.device=? AND i.scope=? AND o.status IN ('pending','deferred')", p(partition)) { Self.data($0, 0) }
                let protected = pending.contains { body in
                    guard let op = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                          let payload = op["payload"] as? [String: Any] else { return false }
                    if payload["visitId"] as? String == change.id || payload["plannedVisitId"] as? String == change.id { return true }
                    guard let id = op["clientRequestId"] as? String, let uuid = UUID(uuidString: id) else { return false }
                    return (try? ack(for: uuid, in: partition))?.entityId == change.id
                }
                if protected { continue }
                try run("INSERT OR REPLACE INTO delta(subject,device,scope,entity,id,revision,body) VALUES (?,?,?,?,?,?,?)",
                        p(partition) + [.text(change.entity), .text(change.id), .integer(change.revision), change.value.map(Value.blob) ?? .null])
            }
            #if DEBUG
            if failBeforeDeltaCursor { throw StoreError.database }
            #endif
            try run("UPDATE partitions SET cursor=? WHERE \(Self.predicate)", [.text(nextCursor)] + p(partition))
        }
    }
    private func applyReference(_ change: DeltaChange, generation: Int64, partition: StorePartition) throws {
        guard generation > 0, change.op == "upsert", let body = change.value else { throw StoreError.invalidInput }
        let product: BootstrapV1.Product?
        let productId: String
        if change.entity == "product" {
            let value = try decode(BootstrapV1.Product.self, body)
            guard value.isValid, value.id == change.id, value.revision == change.revision else { throw StoreError.invalidInput }
            product = value; productId = value.id
        } else {
            let value = try decode(BootstrapV1.InventoryAvailability.self, body)
            guard value.isValid, value.id == change.id, value.revision == change.revision else { throw StoreError.invalidInput }
            product = nil; productId = value.productId
        }
        let existing = try query("SELECT revision FROM reference_data WHERE \(Self.predicate) AND generation=? AND entity=? AND id=?",
                                 p(partition) + [.integer(generation), .text(change.entity), .text(change.id)]) {
            sqlite3_column_int64($0, 0)
        }.first ?? 0
        guard change.revision >= existing else { return }
        try writeReference(entity: change.entity, id: change.id, productId: productId, revision: change.revision,
                           body: .blob(body), generation: generation, partition: partition)
        if let product {
            // Keep header/sheet revision and per-account pricing; only refresh product master fields.
            for sheet in try callSheets(for: partition) where sheet.lines.contains(where: { $0.productId == product.id }) {
                let lines = sheet.lines.map { line in
                    line.productId == product.id ? CallSheet.Line(productId: line.productId, code: product.code,
                        name: product.name, uom: product.uom, barcode: product.barcodes?.first?.barcode, pricing: line.pricing) : line
                }
                let refreshed = CallSheet(outletId: sheet.outletId, revision: sheet.revision, header: sheet.header, lines: lines)
                try run("UPDATE call_sheets SET body=? WHERE \(Self.predicate) AND generation=? AND outlet_id=?",
                        [try encode(refreshed)] + p(partition) + [.integer(generation), .text(sheet.outletId)])
            }
        }
    }
    func deltaValue(entity: String, id: String, for partition: StorePartition) throws -> Data? {
        try query("SELECT body FROM delta WHERE \(Self.predicate) AND entity=? AND id=?", p(partition) + [.text(entity), .text(id)]) {
            sqlite3_column_type($0, 0) == SQLITE_NULL ? nil : Self.data($0, 0)
        }.first ?? nil
    }
    func pendingOutbox(for partition: StorePartition) throws -> [OutboxItem] {
        guard try !isHeld(partition) else { return [] }
        return try queuedOutbox(for: partition)
    }
    func heldOutbox(for partition: StorePartition) throws -> [OutboxItem] {
        guard try isHeld(partition) else { return [] }
        return try queuedOutbox(for: partition)
    }
    private func queuedOutbox(for partition: StorePartition) throws -> [OutboxItem] {
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
            guard status == "pending" || status == "deferred" else { throw status == nil ? StoreError.unknownIntent : StoreError.alreadyResolved }
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
    /// QSR-010: sign-out/revocation removes the server-provided cache — plan, outlets, customers,
    /// route, employee header, call sheets/prices, deltas and the offline lease. Intents, outbox and
    /// acks are the person's evidence and stay encrypted and held for supervised review (ADR-020).
    func purgeCacheForReview(_ partition: StorePartition) throws {
        try transaction {
            try ensure(partition)
            try purge(where: Self.predicate, p(partition))
        }
        try exec("PRAGMA wal_checkpoint(TRUNCATE)")
    }
    func purgeAllCachesForReview() throws {
        try transaction { try purge(where: "1=1", []) }
        try exec("PRAGMA wal_checkpoint(TRUNCATE)")
    }
    private func purge(where clause: String, _ values: [Value]) throws {
        for table in ["snapshot", "call_sheets", "reference_data", "delta"] {
            try run("DELETE FROM \(table) WHERE \(clause)", values)
        }
        try run("UPDATE partitions SET held=1,cursor=NULL,lease_expiry=NULL,cache_expiry=NULL WHERE \(clause)", values)
    }
    func releaseHeld(_ partition: StorePartition) throws {
        try run("UPDATE partitions SET held=0 WHERE \(Self.predicate)", p(partition))
    }
    /// Only call after the server verifies the same full subject on this bound device.
    /// Scope may change; releasing a different subject or device is never permitted by this predicate.
    func releaseHeld(subject: String, deviceId: String) throws {
        guard !subject.isEmpty, !deviceId.isEmpty else { throw StoreError.invalidInput }
        try run("UPDATE partitions SET held=0 WHERE subject=? AND device=?", [.text(subject), .text(deviceId)])
    }
    func isHeld(_ partition: StorePartition) throws -> Bool { try state(partition)?.1 ?? false }
    func hasOtherHeldWork(for partition: StorePartition) throws -> Bool {
        if try query("SELECT 1 FROM partitions p JOIN outbox o ON o.subject=p.subject AND o.device=p.device AND o.scope=p.scope WHERE p.subject=? AND p.device=? AND p.scope<>? AND p.held=1 AND o.status IN ('pending','deferred') LIMIT 1",
                     p(partition), { _ in true }).first == true { return true }
        // IOS-016: a prior scope holding only photos (waiting or for review) is held work too.
        return try query("SELECT 1 FROM partitions p JOIN evidence_photos e ON e.subject=p.subject AND e.device=p.device AND e.scope=p.scope WHERE p.subject=? AND p.device=? AND p.scope<>? AND p.held=1 AND e.state IN ('pending','review') LIMIT 1",
                         p(partition)) { _ in true }.first ?? false
    }

    // MARK: IOS-016 visit photos

    func savePhoto(_ row: EvidencePhotoRow, for partition: StorePartition, now: Date) throws {
        let types = try snapshot(for: partition)?.photoTypes ?? []
        guard EvidencePhotos.isValidNew(row, types: types) else { throw StoreError.invalidInput }
        try transaction {
            guard try isLeaseValid(now: now, for: partition) else { throw StoreError.leaseExpired }
            guard try state(partition)?.1 == false else { throw StoreError.heldForReview }
            // The call must be open: a non-rejected Start, and no queued or accepted End against it. A
            // server-rejected End reopens the call (IOS-017), so photos may still be taken.
            let start = row.checkInRequestId.uuidString.lowercased()
            guard let checkIn = try intent(for: row.checkInRequestId, in: partition), checkIn.kind == "visit.checkIn",
                  try outcome(start, partition) != "rejected" else { throw AppModel.CallFailure.notStarted }
            let rejected = Set(try reviewOutbox(for: partition).map(\.intent.requestId))
            guard VisitCompletion.isOpen(checkIn, intents: try intents(for: partition), rejected: rejected) else {
                throw AppModel.CallFailure.alreadyClosed
            }
            let count = try query("SELECT count(*) FROM evidence_photos WHERE \(Self.predicate) AND check_in_request_id=?",
                                  p(partition) + [.text(start)]) { sqlite3_column_int64($0, 0) }.first ?? 0
            guard count < EvidencePhotos.maxPerVisit else { throw AppModel.CallFailure.photoLimit }
            try run("""
                INSERT INTO evidence_photos(subject,device,scope,local_id,check_in_request_id,photo_type,mime,size_bytes,sha256,captured_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)
                """, p(partition) + [.text(row.localId.uuidString.lowercased()), .text(start), .text(row.photoType),
                                     .text(row.mime), .integer(row.sizeBytes), .text(row.sha256), .integer(row.capturedAt)])
        }
        try protectFiles()
    }
    private static let photoColumns = "local_id,check_in_request_id,photo_type,mime,size_bytes,sha256,captured_at,state,attempts,evidence_id,review_code,uploaded_at"
    private static func photo(_ row: OpaquePointer) throws -> EvidencePhotoRow {
        guard let id = UUID(uuidString: text(row, 0)), let start = UUID(uuidString: text(row, 1)) else { throw StoreError.database }
        let optional: (Int32) -> String? = { sqlite3_column_type(row, $0) == SQLITE_NULL ? nil : text(row, $0) }
        return EvidencePhotoRow(localId: id, checkInRequestId: start, photoType: text(row, 2), mime: text(row, 3),
            sizeBytes: sqlite3_column_int64(row, 4), sha256: text(row, 5), capturedAt: sqlite3_column_int64(row, 6),
            state: text(row, 7), attempts: Int(sqlite3_column_int64(row, 8)), evidenceId: optional(9),
            reviewCode: optional(10), uploadedAt: sqlite3_column_type(row, 11) == SQLITE_NULL ? nil : sqlite3_column_int64(row, 11))
    }
    func photos(forCheckIn requestId: UUID, in partition: StorePartition) throws -> [EvidencePhotoRow] {
        try query("SELECT \(Self.photoColumns) FROM evidence_photos WHERE \(Self.predicate) AND check_in_request_id=? ORDER BY captured_at,rowid",
                  p(partition) + [.text(requestId.uuidString.lowercased())], Self.photo)
    }
    func pendingPhotos(for partition: StorePartition) throws -> [EvidencePhotoRow] {
        try query("SELECT \(Self.photoColumns) FROM evidence_photos WHERE \(Self.predicate) AND state='pending' ORDER BY captured_at,rowid",
                  p(partition), Self.photo)
    }
    func reviewPhotos(for partition: StorePartition) throws -> [EvidencePhotoRow] {
        try query("SELECT \(Self.photoColumns) FROM evidence_photos WHERE \(Self.predicate) AND state='review' ORDER BY captured_at,rowid",
                  p(partition), Self.photo)
    }
    private func photoState(_ localId: UUID, _ partition: StorePartition) throws -> String? {
        try query("SELECT state FROM evidence_photos WHERE \(Self.predicate) AND local_id=?",
                  p(partition) + [.text(localId.uuidString.lowercased())]) { Self.text($0, 0) }.first
    }
    func markPhotoUploaded(_ localId: UUID, evidenceId: String, at: Int64, in partition: StorePartition) throws {
        guard !evidenceId.isEmpty, at > 0 else { throw StoreError.invalidInput }
        try transaction {
            // A held partition freezes its photos for supervised review.
            guard try self.state(partition)?.1 == false else { throw StoreError.heldForReview }
            let state = try photoState(localId, partition)
            guard state == "pending" else { throw state == nil ? StoreError.unknownIntent : StoreError.alreadyResolved }
            try run("UPDATE evidence_photos SET state='uploaded',evidence_id=?,uploaded_at=? WHERE \(Self.predicate) AND local_id=?",
                    [.text(evidenceId), .integer(at)] + p(partition) + [.text(localId.uuidString.lowercased())])
        }
    }
    func reviewPhoto(_ localId: UUID, code: String, in partition: StorePartition) throws {
        guard !code.isEmpty else { throw StoreError.invalidInput }
        try transaction {
            // A held partition freezes its photos for supervised review.
            guard try self.state(partition)?.1 == false else { throw StoreError.heldForReview }
            let state = try photoState(localId, partition)
            guard state == "pending" else { throw state == nil ? StoreError.unknownIntent : StoreError.alreadyResolved }
            try run("UPDATE evidence_photos SET state='review',review_code=? WHERE \(Self.predicate) AND local_id=?",
                    [.text(code)] + p(partition) + [.text(localId.uuidString.lowercased())])
        }
    }
    func countPhotoAttempt(_ localId: UUID, in partition: StorePartition) throws -> Int {
        var attempts = 0
        try transaction {
            // A held partition freezes its photos for supervised review.
            guard try self.state(partition)?.1 == false else { throw StoreError.heldForReview }
            guard try photoState(localId, partition) == "pending" else { throw StoreError.alreadyResolved }
            try run("UPDATE evidence_photos SET attempts=attempts+1 WHERE \(Self.predicate) AND local_id=?",
                    p(partition) + [.text(localId.uuidString.lowercased())])
            attempts = Int(try query("SELECT attempts FROM evidence_photos WHERE \(Self.predicate) AND local_id=?",
                                     p(partition) + [.text(localId.uuidString.lowercased())]) { sqlite3_column_int64($0, 0) }.first ?? 0)
        }
        return attempts
    }

    func orderDrafts(for partition: StorePartition) throws -> [OrderDraft] {
        try query("SELECT body FROM order_drafts WHERE \(Self.predicate) ORDER BY created_at, draft_id", p(partition)) {
            try decode(OrderDraft.self, Self.data($0, 0))
        }
    }
    private func orderDraft(_ id: String, _ partition: StorePartition) throws -> OrderDraft? {
        try query("SELECT body FROM order_drafts WHERE \(Self.predicate) AND draft_id=?", p(partition) + [.text(id)]) {
            try decode(OrderDraft.self, Self.data($0, 0))
        }.first
    }
    func saveOrderDraft(_ draft: OrderDraft, for partition: StorePartition, now: Date) throws {
        let body = try encode(draft)
        try transaction {
            guard try state(partition)?.1 == false else { throw OrderDraftFailure.held }
            guard try isLeaseValid(now: now, for: partition) else { throw OrderDraftFailure.offlineExpired }
            let existing = try orderDraft(draft.draftId, partition)
            try OrderDraftRules.validate(OrderCallContext.read(store: self, partition: partition), draft: draft, existing: existing)
            try run("INSERT OR REPLACE INTO order_drafts(subject,device,scope,draft_id,client_visit_id,outlet_id,created_at,body) VALUES (?,?,?,?,?,?,?,?)",
                    p(partition) + [.text(draft.draftId), .text(draft.clientVisitId), .text(draft.outletId), .integer(draft.createdAt), body])
        }
        try protectFiles()
    }
    func discardOrderDraft(_ draftId: String, for partition: StorePartition) throws {
        try transaction {
            if try isHeld(partition) { throw OrderDraftFailure.held }
            guard let existing = try orderDraft(draftId, partition) else { throw OrderDraftFailure.unknownDraft }
            if existing.submittedRequestId != nil { throw OrderDraftFailure.submitted }
            try run("DELETE FROM order_drafts WHERE \(Self.predicate) AND draft_id=?", p(partition) + [.text(draftId)])
        }
    }
    @discardableResult
    func submitOrderDraft(_ draftId: String, intent: VisitIntent, for partition: StorePartition, now: Date) throws -> OrderDraft {
        guard let object = intent.object, object["kind"] as? String == intent.kind,
              object["clientRequestId"] as? String == intent.requestId.uuidString.lowercased(),
              let payload = intent.payload else { throw StoreError.invalidInput }
        var sent: OrderDraft?
        try transaction {
            guard try state(partition)?.1 == false else { throw OrderDraftFailure.held }
            guard try isLeaseValid(now: now, for: partition) else { throw OrderDraftFailure.offlineExpired }
            guard let draft = try orderDraft(draftId, partition) else { throw OrderDraftFailure.unknownDraft }
            if draft.submittedRequestId != nil { throw OrderDraftFailure.submitted }
            try OrderSubmission.requireIntent(intent, for: draft)
            // Order rules first, so an ended call reads as an order refusal, not a generic visit one.
            try OrderDraftRules.validate(OrderCallContext.read(store: self, partition: partition), draft: draft, existing: nil)
            // The wire visit ID, when present, must be the server's ID for this draft's own check-in.
            guard let checkIn = UUID(uuidString: draft.checkInRequestId) else { throw StoreError.invalidInput }
            let visitId = try ack(for: checkIn, in: partition)?.entityId
            guard payload["visitId"] as? String == visitId, visitId != nil || payload["visitId"] == nil else {
                throw StoreError.invalidInput
            }
            let id = intent.requestId.uuidString.lowercased()
            try run("INSERT INTO intents(subject,device,scope,request_id,kind,body) VALUES (?,?,?,?,?,?)",
                    p(partition) + [.text(id), .text(intent.kind), .blob(intent.operationJSON)])
            try run("INSERT INTO outbox(subject,device,scope,request_id,status) VALUES (?,?,?,?,?)",
                    p(partition) + [.text(id), .text(visitId == nil ? "deferred" : "pending")])
            var frozen = draft
            frozen.submittedRequestId = id
            frozen.submittedAt = Int64(now.timeIntervalSince1970 * 1000)
            try run("UPDATE order_drafts SET body=? WHERE \(Self.predicate) AND draft_id=?",
                    [try encode(frozen)] + p(partition) + [.text(draftId)])
            sent = frozen
        }
        try protectFiles()
        guard let sent else { throw StoreError.database }
        return sent
    }
    func requestState(for requestId: UUID, in partition: StorePartition) throws -> String? {
        try query("SELECT status,rejection_code FROM outbox WHERE \(Self.predicate) AND request_id=?",
                  p(partition) + [.text(requestId.uuidString.lowercased())]) { row in
            let status = Self.text(row, 0)
            guard status == "rejected" else { return status }
            return "rejected:" + (sqlite3_column_type(row, 1) == SQLITE_NULL ? "unknown_code" : Self.text(row, 1))
        }.first
    }

    #if DEBUG
    /// Downgrade harness: preserve actual v2 snapshot/outbox/acks while removing the v3, v4 and v5 additions.
    func prepareLegacyV2() throws {
        try transaction { try exec("DROP TABLE evidence_photos; DROP TABLE reference_data; DROP TABLE call_sheets; DROP TABLE order_drafts; PRAGMA user_version=2") }
    }
    /// Preserve real v3 call sheets and durable evidence while removing the v4, v5 and v6 additions.
    func prepareLegacyV3() throws {
        try transaction { try exec("DROP TABLE evidence_photos; DROP TABLE reference_data; DROP TABLE order_drafts; PRAGMA user_version=3") }
    }
    /// Preserve real v4 order drafts while removing the v5 reference data and v6 photo tables.
    func prepareLegacyV4() throws {
        try transaction { try exec("DROP TABLE evidence_photos; DROP TABLE reference_data; PRAGMA user_version=4") }
    }
    /// The v5 schema with its data, only the v6 photo table removed.
    func prepareLegacyV5() throws {
        try transaction { try exec("DROP TABLE evidence_photos; PRAGMA user_version=5") }
    }
    var schemaVersion: Int { (try? scalar("PRAGMA user_version")).flatMap(Int.init) ?? -1 }

    /// Migration harness only. Creates an encrypted pre-v1 fixture with a caller-owned durable UUID.
    static func createLegacyV0(url: URL, secrets: SecretStore, keyAccount: String,
                               partition: StorePartition, intent: VisitIntent) throws {
        // Initialize an encrypted file, then recreate the v0 schema under its existing key.
        let store = try EncryptedFieldStore(url: url, secrets: secrets, keyAccount: keyAccount)
        try store.transaction {
            try store.exec("DROP TABLE evidence_photos; DROP TABLE reference_data; DROP TABLE order_drafts; DROP TABLE call_sheets; DROP TABLE acks; DROP TABLE outbox; DROP TABLE intents; DROP TABLE snapshot; DROP TABLE partitions")
            try store.exec("CREATE TABLE legacy_intents(subject TEXT,device TEXT,scope TEXT,request_id TEXT,kind TEXT,body BLOB)")
            try store.run("INSERT INTO legacy_intents VALUES(?,?,?,?,?,?)", store.p(partition) + [.text(intent.requestId.uuidString.lowercased()), .text(intent.kind), .blob(intent.operationJSON)])
            try store.exec("PRAGMA user_version=0")
        }
        store.close()
    }
    #endif
}
