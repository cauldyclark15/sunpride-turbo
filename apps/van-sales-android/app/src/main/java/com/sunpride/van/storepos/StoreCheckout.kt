package com.sunpride.van.storepos

import com.sunpride.van.data.*
import com.sunpride.van.pos.*
import com.sunpride.van.sync.VanBootstrapCodec
import com.sunpride.van.storage.OutboxRow
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** F-R03: use the existing pure POS quote/promotion engines; there is no store price editor. */
object StoreCheckout {
    internal val customerLock=kotlinx.coroutines.sync.Mutex()
    fun normalizePhone(value:String):String=value.trim().replace(Regex("[ ()+-]"),"").also {require(it.matches(Regex("[0-9]{7,15}"))){"Enter a valid customer phone"}}
    fun availablePoints(config:StorePosConfig,rows:List<OutboxRow>):Long {
        val customer=config.details.optJSONObject("customerLookup")?:return 0
        val key=customer.optString("lookupId");if(key.isBlank())return 0
        val spent=rows.filter {it.kind=="store.sale"&&it.status !in setOf("rejected","conflict","parked")}.sumOf {row->
            val p=JSONObject(row.operationJson).getJSONObject("payload")
            if(p.optString("customerPhone")==customer.optString("phone")&&(row.status in setOf("pending","sending")||p.optString("loyaltyLookupId")==key))p.optString("redeemPoints","0").toLong() else 0L
        }
        return maxOf(0,Math.subtractExact(customer.getString("points").toLong(),spent))
    }
    fun objects(a: JSONArray?): List<JSONObject> = if(a==null)emptyList() else (0 until a.length()).map(a::getJSONObject)
    fun products(config: StorePosConfig): List<Product> = objects(config.details.optJSONArray("catalogue")).map(VanBootstrapCodec::product)
    fun context(config: StorePosConfig,rows: List<OutboxRow>,now:Long): CheckoutContext {
        val data=config.details
        check(data.optBoolean("transactionsEnabled")) {"The office must link the store and its account first"}
        check(data.optBoolean("promotionsOfflineSupported",true)) {"This campaign requires office checkout; do not invent an offline discount"}
        val remote=objects(data.optJSONArray("sales")).map {it.getString("id")}.toSet()
        val local=rows.filter {it.kind=="store.sale" && it.clientRequestId !in remote && JSONObject(it.operationJson).getJSONObject("payload").optString("modeVersionId")==config.modeVersionId}
        val used=mutableMapOf<String,Long>()
        local.forEach {row->objects(JSONObject(row.operationJson).getJSONObject("payload").let {it.optJSONArray("stockLines")?:it.getJSONArray("lines")}).forEach {l->used[l.getString("productId")]=Math.addExact(used[l.getString("productId")]?:0,l.getString("quantityBase").toLong())}}
        val stock=objects(data.optJSONArray("catalogue")).map {TruckStock(it.getString("productId"),Math.subtractExact(it.getString("availableBase").toLong(),used[it.getString("productId")]?:0),0)}
        val customer=data.optJSONObject("customer")?.let(VanBootstrapCodec::customer)
        val prices=objects(data.optJSONArray("catalogue")).filter {!it.isNull("unitPriceMinor")}.map {PriceLine(checkNotNull(config.registerId),it.getString("productId"),it.getString("uomCode"),it.getString("unitPriceMinor").toLong(),"PHP",it.getLong("priceFrom"),if(it.isNull("priceTo"))null else it.getLong("priceTo"),"SAP replicated conditions")}
        val governed=JSONObject().put("schemes",data.optJSONArray("governedPromotions")?:JSONArray())
        val lists=JSONObject();val units=JSONObject()
        objects(data.optJSONArray("catalogue")).forEach {p->lists.put(p.getString("productId"),p.opt("sourcePriceListId")?:JSONObject.NULL);units.put(p.getString("productId"),p.optJSONObject("units")?:JSONObject())}
        governed.put("priceLists",lists).put("units",units)
        // IP-SCPWD-CAP: the weekly senior/PWD limit as this till knows it: the bundle's use per card plus what this phone sold since.
        val cap=com.sunpride.van.selling.PrivilegeCapInfo.decode(data.optJSONObject("privilegeCap"))
        val capUsed=com.sunpride.van.selling.PrivilegeCap.localUsed(cap,now,rows.filter {it.kind=="store.sale"}.mapNotNull {r->
            JSONObject(r.operationJson).optJSONObject("payload")?.optJSONObject("discountClaim")?.let {Triple(r.status,r.createdAt,it)}})
        return CheckoutContext(true,listOfNotNull(customer),products(config),stock,prices,VanPolicy(),now,
            promotions=emptyList(),governedPromotionsJson=governed.toString(),taxFacts=taxFacts(config),
            capRemaining=com.sunpride.van.selling.PrivilegeCap.remainingFn(cap,capUsed,now))
    }
    /**
     * IP-HH2: how each catalogue product is taxed, when the office's bundle says so (`taxTreatment` + `taxBasisPoints` on the catalogue row).
     * A bundle that does not carry them gives no facts, so a discount claim is refused in plain words rather than guessed.
     */
    fun taxFacts(config: StorePosConfig): (QuotedLine,String?)->com.sunpride.van.selling.TaxFact? {
        val byProduct=objects(config.details.optJSONArray("catalogue")).mapNotNull {row->
            val treatment=row.optString("taxTreatment").takeIf {it.isNotBlank()}?:return@mapNotNull null
            row.getString("productId") to com.sunpride.van.selling.TaxFact(treatment,row.optInt("taxBasisPoints",0))
        }.toMap()
        return {line,_->byProduct[line.product.productId]}
    }
    /** True when this store's bundle carries tax facts for every catalogue product (so a discount claim can be worked out here). */
    fun claimsPossible(config: StorePosConfig): Boolean {
        // IP-INT3: a product with no price cannot be sold, so it needs no tax fact; every sellable product must have one.
        val rows=objects(config.details.optJSONArray("catalogue")).filter {!it.isNull("unitPriceMinor")}
        return rows.isNotEmpty()&&rows.all {it.optString("taxTreatment").isNotBlank()}
    }
    /** Tender codes the office has turned on for this register (the bundle's `paymentMethods`). */
    fun enabledTenders(config: StorePosConfig): Set<String> = objects(config.details.optJSONArray("paymentMethods")).mapNotNull {it.optString("code").takeIf {c->c.isNotBlank()}}.toSet()
    /**
     * Beta.28 device: Payment offered Cash although the store's bundle carried no cash tender and no receipt numbers, so every sale
     * was refused at save time. These are the two set-up gaps `StoreTransactions.sale()` stops on, said up front in plain words
     * (null when the till can sell).
     */
    fun setupProblem(config: StorePosConfig): String? {
        if(enabledTenders(config).isEmpty()) return "No payment types are turned on for this store yet. Ask the office to set them up."
        if("cash" !in enabledTenders(config)) return "Cash is not turned on for this store yet. Ask the office."
        val invoice=runCatching {com.sunpride.van.fiscal.FiscalNumbers.ranges(JSONObject().put("fiscal",config.details.optJSONObject("fiscal")?:JSONObject()))}.getOrNull()
            ?.any {it.optString("documentType")=="sales_invoice"}
        if(invoice!=true) return "This till has no receipt numbers yet. Tap Sync. If it stays, ask the office to give this handheld a receipt range."
        return null
    }
    fun quote(config: StorePosConfig,rows: List<OutboxRow>,lines:List<CartLine>,now:Long,claim:com.sunpride.van.selling.DiscountClaim?=null): CheckoutQuote {
        val context=context(config,rows,now)
        val request=CheckoutRequest(CheckoutRules.newSaleId(),context.customers.singleOrNull()?.outletId,lines,PaymentInput("cash",CheckoutRules.MAX_MINOR),claim=claim)
        val result=CheckoutRules.evaluate(request,context)
        if(!result.ok)throw CheckoutRefused(result.issues)
        return checkNotNull(result.quote)
    }
    fun total(config:StorePosConfig,base:Long,employee:Boolean,points:Long):Long {
        require(points>=0)
        val policy=config.details
        val discount=if(employee) Math.multiplyExact(base,policy.getJSONObject("supervisor").getLong("employeeDiscountBps"))/10000 else 0
        val loyalty=policy.optJSONObject("loyalty")
        check(points==0L || loyalty?.optBoolean("enabled")==true) {"Loyalty is off"}
        val redeemed=Math.multiplyExact(points,loyalty?.optString("pointValueCentavos")?.toLongOrNull()?:0)
        return Math.subtractExact(Math.subtractExact(base,discount),redeemed).also {check(it>=0){"Discounts exceed this basket"}}
    }
    fun proof(config:StorePosConfig,pin:String,saleId:String,shiftId:String,total:Long):String {
        require(pin.matches(Regex("[0-9]{6,12}"))) {"Enter the supervisor PIN"}
        val supervisor=config.details.getJSONObject("supervisor")
        val chars=pin.toCharArray();val spec=PBEKeySpec(chars,supervisor.getString("salt").toByteArray(),160000,256)
        val key=try{SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded}finally{chars.fill('\u0000');spec.clearPassword()}
        fun hex(bytes:ByteArray)=bytes.joinToString(""){"%02x".format(it.toInt() and 255)}
        check(MessageDigest.isEqual(hex(MessageDigest.getInstance("SHA-256").digest(key)).toByteArray(),supervisor.getString("hash").toByteArray())) {"Supervisor PIN was not accepted"}
        return try{val mac=Mac.getInstance("HmacSHA256");mac.init(SecretKeySpec(key,"HmacSHA256"));hex(mac.doFinal("$saleId|$shiftId|$total|${config.policyId}".toByteArray()))}finally{key.fill(0)}
    }
}
