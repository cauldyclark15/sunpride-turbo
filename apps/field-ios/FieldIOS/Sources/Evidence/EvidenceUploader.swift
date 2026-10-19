import Foundation

/// The storage upload API (`visits/evidence`): short-lived claim URL, raw upload, attach.
@MainActor
protocol EvidenceAPI: AnyObject {
    /// Returns the one-time upload URL and its claim reference.
    func uploadURL(visitId: String) async throws -> (url: URL, claim: String)
    func uploadURL(visitId: String, photo: EvidencePhotoRow) async throws -> (url: URL, claim: String)
    /// POSTs the bytes; returns the server media ID.
    func upload(_ url: URL, bytes: Data, mime: String) async throws -> String
    /// Returns the server evidence ID (the same ID again for a retried, already attached photo).
    func attach(claim: String, visitId: String, storageId: String, photo: EvidencePhotoRow) async throws -> String
}

extension EvidenceAPI {
    func uploadURL(visitId: String, photo: EvidencePhotoRow) async throws -> (url: URL, claim: String) {
        try await uploadURL(visitId: visitId)
    }
}

/// A storage POST that reached the server and was refused; retried a bounded number of times.
struct EvidenceUploadFailure: Error, Equatable {}

@MainActor
final class ServerEvidenceAPI: EvidenceAPI {
    private let functions: ServerAPI
    private let http: HTTPClient
    init(functions: ServerAPI, http: HTTPClient) { self.functions = functions; self.http = http }

