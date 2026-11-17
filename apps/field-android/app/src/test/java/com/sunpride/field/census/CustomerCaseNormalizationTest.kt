package com.sunpride.field.census

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Locale

/** SP-0182: actual form serialization, including drafts restored before any field loses focus. */
class CustomerCaseNormalizationTest {
    @Test fun lowerUpperAndMixedCaseMatchTheWebsiteIncludingAccentsAndPunctuation() {
        val examples = listOf(
            "aling rosa store" to "Aling Rosa Store",
            "ALING ROSA STORE" to "Aling Rosa Store",
            "aLiNg rOsA sToRe" to "Aling Rosa Store",
            "  PEÑA'S  SARI-SARI / o'NEIL d’ANGELO\nMUÑOZ" to "  Peña's  Sari-Sari / O'Neil D’Angelo\nMuñoz",
            "12B GORORDO AVE., CEBU" to "12B Gorordo Ave., Cebu",
            "PEN\u0303A STORE" to "Pen\u0303a Store",
            "" to "",
        )
        for ((input, expected) in examples) {
            assertEquals(input, expected, CustomerCapture.normalizeText("customerName", input))
            assertEquals(expected, expected, CustomerCapture.normalizeText("customerName", expected))
        }
    }

    @Test fun everyDescriptiveFieldIsNormalizedButNoIdentifierOrPickerIsChanged() {
        for (field in CustomerMaster.FIELDS) {
            val descriptive = field.kind == CustomerMaster.Kind.TEXT && !field.key.endsWith("Code") && field.key != "clusterNo"
            assertEquals(field.key, if (descriptive) "Mixed Text" else "mIXed TEXT",
                CustomerCapture.normalizeText(field.key, "mIXed TEXT"))
        }
        for ((key, value) in mapOf(
            "email" to "Sales.Team+CEBU@Example.COM", "shipToEmail" to "Delivery.Team@Example.COM",
            "code" to "SAP-abC001", "distributorCode" to "dIST-aBC123", "clusterNo" to "CL-a1",
            "mobileNo" to "+639175550101", "shipToMobileNo" to "0917 555 0202", "tin" to "001-002-003",
            "creditLimit" to "1,234.50", "latitude" to "10.331200", "unknownKey" to "RAW text",
        )) assertEquals(key, value, CustomerCapture.normalizeText(key, value))
    }

    @Test fun caseDoesNotDependOnThePhoneLanguage() {
        val before = Locale.getDefault()
        try {
            Locale.setDefault(Locale.forLanguageTag("tr-TR"))
            assertEquals("Isabel Inc.", CustomerCapture.normalizeText("registeredName", "ISABEL INC."))
            assertEquals("Sales.I@Example.COM", CustomerCapture.normalizeText("email", "Sales.I@Example.COM"))
        } finally { Locale.setDefault(before) }
    }

    private fun form() = CustomerCapture.Form(
        registeredName = "ALING ROSA STORE INC.", tradeName = "peña's sari-sari", customerName = "aLiNg rOsA sToRe",
        email = "Sales.Team+CEBU@Example.COM", mobileNo = "0917 555 0101", telNo = "02 1234",
        tin = "001-002-003", houseNo = "12b", street1 = "GORORDO AVE.", street2 = "near THE CHAPEL",
        floor = "SECOND FLOOR", roomStallNo = "stall a", provinceCode = "0722", municipalityCode = "0730",
        barangayCode = "07300001", postalCode = "6000", salesOrgCode = "1000", distributionChannelCode = "40",
        customerGroup1Code = "ADP", customerGroup2Code = "DAW", typeOfBusiness = "Sole Proprietor",
        contactPerson = "JUAN o'NEIL", details = CustomerMaster.CUSTOMER_FIELDS.filter { it.adp }
            .associate { it.key to "mIXed TEXT" } + mapOf("creditLimit" to "1234.50", "paymentTermsCode" to "0003"),
    )
    private fun payload(f: CustomerCapture.Form, g: CustomerCapture.Geography? = null) = CustomerCapture.payload(
        "00000000-0000-4000-8000-000000000000", f, g, 5000L, JSONObject(), "",
    )

