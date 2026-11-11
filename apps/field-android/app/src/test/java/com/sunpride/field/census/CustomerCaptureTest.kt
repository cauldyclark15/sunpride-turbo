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
    private fun complete() = CustomerCapture.start(setup, "Aling Nena Store").copy(mobileNo = "0917 555 0101",
        regionCode = "0700000000", provinceCode = "0702200000", municipalityCode = "0730600000", barangayCode = "0730600003",
        houseNo = "12", street1 = "Gorordo Ave", postalCode = "6000", distributionChannelCode = "41", customerGroup1Code = "RSF",
        customerGroup2Code = "RSS", customerGroupCode = "74", typeOfBusiness = "Sole Proprietor", contactPerson = "Nena Cruz")
    private val fix = JSONObject().put("latitude", 10.3312).put("longitude", 123.9056).put("accuracyMeters", 9.0)
        .put("fixTime", 5000L).put("provider", "gps").put("mockSignal", false)
    private val jpeg = Base64.getEncoder().encodeToString(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xd9.toByte()))

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
        // Barangay only when its list is on the phone; Postal Code only when the municipality has one.
        val bohol = complete().withProvince("0704600000").withMunicipality("0701200000", geography)
        assertEquals(emptyList<String>(), missing(bohol))
        assertEquals(listOf("barangayCode"), missing(complete().copy(barangayCode = "")))
        val blank = CustomerCapture.missing(CustomerCapture.Form(), setup, geography, hasFix = false, hasPhoto = false)
        assertEquals(listOf("customerName", "mobileNo", "regionCode", "provinceCode", "municipalityCode", "barangayCode", "coordinates",
            "salesOrgCode", "distributionChannelCode", "customerGroup1Code", "customerGroup2Code", "customerGroupCode", "typeOfBusiness",
            "contactPerson", "photo"), blank.map { it.key })
        assertEquals("Customer Name is required.", blank.first().message)
        assertEquals("Contact Person is required.", blank.first { it.key == "contactPerson" }.message)
    }

    @Test fun draftErrorsUseTheClientsLabels() {
        assertEquals(emptyList<Any>(), CustomerCapture.draftErrors(complete(), setup, geography, 10.33, 123.9))
        val bad = complete().copy(mobileNo = "12345", tin = "12-3", email = "x")
        assertEquals(listOf("email", "mobileNo", "tin"), CustomerCapture.draftErrors(bad, setup, geography, 10.33, 123.9).map { it.field })
        assertEquals("Mobile No. must be a Philippine mobile number: 09XXXXXXXXX or +639XXXXXXXXX.",
            CustomerCapture.draftErrors(bad, setup, geography, 10.33, 123.9).first { it.field == "mobileNo" }.message)
        assertEquals(listOf("postal_code_mismatch"), CustomerCapture.draftErrors(complete().copy(postalCode = "6014"), setup, geography, 10.33, 123.9).map { it.code })
    }

    @Test fun payloadCarriesTheCustomerObjectAndPassesTheOutboxCheck() {
        val id = UUID.randomUUID().toString()
        val p = CustomerCapture.payload(id, complete(), geography, 5000L, fix, jpeg)
        val c = p.getJSONObject("customer")
        assertEquals("12 Gorordo Ave, Apas, City of Cebu, Cebu 6000", c.getString("customerAddress"))
        assertEquals(c.getString("customerAddress"), p.getString("address"))
        assertEquals(listOf("customerName", "mobileNo", "regionCode", "provinceCode", "municipalityCode", "barangayCode", "houseNo",
            "street1", "postalCode", "salesOrgCode", "distributionChannelCode", "customerGroup1Code", "customerGroup2Code",
            "customerGroupCode", "typeOfBusiness", "customerAddress").sorted(), c.keys().asSequence().toList().sorted())
        assertEquals("Aling Nena Store", p.getString("name")); assertEquals("Nena Cruz", p.getString("ownerName"))
        assertEquals("0917 555 0101", p.getString("ownerPhone")); assertEquals("gps", p.getString("locationSource"))
        for (old in listOf("channelId", "subchannelId", "estimatedClass", "batchId", "kind")) assertFalse(old, p.has(old))
        CensusRules.validate(p) // routes to CustomerCapture.validate
        val intent = CensusRules.intent(StoreScope("account", "device", "scope"), p, 5000L)
        assertEquals(CensusRules.KIND, intent.kind)
        assertEquals(p.toString(), JSONObject(intent.serializedOperation).getJSONObject("payload").toString())
    }

    @Test fun outboxCheckRefusesBadCaptures() {
        fun refused(p: JSONObject) = runCatching { CensusRules.validate(p) }.isFailure
        val ok = CustomerCapture.payload(UUID.randomUUID().toString(), complete(), geography, 5000L, fix, jpeg)
        assertTrue(refused(JSONObject(ok.toString()).also { it.getJSONObject("customer").put("mobileNo", "123") }))
        assertTrue(refused(JSONObject(ok.toString()).also { it.getJSONObject("customer").put("nonsense", "x") }))
        assertTrue(refused(JSONObject(ok.toString()).put("ownerName", " ")))
        assertTrue(refused(JSONObject(ok.toString()).put("photoJpegBase64", "")))
        assertTrue(refused(JSONObject(ok.toString()).also { it.getJSONObject("location").put("accuracyMeters", 80.0) }))
        assertTrue(refused(JSONObject(ok.toString()).also { it.getJSONObject("location").put("mockSignal", true) }))
        assertFalse(refused(ok))
    }
}
