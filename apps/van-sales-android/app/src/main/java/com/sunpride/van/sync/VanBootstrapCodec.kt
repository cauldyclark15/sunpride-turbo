package com.sunpride.van.sync

import com.sunpride.van.data.*
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

object VanBootstrapCodec {
    internal fun objects(a: JSONArray): List<JSONObject> = (0 until a.length()).map { a.getJSONObject(it) }
    internal fun strings(a: JSONArray): List<String> = (0 until a.length()).map { a.getString(it) }
    internal fun nullable(o: JSONObject, key: String): String? = if (o.isNull(key)) null else o.getString(key)
    private fun base(o: JSONObject, key: String): Long = o.getString(key).toLong()
    fun policy(o: JSONObject) = VanPolicy(o.getBoolean("allowNegativeStock"), o.getBoolean("loadDiscrepancyRequiresApproval"),
        o.getBoolean("walkInAllowed"), strings(o.getJSONArray("loadDiscrepancyReasons")), strings(o.getJSONArray("damageReasons")),
        o.optJSONArray("paymentMethods")?.let(::paymentMethods) ?: PaymentMethod.CASH_ONLY,
        o.optJSONArray("voidReasons")?.let(::strings) ?: emptyList(),
        o.optJSONObject("voidApproval")?.let { VoidApproval(it.getBoolean("required"),base(it,"thresholdMinor"),nullable(it,"key")) })
    /** VAN-012: optional; a policy cached before it (or an older server) allows cash only. */
    fun paymentMethods(a: JSONArray): List<PaymentMethod> {
        val methods = objects(a).map { PaymentMethod(it.getString("code"), it.getString("label"), PaymentKind.of(it.getString("kind")),
            it.getBoolean("referenceRequired"), nullable(it,"referenceLabel")) }
        require(methods.isNotEmpty() && methods.size <= 12 && methods.map { it.code }.distinct().size == methods.size)
        require(methods.all { Regex("^[a-z][a-z0-9_]{0,31}$").matches(it.code) && it.label.isNotBlank() && it.label.length <= 40 })
        // Cash gives change and credit charges the account: neither carries a reference.
        require(methods.none { it.kind != PaymentKind.OTHER && it.referenceRequired })
        return methods
    }
    fun trip(o: JSONObject): Trip = Trip(o.getString("tripId"), o.getString("tripNumber"), o.getString("status"), o.getString("serviceDate"),
        o.optJSONObject("vehicle")?.let { Vehicle(it.getString("vehicleId"), it.getString("vehicleCode"), it.getString("plateNumber"), nullable(it,"name")) },
        o.optJSONObject("route")?.let { Route(it.getString("routeId"), it.getString("code"), it.getString("name")) },
        nullable(o,"driverName"), nullable(o,"helperName"), o.getString("truckLocationId"), nullable(o,"routeSessionId"),
        if (o.isNull("startedAt")) null else o.getLong("startedAt"))
    fun line(o: JSONObject): LoadLine = LoadLine(o.getInt("lineNumber"), o.getString("productId"), o.getString("productCode"),
        o.getString("productName"), o.getString("uomCode"), base(o,"quantityScale"), nullable(o,"lotNumber"), base(o,"expectedBase"),
        if (o.isNull("actualBase")) null else base(o,"actualBase"), nullable(o,"discrepancyReason"))
    fun product(o: JSONObject): Product {
        val barcodes = strings(o.getJSONArray("barcodes"))
        // Optional (VAN-009); a cache written before it simply has no unit per barcode.
        val units = o.optJSONArray("barcodeUnits")?.let(::objects)?.map {
            BarcodeUnit(it.getString("barcode"), it.getString("uomCode"), if (it.isNull("baseQuantity")) null else base(it,"baseQuantity"))
        } ?: emptyList()
        require(units.all { it.barcode in barcodes && (it.baseQuantity == null || it.baseQuantity > 0) })
        require(units.map { it.barcode }.distinct().size == units.size)
        return Product(o.getString("productId"), o.getString("code"), o.getString("name"), o.getString("uomCode"),
            base(o,"quantityScale"), barcodes, units)
    }
    fun customer(o: JSONObject) = Customer(o.getString("outletId"), o.getString("code"), o.getString("name"), nullable(o,"address"),
        if (o.isNull("sequence")) null else o.getInt("sequence"), o.getString("source"),
        credit = o.optJSONObject("credit")?.let { CustomerCredit(it.getInt("termsDays").also { d -> require(d in 1..180) }, base(it,"availableMinor")) })
    fun decode(text: String): VanBootstrap = try {
        val o = JSONObject(text)
        VanWireSchema.validate(o)
        if (o.getString("type") != "van.bootstrap.response") throw VanWireFailure()
        val day = o.getString("serviceDate"); LocalDate.parse(day)
        val t = o.optJSONObject("trip")?.let(::trip)
        val l = o.optJSONObject("load")?.let { Load(it.getString("loadId"), it.getString("status"), objects(it.getJSONArray("lines")).map(::line)) }
        val ps = objects(o.getJSONArray("products")).map(::product)
        val cs = objects(o.getJSONArray("customers")).map(::customer)
        val stocks = objects(o.getJSONArray("truckStock")).map { TruckStock(it.getString("productId"),base(it,"availableBase"),base(it,"damagedBase")) }
        require(t == null && l == null || t != null && t.serviceDate == day)
        require(ps.all { it.quantityScale > 0 } && l?.lines?.all { it.quantityScale > 0 } != false)
        require(ps.map { it.productId }.distinct().size == ps.size && cs.map { it.outletId }.distinct().size == cs.size)
        require(stocks.map { it.productId }.distinct().size == stocks.size)
        require(l == null || l.lines.map { it.lineNumber }.distinct().size == l.lines.size)
        VanBootstrap(o.getLong("serverTime"), day, o.getJSONObject("seller").let { Seller(it.getString("profileId"),it.getString("name")) },
            policy(o.getJSONObject("policy")),t,l,stocks,ps,cs)
    } catch (_: Exception) { throw VanWireFailure() }
    fun bootstrapRequest(deviceId: String): ByteArray = JSONObject().put("type","van.bootstrap.request").put("contractVersion",1).put("deviceId",deviceId).toString().toByteArray(Charsets.UTF_8)
    /** Concatenate persisted operation JSON verbatim, never parse/re-serialize queued bytes. */
    fun pushRequest(deviceId: String, operations: List<String>): ByteArray {
        require(operations.size in 1..20)
        operations.forEach { val op = JSONObject(it); require(op.getString("kind") in setOf("trip.start","load.confirm","truck.damage")) }
        return ("{\"type\":\"van.push.request\",\"contractVersion\":1,\"deviceId\":" + JSONObject.quote(deviceId) + ",\"operations\":[" + operations.joinToString(",") + "]}").toByteArray(Charsets.UTF_8)
    }
    fun pushResults(text: String): List<PushResult> = try {
        val o = JSONObject(text); VanWireSchema.validate(o); require(o.getString("type") == "van.push.response")
        objects(o.getJSONArray("results")).map { r -> PushResult(r.getString("kind"),r.getString("clientRequestId"),r.getString("status"),
            r.optJSONObject("ack")?.let { PushAck(it.getString("entityId"),nullable(it,"movementId"),it.getLong("serverTime")) },
            if (r.has("code")) r.getString("code") else null) }
    } catch (_: Exception) { throw VanWireFailure() }
}
