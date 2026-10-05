import CryptoKit
import XCTest
@testable import FieldIOS

@MainActor
private final class FakeEvidenceAPI: EvidenceAPI {
    enum Step { case ok, offline, refused(String), storageRefused, lostAttachResponse }
    var steps: [Step] = []
    var uploads: [(url: URL, bytes: Data, mime: String)] = []
    var attaches: [(claim: String, visitId: String, storageId: String, photo: EvidencePhotoRow)] = []
    var claims = 0
    private func next() -> Step { steps.isEmpty ? .ok : steps.removeFirst() }
    private var current: Step = .ok
    func uploadURL(visitId: String) async throws -> (url: URL, claim: String) {
        current = next()
        if case .offline = current { throw MobileError.offline }
        claims += 1
        return (URL(string: "https://storage.test/upload/\(claims)")!, "claim-\(claims)")
    }
    func upload(_ url: URL, bytes: Data, mime: String) async throws -> String {
        if case .storageRefused = current { throw EvidenceUploadFailure() }
        uploads.append((url, bytes, mime))
        return "storage-\(uploads.count)"
    }
    func attach(claim: String, visitId: String, storageId: String, photo: EvidencePhotoRow) async throws -> String {
        attaches.append((claim, visitId, storageId, photo))
        switch current {
        case .refused(let code): throw MobileError.rejected(code)
        case .lostAttachResponse: throw MobileError.offline
        default: return "evidence-1"
        }
    }
}

@MainActor
private final class MemoryPhotoFiles: PhotoFiles {
    var files: [UUID: Data] = [:]
    func write(_ localId: UUID, _ bytes: Data) throws { files[localId] = bytes }
    func read(_ localId: UUID) throws -> Data { guard let data = files[localId] else { throw PhotoFileError.damaged }; return data }
    func delete(_ localId: UUID) { files[localId] = nil }
}

