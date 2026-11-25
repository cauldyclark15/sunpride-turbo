package com.sunpride.field.census

import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64
import java.util.Locale

/** SP-0170 "Add customer" (the field app's new-store flow): the agent's part of the client's
 * customer sheet (SPEC rule 10), its dependent pickers and the census.capture payload carrying the
 * contract's `customer` object. Pure logic; CensusScreen renders it. */
object CustomerCapture {
    // SP-0182: same free-text policy as the web. Emails, list keys and identifiers keep their case.
    private val titleCaseFields = (CustomerMaster.FIELDS + CustomerMaster.NAME_FIELDS).filter {
        it.kind == CustomerMaster.Kind.TEXT && !it.key.endsWith("Code") && it.key != "clusterNo"
    }.map { it.key }.toSet()
    private val words = Regex("\\p{L}[\\p{L}\\p{M}]*(?:['’][\\p{L}\\p{M}]+)*")
    private val nameParts = Regex("(^|['’])([\\p{L}\\p{M}]+)")
    fun normalizeText(key: String, value: String): String {
        if (key !in titleCaseFields) return value
        return words.replace(value.lowercase(Locale.ROOT)) { word ->
            nameParts.replace(word.value) { match ->
                val separator = match.groupValues[1]; val part = match.groupValues[2]
                // Preserve possessive 's; capitalize O'Neil and D’Angelo.
                separator + if (separator.isNotEmpty() && part == "s") part
                    else part.take(1).uppercase(Locale.ROOT) + part.drop(1)
            }
        }
    }

    /** Offline setup from census-config `customerMaster` (reference lists, default Sales Organization,
     * the provinces of the agent's customers whose barangays the phone keeps). */
    data class Setup(val salesOrgCode: String, val provinceCodes: List<String>, val index: CustomerMaster.ReferenceIndex, val enrollmentFields: List<EnrollmentFields.Field> = emptyList()) {
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
        return Setup(cm.optString("salesOrgCode").ifEmpty { "1000" }, provinces, CustomerMaster.ReferenceIndex(rows), EnrollmentFields.parse(cm.optJSONObject("enrollmentForm")?.optJSONArray("fields")))
    }