    @Test fun saveWithoutBlurNormalizesMainFieldsAndAdpButKeepsCodesEmailAndAmounts() {
        val f = form()
        val p = payload(f)
        val c = p.getJSONObject("customer")
        for ((key, expected) in mapOf(
            "registeredName" to "Aling Rosa Store Inc.", "tradeName" to "Peña's Sari-Sari", "customerName" to "Aling Rosa Store",
            "houseNo" to "12B", "street1" to "Gorordo Ave.", "street2" to "Near The Chapel", "floor" to "Second Floor",
            "roomStallNo" to "Stall A", "email" to f.email, "mobileNo" to f.mobileNo, "telNo" to f.telNo, "tin" to f.tin,
            "salesOrgCode" to "1000", "distributionChannelCode" to "40", "customerGroup1Code" to "ADP", "customerGroup2Code" to "DAW",
            "typeOfBusiness" to "Sole Proprietor", "creditLimit" to "1234.50", "paymentTermsCode" to "0003",
        )) assertEquals(key, expected, c.getString(key))
        for (field in CustomerMaster.CUSTOMER_FIELDS.filter { it.adp })
            assertEquals(field.key, if (field.key.endsWith("Code") || field.key == "clusterNo") "mIXed TEXT" else "Mixed Text", c.getString(field.key))
        assertEquals(c.getString("registeredName"), p.getString("name")) // SP-0196: the store
        assertEquals("Juan O'Neil", p.getString("ownerName"))
        assertEquals(f.mobileNo, p.getString("ownerPhone"))
        assertEquals("ALING ROSA STORE INC.", f.registeredName) // no mutation of a draft or queued operation
    }

    @Test fun copiedShipToAndGeneratedAddressKeepOfficialGeographyLabels() {
        val g = CustomerCapture.Geography(emptyList(), listOf(CustomerMaster.GeoProvince("0722", "Cebu", "07")),
            listOf(CustomerMaster.GeoMunicipality("0730", "City of Cebu", "0722")), mapOf("0730" to listOf("6000")),
            mapOf("0722" to listOf(CustomerMaster.GeoBarangay("07300001", "Santo Niño (Pob.)", "0730"))))
        val f = form()
        val expected = "Stall A, Second Floor, 12B Gorordo Ave., Near The Chapel, Santo Niño (Pob.), City of Cebu, Cebu 6000"
        val p = payload(f, g); val c = p.getJSONObject("customer")
        val ship = c.getJSONArray("shipTos").getJSONObject(0)
        assertEquals(expected, CustomerCapture.address(f, g))
        assertEquals(expected, c.getString("customerAddress")); assertEquals(expected, p.getString("address"))
        assertEquals(expected, ship.getString("shipToAddress"))
        assertEquals("Aling Rosa Store", ship.getString("shipToParty"))
        assertEquals("Juan O'Neil", ship.getString("contactPerson"))
        assertEquals(f.email, ship.getString("email")); assertEquals(f.mobileNo, ship.getString("mobileNo"))
        assertEquals("", f.detail("customerAddress")) // generated address is not converted to a custom one
        assertTrue(CustomerCapture.address(f.copy(street1 = "NEW ROAD"), g).contains("12B New Road"))
    }

    @Test fun customAddressAndSeparateDeliveryNormalizeWithoutTouchingEitherEmail() {
        val f = form().withDetail("customerAddress", "NEAR THE CHAPEL").copy(sameAsCustomer = false,
            shipToParty = "SECOND WAREHOUSE", shipToAddress = "99 MAIN STREET", shipToMobileNo = "09175550202",
            shipToEmail = "Other.Team@Example.COM")
        val p = payload(f); val c = p.getJSONObject("customer"); val ship = c.getJSONArray("shipTos").getJSONObject(0)
        assertEquals("Near The Chapel", c.getString("customerAddress")); assertEquals("Near The Chapel", p.getString("address"))
        assertEquals("Second Warehouse", ship.getString("shipToParty")); assertEquals("99 Main Street", ship.getString("shipToAddress"))
        assertEquals("Juan O'Neil", ship.getString("contactPerson"))
        assertEquals(f.email, c.getString("email")); assertEquals(f.shipToEmail, ship.getString("email"))
        assertEquals(f.shipToMobileNo, ship.getString("mobileNo"))
    }

    @Test fun restoredUnnormalizedDraftIsKeptIntactAndNormalizesWhenSubmitted() {
        val f = form().withDetail("customerAddress", "NEAR THE CHAPEL").copy(sameAsCustomer = false,
            shipToParty = "SECOND WAREHOUSE", shipToAddress = "99 MAIN STREET", shipToEmail = "Other.Team@Example.COM")
        val photo = byteArrayOf(1, 2, 3)
        val restored = CustomerCapture.parseDraft(CustomerCapture.draftJson(CustomerCapture.Draft(f, null, photo)))!!
        assertEquals(f, restored.form); assertArrayEquals(photo, restored.photo)
        val c = payload(restored.form).getJSONObject("customer")
        assertEquals("Aling Rosa Store", c.getString("customerName"))
        assertEquals("Near The Chapel", c.getString("customerAddress"))
        assertEquals("Second Warehouse", c.getJSONArray("shipTos").getJSONObject(0).getString("shipToParty"))
        assertEquals(f.email, c.getString("email")); assertEquals("mIXed TEXT", c.getString("distributorCode"))
    }
}
