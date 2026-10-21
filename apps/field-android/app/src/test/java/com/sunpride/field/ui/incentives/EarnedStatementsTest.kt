package com.sunpride.field.ui.incentives

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnedStatementsTest {
    private fun fixture() = JSONObject("""{"rows":[{"plan_name":"Sample earned plan","period_from":"2026-10-01","period_to":"2026-10-31","status":"calculated","plan_source":"sample","amountCentavos":1005,"result":{"lines":[{"metric":"targets","actual":3,"target":4,"amountCentavos":1005},{"metric":"coverage","actual":null,"target":null,"amountCentavos":0,"excluded":true}]}}]}""")
    @Test fun currentPersonalStatementsKeepUnknownExcludedAndExactCentavos() {
        val rows=EarnedStatements.decode(fixture())
        assertEquals(1,rows.size)
        assertEquals(1005L,rows.single().amountMinor)
        assertTrue(rows.single().sample)
        assertEquals("calculated",rows.single().status)
        assertEquals("3",rows.single().metrics.first().actual)
        assertEquals("Unknown",rows.single().metrics.last().actual)
        assertTrue(rows.single().metrics.last().excluded)
        assertTrue(EarnedStatements.money(1005).contains("10.05"))
        assertEquals("/api/v1/account/incentives",EarnedStatements.PATH)
    }
    @Test fun malformedOrFractionalMoneyNeverBecomesZero() {
        val body=fixture()
        body.getJSONArray("rows").getJSONObject(0).put("amountCentavos",10.5)
        assertThrows(IllegalArgumentException::class.java) { EarnedStatements.decode(body) }
        body.getJSONArray("rows").getJSONObject(0).put("amountCentavos","9223372036854775808")
        assertThrows(NumberFormatException::class.java) { EarnedStatements.decode(body) }
    }
}