@MainActor
final class EvidencePhotosTests: XCTestCase {
    private var directory: URL!
    private var secrets: KeychainStore!
    private var store: EncryptedFieldStore!
    private var partition: StorePartition!
    private let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5, 6, 0xFF, 0xD9])
    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    override func setUp() async throws {
        try await super.setUp()
        directory = FileManager.default.temporaryDirectory.appending(path: "evidence-\(UUID().uuidString)")
        secrets = KeychainStore(service: "com.sunpride.evidence.tests.\(UUID().uuidString)")
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        partition = try StorePartition(subject: "issuer|seller", deviceId: "device-1", scope: "scope-1")
        try saveSnapshot(types: [])
    }
    override func tearDown() async throws {
        store.close()
        try? secrets.delete("db")
        try? secrets.delete(SealedPhotoFiles.keyAccount)
        try? FileManager.default.removeItem(at: directory)
        try await super.tearDown()
    }
    private func saveSnapshot(types: [PhotoType]) throws {
        let expiry = nowMs + 600_000
        try store.saveSnapshot(StoreSnapshot(employee: .init(id: "employee-1", role: "sales", orgUnitId: "unit-1"),
            visits: [.init(id: "planned-1", outletId: "outlet-1", serviceDate: BootstrapClient.manilaDay(Date()),
                           planId: "plan-1", planVersion: 1, intents: ["audit"])],
            outlets: [.init(id: "outlet-1", name: "Outlet", routeId: nil)], customers: [], route: nil, tasks: [],
            photoTypes: types), cursor: "cursor", leaseExpiresAt: expiry, cacheExpiresAt: expiry, for: partition)
    }
    private func op(_ kind: String, id: UUID, payload: [String: Any], dependsOn: UUID? = nil) throws -> VisitIntent {
        var object: [String: Any] = ["kind": kind, "clientRequestId": id.uuidString.lowercased(), "payload": payload]
        if let dependsOn { object["dependsOn"] = [dependsOn.uuidString.lowercased()] }
        return VisitIntent(requestId: id, kind: kind, operationJSON: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
    }
    @discardableResult private func start() throws -> UUID {
        let id = UUID()
        try store.enqueue(op("visit.checkIn", id: id, payload: ["outletId": "outlet-1", "plannedVisitId": "planned-1",
                                                                  "serviceDate": BootstrapClient.manilaDay(Date())]),
                          for: partition, now: Date())
        return id
    }
    private func end(_ checkIn: UUID) throws {
        try store.enqueue(op("visit.checkOut", id: UUID(), payload: ["outcome": "nonproductive", "reasonCode": "closed",
                                                                     "visitId": "server-visit-1"], dependsOn: checkIn),
                          for: partition, now: Date())
    }
    private func row(_ checkIn: UUID, type: String = "storefront", bytes: Data? = nil) -> EvidencePhotoRow {
        let data = bytes ?? jpeg
        return EvidencePhotoRow(localId: UUID(), checkInRequestId: checkIn, photoType: type, mime: EvidencePhotos.mime,
                                sizeBytes: Int64(data.count), sha256: EvidencePhotos.sha256Hex(data), capturedAt: nowMs)
    }

    // MARK: Contract

    func testSharedPhotoTypesFixtureDecodesAndOldServersFallBackToDefaults() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "bootstrap-photo-types-response", withExtension: "json"))
        let page = try JSONDecoder().decode(BootstrapV1.Page.self, from: Data(contentsOf: url))
        XCTAssertEqual(page.photoTypes?.map(\.code), ["storefront", "shelf_display", "price_tag", "promotion", "other"])
        XCTAssertEqual(page.photoTypes?.first?.label, "Store front")
        // The provisional phone defaults mirror the backend list exactly.
        XCTAssertEqual(EvidencePhotos.defaultTypes, page.photoTypes)
        let old = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "bootstrap-response", withExtension: "json"))
        XCTAssertNil(try JSONDecoder().decode(BootstrapV1.Page.self, from: Data(contentsOf: old)).photoTypes)
        XCTAssertEqual(EvidencePhotos.offered([]), EvidencePhotos.defaultTypes)
    }
    func testPhotoTypesAreStrict() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "bootstrap-photo-types-response", withExtension: "json"))
        let base = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        for bad: Any in [[["code": "Store Front", "label": "x"]], [["code": "a", "label": ""]],
                         [["code": "a", "label": "x", "extra": 1]], [["code": "a", "label": "x"], ["code": "a", "label": "y"]],
                         NSNull()] {
            var page = base; page["photoTypes"] = bad
            XCTAssertThrowsError(try JSONDecoder().decode(BootstrapV1.Page.self,
                from: JSONSerialization.data(withJSONObject: page)), "\(bad)")
        }
    }
    func testSnapshotKeepsPhotoTypes() throws {
        let types = [try PhotoType(code: "shelf", label: "Shelf")]
        try saveSnapshot(types: types)
        XCTAssertEqual(try store.snapshot(for: partition)?.photoTypes, types)
        XCTAssertEqual(EvidencePhotos.label("shelf", types: types), "Shelf")
        XCTAssertEqual(EvidencePhotos.label("gone", types: types), "Photo")
    }

    // MARK: Store

    func testPhotoBelongsToAnOpenCallAndIsCapped() throws {
        XCTAssertThrowsError(try store.savePhoto(row(UUID()), for: partition, now: Date())) {
            XCTAssertEqual($0 as? AppModel.CallFailure, .notStarted)
        }
        let call = try start()
        XCTAssertThrowsError(try store.savePhoto(row(call, type: "selfie"), for: partition, now: Date()), "unknown type")
        var tampered = row(call); tampered.attempts = 1
        XCTAssertThrowsError(try store.savePhoto(tampered, for: partition, now: Date()), "new rows start clean")
        for _ in 0..<EvidencePhotos.maxPerVisit { try store.savePhoto(row(call), for: partition, now: Date()) }
        XCTAssertThrowsError(try store.savePhoto(row(call), for: partition, now: Date())) {
            XCTAssertEqual($0 as? AppModel.CallFailure, .photoLimit)
        }
        let saved = try store.photos(forCheckIn: call, in: partition)
        XCTAssertEqual(saved.count, EvidencePhotos.maxPerVisit)
        XCTAssertEqual(saved.first?.state, "pending")
        XCTAssertEqual(saved.first?.checkInRequestId, call)
        XCTAssertEqual(try store.pendingPhotos(for: partition).count, EvidencePhotos.maxPerVisit)
    }
    func testEndedRejectedOrHeldCallTakesNoPhoto() throws {
        let ended = try start()
        try store.savePhoto(row(ended), for: partition, now: Date())
        try end(ended)
        XCTAssertThrowsError(try store.savePhoto(row(ended), for: partition, now: Date())) {
            XCTAssertEqual($0 as? AppModel.CallFailure, .alreadyClosed)
        }
        let rejected = try start()
        try store.recordRejection(code: "invalid_plan", for: rejected, in: partition)
        XCTAssertThrowsError(try store.savePhoto(row(rejected), for: partition, now: Date()))
        let open = try start()
        try store.holdForReview(partition)
        XCTAssertThrowsError(try store.savePhoto(row(open), for: partition, now: Date())) {
            XCTAssertEqual($0 as? StoreError, .heldForReview)
        }
    }
    func testSignOutPurgeKeepsPhotosAsHeldEvidence() throws {
        let call = try start()
        try store.savePhoto(row(call), for: partition, now: Date())
        try store.purgeAllCachesForReview()
        XCTAssertNil(try store.snapshot(for: partition))
        XCTAssertEqual(try store.photos(forCheckIn: call, in: partition).count, 1)
        XCTAssertTrue(BackgroundRetry.hasRetryableWork(store: store, partition: partition) == false, "held work never retries")
    }
    func testPendingPhotoIsRetryableWorkAfterTheVisitOutboxDrains() throws {
        let call = try start()
        try store.recordAck(ServerAck(entityId: "server-visit-1", eventIds: [], serverTime: nowMs), for: call, in: partition)
        XCTAssertFalse(BackgroundRetry.hasRetryableWork(store: store, partition: partition))
        try store.savePhoto(row(call), for: partition, now: Date())
        XCTAssertTrue(BackgroundRetry.hasRetryableWork(store: store, partition: partition))
        let status = try FieldSyncStatus.read(store: store, partition: partition, now: Date(), sending: false, offline: false)
        XCTAssertEqual(status.queued, 0, "a photo never counts as unsent visit work")
        XCTAssertEqual(status.photosWaiting, 1)
    }
    func testV3ToV4MigrationKeepsOutboxAndAddsPhotos() throws {
        let call = try start()
        try store.prepareLegacyV3()
        XCTAssertEqual(store.schemaVersion, 3)
        store.close()
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        XCTAssertEqual(store.schemaVersion, 4)
        XCTAssertEqual(try store.pendingOutbox(for: partition).map(\.intent.requestId), [call])
        try store.savePhoto(row(call), for: partition, now: Date())
        store.close()
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        XCTAssertEqual(store.schemaVersion, 4)
        XCTAssertEqual(try store.photos(forCheckIn: call, in: partition).count, 1)
    }

    // MARK: Sealed files

    func testSealedFilesRoundTripAndNeverHoldPlaintext() throws {
        let files = try SealedPhotoFiles(directory: directory.appending(path: "evidence"), secrets: secrets)
        let id = UUID(), other = UUID()
        let bytes = Data((0..<4096).map { UInt8($0 % 251) })
        try files.write(id, bytes)
        XCTAssertEqual(try files.read(id), bytes)
        let raw = try Data(contentsOf: files.file(id))
        XCTAssertNotEqual(raw, bytes)
        XCTAssertNil(raw.range(of: bytes.prefix(64)), "plaintext never on disk")
        XCTAssertEqual(try files.directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        XCTAssertEqual(try files.file(id).resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        // One photo's sealed file cannot stand in for another's (local ID is associated data).
        try FileManager.default.copyItem(at: files.file(id), to: files.file(other))
        XCTAssertThrowsError(try files.read(other)) { XCTAssertEqual($0 as? PhotoFileError, .damaged) }
        files.delete(id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.file(id).path))
        let attributes = try XCTUnwrap(secrets.attributes(SealedPhotoFiles.keyAccount))
        XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    }

    // MARK: App model

    func testModelKeepsAPhotoOnlyForTheOpenCallAndReportsItsState() async throws {
        try secrets.save(Data("test-session".utf8), for: StoreAccount.session)
        defer { try? secrets.delete(StoreAccount.session) }
        let registry = FakeRegistry()
        registry.lastMine = .success(MineResult(deviceId: "device-1", status: "active", bound: true, allowedApp: "IOS"))
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        let files = MemoryPhotoFiles()
        let model = AppModel(auth: AuthClient(site: StubHTTP.site, store: secrets, http: StubHTTP.client()),
                             registry: registry, store: secrets, localStore: store, photoFiles: files,
                             evidenceAPI: FakeEvidenceAPI()) { key }
        defer { model.enrollment.signedOut() }
        await model.launch()
        _ = try model.storage(for: partition)
        model.refreshToday()
        let visit = try XCTUnwrap(model.visits.first { $0.id == "planned-1" })
        XCTAssertThrowsError(try model.savePhoto(type: "storefront", jpeg: jpeg, capturedAt: Date(), for: visit)) {
            XCTAssertEqual($0 as? AppModel.CallFailure, .notStarted)
        }
        try model.queueCheckIn(visit, unplannedReason: nil, location: nil)
        XCTAssertThrowsError(try model.savePhoto(type: "storefront", jpeg: Data("not a jpeg".utf8), capturedAt: Date(), for: visit)) {
            XCTAssertEqual($0 as? AppModel.CallFailure, .photoInvalid)
        }
        XCTAssertThrowsError(try model.savePhoto(type: "selfie", jpeg: jpeg, capturedAt: Date(), for: visit))
        XCTAssertTrue(files.files.isEmpty, "a refused row leaves no sealed file behind")
        let taken = Date(timeIntervalSince1970: 1_790_000_000.123)
        try model.savePhoto(type: "shelf_display", jpeg: jpeg, capturedAt: taken, for: visit)
        let photos = model.photos(for: visit)
        XCTAssertEqual(photos.map(\.photoType), ["shelf_display"])
        XCTAssertEqual(photos.first?.state, "pending")
        XCTAssertEqual(photos.first?.capturedAt.timeIntervalSince1970 ?? 0, 1_790_000_000.123, accuracy: 0.001)
        XCTAssertEqual(files.files.values.first, jpeg)
        XCTAssertEqual(EvidencePhotos.summary(photos), "1 photo · 1 waiting to upload")
        XCTAssertEqual(model.photoTypeChoices, EvidencePhotos.defaultTypes)
        // End never waits for the photo; afterwards the call takes no more.
        try model.queueCheckOut(outcome: "nonproductive", reason: "Closed", for: visit)
        XCTAssertThrowsError(try model.savePhoto(type: "storefront", jpeg: jpeg, capturedAt: Date(), for: visit)) {
            XCTAssertEqual($0 as? AppModel.CallFailure, .alreadyClosed)
        }
        XCTAssertEqual(model.photos(for: visit).count, 1)
    }

    // MARK: Upload

    private func uploader(_ files: PhotoFiles, _ api: EvidenceAPI) -> EvidenceUploader {
        EvidenceUploader(store: store, partition: partition, files: files, api: api, now: { Date(timeIntervalSince1970: 1_800_000_000) })
    }
    private func saved(_ call: UUID, _ files: MemoryPhotoFiles, type: String = "storefront") throws -> EvidencePhotoRow {
        let photo = row(call, type: type)
        try files.write(photo.localId, jpeg)
        try store.savePhoto(photo, for: partition, now: Date())
        return photo
    }
    private func accept(_ call: UUID) throws {
        try store.recordAck(ServerAck(entityId: "server-visit-1", eventIds: [], serverTime: nowMs), for: call, in: partition)
    }

    func testPhotoWaitsForStartAckThenUploadsAttachesAndDropsPhoneCopy() async throws {
        let files = MemoryPhotoFiles(), api = FakeEvidenceAPI()
        let call = try start()
        let photo = try saved(call, files)
        var report = await uploader(files, api).run()
        XCTAssertEqual(report, UploadReport(waiting: 1, retryLater: true))
        XCTAssertEqual(api.claims, 0, "no visit ID yet: nothing is sent")
        try accept(call)
        report = await uploader(files, api).run()
        XCTAssertEqual(report, UploadReport(uploaded: 1))
        XCTAssertEqual(api.uploads.first?.bytes, jpeg)
        XCTAssertEqual(api.uploads.first?.mime, "image/jpeg")
        let attach = try XCTUnwrap(api.attaches.first)
        XCTAssertEqual(attach.claim, "claim-1")
        XCTAssertEqual(attach.visitId, "server-visit-1")
        XCTAssertEqual(attach.storageId, "storage-1")
        XCTAssertEqual(attach.photo.sha256, EvidencePhotos.sha256Hex(jpeg))
        XCTAssertEqual(attach.photo.capturedAt, photo.capturedAt)
        let uploaded = try XCTUnwrap(store.photos(forCheckIn: call, in: partition).first)
        XCTAssertEqual(uploaded.state, "uploaded")
        XCTAssertEqual(uploaded.evidenceId, "evidence-1")
        XCTAssertEqual(uploaded.uploadedAt, 1_800_000_000_000)
        XCTAssertNil(files.files[photo.localId])
        XCTAssertTrue(try store.pendingPhotos(for: partition).isEmpty)
    }
    func testOfflineAndLostAttachResponseKeepThePhotoForAnIdenticalRetry() async throws {
        let files = MemoryPhotoFiles(), api = FakeEvidenceAPI()
        let call = try start(); try accept(call)
        let photo = try saved(call, files)
        api.steps = [.offline]
        var report = await uploader(files, api).run()
        XCTAssertTrue(report.retryLater)
        XCTAssertEqual(try store.pendingPhotos(for: partition).first?.attempts, 0, "offline is not an attempt")
        api.steps = [.lostAttachResponse]
        report = await uploader(files, api).run()
        XCTAssertEqual(report.waiting, 1)
        XCTAssertNotNil(files.files[photo.localId])
        report = await uploader(files, api).run()
        XCTAssertEqual(report.uploaded, 1)
        // The retry sends the same bytes and metadata; the server resolves it to the original row.
        XCTAssertEqual(api.attaches.count, 2)
        XCTAssertEqual(api.attaches[0].photo, api.attaches[1].photo)
        XCTAssertEqual(api.uploads[0].bytes, api.uploads[1].bytes)
        XCTAssertNotEqual(api.attaches[0].claim, api.attaches[1].claim, "each try uses a fresh claim")
    }
    func testFinalRefusalGoesToOfficeReviewAndOthersContinue() async throws {
        let files = MemoryPhotoFiles(), api = FakeEvidenceAPI()
        let call = try start(); try accept(call)
        let refused = try saved(call, files), fine = try saved(call, files, type: "other")
        api.steps = [.refused("invalid_request"), .ok]
        let report = await uploader(files, api).run()
        XCTAssertEqual(report, UploadReport(uploaded: 1, review: 1))
        let rows = try store.photos(forCheckIn: call, in: partition)
        XCTAssertEqual(rows.first { $0.localId == refused.localId }?.reviewCode, "invalid_request")
        XCTAssertEqual(rows.first { $0.localId == fine.localId }?.state, "uploaded")
        XCTAssertNotNil(files.files[refused.localId], "a refused photo stays on the phone for review")
        XCTAssertEqual(try store.reviewPhotos(for: partition).count, 1)
    }
    func testStorageRefusalRetriesThenReview() async throws {
        let files = MemoryPhotoFiles(), api = FakeEvidenceAPI()
        let call = try start(); try accept(call)
        _ = try saved(call, files)
        for attempt in 1...EvidencePhotos.maxAttempts {
            api.steps = [.storageRefused]
            let report = await uploader(files, api).run()
            XCTAssertEqual(report.review, attempt == EvidencePhotos.maxAttempts ? 1 : 0)
        }
        XCTAssertEqual(try store.reviewPhotos(for: partition).first?.reviewCode, "upload_failed")
        XCTAssertEqual(try store.reviewPhotos(for: partition).first?.attempts, EvidencePhotos.maxAttempts)
    }
    func testDamagedFileRejectedStartAndHeldPartitionNeverUpload() async throws {
        let files = MemoryPhotoFiles(), api = FakeEvidenceAPI()
        let call = try start(); try accept(call)
        let damaged = try saved(call, files)
        files.files[damaged.localId] = Data([0xFF, 0xD8, 0, 0xFF, 0xD9])
        let rejectedCall = try start()
        let orphan = try saved(rejectedCall, files)
        try store.recordRejection(code: "invalid_plan", for: rejectedCall, in: partition)
        let report = await uploader(files, api).run()
        XCTAssertEqual(report.review, 2)
        XCTAssertEqual(api.claims, 0)
        let codes = Dictionary(uniqueKeysWithValues: try store.reviewPhotos(for: partition).map { ($0.localId, $0.reviewCode) })
        XCTAssertEqual(codes[damaged.localId], "file_damaged")
        XCTAssertEqual(codes[orphan.localId], "visit_rejected")

        let open = try start(); try accept(open)
        _ = try saved(open, files)
        try store.holdForReview(partition)
        let held = await uploader(files, api).run()
        XCTAssertEqual(held, UploadReport(waiting: 1))
        XCTAssertEqual(api.claims, 0)
    }
}
