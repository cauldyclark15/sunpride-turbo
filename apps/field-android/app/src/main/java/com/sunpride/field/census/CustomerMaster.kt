package com.sunpride.field.census

/** SP-0170: Kotlin port of `@sunpride/customer-master` (packages/customer-master/src) for the
 * field app's "Add customer" form. The client's fields in the order of Sunpride's "Customer
 * Information template", with their exact labels, and the same validation (draft or complete).
 * CustomerMasterParityTest checks every field, label and rule against the JS package through
 * packages/customer-master/fixtures/android-parity.json. Keep both in step. */
object CustomerMaster {
    enum class Kind(val wire: String) { TEXT("text"), LIST("list"), GEO("geo"), COORDINATES("coordinates"), MONEY("money"),
        EMAIL("email"), MOBILE("mobile"), TIN("tin") }
    data class Field(val key: String, val label: String, val section: String, val required: Boolean, val kind: Kind,
        val list: String? = null, val max: Int? = null, val shipTo: Boolean = false, val adp: Boolean = false)

    const val GENERAL = "Customer General Information"
    const val LOCATION = "Customer Location"
    const val ASSIGNMENT = "Customer Assignment"
    const val PAYMENT = "Payment Arrangement"
    const val DELIVERY = "Delivery Arrangement"
    const val ADP = "ADP Specific"
    val SECTIONS = listOf(GENERAL, LOCATION, ASSIGNMENT, PAYMENT, DELIVERY, ADP)
    /** Distribution Channel 40 (Distributive Trade) is the only channel with the ADP block. */
    const val ADP_CHANNEL = "40"

    private fun f(key: String, label: String, section: String, required: Boolean, kind: Kind, list: String? = null,
        max: Int? = null, shipTo: Boolean = false, adp: Boolean = false) = Field(key, label, section, required, kind, list, max, shipTo, adp)
    private fun adp(key: String, label: String, max: Int) = f(key, label, ADP, true, Kind.TEXT, max = max, adp = true)

