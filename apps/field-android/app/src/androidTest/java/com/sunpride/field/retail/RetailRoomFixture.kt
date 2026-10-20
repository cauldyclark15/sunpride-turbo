package com.sunpride.field.retail

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.room.Room
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.AppEnvironment
import com.sunpride.field.auth.SessionVault
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeyProtection
import com.sunpride.field.storage.*
import com.sunpride.field.ui.LiveFieldBackend
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import com.sunpride.retail.*
import kotlinx.coroutines.runBlocking
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.time.ZoneId
import java.util.UUID

/** Isolates the real backend's hard-wired Room singleton; no live DB, vault, session or work is changed.
 * Reflection only supplies the storage boundary. All save/queue/draft validation remains production code.
 * The old singleton is restored, never closed. Instrumentation is sequential, as in the existing suite. */
internal class RetailRoomFixture : AutoCloseable {
    private val base = InstrumentationRegistry.getInstrumentation().targetContext
    private val suffix = UUID.randomUUID().toString()
    val name = "field-retail-$suffix.db"
    private val key = ByteArray(32).also { SecureRandom().nextBytes(it) }
    val scope = StoreScope("issuer|retail-$suffix","retail-device-$suffix","retail-scope-$suffix")
    val at = System.currentTimeMillis()
    val day = Instant.ofEpochMilli(at).atZone(ZoneId.of("Asia/Manila")).toLocalDate().toString()
    private val singleton = EncryptedFieldDatabase::class.java.getDeclaredField("shared").apply { isAccessible=true }
    private val original = singleton.get(EncryptedFieldDatabase)
    private val preferences = mutableSetOf<String>()
    private val isolated = object : ContextWrapper(base) {
        override fun getSharedPreferences(name: String,mode: Int): SharedPreferences {
            val own="retail-$suffix-$name"; preferences+=own; return base.getSharedPreferences(own,mode)
        }
        // saveRetail's best-effort scheduler is intentionally unavailable: never wake a live worker.
        override fun getApplicationContext(): Context = error("Retail fixture never schedules background work")
    }
    val signer = object : DeviceSigner {
        override val publicKeySpki=byteArrayOf(1)
        override val protection=KeyProtection.SOFTWARE
        override fun signDer(message: ByteArray)=byteArrayOf(1)
        override fun sign(message: String)="retail-fixture-signature"
    }
    private val token="fixture-session-$suffix"
    private val vault=object : SessionVault {
        override fun readSession()=token
        override fun saveSession(token: String)=error("No authentication in retail tests")
        override var deviceId: String?=scope.deviceId
        override fun wipe()=error("Never sign out a real session")
        override fun clearSession()=error("No authentication in retail tests")
    }
    var db: StoreDatabase = open(); private set
    val store get() = RoomFieldStore(db,scope,closesDatabase=false)
    val backend: LiveFieldBackend
    lateinit var start: IntentRow; private set
    val call get() = requireNotNull(RetailAvailability.decode(retailJson()))
    fun retailJson() = JSONObject().put("version",RetailAvailability.VERSION).put("setupNeeded",false)
        .put("snapshotId","snapshot-$suffix").put("outletId","outlet-retail").put("serviceDate",day).put("sample",true)
        .put("msl",JSONObject().put("id","msl-retail").put("label","Sample neighbourhood MSL"))
        .put("lines",JSONArray().put(line("p-absent","MSL-1","Must-stock one",3,0,
            listOf("MSL minimum: 3 base units","Focus SKU: launch priority"),"Build first order"))
            .put(line("p-present","MSL-2","Must-stock two",1,2,listOf("Days of cover: replenish 2 base units"),null)))
    private fun line(id: String,code: String,name: String,min: Long,qty: Long,reasons: List<String>,objective: String?) =
        JSONObject().put("productId",id).put("code",code).put("name",name).put("uom","PC").put("quantityScale",1)
            .put("required",true).put("minimumBase",min).put("quantityBase",qty).put("reasons",JSONArray(reasons))
            .put("objective",objective ?: JSONObject.NULL).put("barcodes",JSONArray().put("barcode-$id"))
    fun answers()=listOf(ShelfAnswer("p-absent","absent",shelfBase=0,backroomBase=2),
        ShelfAnswer("p-present","present","scan",shelfBase=4,backroomBase=7))
    init {
        singleton.set(EncryptedFieldDatabase,db)
        isolated.getSharedPreferences("field_transport_epoch",0).edit().putInt("epoch",2).commit()
        val session=MessageDigest.getInstance("SHA-256").digest(token.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
        check(isolated.getSharedPreferences("field_v2_cache_index",0).edit().putString("$session.subject",scope.account)
            .putString("$session.device",scope.deviceId).putString("$session.scope",scope.fingerprint).commit())
        backend=LiveFieldBackend(AppEnvironment("https://retail.invalid"),vault,isolated) { signer }
    }
    private fun open(): StoreDatabase {
        System.loadLibrary("sqlcipher")
        return Room.databaseBuilder(base,StoreDatabase::class.java,name)
            .openHelperFactory(SupportOpenHelperFactory(key.copyOf())).build().also { it.openHelper.writableDatabase }
    }
    fun reopen() { db.close(); db=open(); singleton.set(EncryptedFieldDatabase,db) }
    fun ready()=runBlocking {
        val outlet=JSONObject().put("id","outlet-retail").put("name","Retail fixture store").put("customerId","customer-retail")
            .put("availability",retailJson())
        val plan=JSONObject().put("id","planned-retail").put("outletId","outlet-retail").put("serviceDate",day)
        val sheet=CallSheet("outlet-retail",1,CallSheetHeader("Retail fixture store",null,null,null,null,null,null,null,null,null),
            call.lines.map { CallSheetProduct(it.productId,it.code,it.name,it.uom,it.barcodes.single(),null) })
        store.swap(store.stage(ScopedSnapshot("{}",null,listOf(SnapshotItem("planned-retail",plan.toString(),day)),
            listOf(SnapshotItem("outlet-retail",outlet.toString())),listOf(SnapshotItem("customer-retail","{\"code\":\"C-RETAIL\"}")),
            emptyList(),listOf(sheet))),"retail-cursor",Long.MAX_VALUE,Long.MAX_VALUE)
        start=VisitIntentFactory.create(scope,"visit.checkIn",null,null,null,"planned-retail","outlet-retail",
            listOf("sell"),null,null,null,null,null,at=at)
        store.enqueue(start,at)
    }
    fun save(quantities: Map<String,Long> = mapOf("p-absent" to 5L,"p-present" to 0L)) =
        backend.saveRetail(call,start.clientVisitId,start.requestId,start.requestId,answers(),quantities)
    fun checkout(previous: String=start.requestId)=VisitIntentFactory.create(scope,"visit.checkOut",start.clientVisitId,
        start.requestId,previous,"planned-retail","outlet-retail",emptyList(),null,null,"completed",null,null,at=at+100)
    override fun close() {
        singleton.set(EncryptedFieldDatabase,original)
        db.close(); base.deleteDatabase(name)
        preferences.forEach { base.deleteSharedPreferences(it) }
    }
}