    private var capabilities: [URL: String] = [:]
    func uploadURL(visitId: String) async throws -> (url: URL, claim: String) { throw MobileError.invalidResponse }
    func uploadURL(visitId: String, photo: EvidencePhotoRow) async throws -> (url: URL, claim: String) {
        let me = try await functions.currentMe()
        guard let deviceId = (me["device"] as? [String: Any])?["id"] as? String else { throw MobileError.invalidResponse }
        let body = try NativeV2.bytes(["version": 2, "deviceId": deviceId, "purpose": "visit-photo", "ownerId": visitId,
            "mime": photo.mime, "size": photo.sizeBytes, "sha256": photo.sha256])
        let data = try await functions.signedPost("/api/media/claims", body: body, deviceId: deviceId)
        let value = try NativeV2.validate(data)
        guard let raw = value["uploadUrl"] as? String, let url = URL(string: raw), functions.sameOrigin(url),
              url.path.hasPrefix("/api/media/uploads/"), let token = value["uploadToken"] as? String, !token.isEmpty,
              let upload = value["uploadId"] as? String, url.lastPathComponent == upload else { throw MobileError.invalidResponse }
        capabilities[url] = token
        return (url, upload)
    }
    func upload(_ url: URL, bytes: Data, mime: String) async throws -> String {
        guard let capability = capabilities.removeValue(forKey: url) else { throw MobileError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue(mime, forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(capability)", forHTTPHeaderField: "Authorization")
        request.httpBody = bytes; request.timeoutInterval = 120
        let (data, response) = try await http.send(request)
        guard (200..<300).contains(response.statusCode), let value = try? NativeV2.validate(data),
              value["status"] as? String == "stored", value["sha256"] as? String == EvidencePhotos.sha256Hex(bytes),
              let blob = value["blobId"] as? String, blob == url.lastPathComponent else { throw EvidenceUploadFailure() }
        return blob
    }
    func attach(claim: String, visitId: String, storageId: String, photo: EvidencePhotoRow) async throws -> String {
        let me = try await functions.currentMe()
        guard let id = (me["device"] as? [String: Any])?["id"] as? String,
              let scope = (me["scope"] as? [String: Any])?["id"] as? String else { throw MobileError.invalidResponse }
        let op: [String: Any] = ["clientOpId": photo.localId.uuidString.lowercased(), "opType": "evidence.attach",
            "clientTime": photo.capturedAt, "dependsOn": [], "payload": ["visitId": visitId, "blobId": storageId,
                "checksum": photo.sha256, "mime": photo.mime, "size": photo.sizeBytes, "capturedAt": photo.capturedAt,
                "photoType": photo.photoType, "source": "mobile"]]
        let data = try await functions.signedPost("/api/sync/push", body: NativeV2.push(deviceId: id, scopeId: scope, operations: [op]), deviceId: id)
        let result = try NativeV2.validate(data)
        guard let rows = result["results"] as? [[String: Any]], rows.count == 1, let row = rows.first,
              row["clientOpId"] as? String == photo.localId.uuidString.lowercased(), row["opType"] as? String == "evidence.attach" else { throw MobileError.invalidResponse }
        guard ["applied", "duplicate"].contains(row["status"] as? String ?? ""),
              let evidence = (row["ack"] as? [String: Any])?["entityId"] as? String else {
            throw MobileError.rejected("evidence_pending_review")
        }
        return evidence
    }
}

struct UploadReport: Equatable {
    var uploaded = 0
    var waiting = 0
    var review = 0
    /// True when something is still owed and a later run can make progress (offline, no ack yet).
    var retryLater = false
}

/// Uploads saved visit photos once their call's Start has a server visit ID. Runs beside the visit
/// outbox, never inside it: a photo waiting for a network never holds back Start, activities or End.
///
/// Retry safety: the local row stays `pending` until attach succeeds. A lost attach response is
/// retried with a fresh claim and upload of the same bytes; the server recognises the same visit,
/// person and checksum and returns the original evidence row instead of a second one.
@MainActor
final class EvidenceUploader {
    /// One flight per process, shared by foreground sync and the background refresh task.
    private static var flying = false
    private let store: any FieldLocalStore
    private let partition: StorePartition
    private let files: PhotoFiles
    private let api: EvidenceAPI
    private let now: () -> Date

    init(store: any FieldLocalStore, partition: StorePartition, files: PhotoFiles, api: EvidenceAPI,
         now: @escaping () -> Date = { Date() }) {
        self.store = store; self.partition = partition; self.files = files; self.api = api; self.now = now
    }

    func run() async -> UploadReport {
        guard !Self.flying else { return UploadReport(retryLater: true) }
        Self.flying = true
        defer { Self.flying = false }
        // A held partition (sign-out, removed phone, scope change) keeps its photos for review.
        guard (try? store.isHeld(partition)) == false, let photos = try? store.pendingPhotos(for: partition) else {
            return UploadReport(waiting: (try? store.pendingPhotos(for: partition).count) ?? 0)
        }
        var report = UploadReport()
        let rejected = Set(((try? store.reviewOutbox(for: partition)) ?? []).map(\.intent.requestId))
        for photo in photos {
            if !mayContinue() { report.retryLater = true; break }
            let start = try? store.intent(for: photo.checkInRequestId, in: partition)
            if start?.kind != "visit.checkIn" || rejected.contains(photo.checkInRequestId) {
                review(photo, start == nil ? "visit_missing" : "visit_rejected", &report); continue
            }
            guard let visitId = (try? store.ack(for: photo.checkInRequestId, in: partition))?.entityId else {
                report.waiting += 1; report.retryLater = true; continue // Start not accepted yet.
            }
            guard let bytes = try? files.read(photo.localId), Int64(bytes.count) == photo.sizeBytes,
                  EvidencePhotos.sha256Hex(bytes) == photo.sha256 else {
                review(photo, "file_damaged", &report); continue
            }
            do {
                // Every await can outlive a cancel or a hold (sign-out, removed phone, scope change):
                // recheck both after each one, before attaching and before the phone copy goes.
                let (url, claim) = try await api.uploadURL(visitId: visitId, photo: photo)
                guard mayContinue() else { report.retryLater = true; break }
                let storageId = try await api.upload(url, bytes: bytes, mime: photo.mime)
                guard mayContinue() else { report.retryLater = true; break }
                let evidenceId = try await api.attach(claim: claim, visitId: visitId, storageId: storageId, photo: photo)
                // Attached but stopped: keep the row pending and the bytes; a later attach of the same
                // bytes returns this same evidence ID.
                guard mayContinue() else { report.retryLater = true; break }
                try store.markPhotoUploaded(photo.localId, evidenceId: evidenceId,
                                            at: Int64(now().timeIntervalSince1970 * 1000), in: partition)
                // The server holds the photo now; the phone copy is no longer needed.
                files.delete(photo.localId)
                report.uploaded += 1
            } catch let failure as NativeFailure where failure.withdraws {
                // Retire cache authority before any further attachment or deletion.
                try? store.purgeCacheForReview(partition)
                report.retryLater = false
                break
            } catch MobileError.rejected(let code) {
                guard mayContinue() else { report.retryLater = true; break }
                if EvidencePhotos.finalCodes.contains(code) { review(photo, code, &report) }
                else { retry(photo, &report) }
            } catch is EvidenceUploadFailure {
                guard mayContinue() else { report.retryLater = true; break }
                retry(photo, &report)
            } catch {
                // Offline, signed out, cancelled, held or server busy: nothing changes; try again later.
                report.retryLater = true
                break
            }
        }
        report.waiting = (try? store.pendingPhotos(for: partition).count) ?? report.waiting
        return report
    }

    /// False once this run is cancelled or the partition is held (or its state can't be read).
    private func mayContinue() -> Bool {
        !Task.isCancelled && (try? store.isHeld(partition)) == false
    }
    private func review(_ photo: EvidencePhotoRow, _ code: String, _ report: inout UploadReport) {
        try? store.reviewPhoto(photo.localId, code: code, in: partition)
        report.review += 1
    }
    private func retry(_ photo: EvidencePhotoRow, _ report: inout UploadReport) {
        if let attempts = try? store.countPhotoAttempt(photo.localId, in: partition), attempts >= EvidencePhotos.maxAttempts {
            review(photo, "upload_failed", &report)
        } else { report.retryLater = true }
    }
}