    val FIELDS: List<Field> = listOf(
        f("registeredName", "Registered Name", GENERAL, true, Kind.TEXT, max = 200),
        f("tradeName", "Trade Name", GENERAL, false, Kind.TEXT, max = 200),
        f("customerName", "Customer Name", GENERAL, true, Kind.TEXT, max = 200),
        f("customerAddress", "Customer Address", GENERAL, true, Kind.TEXT, max = 500),
        f("email", "Email Address", GENERAL, false, Kind.EMAIL, max = 200),
        f("mobileNo", "Mobile No.", GENERAL, true, Kind.MOBILE),
        f("telNo", "Tel. No.", GENERAL, false, Kind.TEXT, max = 40),
        f("tin", "TIN number", GENERAL, false, Kind.TIN),
        f("taxClassificationCode", "Tax Classification", GENERAL, true, Kind.LIST, "tax_classification"),
        f("countryCode", "Country", LOCATION, true, Kind.LIST, "country"),
        f("regionCode", "Region", LOCATION, true, Kind.GEO),
        f("provinceCode", "Province", LOCATION, true, Kind.GEO),
        f("municipalityCode", "Municipality", LOCATION, true, Kind.GEO),
        f("barangayCode", "Barangay", LOCATION, true, Kind.GEO),
        f("houseNo", "House No.", LOCATION, false, Kind.TEXT, max = 60),
        f("street1", "Street 1", LOCATION, false, Kind.TEXT, max = 200),
        f("street2", "Street 2", LOCATION, false, Kind.TEXT, max = 200),
        f("floor", "Floor", LOCATION, false, Kind.TEXT, max = 60),
        f("roomStallNo", "Room No. / Stall No.", LOCATION, false, Kind.TEXT, max = 60),
        f("postalCode", "Postal Code", LOCATION, true, Kind.GEO),
        f("coordinates", "Geographical Coordinates", LOCATION, true, Kind.COORDINATES),
        f("salesOrgCode", "Sales Organization", ASSIGNMENT, true, Kind.LIST, "sales_organization"),
        f("salesOfficeCode", "Sales Office", ASSIGNMENT, true, Kind.LIST, "sales_office"),
        f("distributionChannelCode", "Distribution Channel", ASSIGNMENT, true, Kind.LIST, "distribution_channel"),
        f("customerGroup1Code", "Customer Grp 1", ASSIGNMENT, true, Kind.LIST, "customer_group_1"),
        f("customerGroup2Code", "Customer Grp 2", ASSIGNMENT, true, Kind.LIST, "customer_group_2"),
        f("customerGroupCode", "Customer Group", ASSIGNMENT, true, Kind.LIST, "customer_group"),
        f("typeOfBusiness", "Type of Business", ASSIGNMENT, true, Kind.LIST, "type_of_business"),
        f("salesPartnerCode", "Sales Partner", ASSIGNMENT, false, Kind.LIST, "sales_partner"),
        f("paymentTermsCode", "Terms of payment", PAYMENT, true, Kind.LIST, "payment_terms"),
        f("creditLimit", "Credit Limit", PAYMENT, false, Kind.MONEY),
        f("pricingProcedureCode", "Customer Pricing Procedure", PAYMENT, true, Kind.LIST, "pricing_procedure"),
        f("deliveringPlantCode", "Delivering Plant", DELIVERY, true, Kind.LIST, "delivering_plant"),
        f("shipToParty", "Ship-to Party", DELIVERY, true, Kind.TEXT, max = 200, shipTo = true),
        f("shipToAddress", "Ship-to Address", DELIVERY, true, Kind.TEXT, max = 500, shipTo = true),
        f("contactPerson", "Contact Person", DELIVERY, true, Kind.TEXT, max = 200, shipTo = true),
        f("mobileNo", "Mobile No.", DELIVERY, true, Kind.MOBILE, shipTo = true),
        f("email", "Email Address", DELIVERY, false, Kind.EMAIL, max = 200, shipTo = true),
        adp("distributorCode", "Distributor Code", 60),
        adp("distributorName", "Distributor Name", 200),
        adp("distributorCustomerCode", "Distributor Customer Code", 60),
        adp("distributionMode", "Distribution Mode", 100),
        adp("subDistributorCode", "Sub-Distributor Code", 60),
        adp("subDistributorName", "Sub-Distributor Name", 200),
        adp("distributorSalesman", "Distributor Salesman", 200),
        adp("distributorSalesmanCode", "Distributor Salesman Code", 60),
        adp("truckServing", "Truck Serving", 200),
        adp("truckCode", "Truck Code", 60),
        adp("distributorHub", "Distributor Hub", 200),
        adp("clusterNo", "Cluster #", 60),
        adp("clusterName", "Cluster Name", 200),
    )
    val CUSTOMER_FIELDS = FIELDS.filter { !it.shipTo }
    val SHIP_TO_FIELDS = FIELDS.filter { it.shipTo }
    fun field(key: String): Field = CUSTOMER_FIELDS.first { it.key == key }
    fun shipToField(key: String): Field = SHIP_TO_FIELDS.first { it.key == key }

    /** SPEC rule 10: what the field agent fills on "Add customer", in sheet order (the office
     * completes Tax, Sales Office, Payment, Delivery, Pricing and Delivering Plant). Customer Address
     * is built from the location parts; Contact Person is the ship-to contact (contract §6). */
    val FIELD_CAPTURE: List<String> = listOf(
        "registeredName", "tradeName", "customerName", "customerAddress", "email", "mobileNo", "telNo", "tin",
        "regionCode", "provinceCode", "municipalityCode", "barangayCode", "houseNo", "street1", "street2", "floor",
        "roomStallNo", "postalCode", "coordinates",
        "salesOrgCode", "distributionChannelCode", "customerGroup1Code", "customerGroup2Code", "customerGroupCode", "typeOfBusiness",
    )
    /** Ship-to field the agent fills (Contact Person of the "same as customer" ship-to). */
    val FIELD_CAPTURE_SHIP_TO: List<String> = listOf("contactPerson")

