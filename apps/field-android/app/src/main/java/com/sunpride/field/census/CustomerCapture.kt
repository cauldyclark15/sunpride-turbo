package com.sunpride.field.census

import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

/** SP-0170 "Add customer" (the field app's new-store flow): the agent's part of the client's
 * customer sheet (SPEC rule 10), its dependent pickers and the census.capture payload carrying the
 * contract's `customer` object. Pure logic; CensusScreen renders it. */
object CustomerCapture {
    /** Offline setup from census-config `customerMaster` (reference lists, default Sales Organization,
     * the provinces of the agent's customers whose barangays the phone keeps). */
    data class Setup(val salesOrgCode: String, val provinceCodes: List<String>, val index: CustomerMaster.ReferenceIndex) {
        fun options(list: String, salesOrgCode: String? = null, channelCode: String? = null, group1Code: String? = null) =
            index.options(list, salesOrgCode, channelCode, group1Code)
    }
    fun setup(config: JSONObject?): Setup? {
        val cm = config?.optJSONObject("customerMaster") ?: return null
        val a = cm.optJSONArray("lists") ?: return null
        val rows = (0 until a.length()).mapNotNull { a.optJSONObject(it) }.mapNotNull { o ->
            val list = o.optString("list").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val code = o.optString("code").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            CustomerMaster.RefRow(list, o.optString("salesOrgCode"), o.optString("channelCode"), o.optString("group1Code"),
                code, o.optString("name", code))
        }
        if (rows.isEmpty()) return null
        val provinces = cm.optJSONArray("provinceCodes")?.let { p -> (0 until p.length()).mapNotNull { p.opt(it) as? String } }.orEmpty()
        return Setup(cm.optString("salesOrgCode").ifEmpty { "1000" }, provinces, CustomerMaster.ReferenceIndex(rows))
    }

