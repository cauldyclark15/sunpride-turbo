package com.sunpride.field.evidence

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ConvexFunctionError
import com.sunpride.field.auth.ConvexFunctions
import com.sunpride.field.auth.defaultHttpClient
import com.sunpride.field.storage.EvidencePhotoRow
import com.sunpride.field.storage.EvidencePhotos
import com.sunpride.field.storage.FieldStore
import com.sunpride.field.storage.StoreScope
import kotlinx.coroutines.sync.Mutex
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/** The storage upload API (`visits/evidence`): short-lived claim URL, raw upload, attach. */
interface EvidenceApi {
    /** Returns the one-time upload URL and its claim reference. */
    fun uploadUrl(visitId: String): Pair<String, String>
    /** POSTs the bytes; returns the Convex storage ID. */
    fun upload(url: String, bytes: ByteArray, mime: String): String
    /** Returns the server evidence ID (the same ID again for a retried, already attached photo). */
    fun attach(claim: String, visitId: String, storageId: String, row: EvidencePhotoRow): String
}

/** A storage POST that reached the server and was refused; retried a bounded number of times. */
class EvidenceUploadFailure : Exception("Upload refused", null)

class ConvexEvidenceApi(private val functions: ConvexFunctions,
    private val http: OkHttpClient = defaultHttpClient()) : EvidenceApi {
    override fun uploadUrl(visitId: String): Pair<String, String> {
        val value = functions.mutation("visits/evidence:generateUploadUrl", JSONObject().put("visitId", visitId))
            as? JSONObject ?: throw AuthFailure(AuthFailure.Kind.SERVER)
        val url = value.optString("url"); val claim = value.optString("uploadTokenRef")
        if (!url.startsWith("https://") || claim.isBlank()) throw AuthFailure(AuthFailure.Kind.SERVER)
        return url to claim
    }
    override fun upload(url: String, bytes: ByteArray, mime: String): String {
        // The signed URL is its own authority: no bearer is sent to the storage endpoint.
        val request = Request.Builder().url(url).post(bytes.toRequestBody(mime.toMediaType())).build()
        return try {
            http.newCall(request).execute().use { response ->
                if (response.code !in 200..299) throw EvidenceUploadFailure()
                runCatching { JSONObject(response.body?.string().orEmpty()).getString("storageId") }
                    .getOrNull()?.takeIf { it.isNotBlank() } ?: throw EvidenceUploadFailure()
            }
        } catch (_: IOException) { throw AuthFailure(AuthFailure.Kind.OFFLINE) }
    }
    override fun attach(claim: String, visitId: String, storageId: String, row: EvidencePhotoRow): String {
        val value = functions.mutation("visits/evidence:attach", JSONObject()
            .put("uploadTokenRef", claim).put("visitId", visitId).put("storageId", storageId)
            .put("mime", row.mime).put("size", row.sizeBytes).put("checksum", row.sha256)
            .put("capturedAt", row.capturedAt).put("photoType", row.photoType).put("source", "mobile"))
            as? JSONObject ?: throw AuthFailure(AuthFailure.Kind.SERVER)
        return value.optString("evidenceId").takeIf { it.isNotBlank() } ?: throw AuthFailure(AuthFailure.Kind.SERVER)
    }
}

data class UploadReport(val uploaded: Int = 0, val waiting: Int = 0, val review: Int = 0,
    /** True when something is still owed and a later run can make progress (offline, no ack yet). */
    val retryLater: Boolean = false)

/**
 * Uploads saved visit photos once their call's Start has a server visit ID. Runs beside the visit
 * outbox, never inside it: a photo waiting for a network never holds back Start, activities or End.
 *
 * Retry safety: the local row stays `pending` until attach succeeds. A lost attach response is
 * retried with a fresh claim and upload of the same bytes; the server recognises the same visit,
 * person and checksum and returns the original evidence row instead of a second one.
 */
class EvidenceUploader(private val store: FieldStore, private val scope: StoreScope,
    private val files: PhotoFiles, private val api: EvidenceApi,
    private val now: () -> Long = System::currentTimeMillis) {
    companion object {
        private val flights = ConcurrentHashMap<StoreScope, Mutex>()
        /** Server refusals that a retry cannot fix: the office reviews the photo instead. */
        val FINAL = setOf("invalid_request", "out_of_scope", "conflict")
    }
    private val flight = flights.computeIfAbsent(scope) { Mutex() }

    suspend fun run(): UploadReport {
        if (!flight.tryLock()) return UploadReport(retryLater = true)
        try {
            // A held partition (sign-out, revoked phone, scope change) keeps its photos for review.
            if (store.syncHealth() == "held_for_review") return UploadReport(waiting = store.pendingPhotos().size)
            var report = UploadReport()
            val calls = store.history().associateBy { it.first.requestId }
            for (photo in store.pendingPhotos()) {
                val start = calls[photo.checkInRequestId]
                if (start == null || start.second.state == "review") {
                    store.reviewPhoto(photo.localId, if (start == null) "visit_missing" else "visit_rejected")
                    report = report.copy(review = report.review + 1); continue
                }
                val visitId = store.ack(photo.checkInRequestId)?.entityId
                if (visitId == null) { // Start not yet accepted: wait for the visit sync.
                    report = report.copy(waiting = report.waiting + 1, retryLater = true); continue
                }
                val bytes = runCatching { files.read(photo.localId) }.getOrNull()
                if (bytes == null || bytes.size.toLong() != photo.sizeBytes || EvidencePhotos.sha256Hex(bytes) != photo.sha256) {
                    store.reviewPhoto(photo.localId, "file_damaged")
                    report = report.copy(review = report.review + 1); continue
                }
                try {
                    val (url, claim) = api.uploadUrl(visitId)
                    val storageId = api.upload(url, bytes, photo.mime)
                    val evidenceId = api.attach(claim, visitId, storageId, photo)
                    store.markPhotoUploaded(photo.localId, evidenceId, now())
                    // The server holds the photo now; the phone copy is no longer needed.
                    runCatching { files.delete(photo.localId) }
                    report = report.copy(uploaded = report.uploaded + 1)
                } catch (e: kotlinx.coroutines.CancellationException) { throw e }
                catch (e: AuthFailure) {
                    // Offline, signed out or server busy: nothing changes; try again later.
                    return report.copy(waiting = store.pendingPhotos().size, retryLater = true)
                } catch (e: ConvexFunctionError) {
                    if (e.code in FINAL) {
                        store.reviewPhoto(photo.localId, e.code!!)
                        report = report.copy(review = report.review + 1)
                    } else report = retry(photo, report)
                } catch (_: EvidenceUploadFailure) { report = retry(photo, report) }
            }
            return report.copy(waiting = store.pendingPhotos().size)
        } finally { flight.unlock() }
    }

    private suspend fun retry(photo: EvidencePhotoRow, report: UploadReport): UploadReport =
        if (store.countPhotoAttempt(photo.localId) >= EvidencePhotos.MAX_ATTEMPTS) {
            store.reviewPhoto(photo.localId, "upload_failed")
            report.copy(review = report.review + 1)
        } else report.copy(retryLater = true)
}