    data class RefRow(val list: String, val salesOrgCode: String, val channelCode: String, val group1Code: String,
        val code: String, val name: String)

    /** "Description (Code)" — how every dropdown shows an option. */
    fun optionLabel(code: String, name: String): String = if (code == name) name else "$name ($code)"
    fun optionLabel(row: RefRow): String = optionLabel(row.code, row.name)

    class ReferenceIndex(rows: List<RefRow>) {
        private val byList: Map<String, List<RefRow>> = rows.groupBy { it.list }
        fun all(list: String): List<RefRow> = byList[list].orEmpty()
        /** Rows of [list] under the given parents; a null parent does not filter, a blank row parent matches any. */
        fun options(list: String, salesOrgCode: String? = null, channelCode: String? = null, group1Code: String? = null): List<RefRow> =
            all(list).filter { r ->
                (salesOrgCode == null || r.salesOrgCode == "" || r.salesOrgCode == salesOrgCode) &&
                    (channelCode == null || r.channelCode == "" || r.channelCode == channelCode) &&
                    (group1Code == null || r.group1Code == "" || r.group1Code == group1Code)
            }
        val isEmpty: Boolean get() = byList.isEmpty()
    }

    /** Which dependent fields apply (SPEC rules 5/6): null = not decided yet (no valid channel). */
    data class Applicability(val group1: Boolean?, val group2: Boolean?, val adp: Boolean)
    fun applicability(index: ReferenceIndex, salesOrgCode: String?, channelCode: String?, group1Code: String?): Applicability {
        val org = text(salesOrgCode); val ch = text(channelCode); val g1 = text(group1Code)
        val channelValid = org != null && ch != null && index.options("distribution_channel", org).any { it.code == ch }
        val group1 = if (channelValid) index.options("customer_group_1", org, ch).isNotEmpty() else null
        val group2 = if (channelValid) index.options("customer_group_2", org, ch, g1).isNotEmpty() else null
        return Applicability(group1, group2, ch == ADP_CHANNEL)
    }

    fun text(v: Any?): String? = when (v) {
        null -> null
        is String -> v.trim().takeIf { it.isNotEmpty() }
        is Number -> numberText(v)
        else -> v.toString().trim().takeIf { it.isNotEmpty() }
    }
    private fun numberText(n: Number): String {
        val d = n.toDouble()
        return if (d == Math.floor(d) && !d.isInfinite() && kotlin.math.abs(d) < 1e15) d.toLong().toString() else d.toString()
    }
    private fun blank(v: Any?): Boolean = v == null || (v is String && v.trim().isEmpty())

