package com.sunpride.van.retail

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.retail.*
import com.sunpride.van.data.VanRepository
import com.sunpride.van.pos.*
import com.sunpride.van.storage.*
import com.sunpride.van.sync.FakeVanBackend
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import java.time.Instant
import java.time.ZoneId
import java.util.UUID

/** Unique encrypted DB/key and preferences. No stub/live DB reset, session restoration, network or printer.
 * Repository reflection injects only its existing current-store boundary; all controller/store bodies are real. */
internal class RetailRoomFixture : AutoCloseable {
    private val base=InstrumentationRegistry.getInstrumentation().targetContext
    private val suffix=UUID.randomUUID().toString()
    val name="van-retail-$suffix.db"
    private val key=ByteArray(32).also { SecureRandom().nextBytes(it) }
    val scope=StoreScope("v2|retail-$suffix|fingerprint-$suffix","retail-device-$suffix")
    val at=System.currentTimeMillis()
    val day=Instant.ofEpochMilli(at).atZone(ZoneId.of("Asia/Manila")).toLocalDate().toString()
    val product="k57prod0000000000000000000000001"
    val second="k57prod0000000000000000000000002"
    val outlet="k57out00000000000000000000000001"
    var db=EncryptedVanDatabase.openWithPassphrase(base,key.copyOf(),name); private set
    val store get()=RoomVanStore(db,scope,clock={at+10})
    private val preferences=mutableSetOf<String>()
    private val isolated=object : ContextWrapper(base) {
        override fun getApplicationContext(): Context=this
        override fun getSharedPreferences(name: String,mode: Int): SharedPreferences {
            val own="retail-$suffix-$name"; preferences+=own; return base.getSharedPreferences(own,mode)
        }
    }
    private var repository: VanRepository?=null
    fun repository(): VanRepository = repository ?: VanRepository.forWorker(isolated,true).also { repo ->
        val current=VanRepository::class.java.getDeclaredField("current").apply { isAccessible=true }
        @Suppress("UNCHECKED_CAST")
        (current.get(repo) as MutableStateFlow<RoomVanStore?>).value=store
        VanRepository::class.java.getDeclaredField("database").apply { isAccessible=true }.set(repo,db)
        // The real repository's guard requires a signed-in session as well as the
        // authorized store. Seed only this fixture's isolated encrypted preferences.
        val vault=VanRepository::class.java.getDeclaredField("vault").apply {isAccessible=true}.get(repo) as com.sunpride.van.auth.SessionVault
        vault.saveSession("retail-isolated-test-session")
        @Suppress("UNCHECKED_CAST")
        (VanRepository::class.java.getDeclaredField("session").apply {isAccessible=true}.get(repo) as MutableStateFlow<com.sunpride.van.data.SessionState>).value=com.sunpride.van.data.SessionState(true)
        @Suppress("UNCHECKED_CAST")
        (VanRepository::class.java.getDeclaredField("enrollment").apply {isAccessible=true}.get(repo) as MutableStateFlow<com.sunpride.van.auth.EnrollmentState>).value=com.sunpride.van.auth.EnrollmentState.Ready(scope.deviceId)
        repository=repo
    }
    val call get()=requireNotNull(RetailAvailability.decode(retailJson()))
    fun retailJson()=JSONObject().put("version",RetailAvailability.VERSION).put("setupNeeded",false)
        .put("snapshotId","snapshot-$suffix").put("outletId",outlet).put("serviceDate",day).put("sample",true)
        .put("msl",JSONObject().put("id","msl-retail").put("label","Sample neighbourhood MSL"))
        .put("lines",JSONArray().put(line(product,"MSL-1","Must-stock one",3,0,
            listOf("MSL minimum: 3 base units","Focus SKU: launch priority"),"Build first order"))
            .put(line(second,"MSL-2","Must-stock two",1,2,listOf("Days of cover: replenish 2 base units"),null)))
    private fun line(id: String,code: String,name: String,min: Long,qty: Long,reasons: List<String>,objective: String?)=
        JSONObject().put("productId",id).put("code",code).put("name",name).put("uom","PC").put("quantityScale",1)
            .put("required",true).put("minimumBase",min).put("quantityBase",qty).put("reasons",JSONArray(reasons))
            .put("objective",objective ?: JSONObject.NULL).put("barcodes",JSONArray().put("barcode-$id"))
    fun answers()=listOf(ShelfAnswer(product,"absent",shelfBase=0,backroomBase=2),
        ShelfAnswer(second,"present","scan",shelfBase=4,backroomBase=7))
    fun snapshot(): String {
        val o=JSONObject(FakeVanBackend.FIXTURE).put("serverTime",at).put("serviceDate",day)
        o.remove("promotions")
        o.getJSONObject("trip").put("status","active").put("serviceDate",day).put("routeSessionId","retail-route")
        o.getJSONObject("load").put("status","posted")
        val lines=o.getJSONObject("load").getJSONArray("lines")
        for(i in 0 until lines.length())lines.getJSONObject(i).put("actualBase",lines.getJSONObject(i).getString("expectedBase"))
        o.getJSONArray("customers").getJSONObject(0).put("priceListId","PL-RETAIL")
        o.put("truckStock",JSONArray(listOf(product,second).map { JSONObject().put("productId",it)
            .put("availableBase","20").put("damagedBase","0") }))
        o.put("priceLines",JSONArray(listOf(product,second).map { JSONObject().put("priceListId","PL-RETAIL")
            .put("priceListCode","PL-RETAIL").put("productId",it).put("uomCode","PC").put("unitPriceMinor","1000")
            .put("currency","PHP").put("effectiveFrom",at-1000).put("effectiveTo",JSONObject.NULL) }))
        o.put("_v2",JSONObject().put("subject",scope.fullAuthSubject).put("scopeFingerprint","fingerprint-$suffix")
            .put("epoch","retail-epoch").put("cursor","retail-cursor").put("leaseExpiresAt",Long.MAX_VALUE)
            .put("cacheExpiresAt",Long.MAX_VALUE).put("availability",JSONArray().put(retailJson())))
        return o.toString()
    }
    fun ready()=runBlocking { store.replaceBootstrap(snapshot()); Unit }
    fun reopen() {
        check(repository==null) {"Close UI repository before reopening"}
        db.close(); db=EncryptedVanDatabase.openWithPassphrase(base,key.copyOf(),name)
    }
    fun request(id: String=UUID.randomUUID().toString(),qty: Long=5)=CheckoutRequest(id,outlet,
        listOf(CartLine(product,qty)),PaymentInput("cash",100_000))
    override fun close() {
        repository?.close(); db.close(); base.deleteDatabase(name)
        preferences.forEach { base.deleteSharedPreferences(it) }
    }
}