    /** PSGC geography kept on the phone: every region/province/municipality/postal code (one pack)
     * plus barangays for the provinces fetched so far (the agent's area, and any picked while online). */
    class Geography(val regions: List<CustomerMaster.GeoRegion>, val provinces: List<CustomerMaster.GeoProvince>,
        val municipalities: List<CustomerMaster.GeoMunicipality>, private val postal: Map<String, List<String>>,
        val barangaysByProvince: Map<String, List<CustomerMaster.GeoBarangay>> = emptyMap()) {
        private val regionBy = regions.associateBy { it.code }
        private val provinceBy = provinces.associateBy { it.code }
        private val municipalityBy = municipalities.associateBy { it.code }
        fun region(code: String?) = code?.let { regionBy[it] }
        fun province(code: String?) = code?.let { provinceBy[it] }
        fun municipality(code: String?) = code?.let { municipalityBy[it] }
        fun provincesOf(regionCode: String?): List<CustomerMaster.GeoProvince> =
            if (regionCode.isNullOrEmpty()) emptyList() else provinces.filter { it.regionCode == regionCode }.sortedBy { it.name }
        fun municipalitiesOf(provinceCode: String?): List<CustomerMaster.GeoMunicipality> =
            if (provinceCode.isNullOrEmpty()) emptyList() else municipalities.filter { it.provinceCode == provinceCode }.sortedBy { it.name }
        /** Null when this province's barangays are not on the phone yet. */
        fun barangaysOf(municipalityCode: String?): List<CustomerMaster.GeoBarangay>? {
            val m = municipality(municipalityCode) ?: return emptyList()
            return barangaysByProvince[m.provinceCode]?.filter { it.municipalityCode == m.code }?.sortedBy { it.name }
        }
        fun hasBarangays(provinceCode: String?) = provinceCode != null && barangaysByProvince.containsKey(provinceCode)
        fun postalCodesOf(municipalityCode: String?): List<String> = municipalityCode?.let { postal[it] }.orEmpty()
        fun barangay(municipalityCode: String?, code: String?): CustomerMaster.GeoBarangay? =
            code?.let { c -> barangaysOf(municipalityCode)?.firstOrNull { it.code == c } }
        fun withBarangays(provinceCode: String, rows: List<CustomerMaster.GeoBarangay>) =
            Geography(regions, provinces, municipalities, postal, barangaysByProvince + (provinceCode to rows))
        fun resolve(f: Form): CustomerMaster.ResolvedGeography = CustomerMaster.ResolvedGeography(region(f.regionCode),
            province(f.provinceCode), municipality(f.municipalityCode), barangay(f.municipalityCode, f.barangayCode),
            postalCodesOf(f.municipalityCode))
        companion object {
            /** GET /api/v1/geography/pack. */
            fun parse(pack: JSONObject): Geography {
                fun rows(key: String) = pack.optJSONArray(key)?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
                val postal = linkedMapOf<String, MutableList<String>>()
                rows("postalCodes").forEach { postal.getOrPut(it.optString("municipalityCode")) { mutableListOf() } += it.optString("code") }
                return Geography(rows("regions").map { CustomerMaster.GeoRegion(it.getString("code"), it.getString("name")) },
                    rows("provinces").map { CustomerMaster.GeoProvince(it.getString("code"), it.getString("name"), it.getString("regionCode")) },
                    rows("municipalities").map { CustomerMaster.GeoMunicipality(it.getString("code"), it.getString("name"), it.getString("provinceCode")) },
                    postal.mapValues { (_, v) -> v.distinct() })
            }
            /** GET /api/v1/geography/pack/barangays?provinceCode=. */
            fun barangays(json: JSONObject): List<CustomerMaster.GeoBarangay> = json.optJSONArray("barangays")?.let { a ->
                (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map {
                    CustomerMaster.GeoBarangay(it.getString("code"), it.getString("name"), it.getString("municipalityCode")) }
            }.orEmpty()
        }
    }

    /** What the agent typed and picked. Codes are "" until chosen. */
    data class Form(
        val registeredName: String = "", val tradeName: String = "", val customerName: String = "", val email: String = "",
        val mobileNo: String = "", val telNo: String = "", val tin: String = "",
        val regionCode: String = "", val provinceCode: String = "", val municipalityCode: String = "", val barangayCode: String = "",
        val houseNo: String = "", val street1: String = "", val street2: String = "", val floor: String = "", val roomStallNo: String = "",
        val postalCode: String = "",
        val salesOrgCode: String = "", val distributionChannelCode: String = "", val customerGroup1Code: String = "",
        val customerGroup2Code: String = "", val customerGroupCode: String = "", val typeOfBusiness: String = "",
        val contactPerson: String = "",
        /** SP-0184: the remaining sheet fields, keyed by CustomerMaster (including conditional ADP). */
        val details: Map<String, String> = emptyMap(),
        val sameAsCustomer: Boolean = true, val shipToParty: String = "", val shipToAddress: String = "",
        val shipToMobileNo: String = "", val shipToEmail: String = "",
    ) {
        fun detail(key: String): String = details[key] ?: if (key == "countryCode") "PH" else ""
        fun withDetail(key: String, value: String) = copy(details = details + (key to value))
        private fun withoutAdp() = details.filterKeys { key -> CustomerMaster.CUSTOMER_FIELDS.none { it.key == key && it.adp } }
        // Dependent pickers: a new parent clears every child chosen under the old one.
        fun withRegion(code: String) = if (code == regionCode) this else copy(regionCode = code, provinceCode = "", municipalityCode = "", barangayCode = "", postalCode = "")
        fun withProvince(code: String) = if (code == provinceCode) this else copy(provinceCode = code, municipalityCode = "", barangayCode = "", postalCode = "")
        /** A municipality with one postal code fills it in. */
        fun withMunicipality(code: String, geography: Geography?) = if (code == municipalityCode) this else
            copy(municipalityCode = code, barangayCode = "", postalCode = geography?.postalCodesOf(code)?.singleOrNull().orEmpty())
        fun withSalesOrg(code: String) = if (code == salesOrgCode) this else copy(salesOrgCode = code, distributionChannelCode = "", customerGroup1Code = "", customerGroup2Code = "",
            details = withoutAdp() - setOf("salesOfficeCode", "deliveringPlantCode"))
        fun withChannel(code: String) = if (code == distributionChannelCode) this else copy(distributionChannelCode = code, customerGroup1Code = "", customerGroup2Code = "", details = withoutAdp())
        fun withGroup1(code: String) = if (code == customerGroup1Code) this else copy(customerGroup1Code = code, customerGroup2Code = "")
        /** The customer-object values (contract §1 keys), blank ones left out. */
        fun values(): LinkedHashMap<String, String> = linkedMapOf(
            "registeredName" to registeredName, "tradeName" to tradeName, "customerName" to customerName, "email" to email,
            "mobileNo" to mobileNo, "telNo" to telNo, "tin" to tin, "regionCode" to regionCode, "provinceCode" to provinceCode,
            "municipalityCode" to municipalityCode, "barangayCode" to barangayCode, "houseNo" to houseNo, "street1" to street1,
            "street2" to street2, "floor" to floor, "roomStallNo" to roomStallNo, "postalCode" to postalCode,
            "salesOrgCode" to salesOrgCode, "distributionChannelCode" to distributionChannelCode,
            "customerGroup1Code" to customerGroup1Code, "customerGroup2Code" to customerGroup2Code,
            "customerGroupCode" to customerGroupCode, "typeOfBusiness" to typeOfBusiness,
        ).also { out ->
            out["countryCode"] = detail("countryCode")
            for (field in CustomerMaster.CUSTOMER_FIELDS) {
                if (field.key in details && (!field.adp || distributionChannelCode == CustomerMaster.ADP_CHANNEL))
                    out[field.key] = details.getValue(field.key)
            }
        }.mapValuesTo(linkedMapOf()) { it.value.trim() }.filterValues { it.isNotEmpty() }.toMap(linkedMapOf())
    }

    /** SP-0176: the unsaved Add customer form kept on the phone (survives Back and an app restart) until it is
     * saved or discarded: every typed/picked value, the GPS fix and the storefront photo. */
    data class Draft(val form: Form, val fix: JSONObject?, val photo: ByteArray?) {
        /** Nothing typed yet (the defaulted Sales Organization and a name carried from the search do not count). */
        fun isEmpty() = fix == null && photo == null && form.contactPerson.isBlank() && form.sameAsCustomer &&
            listOf(form.shipToParty, form.shipToAddress, form.shipToMobileNo, form.shipToEmail).all { it.isBlank() } &&
            form.values().all { (key, value) -> key == "salesOrgCode" || key == "customerName" || (key == "countryCode" && value == "PH") }
    }
    fun draftJson(d: Draft): String {
        val values = JSONObject(); d.form.values().forEach { (k, v) -> values.put(k, v) }
        if (d.form.contactPerson.isNotBlank()) values.put("contactPerson", d.form.contactPerson)
        val o = JSONObject().put("version", 1).put("form", values)
            .put("details", JSONObject(d.form.details)).put("sameAsCustomer", d.form.sameAsCustomer)
            .put("shipToParty", d.form.shipToParty).put("shipToAddress", d.form.shipToAddress)
            .put("shipToMobileNo", d.form.shipToMobileNo).put("shipToEmail", d.form.shipToEmail)
        d.fix?.let { o.put("fix", JSONObject(it.toString())) }
        d.photo?.let { o.put("photo", java.util.Base64.getEncoder().encodeToString(it)) }
        return o.toString()
    }
    fun parseDraft(text: String?): Draft? = runCatching {
        val o = JSONObject(text ?: return null); if (o.optInt("version") != 1) return null
        val v = o.getJSONObject("form"); fun g(k: String) = v.optString(k, "")
        val form = Form(registeredName = g("registeredName"), tradeName = g("tradeName"), customerName = g("customerName"),
            email = g("email"), mobileNo = g("mobileNo"), telNo = g("telNo"), tin = g("tin"), regionCode = g("regionCode"),
            provinceCode = g("provinceCode"), municipalityCode = g("municipalityCode"), barangayCode = g("barangayCode"),
            houseNo = g("houseNo"), street1 = g("street1"), street2 = g("street2"), floor = g("floor"), roomStallNo = g("roomStallNo"),
            postalCode = g("postalCode"), salesOrgCode = g("salesOrgCode"), distributionChannelCode = g("distributionChannelCode"),
            customerGroup1Code = g("customerGroup1Code"), customerGroup2Code = g("customerGroup2Code"),
            customerGroupCode = g("customerGroupCode"), typeOfBusiness = g("typeOfBusiness"), contactPerson = g("contactPerson"),
            details = o.optJSONObject("details")?.let { d -> CustomerMaster.CUSTOMER_FIELDS.filter { d.has(it.key) }
                .associate { it.key to d.optString(it.key, "") } }.orEmpty(),
            sameAsCustomer = o.optBoolean("sameAsCustomer", true), shipToParty = o.optString("shipToParty"),
            shipToAddress = o.optString("shipToAddress"), shipToMobileNo = o.optString("shipToMobileNo"), shipToEmail = o.optString("shipToEmail"))
        Draft(form, o.optJSONObject("fix"), o.optString("photo").takeIf { it.isNotEmpty() }?.let { java.util.Base64.getDecoder().decode(it) })
    }.getOrNull()

    /** The agent's form starts with the Sales Organization of their assignment. */
    fun start(setup: Setup?, customerName: String = ""): Form = Form(customerName = customerName.take(200),
        salesOrgCode = setup?.salesOrgCode?.takeIf { code -> setup.options("sales_organization").any { it.code == code } }.orEmpty())

    /** Customer Address, built from the location parts (same rule as the server). */
    fun address(f: Form, g: Geography?): String = f.detail("customerAddress").trim().ifEmpty { CustomerMaster.formatAddress(f.roomStallNo, f.floor, f.houseNo, f.street1, f.street2,
        g?.barangay(f.municipalityCode, f.barangayCode)?.name, g?.municipality(f.municipalityCode)?.name,
        g?.province(f.provinceCode)?.name, f.postalCode).orEmpty() }

    data class Option(val code: String, val label: String)
    fun refOptions(rows: List<CustomerMaster.RefRow>) = rows.distinctBy { it.code }.map { Option(it.code, CustomerMaster.optionLabel(it)) }
    fun salesOrgs(s: Setup) = refOptions(s.options("sales_organization"))
    fun channels(s: Setup, f: Form) = if (f.salesOrgCode.isEmpty()) emptyList() else refOptions(s.options("distribution_channel", f.salesOrgCode))
    fun group1s(s: Setup, f: Form) = if (f.distributionChannelCode.isEmpty()) emptyList()
        else refOptions(s.options("customer_group_1", f.salesOrgCode, f.distributionChannelCode))
    fun group2s(s: Setup, f: Form) = if (f.customerGroup1Code.isEmpty()) emptyList()
        else refOptions(s.options("customer_group_2", f.salesOrgCode, f.distributionChannelCode, f.customerGroup1Code))
    fun customerGroups(s: Setup) = refOptions(s.options("customer_group"))
    fun typesOfBusiness(s: Setup) = refOptions(s.options("type_of_business"))
    /** Rule 6: whether Customer Grp 1 / Grp 2 apply to the chosen chain (null = choose the channel first). */
    fun applicability(s: Setup, f: Form) = CustomerMaster.applicability(s.index, f.salesOrgCode, f.distributionChannelCode,
        f.customerGroup1Code.ifEmpty { null })

    /** A field Save found missing, in form order; [key] matches the contract key ("photo" for the storefront photo). */
    data class Missing(val key: String, val message: String)
    /** SP-0184: all required sheet fields before submission, including conditional ADP and ship-to.
     * Missing offline geography must be downloaded, not deferred to an Admin to complete. */
    fun missing(f: Form, s: Setup?, g: Geography?, hasFix: Boolean, hasPhoto: Boolean): List<Missing> = buildList {
        val values = f.values()
        val app = s?.let { applicability(it, f) }
        for (key in CustomerMaster.FIELD_CAPTURE) {
            val field = CustomerMaster.field(key)
            if (!field.required || key == "customerAddress" || (field.adp && f.distributionChannelCode != CustomerMaster.ADP_CHANNEL)) continue
            if (key == "customerGroup1Code" && app?.group1 == false) continue
            if (key == "customerGroup2Code" && (app?.group1 == false || app?.group2 == false)) continue
            if (key == "coordinates") {
                if (!hasFix) add(Missing(key, "Tap Use my location to set the ${label(key)}."))
            } else if (values[key].isNullOrBlank()) {
                val download = if (key == "barangayCode" && g?.barangaysOf(f.municipalityCode) == null)
                    " Connect once to download this province's barangays." else ""
                add(Missing(key, "${label(key)} is required.$download"))
            }
        }
        val ship = shipTo(f, g)
        for (field in CustomerMaster.SHIP_TO_FIELDS.filter { it.required }) {
            if (f.sameAsCustomer && field.key != "contactPerson") continue
            val key = if (field.key == "mobileNo") "shipToMobileNo" else field.key
            if ((ship[field.key] as? String).isNullOrBlank()) add(Missing(key, "${label(key)} is required."))
        }
        if (!hasPhoto) add(Missing("photo", "Take a storefront photo."))
    }
    fun label(key: String): String = when (key) {
        "contactPerson", "shipToParty", "shipToAddress" -> CustomerMaster.shipToField(key).label
        "shipToMobileNo" -> CustomerMaster.shipToField("mobileNo").label
        "shipToEmail" -> CustomerMaster.shipToField("email").label
        else -> CustomerMaster.field(key).label
    }
    fun formLabel(key: String): String {
        val field = when (key) {
            "contactPerson", "shipToParty", "shipToAddress" -> CustomerMaster.shipToField(key)
            "shipToMobileNo" -> CustomerMaster.shipToField("mobileNo")
            "shipToEmail" -> CustomerMaster.shipToField("email")
            else -> CustomerMaster.field(key)
        }
        return field.label + if (field.required) " *" else ""
    }
    fun shipTo(f: Form, g: Geography?): Map<String, Any?> = linkedMapOf(
        "sameAsCustomer" to f.sameAsCustomer,
        "shipToParty" to if (f.sameAsCustomer) f.customerName.trim() else f.shipToParty.trim(),
        "shipToAddress" to if (f.sameAsCustomer) address(f, g) else f.shipToAddress.trim(),
        "contactPerson" to f.contactPerson.trim(),
        "mobileNo" to if (f.sameAsCustomer) f.mobileNo.trim() else f.shipToMobileNo.trim(),
        "email" to if (f.sameAsCustomer) f.email.trim() else f.shipToEmail.trim(),
    )

    /** The shared draft rules (formats, lists, dependencies), as the server checks them. */
    fun draftErrors(f: Form, s: Setup, g: Geography?, latitude: Double?, longitude: Double?): List<CustomerMaster.Error> {
        val input = HashMap<String, Any?>(f.values()); input["latitude"] = latitude; input["longitude"] = longitude
        input["shipTos"] = listOf(shipTo(f, g))
        return CustomerMaster.validate(input, "draft", s.index, g?.resolve(f)).errors.map { error ->
            val key = when (error.field) {
                "shipTos[0].mobileNo" -> if (f.sameAsCustomer) "mobileNo" else "shipToMobileNo"
                "shipTos[0].email" -> if (f.sameAsCustomer) "email" else "shipToEmail"
                else -> error.field.removePrefix("shipTos[0].")
            }
            error.copy(field = key)
        }.distinctBy { it.field }
    }

    /** The contract's `customer` object: the agent's fields with the built Customer Address. */
    fun customer(f: Form, g: Geography?): JSONObject {
        val o = JSONObject()
        f.values().forEach { (k, v) -> o.put(k, v) }
        address(f, g).takeIf { it.isNotEmpty() }?.let { o.put("customerAddress", it) }
        o.put("shipTos", JSONArray().put(JSONObject(shipTo(f, g))))
        return o
    }

    /** census.capture payload for a new customer (server: field enrolment + draft customer profile). */
    fun payload(captureId: String, f: Form, g: Geography?, deviceTime: Long, gpsFix: JSONObject, photo: String,
        acknowledged: List<String> = emptyList()): JSONObject {
        val customer = customer(f, g)
        val p = JSONObject().put("captureId", captureId).put("name", f.customerName.trim())
            .put("address", customer.optString("customerAddress").ifEmpty { f.customerName.trim() })
            .put("ownerName", f.contactPerson.trim()).put("ownerPhone", f.mobileNo.trim()).put("deviceTime", deviceTime)
            .put("locationSource", "gps").put("location", gpsFix).put("photoJpegBase64", photo).put("customer", customer)
        if (acknowledged.isNotEmpty()) p.put("acknowledgedDuplicateIds", JSONArray(acknowledged.distinct().take(10)))
        return p
    }

    private val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
    /** Outbox check of a new-customer capture (no reference lists needed: formats only; the server checks lists). */
    fun validate(p: JSONObject) {
        require(uuid.matches(p.getString("captureId"))) { "Open Add customer again." }
        val c = p.getJSONObject("customer")
        val allowed = CustomerMaster.CUSTOMER_FIELDS.map { it.key }.toSet() + "shipTos"
        c.keys().forEach { k -> require(k in allowed) { "Unknown customer field $k." } }
        require(p.getString("name").trim().length in 1..200) { "Customer Name is required." }
        require(p.getString("address").trim().length in 1..500) { "Customer Address is required." }
        require(p.getString("ownerName").trim().length in 1..150) { "Contact Person is required." }
        val input = HashMap<String, Any?>(); c.keys().forEach { input[it] = if (c.isNull(it)) null else c.get(it) }
        c.optJSONArray("shipTos")?.let { a ->
            require(a.length() in 1..20) { "Add a ship-to." }
            input["shipTos"] = (0 until a.length()).map { i -> val ship = a.getJSONObject(i)
                val keys = CustomerMaster.SHIP_TO_FIELDS.map { it.key }.toSet() + "sameAsCustomer"
                require(ship.keys().asSequence().all { it in keys }) { "Unknown ship-to field." }
                ship.keys().asSequence().associateWith { if (ship.isNull(it)) null else ship.get(it) }
            }
        }
        val location = p.getJSONObject("location")
        input["latitude"] = location.getDouble("latitude"); input["longitude"] = location.getDouble("longitude")
        val errors = CustomerMaster.validate(input, "field", CustomerMaster.ReferenceIndex(emptyList()), null).errors
            // Reference lists are unavailable here; the form and server check conditional groups.
            .filter { it.code !in setOf("invalid_option", "not_for_sales_org", "not_for_channel", "not_for_group1", "not_applicable", "choose_parent_first") &&
                !(it.code == "required" && it.field in setOf("customerGroup1Code", "customerGroup2Code")) }
        require(errors.isEmpty()) { errors.first().message }
        val at = p.getLong("deviceTime"); val l = p.getJSONObject("location")
        require(l.getDouble("latitude").isFinite() && l.getDouble("latitude") in -90.0..90.0)
        require(l.getDouble("longitude").isFinite() && l.getDouble("longitude") in -180.0..180.0)
        require(p.optString("locationSource", "gps") == "gps" && l.getDouble("accuracyMeters") > 0 && l.getDouble("accuracyMeters") < 50 &&
            !l.getBoolean("mockSignal") && l.getString("provider") in listOf("gps", "fused", "network") &&
            kotlin.math.abs(at - l.getLong("fixTime")) <= 120_000) { "Get a fresh GPS fix with accuracy under 50 m. Mock locations cannot be used." }
        val photo = Base64.getDecoder().decode(p.getString("photoJpegBase64"))
        require(photo.size in 4..CensusRules.MAX_PHOTO_BYTES && photo[0] == 0xff.toByte() && photo[1] == 0xd8.toByte() &&
            photo[photo.size - 2] == 0xff.toByte() && photo.last() == 0xd9.toByte()) { "Take a storefront photo." }
    }
}