    /** PSGC geography kept on the phone: every region/province/municipality/postal code (one pack)
     * plus barangays for the provinces fetched so far (the agent's area, and any picked while online). */
    class Geography(val regions: List<CustomerMaster.GeoRegion>, val provinces: List<CustomerMaster.GeoProvince>,
        val municipalities: List<CustomerMaster.GeoMunicipality>, private val postal: Map<String, List<String>>,
        val barangaysByProvince: Map<String, List<CustomerMaster.GeoBarangay>> = emptyMap(),
        private val postalAreas: Map<String, List<PostalOption>> = emptyMap()) {
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
        fun postalOptionsOf(municipalityCode: String?): List<PostalOption> = municipalityCode?.let { postalAreas[it] }
            ?: postalCodesOf(municipalityCode).map { PostalOption(it) }
        fun suggestedPostal(municipalityCode: String, barangayCode: String): String? =
            suggestPostalCode(postalOptionsOf(municipalityCode), barangay(municipalityCode, barangayCode)?.name)
        fun barangay(municipalityCode: String?, code: String?): CustomerMaster.GeoBarangay? =
            code?.let { c -> barangaysOf(municipalityCode)?.firstOrNull { it.code == c } }
        fun withBarangays(provinceCode: String, rows: List<CustomerMaster.GeoBarangay>) =
            Geography(regions, provinces, municipalities, postal, barangaysByProvince + (provinceCode to rows), postalAreas)
        fun resolve(f: Form): CustomerMaster.ResolvedGeography = CustomerMaster.ResolvedGeography(region(f.regionCode),
            province(f.provinceCode), municipality(f.municipalityCode), barangay(f.municipalityCode, f.barangayCode),
            postalCodesOf(f.municipalityCode))
        companion object {
            /** GET /api/v1/geography/pack. */
            fun parse(pack: JSONObject): Geography {
                fun rows(key: String) = pack.optJSONArray(key)?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
                val postal = rows("postalCodes").groupBy { it.optString("municipalityCode") }
                    .mapValues { (_, values) -> values.map { PostalOption(it.optString("code"),
                        if (it.isNull("area")) null else it.optString("area")) } }
                val municipalities = rows("municipalities").map {
                    CustomerMaster.GeoMunicipality(it.getString("code"), it.getString("name"), it.getString("provinceCode")) }
                val provinceOf = municipalities.associate { it.code to it.provinceCode }
                val allBarangays = if (pack.optBoolean("barangaysComplete")) {
                    val grouped = barangays(pack).groupBy { provinceOf[it.municipalityCode] }
                    rows("provinces").associate { it.getString("code") to grouped[it.getString("code")].orEmpty() }
                } else emptyMap()
                return Geography(rows("regions").map { CustomerMaster.GeoRegion(it.getString("code"), it.getString("name")) },
                    rows("provinces").map { CustomerMaster.GeoProvince(it.getString("code"), it.getString("name"), it.getString("regionCode")) },
                    municipalities,
                    postal.mapValues { (_, v) -> v.map { it.code }.distinct() }, allBarangays, postalAreas = postal)
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
        val firstName: String = "", val middleName: String = "", val lastName: String = "",
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
        /** SP-0196: the agent typed in (or cleared) Customer Address. Until then the field shows the address built from
         * the location pickers; afterwards it shows exactly what was typed and is never refilled or appended to. */
        val addressEdited: Boolean = false,
        val customFields: Map<String,String> = emptyMap(),
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
        fun withBarangay(code: String, geography: Geography?) = if (code == barangayCode) this else
            copy(barangayCode = code, postalCode = if (code.isEmpty()) "" else geography?.suggestedPostal(municipalityCode, code).orEmpty())
        fun withSalesOrg(code: String) = if (code == salesOrgCode) this else copy(salesOrgCode = code, distributionChannelCode = "", customerGroup1Code = "", customerGroup2Code = "",
            details = withoutAdp() - setOf("salesOfficeCode", "deliveringPlantCode"))
        fun withChannel(code: String) = if (code == distributionChannelCode) this else copy(distributionChannelCode = code, customerGroup1Code = "", customerGroup2Code = "", details = withoutAdp())
        fun withGroup1(code: String) = if (code == customerGroup1Code) this else copy(customerGroup1Code = code, customerGroup2Code = "")
        /** The customer-object values (contract §1 keys), blank ones left out. */
        fun values(): LinkedHashMap<String, String> = linkedMapOf(
            "registeredName" to registeredName, "tradeName" to tradeName, "customerName" to customerName, "email" to email,
            "firstName" to firstName, "middleName" to middleName, "lastName" to lastName,
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
        /** A name alone is useful draft work too; only untouched default values do not count. */
        fun isEmpty() = form.customFields.values.all { it.isBlank() } && fix == null && photo == null && form.contactPerson.isBlank() && form.sameAsCustomer &&
            listOf(form.shipToParty, form.shipToAddress, form.shipToMobileNo, form.shipToEmail).all { it.isBlank() } &&
            form.values().all { (key, value) -> key == "salesOrgCode" || (key == "countryCode" && value == "PH") }
    }
    fun draftJson(d: Draft): String {
        val values = JSONObject(); d.form.values().forEach { (k, v) -> values.put(k, v) }
        if (d.form.contactPerson.isNotBlank()) values.put("contactPerson", d.form.contactPerson)
        val o = JSONObject().put("version", 1).put("form", values)
            .put("details", JSONObject(d.form.details)).put("sameAsCustomer", d.form.sameAsCustomer)
            .put("shipToParty", d.form.shipToParty).put("shipToAddress", d.form.shipToAddress)
            .put("shipToMobileNo", d.form.shipToMobileNo).put("shipToEmail", d.form.shipToEmail)
            .put("addressEdited", d.form.addressEdited).put("customFields", JSONObject(d.form.customFields))
        d.fix?.let { o.put("fix", JSONObject(it.toString())) }
        d.photo?.let { o.put("photo", java.util.Base64.getEncoder().encodeToString(it)) }
        return o.toString()
    }
    fun parseDraft(text: String?): Draft? = runCatching {
        val o = JSONObject(text ?: return null); if (o.optInt("version") != 1) return null
        val v = o.getJSONObject("form"); fun g(k: String) = v.optString(k, "")
        val form = Form(customFields = EnrollmentFields.values(o.optJSONObject("customFields")), registeredName = g("registeredName"), tradeName = g("tradeName"), customerName = g("customerName"),
            firstName = g("firstName"), middleName = g("middleName"), lastName = g("lastName"),
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
            // Drafts kept before SP-0196 have no flag: a typed address counts as edited.
            .let { f -> f.copy(addressEdited = o.optBoolean("addressEdited", f.detail("customerAddress").isNotBlank())) }
        Draft(form, o.optJSONObject("fix"), o.optString("photo").takeIf { it.isNotEmpty() }?.let { java.util.Base64.getDecoder().decode(it) })
    }.getOrNull()

    /** The agent's form starts with the Sales Organization of their assignment. */
    fun start(setup: Setup?, customerName: String = ""): Form = Form(customerName = customerName.take(200),
        salesOrgCode = setup?.salesOrgCode?.takeIf { code -> setup.options("sales_organization").any { it.code == code } }.orEmpty())

    /** Customer Address: normalize typed parts, preserving official geography labels. A cleared field still sends the
     * address built from the location pickers (the server needs one), but the field itself stays as the agent left it. */
    fun address(f: Form, g: Geography?): String = normalizeAddress(f, g, f.detail("customerAddress").trim()).ifEmpty { builtAddress(f, g) }
    /** The address built from the location pickers and street fields. */
    fun builtAddress(f: Form, g: Geography?): String =
        CustomerMaster.formatAddress(normalizeText("roomStallNo", f.roomStallNo), normalizeText("floor", f.floor),
            normalizeText("houseNo", f.houseNo), normalizeText("street1", f.street1), normalizeText("street2", f.street2),
            g?.barangay(f.municipalityCode, f.barangayCode)?.name, g?.municipality(f.municipalityCode)?.name,
            g?.province(f.provinceCode)?.name, f.postalCode).orEmpty()
    /** SP-0196: what the Customer Address field shows: the built suggestion until the agent edits it, then only
     * their own text (cleared stays cleared; typing never appends to a suggestion that is no longer shown). */
    fun addressField(f: Form, g: Geography?): String = if (f.addressEdited) f.detail("customerAddress") else builtAddress(f, g)
    fun withAddressTyped(f: Form, text: String): Form = f.withDetail("customerAddress", text).copy(addressEdited = true)
    /** Title-case typed address text like the web, then put the picked place names back in their official spelling
     * ("City Of Cebu" -> "City of Cebu"). */
    fun normalizeAddress(f: Form, g: Geography?, text: String): String {
        var out = normalizeText("customerAddress", text)
        val official = listOfNotNull(g?.barangay(f.municipalityCode, f.barangayCode)?.name, g?.municipality(f.municipalityCode)?.name,
            g?.province(f.provinceCode)?.name, g?.region(f.regionCode)?.name).filter { it.isNotBlank() }.sortedByDescending { it.length }
        for (name in official) out = out.replace(Regex(Regex.escape(name), RegexOption.IGNORE_CASE), Regex.escapeReplacement(name))
        return out
    }
    /** SP-0196: the store's name for lists and the outlet: Registered Name (the store), else Customer Name. */
    fun customerName(f: Form): String = CustomerMaster.fullName(f.values()).ifEmpty { f.customerName.trim() }
    fun storeName(f: Form): String = normalizeText("registeredName", f.registeredName.trim()).ifEmpty { normalizeText("customerName", customerName(f)) }
    /** The store name and owner of a saved Add customer payload (older saves sent the owner as `name`). */
    fun savedNames(p: JSONObject): Pair<String, String?> {
        val c = p.optJSONObject("customer")
        val registered = c?.optString("registeredName").orEmpty().trim()
        val owner = c?.optString("customerName").orEmpty().trim().takeIf { it.isNotEmpty() }
        val store = registered.ifEmpty { p.optString("name").trim() }.ifEmpty { owner.orEmpty() }
        return store to owner?.takeIf { !it.equals(store, ignoreCase = true) }
    }

    data class PostalOption(val code: String, val area: String? = null) {
        val label: String get() = if (area.isNullOrBlank()) code else "$code $area"
    }
    /** Same conservative area-name matching as @sunpride/customer-master/postal.js. */
    fun suggestPostalCode(options: List<PostalOption>, barangayName: String?): String? {
        fun key(name: String) = java.text.Normalizer.normalize(name, java.text.Normalizer.Form.NFD)
            .replace(Regex("\\p{M}"), "").lowercase(Locale.ROOT).trim()
            .replace(Regex("^(?:barangay|brgy)\\.?\\s+"), "").replace(Regex("[^a-z0-9]"), "")
        val valid = options.filter { Regex("^[0-9]{4}$").matches(it.code) }
        val codes = valid.map { it.code }.distinct()
        if (codes.size == 1) return codes.single()
        val wanted = key(barangayName.orEmpty()).takeIf { it.isNotEmpty() } ?: return null
        return valid.filter { o -> o.area.orEmpty().split(Regex("[/&+,;]")).any { key(it) == wanted } }
            .map { it.code }.distinct().singleOrNull()
    }
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

    /** A required field Save found missing, in form order; [key] matches the contract key. */
    data class Missing(val key: String, val message: String)
    /** SP-0184: all required sheet fields before submission, including conditional ADP and ship-to.
     * Missing offline geography must be downloaded, not deferred to an Admin to complete. */
    fun missing(f: Form, s: Setup?, g: Geography?, hasFix: Boolean, hasPhoto: Boolean): List<Missing> = buildList {
        val values = f.values()
        val app = s?.let { applicability(it, f) }
        for (key in CustomerMaster.FIELD_CAPTURE.flatMap { if (it == "customerName") listOf("firstName", "middleName", "lastName") else listOf(it) }) {
            val field = CustomerMaster.field(key)
            if (!field.required || key == "customerAddress" || (field.adp && f.distributionChannelCode != CustomerMaster.ADP_CHANNEL)) continue
            if (key == "customerGroup1Code" && app?.group1 == false) continue
            if (key == "customerGroup2Code" && (app?.group1 == false || app?.group2 == false)) continue
            if (key == "coordinates") continue // SP-0243: best-effort location never blocks Save.
            if (values[key].isNullOrBlank()) {
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
        // SP-0241: a storefront photo is always optional, including approval submission.
        EnrollmentFields.errors(s?.enrollmentFields.orEmpty(), f).forEach { (key,message) -> add(Missing(key,message)) }
    }
    /** Saving work and submitting a complete profile are separate actions. Lists, camera and
     * GPS are not prerequisites for saving; the office still checks completeness on approval. */
    fun saveMissing(f: Form): List<Missing> = buildList {
        if (f.registeredName.isBlank()) add(Missing("registeredName", "Registered Name is required."))
        if (customerName(f).isBlank()) add(Missing("firstName", "Enter the person's name."))
    }

    /** Only size/identity mistakes block an incomplete save. Supplied nonessential values
     * are preserved verbatim for later correction, not silently lost when lists are absent. */
    fun saveErrors(f: Form, s: Setup?, g: Geography?): List<CustomerMaster.Error> =
        draftErrors(f, s ?: Setup("", emptyList(), CustomerMaster.ReferenceIndex(emptyList())), g, null, null)
            .filter { it.code == "too_long" }

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
        return field.label + if (key in setOf("registeredName", "firstName", "lastName")) " *" else ""
    }
    fun shipTo(f: Form, g: Geography?): Map<String, Any?> = linkedMapOf(
        "sameAsCustomer" to f.sameAsCustomer,
        "shipToParty" to normalizeText("shipToParty", if (f.sameAsCustomer) customerName(f) else f.shipToParty.trim()),
        "shipToAddress" to if (f.sameAsCustomer) address(f, g) else normalizeText("shipToAddress", f.shipToAddress.trim()),
        "contactPerson" to normalizeText("contactPerson", f.contactPerson.trim()),
        "mobileNo" to if (f.sameAsCustomer) f.mobileNo.trim() else f.shipToMobileNo.trim(),
        "email" to if (f.sameAsCustomer) f.email.trim() else f.shipToEmail.trim(),
    )

    /** The shared draft rules (formats, lists, dependencies), as the server checks them. */
    fun draftErrors(f: Form, s: Setup, g: Geography?, latitude: Double?, longitude: Double?): List<CustomerMaster.Error> {
        val input = HashMap<String, Any?>(f.values()); input["latitude"] = latitude; input["longitude"] = longitude
        input["customerName"] = customerName(f)
        input["shipTos"] = listOf(shipTo(f, g))
        return (CustomerMaster.nameErrors(input, required = false) + CustomerMaster.validate(input, "draft", s.index, g?.resolve(f)).errors).map { error ->
            val key = when (error.field) {
                "shipTos[0].mobileNo" -> if (f.sameAsCustomer) "mobileNo" else "shipToMobileNo"
                "shipTos[0].email" -> if (f.sameAsCustomer) "email" else "shipToEmail"
                else -> error.field.removePrefix("shipTos[0].")
            }
            error.copy(field = key)
        }.distinctBy { it.field }
    }

    /** The contract's `customer` object: the agent's fields with the Customer Address built from Street 1 and the location. */
    fun customer(f: Form, g: Geography?): JSONObject {
        val o = JSONObject()
        // Normalize at submission as well as blur: restored drafts and Save from a focused field are covered.
        // SP-0220: Customer Address is no longer a separate field; the server builds it from Street 1 and the location.
        f.values().forEach { (k, v) -> if (k != "customerAddress") o.put(k, normalizeText(k, v)) }
        for (field in CustomerMaster.NAME_FIELDS) o.put(field.key, normalizeText(field.key, f.values()[field.key].orEmpty()))
        o.put("customerName", normalizeText("customerName", customerName(f)))
        builtAddress(f, g).takeIf { it.isNotEmpty() }?.let { o.put("customerAddress", it) }
        o.put("shipTos", JSONArray().put(JSONObject(shipTo(f, g))))
        if (f.customFields.isNotEmpty()) o.put("customFields", JSONObject(f.customFields))
        return o
    }

    /** census.capture payload for a new customer (server: field enrolment + draft customer profile). */
    fun payload(captureId: String, f: Form, g: Geography?, deviceTime: Long, gpsFix: JSONObject?, photo: String?,
        acknowledged: List<String> = emptyList()): JSONObject {
        val customer = customer(f, g)
        // SP-0196: `name` is the store (Registered Name); the customer object keeps both names as entered.
        val name = customer.optString("registeredName").trim().ifEmpty { customer.optString("customerName").trim() }
        val p = JSONObject().put("captureId", captureId).put("name", name)
            .put("address", builtAddress(f, g).ifEmpty { name })
            .put("ownerName", normalizeText("contactPerson", f.contactPerson.trim())).put("ownerPhone", f.mobileNo.trim()).put("deviceTime", deviceTime)
            .put("locationSource", "gps").put("location", gpsFix?.takeIf { CustomerLocation.usable(it, deviceTime) } ?: JSONObject.NULL)
            .put("customer", customer)
        photo?.takeIf { it.isNotEmpty() }?.let { p.put("photoJpegBase64", it) }
        if (acknowledged.isNotEmpty()) p.put("acknowledgedDuplicateIds", JSONArray(acknowledged.distinct().take(10)))
        return p
    }

    private val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
    /** Outbox check of a new-customer capture (no reference lists needed: formats only; the server checks lists). */
    fun validate(p: JSONObject) {
        require(uuid.matches(p.getString("captureId"))) { "Open Add customer again." }
        val c = p.getJSONObject("customer")
        val allowed = (CustomerMaster.CUSTOMER_FIELDS + CustomerMaster.NAME_FIELDS).map { it.key }.toSet() + setOf("shipTos", "customFields")
        c.keys().forEach { k -> require(k in allowed) { "Unknown customer field $k." } }
        require(p.getString("name").trim().length in 1..200) { "Registered Name is required." }
        require(p.getString("address").trim().length in 1..500) { "Fill in the customer location." }
        val incomplete = p.optBoolean("allowIncomplete")
        require(p.optString("ownerName").trim().length <= 150 && (incomplete || p.optString("ownerName").isNotBlank())) { "Contact Person is required." }
        if (incomplete) {
            require((c.opt("registeredName") as? String)?.trim()?.isNotEmpty() == true) { "Registered Name is required." }
            require((c.opt("customerName") as? String)?.trim()?.isNotEmpty() == true) { "Enter the person's name." }
        }
        val input = HashMap<String, Any?>(); c.keys().forEach { input[it] = if (c.isNull(it)) null else c.get(it) }
        c.optJSONArray("shipTos")?.let { a ->
            require(a.length() in 1..20) { "Add a ship-to." }
            input["shipTos"] = (0 until a.length()).map { i -> val ship = a.getJSONObject(i)
                val keys = CustomerMaster.SHIP_TO_FIELDS.map { it.key }.toSet() + "sameAsCustomer"
                require(ship.keys().asSequence().all { it in keys }) { "Unknown ship-to field." }
                ship.keys().asSequence().associateWith { if (ship.isNull(it)) null else ship.get(it) }
            }
        }
        c.optJSONObject("customFields")?.let { extra ->
            require(extra.length() <= 30) { "Too many additional fields." }
            extra.keys().forEach { key -> require(Regex("cf_[a-f0-9]{32}").matches(key) && extra.get(key) is String && extra.getString(key).length <= 140000) { "Check the additional information." } }
        }
        val location = p.optJSONObject("location")
        input["latitude"] = location?.getDouble("latitude"); input["longitude"] = location?.getDouble("longitude")
        val nameErrors = if (CustomerMaster.NAME_FIELDS.any { c.has(it.key) }) CustomerMaster.nameErrors(input, required = !incomplete) else emptyList()
        require(nameErrors.isEmpty()) { nameErrors.first().message }
        val errors = CustomerMaster.validate(input, if (incomplete) "draft" else "field", CustomerMaster.ReferenceIndex(emptyList()), null).errors
            // Reference lists are unavailable here; full submission and the office check them.
            .filter { if (incomplete) it.code == "too_long" else
                (it.field == "postalCode" || it.code !in setOf("invalid_option", "not_for_sales_org", "not_for_channel", "not_for_group1", "not_applicable", "choose_parent_first")) &&
                !(it.code == "required" && it.field in setOf("coordinates", "customerGroup1Code", "customerGroup2Code")) }
        require(errors.isEmpty()) { errors.first().message }
        require(p.optString("locationSource", "gps") == "gps")
        require(!p.has("location") || p.isNull("location") || CustomerLocation.usable(location, p.getLong("deviceTime"))) {
            "Try Use my location again, or save without a location."
        }
        CensusRules.validatePhoto(p)
    }
}
