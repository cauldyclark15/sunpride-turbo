package com.sunpride.field.evidence

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ServerError
import com.sunpride.field.auth.ServerFunctions
import com.sunpride.field.auth.defaultHttpClient
import com.sunpride.field.storage.EvidencePhotoRow
import com.sunpride.field.storage.EvidencePhotos
import com.sunpride.field.storage.FieldStore
import com.sunpride.field.storage.StoreScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.currentCoroutineContext
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
    fun uploadUrl(visitId: String, row: EvidencePhotoRow): Pair<String, String> = uploadUrl(visitId)
    /** POSTs the bytes; returns the server upload ID. */
    fun upload(url: String, bytes: ByteArray, mime: String): String
    /** Returns the server evidence ID (the same ID again for a retried, already attached photo). */
    fun attach(claim: String, visitId: String, storageId: String, row: EvidencePhotoRow): String
}

/** A storage POST that reached the server and was refused; retried a bounded number of times. */
class EvidenceUploadFailure : Exception("Upload refused", null)

class ServerEvidenceApi(private val functions: ServerFunctions,
    private val http: OkHttpClient = defaultHttpClient()) : EvidenceApi {
    private val claims = ConcurrentHashMap<String, JSONObject>()
    override fun uploadUrl(visitId: String): Pair<String, String> = error("Photo metadata required")
    override fun uploadUrl(visitId: String, row: EvidencePhotoRow): Pair<String, String> {
        val me = functions.api.me(); val device = me.getJSONObject("device").getString("id")
        val value = functions.api.signed("/api/media/claims", JSONObject().put("version", 2)
            .put("deviceId", device).put("purpose", com.sunpride.field.storage.WorkforceForms.purpose(row.photoType)).put("ownerId", visitId)
            .put("mime", row.mime).put("size", row.sizeBytes).put("sha256", row.sha256),
            requireNotNull(functions.signer).invoke(), device)
        val url = value.getString("uploadUrl")
        val uri = java.net.URI(url)
        // Upload credentials must never follow a server-provided cross-origin URL.
        require(uri.path == "/api/media/uploads/${value.getString("uploadId")}")
        require(uri.scheme == "https" || (uri.scheme == "http" && uri.host in setOf("localhost", "127.0.0.1")))
        require(uri.userInfo == null && uri.query == null && uri.fragment == null)
        require(functions.uploadOrigin(url))
        claims[url] = value
        return url to value.getString("uploadId")
    }
    override fun upload(url: String, bytes: ByteArray, mime: String): String {
        val claim = claims.remove(url) ?: throw EvidenceUploadFailure()
        val request = Request.Builder().url(url).header("Authorization", "Bearer ${claim.getString("uploadToken")}")
            .put(bytes.toRequestBody(mime.toMediaType())).build()
        return try { http.newCall(request).execute().use { response ->
            if (response.code !in 200..299) throw EvidenceUploadFailure()
            val o = JSONObject(response.body?.string().orEmpty())
            check(o.getInt("version") == 2 && o.getString("status") == "stored" &&
                o.getString("sha256") == EvidencePhotos.sha256Hex(bytes))
            o.getString("blobId")
        } } catch (_: IOException) { throw AuthFailure(AuthFailure.Kind.OFFLINE) }
    }
    override fun attach(claim: String, visitId: String, storageId: String, row: EvidencePhotoRow): String {
        val me = functions.api.me(); val device = me.getJSONObject("device").getString("id")
        val payload = JSONObject().put("visitId", visitId).put("blobId", storageId).put("checksum", row.sha256)
            .put("mime", row.mime).put("size", row.sizeBytes).put("capturedAt", row.capturedAt)
            .put("photoType", row.photoType).put("source", "mobile")
        val op = JSONObject().put("clientOpId", row.localId).put("opType", "evidence.attach")
            .put("clientTime", row.capturedAt).put("dependsOn", org.json.JSONArray()).put("payload", payload)
        val body = com.sunpride.field.sync.V2Wire.push(device, me.getJSONObject("scope").getString("id"), org.json.JSONArray().put(op))
        val response = functions.api.signed("/api/sync/push", body, requireNotNull(functions.signer).invoke(), device)
        val results = response.getJSONArray("results"); check(results.length() == 1)
        val result = results.getJSONObject(0)
        check(result.getString("clientOpId") == row.localId && result.getString("opType") == "evidence.attach")
        if (result.getString("status") !in setOf("applied", "duplicate"))
            throw ServerError(result.optString("code"))
        return result.getJSONObject("ack").getString("entityId")
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
    private var authorized: () -> Boolean = { true }
    /** F-209/F-222: retire old upload callbacks even if fallible partition teardown failed. */
    fun whileAuthorized(check: () -> Boolean): EvidenceUploader { authorized=check;return this }

    suspend fun run(): UploadReport {
        if (!flight.tryLock()) return UploadReport(retryLater = true)
        try {
            // A held partition (sign-out, revoked phone, scope change) keeps its photos for review.
            if (store.syncHealth() == "held_for_review" || !authorized()) return UploadReport(waiting = store.pendingPhotos().size)
            var report = UploadReport()
            val calls = store.history().associateBy { it.first.requestId }
            // Workforce media is kept until its aggregate ack is durable, not merely until PUT succeeds.
            for((intent,row) in calls.values) if(com.sunpride.field.storage.WorkforceForms.isForm(intent.kind) && row.state=="done" && store.ack(intent.requestId)!=null) {
                for(photo in store.visitPhotos(intent.clientVisitId).filter { it.photoType in com.sunpride.field.storage.WorkforceForms.PHOTO_TYPES && it.state=="uploaded" }) {
                    currentCoroutineContext().ensureActive()
                    if(!authorized() || store.syncHealth()=="held_for_review")return report.copy(retryLater=true)
                    if(runCatching { files.delete(photo.localId) }.isSuccess) {
                        currentCoroutineContext().ensureActive()
                        if(authorized() && store.syncHealth()!="held_for_review")store.forgetUploadedFormPhoto(photo.localId)
                    }
                }
            }
            for (photo in store.pendingPhotos()) {
                val start = calls[photo.checkInRequestId]
                if (start == null || start.second.state == "review") {
                    store.reviewPhoto(photo.localId, if (start == null) "visit_missing" else "visit_rejected")
                    report = report.copy(review = report.review + 1); continue
                }
                val form=photo.photoType in com.sunpride.field.storage.WorkforceForms.PHOTO_TYPES
                if(form && !com.sunpride.field.storage.WorkforceForms.isForm(start.first.kind)) {
                    store.reviewPhoto(photo.localId,"form_missing");report=report.copy(review=report.review+1);continue
                }
                val visitId = if(form)photo.checkInRequestId else store.ack(photo.checkInRequestId)?.entityId
                if (visitId == null) { // Start not yet accepted: wait for the visit sync.
                    report = report.copy(waiting = report.waiting + 1, retryLater = true); continue
                }
                val bytes = runCatching { files.read(photo.localId) }.getOrNull()
                if (bytes == null || bytes.size.toLong() != photo.sizeBytes || EvidencePhotos.sha256Hex(bytes) != photo.sha256) {
                    store.reviewPhoto(photo.localId, "file_damaged")
                    report = report.copy(review = report.review + 1); continue
                }
                try {
                    currentCoroutineContext().ensureActive()
                    if (store.syncHealth() == "held_for_review" || !authorized()) return report.copy(waiting = store.pendingPhotos().size)
                    val (url, claim) = api.uploadUrl(visitId, photo)
                    currentCoroutineContext().ensureActive()
                    if (store.syncHealth() == "held_for_review" || !authorized()) return report.copy(waiting = store.pendingPhotos().size)
                    val storageId = api.upload(url, bytes, photo.mime)
                    currentCoroutineContext().ensureActive()
                    if (store.syncHealth() == "held_for_review" || !authorized()) return report.copy(waiting = store.pendingPhotos().size)
                    val evidenceId = if(form)storageId else api.attach(claim, visitId, storageId, photo)
                    currentCoroutineContext().ensureActive()
                    if (store.syncHealth() == "held_for_review" || !authorized()) return report.copy(waiting = store.pendingPhotos().size)
                    store.markPhotoUploaded(photo.localId, evidenceId, now())
                    currentCoroutineContext().ensureActive()
                    if (store.syncHealth() == "held_for_review" || !authorized()) return report.copy(waiting = store.pendingPhotos().size)
                    // The server holds the photo now; the phone copy is no longer needed.
                    if(!form)runCatching { files.delete(photo.localId) }
                    report = report.copy(uploaded = report.uploaded + 1)
                } catch (e: kotlinx.coroutines.CancellationException) { throw e }
                catch (e: AuthFailure) {
                    // Offline, signed out or server busy: nothing changes; try again later.
                    return report.copy(waiting = store.pendingPhotos().size, retryLater = true)
                } catch (e: ServerError) {
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
