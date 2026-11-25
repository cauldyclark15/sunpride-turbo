package com.sunpride.field.census

import com.sunpride.field.storage.StoreScope
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.Base64
import java.util.UUID

/** SP-0170 Add customer: dependent pickers, conditional required fields, payload and outbox checks. */
class CustomerCaptureTest {
    private val config: JSONObject by lazy {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val f = File(dir, "packages/customer-master/fixtures/android-parity.json")
            if (f.isFile) {
                val lists = JSONObject(f.readText()).getJSONArray("lists")
                return@lazy JSONObject().put("customerMaster", JSONObject().put("salesOrgCode", "1000")
                    .put("provinceCodes", JSONArray(listOf("0702200000"))).put("lists", lists))
            }
            dir = dir.parentFile
        }
        error("fixture not found")
    }
    private val setup by lazy { CustomerCapture.setup(config)!! }
    private fun plain(value: Any?): Any? = when (value) {
        is JSONObject -> value.keys().asSequence().associateWith { plain(value.get(it)) }
        is JSONArray -> (0 until value.length()).map { plain(value.get(it)) }
        is Number -> value.toDouble()
        JSONObject.NULL -> null
        else -> value
    }
    private val pack = JSONObject()
        .put("regions", JSONArray().put(JSONObject().put("code", "0700000000").put("name", "Region VII (Central Visayas)"))
            .put(JSONObject().put("code", "1300000000").put("name", "NCR")))
        .put("provinces", JSONArray().put(JSONObject().put("code", "0702200000").put("name", "Cebu").put("regionCode", "0700000000"))
            .put(JSONObject().put("code", "0704600000").put("name", "Bohol").put("regionCode", "0700000000")))
        .put("municipalities", JSONArray()
            .put(JSONObject().put("code", "0730600000").put("name", "City of Cebu").put("provinceCode", "0702200000"))
            .put(JSONObject().put("code", "0731100000").put("name", "City of Mandaue").put("provinceCode", "0702200000"))
            .put(JSONObject().put("code", "0701200000").put("name", "Tagbilaran").put("provinceCode", "0704600000")))
        .put("postalCodes", JSONArray().put(JSONObject().put("municipalityCode", "0730600000").put("code", "6000"))
            .put(JSONObject().put("municipalityCode", "0731100000").put("code", "6014")).put(JSONObject().put("municipalityCode", "0731100000").put("code", "6015")))
    private val cebuBarangays = JSONObject().put("provinceCode", "0702200000").put("barangays", JSONArray()
        .put(JSONObject().put("code", "0730600003").put("name", "Apas").put("municipalityCode", "0730600000"))
        .put(JSONObject().put("code", "0731100001").put("name", "Alang-alang").put("municipalityCode", "0731100000")))
    private val geography by lazy {
        CustomerCapture.Geography.parse(pack).withBarangays("0702200000", CustomerCapture.Geography.barangays(cebuBarangays))
    }
    private fun complete() = CustomerCapture.start(setup, "Aling Nena Store").copy(registeredName = "Aling Nena Store Inc.", firstName = "Aling Nena", lastName = "Store", mobileNo = "0917 555 0101",
        regionCode = "0700000000", provinceCode = "0702200000", municipalityCode = "0730600000", barangayCode = "0730600003",
        houseNo = "12", street1 = "Gorordo Ave", postalCode = "6000", distributionChannelCode = "41", customerGroup1Code = "RSF",
        customerGroup2Code = "RSS", customerGroupCode = "74", typeOfBusiness = "Sole Proprietor", contactPerson = "Nena Cruz",
        details = mapOf("taxClassificationCode" to "1", "salesOfficeCode" to "100",
            "paymentTermsCode" to "0003", "pricingProcedureCode" to "2", "deliveringPlantCode" to "1000"))
    private val fix = JSONObject().put("latitude", 10.3312).put("longitude", 123.9056).put("accuracyMeters", 9.0)
        .put("fixTime", 5000L).put("provider", "gps").put("mockSignal", false)
    private val jpeg = Base64.getEncoder().encodeToString(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xd9.toByte()))

    @Test fun draftCanBeEditedButCompletenessIsStillRequiredBeforeApprovalSubmission() {
        val missingStreet = complete().copy(registeredName = "", street1 = "", mobileNo = "0917")
        val draft = CustomerCapture.Draft(missingStreet, fix, Base64.getDecoder().decode(jpeg))
        val stored = CustomerDrafts.parse(CustomerDrafts().save(draft).json())
        val reopened = stored.open(stored.saved.single().id)
        val form = reopened.active!!.form
        assertTrue(CustomerCapture.missing(form, setup, geography, true, true).any { it.key == "registeredName" })
        val premature = CustomerCapture.payload(UUID.randomUUID().toString(), form, geography, 5000L, fix, jpeg)
        assertThrows(IllegalArgumentException::class.java) { CensusRules.validate(premature) }
        val corrected = form.copy(registeredName = "Aling Nena Store Inc.", street1 = "Gorordo Ave", mobileNo = "09175550101")
        assertTrue(CustomerCapture.missing(corrected, setup, geography, true, true).isEmpty())
        assertTrue(CustomerCapture.draftErrors(corrected, setup, geography, 10.3312, 123.9056).isEmpty())
        val submitted = CustomerCapture.payload(UUID.randomUUID().toString(), corrected, geography, 5000L, fix, jpeg)
        val intent = CensusRules.intent(StoreScope("account", "device", "scope"), submitted, 5000L)
        assertEquals(CensusRules.KIND, intent.kind)
        assertEquals("Gorordo Ave", JSONObject(intent.serializedOperation).getJSONObject("payload").getJSONObject("customer").getString("street1"))
        assertTrue(reopened.keep(draft.copy(form = corrected)).clear().saved.isEmpty())
    }

    @Test fun optionalStorePhotoSurvivesDraftAndImmutableOutbox() {
        assertTrue(CustomerCapture.missing(complete(), setup, geography, true, false).isEmpty())
        val restored = CustomerCapture.parseDraft(CustomerCapture.draftJson(CustomerCapture.Draft(complete(), fix, null)))!!
        assertNull(restored.photo)
        for (photo in listOf(null, "")) {
            val p = CustomerCapture.payload(UUID.randomUUID().toString(), restored.form, geography, 5000L, restored.fix, photo)
            assertFalse(p.has("photoJpegBase64"))
            val intent = CensusRules.intent(StoreScope("account", "device", "scope"), p, 5000L)
            assertFalse(JSONObject(intent.serializedOperation).getJSONObject("payload").has("photoJpegBase64"))
            p.put("photoJpegBase64", JSONObject.NULL); CensusRules.validate(p)
            p.put("photoJpegBase64", ""); CensusRules.validate(p)
        }
        val p = CustomerCapture.payload(UUID.randomUUID().toString(), complete(), geography, 5000L, fix, jpeg)
        for (bad in listOf<Any>(false, "invalid", Base64.getEncoder().encodeToString(byteArrayOf(1, 2, 3, 4)),
            Base64.getEncoder().encodeToString(ByteArray(CensusRules.MAX_PHOTO_BYTES + 1)))) {
            assertThrows(IllegalArgumentException::class.java) { CensusRules.validate(JSONObject(p.toString()).put("photoJpegBase64", bad)) }
        }
        CensusRules.validate(p)
        assertEquals(jpeg, p.getString("photoJpegBase64"))
    }

    @Test fun weakOldAndMissingLocationSurviveDraftAndImmutableOutbox() {
        val now = 2_000_000L
        val weak = JSONObject(fix.toString()).put("accuracyMeters", 500.0).put("fixTime", now - 1_800_000L)
        assertTrue(CustomerLocation.usable(weak, now))
        assertTrue(CustomerCapture.missing(complete(), setup, geography, false, true).isEmpty())
        assertTrue(CustomerCapture.draftErrors(complete(), setup, geography, null, null).isEmpty())
        for (reading in listOf(weak, null, JSONObject(weak.toString()).put("fixTime", now - 1_800_001L),
            JSONObject(weak.toString()).put("accuracyMeters", 501.0))) {
            val kept = CustomerCapture.parseDraft(CustomerCapture.draftJson(CustomerCapture.Draft(complete(), reading, byteArrayOf(1, 2))))!!
            assertEquals(complete(), kept.form)
            val p = CustomerCapture.payload(UUID.randomUUID().toString(), kept.form, geography, now, kept.fix, jpeg)
            CensusRules.validate(p)
            val intent = CensusRules.intent(StoreScope("account", "device", "scope"), p, now)
            val saved = JSONObject(intent.serializedOperation).getJSONObject("payload")
            assertEquals(plain(p), plain(saved))
            assertEquals(reading !== weak, saved.isNull("location"))
        }
        val strong = JSONObject(weak.toString()).put("accuracyMeters", 30.0)
        assertSame(strong, CustomerLocation.best(strong, weak, now))
        assertSame(strong, CustomerLocation.best(strong, null, now))
        assertSame(strong, CustomerLocation.best(strong, JSONObject(weak.toString()).put("mockSignal", true), now))
        assertSame(strong, CustomerLocation.best(weak, strong, now))
    }

    @Test fun separateNamesAreRequiredAndSurviveDraftPayloadAndOutbox() {
        val f = complete().copy(firstName = "María José", middleName = "Peña", lastName = "O’Neil")
        assertEquals("First Name *", CustomerCapture.formLabel("firstName"))
        assertEquals("Middle Name", CustomerCapture.formLabel("middleName"))
        assertEquals("Last Name *", CustomerCapture.formLabel("lastName"))
        val restored = CustomerCapture.parseDraft(CustomerCapture.draftJson(CustomerCapture.Draft(f, fix, null)))!!.form
        assertEquals(f, restored)
        val p = CustomerCapture.payload(UUID.randomUUID().toString(), restored, geography, 5000L, fix, jpeg)
        CensusRules.validate(p)
        val c = p.getJSONObject("customer")
        assertEquals("María José", c.getString("firstName")); assertEquals("Peña", c.getString("middleName")); assertEquals("O’Neil", c.getString("lastName"))
        assertEquals("María José Peña O’Neil", c.getString("customerName"))
        assertEquals(c.getString("customerName"), c.getJSONArray("shipTos").getJSONObject(0).getString("shipToParty"))
        assertTrue(CustomerCapture.missing(f.copy(middleName = ""), setup, geography, true, true).isEmpty())
        val blank = f.copy(firstName = " \t ", lastName = "", middleName = "")
        assertEquals(listOf("firstName", "lastName"), CustomerCapture.missing(blank, setup, geography, true, true).map { it.key })
        val bad = CustomerCapture.payload(UUID.randomUUID().toString(), blank, geography, 5000L, fix, jpeg)
        assertTrue(runCatching { CensusRules.validate(bad) }.isFailure)
        assertTrue(CustomerCapture.draftErrors(f.copy(firstName = "A".repeat(200)), setup, geography, 10.33, 123.9).any { it.field == "lastName" && it.code == "too_long" })
        // Pending payloads from an older build remain replayable; legacy text is never split.
        val old = JSONObject(p.toString()).also { o -> CustomerMaster.NAME_FIELDS.forEach { o.getJSONObject("customer").remove(it.key) } }
        CensusRules.validate(old)
        val legacy = CustomerCapture.parseDraft(CustomerCapture.draftJson(CustomerCapture.Draft(CustomerCapture.Form(customerName = "CRUZ, María José"), null, null)))!!.form
        assertEquals("CRUZ, María José", legacy.customerName)
        assertEquals("", legacy.firstName); assertEquals("", legacy.lastName)
    }

    @Test fun setupReadsListsAndDefaultsTheAgentsSalesOrganization() {
        assertEquals("1000", setup.salesOrgCode)
        assertEquals(listOf("0702200000"), setup.provinceCodes)
        assertEquals("1000", CustomerCapture.start(setup).salesOrgCode)
        assertNull(CustomerCapture.setup(JSONObject().put("channels", JSONArray()))) // old server: no customer lists
        // Unknown default is not invented.
        val other = CustomerCapture.setup(JSONObject(config.toString()).also { it.getJSONObject("customerMaster").put("salesOrgCode", "9999") })!!
        assertEquals("", CustomerCapture.start(other).salesOrgCode)
        assertEquals(listOf("SFI (1000)", "ARI (2000)"), CustomerCapture.salesOrgs(setup).map { it.label })
    }

    @Test fun geographyPickersAreDependentAndClearChildren() {
        val g = geography
        assertEquals(listOf("Bohol", "Cebu"), g.provincesOf("0700000000").map { it.name })
        assertEquals(emptyList<Any>(), g.provincesOf(""))
        assertEquals(listOf("City of Cebu", "City of Mandaue"), g.municipalitiesOf("0702200000").map { it.name })
        assertEquals(listOf("Apas"), g.barangaysOf("0730600000")!!.map { it.name })
        assertNull("Bohol barangays are not on the phone", g.barangaysOf("0701200000"))
        val f = complete()
        val noProvince = f.withRegion("1300000000")
        assertEquals(listOf("", "", "", ""), listOf(noProvince.provinceCode, noProvince.municipalityCode, noProvince.barangayCode, noProvince.postalCode))
        val mandaue = f.withMunicipality("0731100000", g)
        assertEquals("", mandaue.barangayCode); assertEquals("two postal codes: agent chooses", "", mandaue.postalCode)
        assertEquals("one postal code fills itself", "6000", f.withProvince("0704600000").withMunicipality("0730600000", g).postalCode)
        assertSame(f, f.withRegion(f.regionCode))
        assertEquals("Apas", g.resolve(f).barangay?.name)
    }

    @Test fun barangayAutofillUsesAreaMetadataAndNeverGuessesAmongUnknownAreas() {
        val packWithAreas = JSONObject(pack.toString())
        packWithAreas.getJSONArray("postalCodes").getJSONObject(1).put("area", "Alang-alang")
        val g = CustomerCapture.Geography.parse(packWithAreas).withBarangays("0702200000", CustomerCapture.Geography.barangays(cebuBarangays))
        val selected = complete().withMunicipality("0731100000", g).withBarangay("0731100001", g)
        assertEquals("6014", selected.postalCode)
        assertEquals("6014 Alang-alang", g.postalOptionsOf("0731100000").first().label)
        assertEquals("", selected.withBarangay("unknown", g).postalCode)
        assertEquals("6000", complete().copy(barangayCode = "", postalCode = "").withBarangay("0730600003", g).postalCode)
        val manual = selected.copy(postalCode = "9999")
        assertSame(manual, manual.withBarangay(manual.barangayCode, g))
        assertEquals("9999", CustomerCapture.parseDraft(CustomerCapture.draftJson(CustomerCapture.Draft(manual, fix, null)))!!.form.postalCode)
        assertEquals("", selected.withBarangay("", g).postalCode)
    }

    @Test fun postalCanBeBlankOrManualThroughSaveDraftAndOutbox() {
        assertEquals("Postal Code", CustomerCapture.formLabel("postalCode"))
        for (postal in listOf("", " \t ", "9999", "0123")) {
            val f = complete().copy(postalCode = postal)
            assertTrue(CustomerCapture.missing(f, setup, geography, true, true).isEmpty())
            assertTrue(CustomerCapture.draftErrors(f, setup, geography, 10.33, 123.9).isEmpty())
            val restored = CustomerCapture.parseDraft(CustomerCapture.draftJson(CustomerCapture.Draft(f, fix, null)))!!.form
            val p = CustomerCapture.payload(UUID.randomUUID().toString(), restored, geography, 5000L, fix, jpeg)
            CensusRules.validate(p)
            assertEquals(postal.trim(), p.getJSONObject("customer").optString("postalCode"))
        }
        val p = CustomerCapture.payload(UUID.randomUUID().toString(), complete(), geography, 5000L, fix, jpeg)
        for (blank in listOf(null, JSONObject.NULL, "", " \t ")) {
            val c = JSONObject(p.toString())
            if (blank == null) c.getJSONObject("customer").remove("postalCode") else c.getJSONObject("customer").put("postalCode", blank)
            CensusRules.validate(c)
        }
        for (invalid in listOf("123", "12345", "6a00", "１２３４")) {
            val c = JSONObject(p.toString()).also { it.getJSONObject("customer").put("postalCode", invalid) }
            assertTrue(invalid, runCatching { CensusRules.validate(c) }.isFailure)
        }
    }

    @Test fun channelChainIsDependentAndClearsGroups() {
        val f = complete()
        assertTrue(CustomerCapture.channels(setup, f).any { it.label == "Route Sales (41)" })
        assertEquals(listOf("20", "70", "80"), CustomerCapture.channels(setup, f.withSalesOrg("2000")).map { it.code })
        val ch = f.withChannel("30")
        assertEquals(listOf("", ""), listOf(ch.customerGroup1Code, ch.customerGroup2Code))
        assertEquals("", f.withGroup1("RSD").customerGroup2Code)
        assertTrue(CustomerCapture.group2s(setup, f).any { it.code == "RSS" })
        assertEquals(emptyList<Any>(), CustomerCapture.group1s(setup, f.withChannel("")))
    }

    @Test fun conditionalRequiredFollowsTheChain() {
        fun missing(f: CustomerCapture.Form) = CustomerCapture.missing(f, setup, geography, hasFix = true, hasPhoto = true).map { it.key }
        assertEquals(emptyList<String>(), missing(complete()))
        val route = complete().copy(customerGroup1Code = "", customerGroup2Code = "")
        assertEquals(listOf("customerGroup1Code", "customerGroup2Code"), missing(route))
        // Services (50): no Grp 1 and no Grp 2.
        assertEquals(emptyList<String>(), missing(complete().withChannel("50")))
        // Food Service (20): Grp 1 but no Grp 2.
        val food = complete().withChannel("20")
        assertEquals(listOf("customerGroup1Code"), missing(food))
        val g1 = CustomerCapture.group1s(setup, food).first().code
        assertEquals(emptyList<String>(), missing(food.withGroup1(g1)))
        // SP-0184: missing offline geography must not submit an incomplete profile for an Admin.
        val bohol = complete().withProvince("0704600000").withMunicipality("0701200000", geography)
        assertEquals(listOf("barangayCode"), missing(bohol))
        assertEquals(listOf("barangayCode"), missing(complete().copy(barangayCode = "")))
        val blank = CustomerCapture.missing(CustomerCapture.Form(), setup, geography, hasFix = false, hasPhoto = false)
        assertEquals(listOf("registeredName", "firstName", "lastName", "mobileNo", "taxClassificationCode", "regionCode", "provinceCode", "municipalityCode", "barangayCode",
            "salesOrgCode", "salesOfficeCode", "distributionChannelCode", "customerGroup1Code", "customerGroup2Code", "customerGroupCode", "typeOfBusiness",
            "paymentTermsCode", "pricingProcedureCode", "deliveringPlantCode", "contactPerson"), blank.map { it.key })
        assertEquals("Registered Name is required.", blank.first().message)
        assertEquals("Contact Person is required.", blank.first { it.key == "contactPerson" }.message)
    }

    @Test fun draftErrorsUseTheClientsLabels() {
        assertEquals(emptyList<Any>(), CustomerCapture.draftErrors(complete(), setup, geography, 10.33, 123.9))
        val bad = complete().copy(mobileNo = "12345", tin = "12-3", email = "x")
        assertEquals(listOf("email", "mobileNo", "tin"), CustomerCapture.draftErrors(bad, setup, geography, 10.33, 123.9).map { it.field })
        assertEquals("Mobile No. must be a Philippine mobile number: 09XXXXXXXXX or +639XXXXXXXXX.",
            CustomerCapture.draftErrors(bad, setup, geography, 10.33, 123.9).first { it.field == "mobileNo" }.message)
        assertTrue(CustomerCapture.draftErrors(complete().copy(postalCode = "6014"), setup, geography, 10.33, 123.9).isEmpty())
    }

    @Test fun payloadCarriesTheCustomerObjectAndPassesTheOutboxCheck() {
        val id = UUID.randomUUID().toString()
        val p = CustomerCapture.payload(id, complete(), geography, 5000L, fix, jpeg)
        val c = p.getJSONObject("customer")
        assertEquals("12 Gorordo Ave, Apas, City of Cebu, Cebu 6000", c.getString("customerAddress"))
        assertEquals(c.getString("customerAddress"), p.getString("address"))
        assertEquals(listOf("registeredName", "firstName", "middleName", "lastName", "customerName", "mobileNo", "regionCode", "provinceCode", "municipalityCode", "barangayCode", "houseNo",
            "street1", "postalCode", "salesOrgCode", "distributionChannelCode", "customerGroup1Code", "customerGroup2Code",
            "customerGroupCode", "typeOfBusiness", "customerAddress", "countryCode", "taxClassificationCode", "salesOfficeCode",
            "paymentTermsCode", "pricingProcedureCode", "deliveringPlantCode", "shipTos").sorted(), c.keys().asSequence().toList().sorted())
        // SP-0196: `name` is the store (Registered Name); both CDM names stay as entered in the customer object.
        assertEquals("Aling Nena Store Inc.", p.getString("name")); assertEquals("Nena Cruz", p.getString("ownerName"))
        assertEquals("Aling Nena Store Inc.", c.getString("registeredName")); assertEquals("Aling Nena Store", c.getString("customerName"))
        assertEquals("0917 555 0101", p.getString("ownerPhone")); assertEquals("gps", p.getString("locationSource"))
        for (old in listOf("channelId", "subchannelId", "estimatedClass", "batchId", "kind")) assertFalse(old, p.has(old))
        CensusRules.validate(p) // routes to CustomerCapture.validate
        val intent = CensusRules.intent(StoreScope("account", "device", "scope"), p, 5000L)
        assertEquals(CensusRules.KIND, intent.kind)
        // Nested JSON object order is unspecified; every value must survive the intent serialization.
        assertEquals(plain(p), plain(JSONObject(intent.serializedOperation).getJSONObject("payload")))
    }

    @Test fun everyEnrollmentSectionSurvivesDraftAndOutboxIncludingSeparateDeliveryAndAdp() {
        val adp = CustomerMaster.CUSTOMER_FIELDS.filter { it.adp }.associate { it.key to "Sample ${it.label}" }
        val f = complete().withChannel("40").copy(customerGroup1Code = "ADP", customerGroup2Code = "DAW",
            sameAsCustomer = false, shipToParty = "Nena Warehouse", shipToAddress = "99 Delivery Road",
            shipToMobileNo = "09175550202", shipToEmail = "delivery@example.ph").let {
            it.copy(details = it.details + adp + mapOf("creditLimit" to "12345.67", "salesPartnerCode" to "",
                "customerAddress" to "12 Custom Street, Cebu"))
        }
        val roundtrip = CustomerCapture.parseDraft(CustomerCapture.draftJson(CustomerCapture.Draft(f, fix, byteArrayOf(1, 2))))!!
        assertEquals(f, roundtrip.form)
        assertTrue(CustomerCapture.missing(f, setup, geography, true, true).isEmpty())
        assertTrue(CustomerCapture.draftErrors(f, setup, geography, 10.33, 123.9).isEmpty())
        val p = CustomerCapture.payload(UUID.randomUUID().toString(), f, geography, 5000L, fix, jpeg)
        CensusRules.validate(p)
        val c = p.getJSONObject("customer")
        for ((key, value) in adp) assertEquals(key, value, c.getString(key))
        assertEquals("12345.67", c.getString("creditLimit"))
        // SP-0220: a typed Customer Address (older drafts) is ignored; the address is built from Street 1 and the location.
        assertEquals(CustomerCapture.builtAddress(f, geography), c.getString("customerAddress"))
        val ship = c.getJSONArray("shipTos").getJSONObject(0)
        assertFalse(ship.getBoolean("sameAsCustomer"))
        assertEquals("Nena Warehouse", ship.getString("shipToParty"))
        assertEquals("99 Delivery Road", ship.getString("shipToAddress"))
        assertEquals("Nena Cruz", ship.getString("contactPerson"))
        assertEquals("09175550202", ship.getString("mobileNo"))
        assertEquals("delivery@example.ph", ship.getString("email"))
        // Every scalar contract field has a control/model value; coordinates come from GPS.
        val fields = CustomerMaster.CUSTOMER_FIELDS.filter { it.key !in complete().values() && it.key !in listOf("coordinates", "customerAddress") }
        for (field in fields) {
            val set = f.withDetail(field.key, "sample")
            assertEquals(field.key, "sample", set.values()[field.key])
        }
    }

    @Test fun formerOfficeFieldsAreRequiredAndValidatedAndDependentSelectionsClear() {
        val f = complete()
        for (key in listOf("taxClassificationCode", "salesOfficeCode", "paymentTermsCode", "pricingProcedureCode", "deliveringPlantCode")) {
            assertTrue(key, CustomerCapture.missing(f.withDetail(key, ""), setup, geography, true, true).any { it.key == key })
            assertTrue(key, CustomerCapture.draftErrors(f.withDetail(key, "NOPE"), setup, geography, 10.33, 123.9).any { it.field == key })
        }
        assertTrue(CustomerCapture.draftErrors(f.withDetail("creditLimit", "-1"), setup, geography, 10.33, 123.9).any { it.code == "invalid_credit_limit" })
        val adp = f.withChannel("40").copy(customerGroup1Code = "ADP", customerGroup2Code = "DAW")
        assertEquals(CustomerMaster.CUSTOMER_FIELDS.filter { it.adp }.map { it.key },
            CustomerCapture.missing(adp, setup, geography, true, true).map { it.key })
        val filled = adp.withDetail("distributorCode", "D001")
        assertFalse(filled.withChannel("41").values().containsKey("distributorCode"))
        assertFalse(filled.withChannel("41").details.containsKey("distributorCode"))
        val ari = filled.withSalesOrg("2000")
        for (key in listOf("salesOfficeCode", "deliveringPlantCode", "distributorCode")) assertEquals("", ari.detail(key))
        assertEquals("", ari.distributionChannelCode)
        assertEquals("0003", ari.detail("paymentTermsCode"))
    }

    @Test fun shipToCopyIsDerivedAndSeparateDeliveryErrorsPointToVisibleControls() {
        val f = complete().copy(email = "shop@example.ph")
        val ship = CustomerCapture.customer(f, geography).getJSONArray("shipTos").getJSONObject(0)
        assertEquals(f.customerName, ship.getString("shipToParty"))
        assertEquals(f.email, ship.getString("email"))
        val separate = f.copy(sameAsCustomer = false, shipToMobileNo = "123", shipToEmail = "bad")
        assertEquals(listOf("shipToParty", "shipToAddress"), CustomerCapture.missing(separate, setup, geography, true, true).map { it.key })
        assertEquals(listOf("shipToMobileNo", "shipToEmail"), CustomerCapture.draftErrors(separate, setup, geography, 10.33, 123.9).map { it.field })
        val bad = CustomerCapture.payload(UUID.randomUUID().toString(), separate, geography, 5000L, fix, jpeg)
        assertTrue(runCatching { CensusRules.validate(bad) }.isFailure)
        val old = CustomerCapture.parseDraft("{\"version\":1,\"form\":{\"customerName\":\"Old draft\",\"contactPerson\":\"Nena\"}}")!!
        assertEquals("Old draft", old.form.customerName)
        assertTrue(old.form.sameAsCustomer)
        assertEquals("PH", old.form.detail("countryCode"))
    }

    @Test fun everyRequiredAgentFieldBlocksSaveIncludingWhitespaceAndMissingOfflineLists() {
        val required = listOf("registeredName", "firstName", "lastName", "mobileNo", "regionCode", "provinceCode", "municipalityCode",
            "barangayCode", "salesOrgCode", "distributionChannelCode", "customerGroup1Code", "customerGroup2Code",
            "customerGroupCode", "typeOfBusiness", "contactPerson")
        for (key in required) for (blank in listOf("", " \t ")) {
            val draft = JSONObject(CustomerCapture.draftJson(CustomerCapture.Draft(complete(), fix, null)))
            draft.getJSONObject("form").put(key, blank)
            val f = CustomerCapture.parseDraft(draft.toString())!!.form
            assertTrue(key, CustomerCapture.missing(f, setup, geography, true, true).any { it.key == key })
        }
        assertTrue(CustomerCapture.missing(complete().copy(barangayCode = ""), setup,
            CustomerCapture.Geography.parse(pack), true, true).any { it.key == "barangayCode" })
        assertEquals("Registered Name *", CustomerCapture.formLabel("registeredName"))
        assertEquals("Trade Name", CustomerCapture.formLabel("tradeName"))
        assertEquals("Street 1", CustomerCapture.formLabel("street1"))
        assertEquals("Street 2", CustomerCapture.formLabel("street2"))
    }

    @Test fun optionalStreetSurvivesDraftReopenFormSaveAndOutbox() {
        assertFalse(CustomerMaster.field("street1").required)
        for (street in listOf("", " \t ")) {
            val form = complete().copy(street1 = street)
            val reopened = CustomerCapture.parseDraft(CustomerCapture.draftJson(CustomerCapture.Draft(form, fix, null)))!!.form
            assertEquals("", reopened.street1)
            assertTrue(CustomerCapture.missing(reopened, setup, geography, true, true).isEmpty())
            assertTrue(CustomerCapture.draftErrors(reopened, setup, geography, 10.33, 123.9).isEmpty())
            val payload = CustomerCapture.payload(UUID.randomUUID().toString(), reopened, geography, 5000L, fix, jpeg)
            assertTrue(payload.getString("address").isNotBlank())
            CensusRules.validate(payload)
            val intent = CensusRules.intent(StoreScope("account", "device", "scope"), payload, 5000L)
            CensusRules.validate(JSONObject(intent.serializedOperation).getJSONObject("payload"))
            for (blank in listOf(null, JSONObject.NULL, "", " \t ")) {
                val p = JSONObject(payload.toString())
                if (blank == null) p.getJSONObject("customer").remove("street1") else p.getJSONObject("customer").put("street1", blank)
                CensusRules.validate(p)
            }
        }
    }

    @Test fun outboxCannotQueueAnIncompleteCustomerEvenWithoutTheScreenCheck() {
        val ok = CustomerCapture.payload(UUID.randomUUID().toString(), complete(), geography, 5000L, fix, jpeg)
        for (key in listOf("registeredName", "customerName", "firstName", "lastName", "mobileNo", "regionCode", "provinceCode",
            "municipalityCode", "barangayCode", "salesOrgCode", "distributionChannelCode", "customerGroupCode", "typeOfBusiness", "countryCode", "taxClassificationCode",
            "salesOfficeCode", "paymentTermsCode", "pricingProcedureCode", "deliveringPlantCode")) {
            for (blank in listOf(null, JSONObject.NULL, "", " \t ")) {
                val p = JSONObject(ok.toString())
                if (blank == null) p.getJSONObject("customer").remove(key) else p.getJSONObject("customer").put(key, blank)
                assertTrue(key, runCatching { CensusRules.validate(p) }.isFailure)
            }
        }
        CensusRules.validate(ok)
    }

    @Test fun outboxHandlesNestedNullsAndRequiresDeliveryAndConditionalAdp() {
        val ok = CustomerCapture.payload(UUID.randomUUID().toString(), complete(), geography, 5000L, fix, jpeg)
        val optional = JSONObject(ok.toString())
        for (key in listOf("tradeName", "email", "telNo", "tin", "creditLimit", "salesPartnerCode")) optional.getJSONObject("customer").put(key, JSONObject.NULL)
        optional.getJSONObject("customer").getJSONArray("shipTos").getJSONObject(0).put("email", JSONObject.NULL)
        CensusRules.validate(optional)
        for (key in CustomerMaster.SHIP_TO_FIELDS.filter { it.required }.map { it.key }) {
            for (blank in listOf(null, JSONObject.NULL, "", " ")) {
                val p = JSONObject(ok.toString())
                val ship = p.getJSONObject("customer").getJSONArray("shipTos").getJSONObject(0)
                if (blank == null) ship.remove(key) else ship.put(key, blank)
                assertTrue(key, runCatching { CensusRules.validate(p) }.isFailure)
            }
        }
        assertTrue(runCatching { CensusRules.validate(JSONObject(ok.toString()).also { it.getJSONObject("customer").remove("shipTos") }) }.isFailure)
        val f = complete().withChannel("40").copy(customerGroup1Code = "ADP", customerGroup2Code = "DAW")
        val adp = CustomerMaster.CUSTOMER_FIELDS.filter { it.adp }.associate { it.key to "Sample ${it.label}" }
        val full = f.copy(details = f.details + adp)
        val valid = CustomerCapture.payload(UUID.randomUUID().toString(), full, geography, 5000L, fix, jpeg)
        CensusRules.validate(valid)
        for (key in adp.keys) for (blank in listOf(null, JSONObject.NULL, "", " ")) {
            val p = JSONObject(valid.toString())
            if (blank == null) p.getJSONObject("customer").remove(key) else p.getJSONObject("customer").put(key, blank)
            assertTrue(key, runCatching { CensusRules.validate(p) }.isFailure)
        }
    }

    @Test fun mixedCaseRestoredCapturePassesTheRealOutboxWithNormalizedNames() {
        val typed = complete().copy(registeredName = "ALING NENA STORE INC.", customerName = "aling nena store",
            tradeName = "nEna'S", street1 = "GORORDO AVE", contactPerson = "NENA CRUZ", email = "Nena.Team@Example.COM")
        val restored = CustomerCapture.parseDraft(CustomerCapture.draftJson(CustomerCapture.Draft(typed, fix, null)))!!.form
        val p = CustomerCapture.payload(UUID.randomUUID().toString(), restored, geography, 5000L, fix, jpeg)
        CensusRules.validate(p)
        val intent = CensusRules.intent(StoreScope("account", "device", "scope"), p, 5000L)
        val saved = JSONObject(intent.serializedOperation).getJSONObject("payload")
        val c = saved.getJSONObject("customer")
        assertEquals("Aling Nena Store Inc.", saved.getString("name"))
        assertEquals("Aling Nena Store", c.getString("customerName"))
        assertEquals("Nena Cruz", saved.getString("ownerName"))
        assertEquals("Aling Nena Store Inc.", c.getString("registeredName"))
        assertEquals("Nena's", c.getString("tradeName"))
        assertEquals("12 Gorordo Ave, Apas, City of Cebu, Cebu 6000", c.getString("customerAddress"))
        assertEquals("Nena.Team@Example.COM", c.getString("email"))
        assertEquals("Nena.Team@Example.COM", c.getJSONArray("shipTos").getJSONObject(0).getString("email"))
        assertEquals("RSS", c.getString("customerGroup2Code"))
        assertEquals(plain(p), plain(saved))
    }

    @Test fun outboxCheckRefusesBadCaptures() {
        fun refused(p: JSONObject) = runCatching { CensusRules.validate(p) }.isFailure
        val ok = CustomerCapture.payload(UUID.randomUUID().toString(), complete(), geography, 5000L, fix, jpeg)
        assertTrue(refused(JSONObject(ok.toString()).also { it.getJSONObject("customer").put("mobileNo", "123") }))
        assertTrue(refused(JSONObject(ok.toString()).also { it.getJSONObject("customer").put("nonsense", "x") }))
        assertTrue(refused(JSONObject(ok.toString()).put("ownerName", " ")))
        assertFalse(refused(JSONObject(ok.toString()).put("photoJpegBase64", "")))
        assertTrue(refused(JSONObject(ok.toString()).put("photoJpegBase64", "broken-photo")))
        assertFalse(refused(JSONObject(ok.toString()).also { it.getJSONObject("location").put("accuracyMeters", 80.0) }))
        assertTrue(refused(JSONObject(ok.toString()).also { it.getJSONObject("location").put("accuracyMeters", 501.0) }))
        assertTrue(refused(JSONObject(ok.toString()).also { it.getJSONObject("location").put("mockSignal", true) }))
        assertFalse(refused(ok))
    }

    // SP-0196 (fails on the old code: the outlet/list name was the owner's Customer Name).
    @Test fun savedCustomersAreNamedByTheStoreWithTheOwnerUnderneath() {
        val f = complete().copy(registeredName = "Aling Nena Sari-Sari Store", customerName = "Nena Reyes", firstName = "Nena", lastName = "Reyes")
        val p = CustomerCapture.payload(UUID.randomUUID().toString(), f, geography, 5000L, fix, jpeg)
        assertEquals("Aling Nena Sari-Sari Store", p.getString("name"))
        assertEquals("Nena Reyes", p.getJSONObject("customer").getString("customerName"))
        assertEquals("Aling Nena Sari-Sari Store" to "Nena Reyes", CustomerCapture.savedNames(p))
        // A save queued by an older build (owner sent as `name`) still lists the store first.
        val old = JSONObject(p.toString()).put("name", "Nena Reyes")
        assertEquals("Aling Nena Sari-Sari Store" to "Nena Reyes", CustomerCapture.savedNames(old))
        // No Registered Name (very old saves): the name that was sent; the owner line is not repeated.
        val bare = JSONObject().put("name", "Nena Reyes").put("customer", JSONObject().put("customerName", "Nena Reyes"))
        assertEquals("Nena Reyes" to null, CustomerCapture.savedNames(bare))
        assertEquals("Aling Nena Sari-Sari Store", CustomerCapture.storeName(f))
        assertEquals("Nena Reyes", CustomerCapture.storeName(f.copy(registeredName = " ")))
    }

    // SP-0196 problem 3: the suggestion follows the pickers only until the agent edits the field.
    @Test fun customerAddressIsSuggestedUntilEditedAndNeverRefilledOrAppended() {
        val picked = CustomerCapture.Form(regionCode = "0700000000", provinceCode = "0702200000", municipalityCode = "0730600000")
        assertEquals("City of Cebu, Cebu", CustomerCapture.addressField(picked, geography))
        // Clearing it keeps it clear (the old field showed the suggestion again at once).
        val cleared = CustomerCapture.withAddressTyped(picked, "")
        assertEquals("", CustomerCapture.addressField(cleared, geography))
        assertEquals("", CustomerCapture.addressField(cleared.copy(barangayCode = "0730600003", houseNo = "12"), geography))
        // Typing after clearing is only what was typed (the old field appended it to the suggestion).
        val typed = CustomerCapture.withAddressTyped(cleared, "123 Rizal Street, Lahug, Cebu City")
        assertEquals("123 Rizal Street, Lahug, Cebu City", CustomerCapture.addressField(typed, geography))
        // A cleared field still sends the built address (the office needs one); the field stays as left.
        assertEquals("City of Cebu, Cebu 6000", CustomerCapture.address(cleared.copy(postalCode = "6000"), geography))
        // The edit survives the draft; drafts kept before SP-0196 count a typed address as edited.
        val back = CustomerCapture.parseDraft(CustomerCapture.draftJson(CustomerCapture.Draft(cleared, null, null)))!!.form
        assertTrue(back.addressEdited); assertEquals("", CustomerCapture.addressField(back, geography))
        val legacy = JSONObject(CustomerCapture.draftJson(CustomerCapture.Draft(typed, null, null))).apply { remove("addressEdited") }
        assertTrue(CustomerCapture.parseDraft(legacy.toString())!!.form.addressEdited)
    }

    // SP-0220: no separate Customer Address; a typed one in an older draft is not sent, the built address is.
    @Test fun customerAddressIsAlwaysBuiltFromStreet1AndLocation() {
        val f = complete().let { CustomerCapture.withAddressTyped(it, "Near the chapel") }
        val p = CustomerCapture.payload(UUID.randomUUID().toString(), f, geography, 5000L, fix, jpeg)
        assertEquals("12 Gorordo Ave, Apas, City of Cebu, Cebu 6000", p.getString("address"))
        assertEquals("12 Gorordo Ave, Apas, City of Cebu, Cebu 6000", p.getJSONObject("customer").getString("customerAddress"))
        assertFalse(CustomerMaster.field("customerAddress").required)
        CensusRules.validate(p)
    }
}
