package com.sunpride.field.census

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EnrollmentFieldsTest {
    private fun key(i: Int) = "cf_" + i.toString().padStart(32,'0')
    private val fields = listOf("text","number","date","choice","boolean","photo").mapIndexed { i,kind ->
        EnrollmentFields.Field(key(i),"Sample $kind",kind,if(kind=="choice") listOf("Red","Blue") else emptyList(),listOf("10"),listOf("Corporate"))
    }
    @Test fun requiredOnlyForEitherChosenAudienceAndNoAndZeroAreNotBlank() {
        assertEquals(6,EnrollmentFields.errors(fields,CustomerCapture.Form(distributionChannelCode="10")).size)
        assertEquals(6,EnrollmentFields.errors(fields,CustomerCapture.Form(typeOfBusiness="Corporate")).size)
        assertTrue(EnrollmentFields.errors(fields,CustomerCapture.Form(distributionChannelCode="41")).isEmpty())
        val values=mapOf(key(0) to "Front desk",key(1) to "0",key(2) to "2024-02-29",key(3) to "Red",key(4) to "false",key(5) to "data:image/jpeg;base64,/9j/2Q==")
        val f=CustomerCapture.Form(distributionChannelCode="10",customFields=values)
        assertTrue(EnrollmentFields.errors(fields,f).isEmpty())
        for ((key,value) in mapOf(key(1) to "-",key(2) to "2026-02-30",key(3) to "Unknown",key(4) to "-",key(5) to "http://foreign/photo")) {
            assertEquals(1,EnrollmentFields.errors(fields,f.copy(customFields=values+(key to value))).size)
        }
    }
    @Test fun customValuesSurvivePhoneDraftAndPayloadWithoutChangingBuiltInFields() {
        val original=CustomerCapture.Form(registeredName="Sample Store",street1="Sample Street",customFields=mapOf(key(0) to "Desk",key(4) to "false"))
        val draft=CustomerCapture.Draft(original,null,null)
        assertFalse(draft.isEmpty())
        val restored=CustomerCapture.parseDraft(CustomerCapture.draftJson(draft))!!
        assertEquals(original.customFields,restored.form.customFields)
        assertEquals("Sample Street",restored.form.street1)
        val sent=CustomerCapture.customer(restored.form,null).getJSONObject("customFields")
        assertEquals("false",sent.getString(key(4)))
        assertEquals("Desk",sent.getString(key(0)))
    }
    @Test fun downloadedOrderAndConditionalRulesAreKept() {
        val rows=JSONArray()
        fields.reversed().forEach { f -> rows.put(JSONObject().put("key",f.key).put("label",f.label).put("kind",f.kind).put("choices",JSONArray(f.choices)).put("requiredChannels",JSONArray(f.requiredChannels)).put("requiredTypes",JSONArray(f.requiredTypes))) }
        assertEquals(fields.reversed(),EnrollmentFields.parse(rows))
    }
}