    /** TIN: ###-###-### or ###-###-###-### (branch code); digits-only accepted. Dashed form or null. */
    fun normalizeTin(v: Any?): String? {
        val s = text(v) ?: return null
        if (!Regex("^[0-9-\\s]+$").matches(s)) return null
        val d = s.replace(Regex("[-\\s]"), "")
        if (d.length != 9 && d.length != 12) return null
        if (s.contains('-') && !Regex("^\\d{3}-\\d{3}-\\d{3}(-\\d{3})?$").matches(s.replace(Regex("\\s"), ""))) return null
        return d.chunked(3).joinToString("-")
    }
    /** PH mobile: 09XXXXXXXXX or +639XXXXXXXXX (spaces/dashes ignored). Stored as 09XXXXXXXXX. */
    fun normalizePhMobile(v: Any?): String? {
        val s = text(v) ?: return null
        val compact = s.replace(Regex("[\\s-]"), "")
        if (Regex("^09\\d{9}$").matches(compact)) return compact
        if (Regex("^\\+639\\d{9}$").matches(compact)) return "0" + compact.substring(3)
        return null
    }
    fun normalizeEmail(v: Any?): String? {
        val s = text(v) ?: return null
        return if (Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$").matches(s) && s.length <= 200) s.lowercase() else null
    }

    /** One-line Customer Address from the location parts (same rule as the JS formatAddress and SQL). */
    fun formatAddress(roomStallNo: String? = null, floor: String? = null, houseNo: String? = null, street1: String? = null,
        street2: String? = null, barangayName: String? = null, municipalityName: String? = null, provinceName: String? = null,
        postalCode: String? = null): String? {
        fun join(parts: List<String?>, sep: String) = parts.mapNotNull { text(it) }.joinToString(sep)
        return join(listOf(roomStallNo, floor, join(listOf(houseNo, street1), " "), street2, barangayName, municipalityName,
            join(listOf(provinceName, postalCode), " ")), ", ").ifEmpty { null }
    }

    data class GeoRegion(val code: String, val name: String)
    data class GeoProvince(val code: String, val name: String, val regionCode: String)
    data class GeoMunicipality(val code: String, val name: String, val provinceCode: String)
    data class GeoBarangay(val code: String, val name: String, val municipalityCode: String)
    /** The chosen PSGC codes resolved with their parents (null = code unknown). */
    data class ResolvedGeography(val region: GeoRegion?, val province: GeoProvince?, val municipality: GeoMunicipality?,
        val barangay: GeoBarangay?, val postalCodes: List<String>)

    data class Error(val code: String, val field: String, val label: String, val section: String, val message: String)
    data class Result(val ok: Boolean, val level: String, val errors: List<Error>, val value: Map<String, Any?>)

    /** Same as JS validateCustomer: `draft` = formats, list membership and dependencies of whatever is
     * filled (only Customer Name required); `complete` = every required field with rules 5/6. */
    fun validate(input: Map<String, Any?>, level: String, index: ReferenceIndex, geography: ResolvedGeography?): Result {
        val errors = mutableListOf<Error>()
        val value = linkedMapOf<String, Any?>()
        fun fail(code: String, f: Field, message: String, i: Int? = null) {
            errors += Error(code, if (i == null) f.key else "shipTos[$i].${f.key}", f.label, f.section, message)
        }
        val app = applicability(index, text(input["salesOrgCode"]), text(input["distributionChannelCode"]), text(input["customerGroup1Code"]))
        fun isRequired(f: Field): Boolean {
            if (level == "draft") return f.key == "customerName"
            if (!f.required) return false
            if (f.adp) return app.adp
            if (f.key == "customerGroup1Code") return app.group1 != false
            if (f.key == "customerGroup2Code") return app.group1 != false && app.group2 != false
            return true
        }
        fun scalar(f: Field, raw: Any?, i: Int? = null): Any? {
            if (blank(raw)) {
                if (isRequired(f)) fail("required", f, "${f.label} is required.", i)
                return null
            }
            when (f.kind) {
                Kind.MONEY -> {
                    val n = (raw as? Number)?.toDouble() ?: raw.toString().replace(",", "").trim().toDoubleOrNull()
                    if (n == null || !n.isFinite() || n < 0 || n > 999999999999.99) {
                        fail("invalid_credit_limit", f, "${f.label} must be a number of 0 or more.", i); return null
                    }
                    return Math.round(n * 100) / 100.0
                }
                Kind.TIN -> return normalizeTin(raw).also { if (it == null)
                    fail("invalid_tin", f, "${f.label} must be ###-###-### or ###-###-###-### (digits only also accepted).", i) }
                Kind.MOBILE -> return normalizePhMobile(raw).also { if (it == null)
                    fail("invalid_mobile", f, "${f.label} must be a Philippine mobile number: 09XXXXXXXXX or +639XXXXXXXXX.", i) }
                Kind.EMAIL -> return normalizeEmail(raw).also { if (it == null) fail("invalid_email", f, "${f.label} is not a valid email address.", i) }
                else -> {
                    val v = text(raw)!!
                    if (f.max != null && v.length > f.max) {
                        fail("too_long", f, "${f.label} must be ${f.max} characters or fewer.", i); return v.take(f.max)
                    }
                    return v
                }
            }
        }
        for (f in CUSTOMER_FIELDS) {
            if (f.kind == Kind.LIST || f.kind == Kind.GEO) {
                val v = text(input[f.key])
                if (v == null && isRequired(f)) fail("required", f, "${f.label} is required.")
                value[f.key] = v; continue
            }
            if (f.kind == Kind.COORDINATES) continue
            value[f.key] = scalar(f, input[f.key])
        }
        fun member(key: String, parent: Map<String, String?>? = null, parentCode: String? = null, parentField: Field? = null) {
            val f = field(key); val v = value[key] as String? ?: return
            if (parentField != null && parent != null && parent.values.any { it.isNullOrEmpty() }) {
                fail("choose_parent_first", f, "Choose ${parentField.label} before ${f.label}."); return
            }
            if (index.all(f.list!!).none { it.code == v }) { fail("invalid_option", f, "${f.label} \"$v\" is not in the list."); return }
            if (parent != null && index.options(f.list, parent["salesOrgCode"], parent["channelCode"], parent["group1Code"]).none { it.code == v })
                fail(parentCode ?: "not_for_sales_org", f, when (parentCode) {
                    "not_for_channel" -> "${f.label} \"$v\" is not under Distribution Channel ${parent["channelCode"]}."
                    "not_for_group1" -> "${f.label} \"$v\" is not under Customer Grp 1 ${parent["group1Code"]}."
                    else -> "${f.label} \"$v\" is not available for Sales Organization ${parent["salesOrgCode"]}."
                })
        }
        val salesOrgCode = value["salesOrgCode"] as String?
        val channelCode = value["distributionChannelCode"] as String?
        val group1Code = value["customerGroup1Code"] as String?
        for (key in listOf("taxClassificationCode", "countryCode", "salesOrgCode", "customerGroupCode", "typeOfBusiness",
            "salesPartnerCode", "paymentTermsCode", "pricingProcedureCode")) member(key)
        val org = field("salesOrgCode")
        for (key in listOf("salesOfficeCode", "distributionChannelCode", "deliveringPlantCode"))
            member(key, mapOf("salesOrgCode" to salesOrgCode), "not_for_sales_org", org)
        if (group1Code != null && app.group1 == false)
            fail("not_applicable", field("customerGroup1Code"), "Customer Grp 1 does not apply to Distribution Channel $channelCode.")
        else member("customerGroup1Code", mapOf("salesOrgCode" to salesOrgCode, "channelCode" to channelCode), "not_for_channel",
            field("distributionChannelCode"))
        val group1Valid = group1Code != null && index.options("customer_group_1", salesOrgCode, channelCode).any { it.code == group1Code }
        if (value["customerGroup2Code"] != null && (app.group1 == false || (group1Valid && app.group2 == false)))
            fail("not_applicable", field("customerGroup2Code"),
                "Customer Grp 2 does not apply to Customer Grp 1 ${group1Code ?: ""}.".replace(" .", "."))
        else member("customerGroup2Code", mapOf("salesOrgCode" to salesOrgCode, "channelCode" to channelCode, "group1Code" to group1Code),
            "not_for_group1", field("customerGroup1Code"))

        val region = field("regionCode"); val province = field("provinceCode"); val municipality = field("municipalityCode")
        val barangay = field("barangayCode"); val postal = field("postalCode")
        val postalCode = value["postalCode"] as String?
        val fourDigits = Regex("^\\d{4}$")
        if (geography != null) {
            val g = geography
            if (value["regionCode"] != null && g.region == null) fail("invalid_option", region, "Region \"${value["regionCode"]}\" is not in the list.")
            if (value["provinceCode"] != null) {
                if (g.province == null) fail("invalid_option", province, "Province \"${value["provinceCode"]}\" is not in the list.")
                else if (value["regionCode"] == null) fail("choose_parent_first", province, "Choose Region before Province.")
                else if (g.province.regionCode != value["regionCode"]) fail("geography_mismatch", province, "Province is not in the chosen Region.")
            }
            if (value["municipalityCode"] != null) {
                if (g.municipality == null) fail("invalid_option", municipality, "Municipality \"${value["municipalityCode"]}\" is not in the list.")
                else if (value["provinceCode"] == null) fail("choose_parent_first", municipality, "Choose Province before Municipality.")
                else if (g.municipality.provinceCode != value["provinceCode"]) fail("geography_mismatch", municipality, "Municipality is not in the chosen Province.")
            }
            if (value["barangayCode"] != null) {
                if (g.barangay == null) fail("invalid_option", barangay, "Barangay \"${value["barangayCode"]}\" is not in the list.")
                else if (value["municipalityCode"] == null) fail("choose_parent_first", barangay, "Choose Municipality before Barangay.")
                else if (g.barangay.municipalityCode != value["municipalityCode"]) fail("geography_mismatch", barangay, "Barangay is not in the chosen Municipality.")
            }
            if (postalCode != null) {
                if (!fourDigits.matches(postalCode)) fail("invalid_option", postal, "Postal Code \"$postalCode\" is not in the list.")
                else if (value["municipalityCode"] == null) fail("choose_parent_first", postal, "Choose Municipality before Postal Code.")
                else if (postalCode !in g.postalCodes) fail("postal_code_mismatch", postal, "Postal Code $postalCode does not belong to the chosen Municipality.")
            }
        } else if (postalCode != null && !fourDigits.matches(postalCode))
            fail("invalid_option", postal, "Postal Code \"$postalCode\" is not in the list.")

        val cf = field("coordinates")
        val lat = input["latitude"]; val lng = input["longitude"]
        if (blank(lat) && blank(lng)) {
            if (level == "complete") fail("required", cf, "${cf.label} is required.")
            value["latitude"] = null; value["longitude"] = null
        } else {
            val la = (lat as? Number)?.toDouble() ?: lat?.toString()?.trim()?.toDoubleOrNull()
            val lo = (lng as? Number)?.toDouble() ?: lng?.toString()?.trim()?.toDoubleOrNull()
            if (blank(lat) || blank(lng) || la == null || lo == null || !la.isFinite() || !lo.isFinite() || la < -90 || la > 90 ||
                lo < -180 || lo > 180 || (la == 0.0 && lo == 0.0)) {
                fail("invalid_coordinates", cf, "${cf.label} must be a latitude from -90 to 90 and a longitude from -180 to 180.")
                value["latitude"] = null; value["longitude"] = null
            } else { value["latitude"] = la; value["longitude"] = lo }
        }

        @Suppress("UNCHECKED_CAST")
        val shipTos = (input["shipTos"] as? List<Map<String, Any?>>).orEmpty()
        value["shipTos"] = shipTos.mapIndexed { i, s ->
            linkedMapOf<String, Any?>("sameAsCustomer" to (s["sameAsCustomer"] == true)).also { out ->
                for (f in SHIP_TO_FIELDS) out[f.key] = scalar(f, s[f.key], i)
            }
        }
        if (level == "complete" && shipTos.isEmpty())
            fail("ship_to_required", SHIP_TO_FIELDS[0], "Add at least one ship-to (Ship-to Party, Ship-to Address, Contact Person, Mobile No.).")
        return Result(errors.isEmpty(), level, errors, value)
    }
}
