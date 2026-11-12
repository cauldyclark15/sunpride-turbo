package com.sunpride.field.census

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** SP-0170: the Kotlin customer rules and labels equal the JS package (`@sunpride/customer-master`).
 * The fixture is generated from the JS package and checked against it by
 * packages/customer-master/test/android-parity.test.js, so a JS change without a Kotlin change fails one side. */
class CustomerMasterParityTest {
    private val fixture: JSONObject by lazy {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val f = File(dir, "packages/customer-master/fixtures/android-parity.json")
            if (f.isFile) return@lazy JSONObject(f.readText())
            dir = dir.parentFile
        }
        error("packages/customer-master/fixtures/android-parity.json not found above ${System.getProperty("user.dir")}")
    }
    private fun objects(a: JSONArray) = (0 until a.length()).map { a.getJSONObject(it) }
    private fun plain(v: Any?): Any? = when (v) {
        null, JSONObject.NULL -> null
        is JSONObject -> v.keys().asSequence().associateWith { plain(v.get(it)) }
        is JSONArray -> (0 until v.length()).map { plain(v.get(it)) }
        else -> v
    }
    private fun str(o: JSONObject, k: String): String? = if (!o.has(k) || o.isNull(k)) null else o.getString(k)
    private val index by lazy {
        CustomerMaster.ReferenceIndex(objects(fixture.getJSONArray("lists")).map {
            CustomerMaster.RefRow(it.getString("list"), it.getString("salesOrgCode"), it.getString("channelCode"),
                it.getString("group1Code"), it.getString("code"), it.getString("name"))
        })
    }

    @Test fun fieldsSectionsAndLabelsMatchTheSheetOrder() {
        assertEquals(plain(fixture.getJSONArray("sections")), CustomerMaster.SECTIONS)
        assertEquals(fixture.getString("adpChannel"), CustomerMaster.ADP_CHANNEL)
        val js = objects(fixture.getJSONArray("fields"))
        assertEquals(js.size, CustomerMaster.FIELDS.size)
        js.zip(CustomerMaster.FIELDS).forEach { (j, k) ->
            val expected = listOf(j.getString("key"), j.getString("label"), j.getString("section"), j.getBoolean("required"),
                j.getString("kind"), str(j, "list"), if (j.has("max")) j.getInt("max") else null, j.getBoolean("shipTo"), j.getBoolean("adp"))
            assertEquals(expected, listOf(k.key, k.label, k.section, k.required, k.kind.wire, k.list, k.max, k.shipTo, k.adp))
        }
    }

    @Test fun fieldCaptureIsTheAgentsPartInSheetOrder() {
        val order = CustomerMaster.CUSTOMER_FIELDS.map { it.key }
        assertEquals(CustomerMaster.FIELD_CAPTURE, CustomerMaster.FIELD_CAPTURE.sortedBy { order.indexOf(it) })
        assertTrue(CustomerMaster.FIELD_CAPTURE.all { it in order })
        // SPEC rule 10: the office completes these.
        for (office in listOf("taxClassificationCode", "salesOfficeCode", "paymentTermsCode", "creditLimit", "pricingProcedureCode",
            "deliveringPlantCode")) assertTrue(office !in CustomerMaster.FIELD_CAPTURE)
        assertEquals(CustomerMaster.CUSTOMER_FIELDS.filter { it.section == CustomerMaster.GENERAL }.map { it.key } - "taxClassificationCode",
            CustomerMaster.FIELD_CAPTURE.take(8))
    }

    @Test fun everyValidationCaseAnswersLikeJs() {
        val cases = objects(fixture.getJSONArray("cases"))
        assertTrue(cases.size > 20)
        for (c in cases) {
            @Suppress("UNCHECKED_CAST")
            val input = plain(c.getJSONObject("input")) as Map<String, Any?>
            val geography = c.optJSONObject("geography")?.let { g ->
                fun o(k: String) = g.optJSONObject(k)
                CustomerMaster.ResolvedGeography(
                    o("region")?.let { CustomerMaster.GeoRegion(it.getString("code"), it.getString("name")) },
                    o("province")?.let { CustomerMaster.GeoProvince(it.getString("code"), it.getString("name"), it.getString("regionCode")) },
                    o("municipality")?.let { CustomerMaster.GeoMunicipality(it.getString("code"), it.getString("name"), it.getString("provinceCode")) },
                    o("barangay")?.let { CustomerMaster.GeoBarangay(it.getString("code"), it.getString("name"), it.getString("municipalityCode")) },
                    g.optJSONArray("postalCodes")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty())
            }
            val r = CustomerMaster.validate(input, c.getString("level"), index, geography)
            val expected = c.getJSONObject("expected")
            val name = c.getString("name")
            assertEquals(name, objects(expected.getJSONArray("errors")).map { Triple(it.getString("code"), it.getString("field"), it.getString("message")) },
                r.errors.map { Triple(it.code, it.field, it.message) })
            assertEquals(name, expected.getBoolean("ok"), r.ok)
            val v = expected.getJSONObject("value")
            for (k in listOf("mobileNo", "tin", "email")) assertEquals("$name $k", str(v, k), r.value[k])
        }
    }

    @Test fun conditionalChainAnswersLikeJs() {
        for (c in objects(fixture.getJSONArray("chains"))) {
            val i = c.getJSONObject("input"); val e = c.getJSONObject("expected")
            val a = CustomerMaster.applicability(index, str(i, "salesOrgCode"), str(i, "distributionChannelCode"), str(i, "customerGroup1Code"))
            fun b(k: String): Boolean? = if (e.isNull(k)) null else e.getBoolean(k)
            assertEquals(i.toString(), CustomerMaster.Applicability(b("group1"), b("group2"), e.getBoolean("adp")), a)
        }
    }

    @Test fun addressAndOptionLabelsAnswerLikeJs() {
        for (c in objects(fixture.getJSONArray("addresses"))) {
            val i = c.getJSONObject("input")
            assertEquals(str(c, "expected"), CustomerMaster.formatAddress(str(i, "roomStallNo"), str(i, "floor"), str(i, "houseNo"),
                str(i, "street1"), str(i, "street2"), str(i, "barangayName"), str(i, "municipalityName"), str(i, "provinceName"), str(i, "postalCode")))
        }
        for (c in objects(fixture.getJSONArray("labels")))
            assertEquals(c.getString("expected"), CustomerMaster.optionLabel(c.getString("code"), c.getString("name")))
    }
}
