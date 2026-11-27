package com.sunpride.field.ui.customers

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ProjectionGrant
import com.sunpride.field.auth.ServerError
import com.sunpride.field.storage.DeltaRow
import com.sunpride.field.storage.FieldStore
import com.sunpride.field.storage.StoreScope
import com.sunpride.field.support.FakeFieldStore
import com.sunpride.field.ui.FieldFormDrafts
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class SubmittedCustomerProfilesTest {
    private val id = "b0599748-37c9-4b4f-87f8-ebae2a8c6486"
    private val prefs = mutableMapOf<String, String>()
    private val store = CacheStore()
    private var current = true
    private var signOuts = 0
    private var rejectGrantWrites = false

    @Before fun reset() { ProjectionGrant.retire() }

    private fun grant() = ProjectionGrant("sample-account-phone-scope", "customer.editor", prefs::get,
        { key, value -> if (rejectGrantWrites) false else { prefs[key] = value; true } }).also { it.begin(id) }

    private fun profile(waiting: Boolean = true, admin: Boolean = false) = JSONObject()
        .put("customer", JSONObject().put("id", id).put("customerName", "Sample store")
            .put("status", "active").put("enrolmentStatus", if (waiting) "provisional" else "approved")
            .put("canEdit", waiting || admin).put("updatedAt", 123L))
        .put("fields", org.json.JSONArray().put(JSONObject().put("key", "mobileNo").put("value", "")))
        .put("missingFields", org.json.JSONArray().put(JSONObject().put("field", "mobileNo").put("label", "Mobile No.")))

    private suspend fun load(preview: Boolean = false, fetch: () -> JSONObject): JSONObject =
        SubmittedCustomerProfiles.load(store, id, preview, grant(), { current }, fetch, { signOuts++ })

    @Test fun waitingListResolvesTheAcknowledgedCustomerInsteadOfTheCaptureId(): Unit = runBlocking {
        val captureRequestId = "589ddba0-1399-4f25-ac7a-363597427d46"
        val ack = com.sunpride.field.storage.AckRow("sample", "phone", "scope", captureRequestId, id, "[]", 123L)
        var storedAck: com.sunpride.field.storage.AckRow? = ack
        val captures = object : FieldStore by store {
            override suspend fun ack(requestId: String) = storedAck.takeIf { requestId == captureRequestId }
        }
        assertEquals(id, SubmittedCustomerProfiles.profileId(captures, captureRequestId, "done"))
        assertNull(SubmittedCustomerProfiles.profileId(captures, "another-capture", "done"))
        for (state in listOf("pending", "sending", "review", "office", "held"))
            assertNull(SubmittedCustomerProfiles.profileId(captures, captureRequestId, state))
        storedAck = null
        assertNull(SubmittedCustomerProfiles.profileId(captures, captureRequestId, "done"))
        storedAck = ack.copy(entityId = "not-a-customer-id")
        assertNull(SubmittedCustomerProfiles.profileId(captures, captureRequestId, "done"))
    }

    @Test fun waitingCustomerOpensThroughTheCacheAndKeepsMissingFields(): Unit = runBlocking {
        val response = profile()
        val opened = load { response }
        assertSame(response, opened)
        assertTrue(opened.getJSONObject("customer").getBoolean("canEdit"))
        assertEquals("Mobile No.", opened.getJSONArray("missingFields").getJSONObject(0).getString("label"))
        assertEquals(response.toString(), grant().read(store.rows.getValue(SubmittedCustomerProfiles.ENTITY to id).json!!))
        assertEquals(id, store.lastPrefix)
        assertEquals(0, signOuts)
    }

    @Test fun previewDoesNotReplaceTheSavedProfile(): Unit = runBlocking {
        load { profile() }
        val cached = store.rows.toMap()
        val preview = profile().put("preview", true)
        assertSame(preview, load(preview = true) { preview })
        assertEquals(cached, store.rows)
    }

    @Test fun reopeningAfterApprovalUsesCurrentPermissionForSalesmanAndAdmin(): Unit = runBlocking {
        load { profile() }
        val approved = load { profile(waiting = false) }
        assertFalse(approved.getJSONObject("customer").getBoolean("canEdit"))
        assertFalse(SubmittedCustomerEdits.waiting(approved.getJSONObject("customer")))
        val admin = load { profile(waiting = false, admin = true) }
        assertTrue(admin.getJSONObject("customer").getBoolean("canEdit"))
        val offline = load { throw AuthFailure(AuthFailure.Kind.OFFLINE) }
        assertEquals(admin.toString(), offline.toString())
    }

    @Test fun refusalNeverFallsBackToTheOldEditableProfileEvenOnLaterOfflineOpen(): Unit = runBlocking {
        load { profile() }
        val cached = store.rows.toMap()
        assertThrows(ServerError::class.java) { runBlocking { load { throw ServerError("forbidden") } } }
        assertEquals(cached, store.rows) // retained disk data alone cannot authorize fallback
        assertThrows(AuthFailure::class.java) { runBlocking { load { throw AuthFailure(AuthFailure.Kind.OFFLINE) } } }
        assertEquals(0, signOuts)
    }

    @Test fun failedDurableDenialSignsOutAndBlocksTheRetainedProfile(): Unit = runBlocking {
        load { profile() }
        rejectGrantWrites = true
        assertThrows(ServerError::class.java) { runBlocking { load { throw ServerError("forbidden") } } }
        assertEquals(1, signOuts)
        assertThrows(AuthFailure::class.java) { runBlocking { load { throw AuthFailure(AuthFailure.Kind.OFFLINE) } } }
    }

    @Test fun heldPartitionDoesNotFetchOrPublishAProfile() {
        store.held = true
        assertThrows(IllegalStateException::class.java) { runBlocking { load { error("Must not fetch") } } }
        assertTrue(store.rows.isEmpty())
    }

    @Test fun changedSessionOrNewerDenialCannotPublishOrCacheALateSuccess() {
        assertThrows(IllegalStateException::class.java) { runBlocking { load { current = false; profile() } } }
        current = true
        assertThrows(IllegalStateException::class.java) { runBlocking { load { grant().deny(); profile() } } }
        assertTrue(store.rows.isEmpty())
    }

    @Test fun profileDraftsSaveReopenAndClearWithoutDroppingOtherUnfinishedForms(): Unit = runBlocking {
        val key = "profile:$id"
        val body = JSONObject().put("edits", JSONObject().put("mobileNo", "09171234567")).toString()
        FieldFormDrafts.save(store, "profile:another-customer", "{}", 1L)
        FieldFormDrafts.save(store, key, body, 2L)
        assertEquals(body, store.localCache(FieldFormDrafts.ENTITY, key)?.json)
        assertFalse(store.localCache(FieldFormDrafts.ENTITY, "profile:another-customer")!!.tombstone)
        FieldFormDrafts.save(store, key, null, 3L)
        assertTrue(store.localCache(FieldFormDrafts.ENTITY, key)!!.tombstone)
        assertFalse(store.localCache(FieldFormDrafts.ENTITY, "profile:another-customer")!!.tombstone)
    }

    /** Enforce RoomFieldStore's actual key/prefix precondition and retention semantics.
     * JVM boundary only: this is not an Android SQLCipher or physical-phone proof. */
    private class CacheStore : FieldStore by FakeFieldStore(StoreScope("sample", "phone", "scope")) {
        val rows = mutableMapOf<Pair<String, String>, DeltaRow>()
        var held = false
        var lastPrefix: String? = null
        override suspend fun isHeld() = held
        override suspend fun localCache(entity: String, key: String) = rows[entity to key]
        override suspend fun putLocalCache(entity: String, key: String, json: String, at: Long, keepPrefix: String) {
            require(entity.startsWith("local.") && key.startsWith(keepPrefix) && json.isNotBlank() && at > 0)
            lastPrefix = keepPrefix
            rows.keys.removeAll { it.first == entity && !it.second.startsWith(keepPrefix) }
            rows[entity to key] = DeltaRow("sample", "phone", "scope", entity, key, at, json, false)
        }
        override suspend fun blockLocalCache(entity: String, key: String, reason: String, at: Long) {
            rows[entity to key] = DeltaRow("sample", "phone", "scope", entity, key, at, reason, true)
        }
    }
}
