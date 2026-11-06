package com.sunpride.van.selling

import org.junit.Assert.*
import org.junit.Test

class PrivilegeTest {
    private val vat12 = TaxFact("vatable", 1200)
    private val exempt = TaxFact("exempt", 0)
    private val zero = TaxFact("zero_rated", 0)
    private fun claim(type: PrivilegeType, eligible: Set<String>? = null) = DiscountClaim(type, "SC-123456", "Juan Dela Cruz", eligible)

    @Test fun itemcountCase39PesosSeniorIs27pesos86() {
        val r = Privilege.cart(listOf(LegalInput("a", 3900, 0, vat12)), claim(PrivilegeType.SENIOR)).getOrThrow()
        assertEquals(2786L, r.total); assertEquals(696L, r.privilegeDiscount); assertEquals(418L, r.vatRemoved)
        assertTrue(r.applied)
        // the bucket convention: shown before the discount, so VAT-exempt sales (3482) = pay (2786) + discount (696)
        val l = r.lines.single(); assertEquals(3482L, l.vatExempt); assertEquals(0L, l.vatable); assertEquals(l.net + l.privilegeDiscount, l.vatExempt)
    }

    @Test fun mixedCartOnlyTheEligibleItemsGetTheDiscount() {
        val lines = listOf(LegalInput("a", 3900, 0, vat12), LegalInput("b", 11200, 0, exempt), LegalInput("c", 5000, 0, zero))
        val r = Privilege.cart(lines, claim(PrivilegeType.PWD, setOf("a", "b"))).getOrThrow()
        assertEquals(2786L, r.lines[0].net)          // VATable: VAT removed, then the discount
        assertEquals(8960L, r.lines[1].net)          // exempt: the discount on the line, nothing to remove
        assertEquals(5000L, r.lines[2].net)          // not eligible: untouched
        assertNull(r.lines[2].privilegeType)
        assertEquals(2786L + 8960L + 5000L, r.total)
        assertEquals(696L + 2240L, r.privilegeDiscount); assertEquals(418L, r.vatRemoved)
        assertEquals(5000L, r.lines[2].vatable + r.lines[2].vat + r.lines[2].zeroRated)
    }

    @Test fun athleteKeepsTheVatAndSoloParentGetsTenPercent() {
        val a = Privilege.cart(listOf(LegalInput("a", 3900, 0, vat12)), claim(PrivilegeType.ATHLETE)).getOrThrow().lines.single()
        assertEquals(3204L, a.net); assertEquals(0L, a.vatRemoved); assertEquals(3482L, a.vatable); assertEquals(418L, a.vat)
        val s = Privilege.cart(listOf(LegalInput("a", 3900, 0, vat12)), claim(PrivilegeType.SOLO_PARENT)).getOrThrow().lines.single()
        assertEquals(348L, s.privilegeDiscount); assertEquals(3482L - 348L, s.net)
    }

    @Test fun aBiggerPromoBeatsThePrivilegeAndTheyNeverStack() {
        val l = Privilege.cart(listOf(LegalInput("a", 3900, 1500, vat12)), claim(PrivilegeType.SENIOR)).getOrThrow()
        assertEquals(2400L, l.total); assertEquals(0L, l.privilegeDiscount); assertFalse(l.applied)
        assertEquals(1500L, l.lines.single().promoDiscount)
    }

    @Test fun aFreeGiftLineCarriesNoTaxAndNoDiscount() {
        val r = Privilege.cart(listOf(LegalInput("a", 3900, 0, vat12), LegalInput("gift", 0, 0, null)), claim(PrivilegeType.SENIOR)).getOrThrow()
        assertEquals(2786L, r.total)
    }

    @Test fun anItemWithNoTaxSetupIsRefusedNotGuessed() {
        val r = Privilege.cart(listOf(LegalInput("a", 3900, 0, null)), claim(PrivilegeType.SENIOR))
        assertTrue(r.isFailure); assertEquals(Privilege.NO_TAX_SETUP, r.exceptionOrNull()?.message)
    }

    @Test fun claimNeedsAnIdNumberAndAName() {
        assertNotNull(ClaimRules.problem(DiscountClaim(PrivilegeType.SENIOR, "", "Juan")))
        assertNotNull(ClaimRules.problem(DiscountClaim(PrivilegeType.SENIOR, "12", "Juan")))
        assertNotNull(ClaimRules.problem(DiscountClaim(PrivilegeType.PWD, "PWD-1234", " ")))
        assertNotNull(ClaimRules.problem(DiscountClaim(PrivilegeType.PWD, "PWD-1234", "Ana", emptySet())))
        assertNull(ClaimRules.problem(DiscountClaim(PrivilegeType.PWD, "PWD-1234", "Ana Reyes")))
        assertEquals("Choose the discount type.", ClaimRules.typeProblem("SC-1234", "Juan", null))
    }

    @Test fun claimJsonCarriesTheServerFieldsAndTheTotals() {
        val c = claim(PrivilegeType.SENIOR, setOf("b", "a"))
        val totals = Privilege.cart(listOf(LegalInput("a", 3900, 0, vat12)), c).getOrThrow()
        val j = c.json("privilegeDiscountMinor", "vatRemovedMinor", totals)
        assertEquals("senior", j.getString("type")); assertEquals("SC-123456", j.getString("idNumber")); assertEquals("Juan Dela Cruz", j.getString("holderName"))
        assertEquals("696", j.getString("privilegeDiscountMinor")); assertEquals("418", j.getString("vatRemovedMinor"))
        assertEquals("a", j.getJSONArray("eligibleProductIds").getString(0))
    }

    /** Every row comes from the SERVER's `computeLine` (privilege.js) run on the same inputs, so the two cannot drift apart silently. */
    @Test fun matchesTheServerFormulaOnEveryGoldenCase() {
        golden.forEach { g ->
            val type = PrivilegeType.of(g[0] as String?)
            val tax = TaxFact(g[1] as String, g[2] as Int)
            val gross = (g[3] as Int).toLong(); val promo = (g[4] as Int).toLong()
            val got = Privilege.line(gross, promo, tax, type)
            val label = g.joinToString("|")
            assertEquals("net $label", (g[5] as Int).toLong(), got.net)
            assertEquals("priv $label", (g[6] as Int).toLong(), got.privilegeDiscount)
            assertEquals("removed $label", (g[7] as Int).toLong(), got.vatRemoved)
            assertEquals("vatable $label", (g[8] as Int).toLong(), got.vatable)
            assertEquals("vat $label", (g[9] as Int).toLong(), got.vat)
            assertEquals("exempt $label", (g[10] as Int).toLong(), got.vatExempt)
            assertEquals("zero $label", (g[11] as Int).toLong(), got.zeroRated)
            assertEquals("promo $label", (g[12] as Int).toLong(), got.promoDiscount)
            assertEquals("type $label", g[13] as String?, got.privilegeType?.wire)
        }
    }

    // type, treatment, vat bps, gross, promo asked, then the server's: net, privilege, vatRemoved, vatable, vat, exempt, zero, promo, type
    private val golden: List<List<Any?>> = listOf(
        listOf("senior", "vatable", 1200, 3900, 0, 2786, 696, 418, 0, 0, 3482, 0, 0, "senior"),
        listOf("senior", "vatable", 1200, 12345, 400, 8818, 2204, 1323, 0, 0, 11022, 0, 0, "senior"),
        listOf("senior", "vatable", 1200, 250050, 0, 178607, 44652, 26791, 0, 0, 223259, 0, 0, "senior"),
        listOf("senior", "exempt", 0, 11200, 0, 8960, 2240, 0, 0, 0, 11200, 0, 0, "senior"),
        listOf("senior", "exempt", 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, null),
        listOf("senior", "exempt", 0, 7777, 3000, 4777, 0, 0, 0, 0, 4777, 0, 3000, null),
        listOf("senior", "zero_rated", 0, 5000, 1500, 3500, 0, 0, 0, 0, 0, 3500, 1500, null),
        listOf("senior", "zero_rated", 0, 99, 50, 49, 0, 0, 0, 0, 0, 49, 50, null),
        listOf("senior", "vatable", 1200, 3900, 0, 2786, 696, 418, 0, 0, 3482, 0, 0, "senior"),
        listOf("senior", "vatable", 1200, 12345, 400, 8818, 2204, 1323, 0, 0, 11022, 0, 0, "senior"),
        listOf("senior", "vatable", 1200, 250050, 0, 178607, 44652, 26791, 0, 0, 223259, 0, 0, "senior"),
        listOf("pwd", "vatable", 1200, 11200, 0, 8000, 2000, 1200, 0, 0, 10000, 0, 0, "pwd"),
        listOf("pwd", "vatable", 1200, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, null),
        listOf("pwd", "vatable", 1200, 7777, 3000, 4777, 0, 0, 4265, 512, 0, 0, 3000, null),
        listOf("pwd", "exempt", 0, 5000, 1500, 3500, 0, 0, 0, 0, 3500, 0, 1500, null),
        listOf("pwd", "exempt", 0, 99, 50, 49, 0, 0, 0, 0, 49, 0, 50, null),
        listOf("pwd", "zero_rated", 0, 3900, 0, 3120, 780, 0, 0, 0, 0, 3900, 0, "pwd"),
        listOf("pwd", "zero_rated", 0, 12345, 400, 9876, 2469, 0, 0, 0, 0, 12345, 0, "pwd"),
        listOf("pwd", "zero_rated", 0, 250050, 0, 200040, 50010, 0, 0, 0, 0, 250050, 0, "pwd"),
        listOf("pwd", "vatable", 1200, 11200, 0, 8000, 2000, 1200, 0, 0, 10000, 0, 0, "pwd"),
        listOf("pwd", "vatable", 1200, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, null),
        listOf("pwd", "vatable", 1200, 7777, 3000, 4777, 0, 0, 4265, 512, 0, 0, 3000, null),
        listOf("solo_parent", "vatable", 1200, 5000, 1500, 3500, 0, 0, 3125, 375, 0, 0, 1500, null),
        listOf("solo_parent", "vatable", 1200, 99, 50, 49, 0, 0, 44, 5, 0, 0, 50, null),
        listOf("solo_parent", "exempt", 0, 3900, 0, 3510, 390, 0, 0, 0, 3900, 0, 0, "solo_parent"),
        listOf("solo_parent", "exempt", 0, 12345, 400, 11110, 1235, 0, 0, 0, 12345, 0, 0, "solo_parent"),
        listOf("solo_parent", "exempt", 0, 250050, 0, 225045, 25005, 0, 0, 0, 250050, 0, 0, "solo_parent"),
        listOf("solo_parent", "zero_rated", 0, 11200, 0, 10080, 1120, 0, 0, 0, 0, 11200, 0, "solo_parent"),
        listOf("solo_parent", "zero_rated", 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, null),
        listOf("solo_parent", "zero_rated", 0, 7777, 3000, 4777, 0, 0, 0, 0, 0, 4777, 3000, null),
        listOf("solo_parent", "vatable", 1200, 5000, 1500, 3500, 0, 0, 3125, 375, 0, 0, 1500, null),
        listOf("solo_parent", "vatable", 1200, 99, 50, 49, 0, 0, 44, 5, 0, 0, 50, null),
        listOf("athlete", "vatable", 1200, 3900, 0, 3204, 696, 0, 3482, 418, 0, 0, 0, "athlete"),
        listOf("athlete", "vatable", 1200, 12345, 400, 10141, 2204, 0, 11022, 1323, 0, 0, 0, "athlete"),
        listOf("athlete", "vatable", 1200, 250050, 0, 205398, 44652, 0, 223259, 26791, 0, 0, 0, "athlete"),
        listOf("athlete", "exempt", 0, 11200, 0, 8960, 2240, 0, 0, 0, 11200, 0, 0, "athlete"),
        listOf("athlete", "exempt", 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, null),
        listOf("athlete", "exempt", 0, 7777, 3000, 4777, 0, 0, 0, 0, 4777, 0, 3000, null),
        listOf("athlete", "zero_rated", 0, 5000, 1500, 3500, 0, 0, 0, 0, 0, 3500, 1500, null),
        listOf("athlete", "zero_rated", 0, 99, 50, 49, 0, 0, 0, 0, 0, 49, 50, null),
        listOf("athlete", "vatable", 1200, 3900, 0, 3204, 696, 0, 3482, 418, 0, 0, 0, "athlete"),
        listOf("athlete", "vatable", 1200, 12345, 400, 10141, 2204, 0, 11022, 1323, 0, 0, 0, "athlete"),
        listOf("athlete", "vatable", 1200, 250050, 0, 205398, 44652, 0, 223259, 26791, 0, 0, 0, "athlete"),
        listOf("uniformed", "vatable", 1200, 11200, 0, 9000, 1000, 1200, 0, 0, 10000, 0, 0, "uniformed"),
        listOf("uniformed", "vatable", 1200, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, null),
        listOf("uniformed", "vatable", 1200, 7777, 3000, 4777, 0, 0, 4265, 512, 0, 0, 3000, null),
        listOf("uniformed", "exempt", 0, 5000, 1500, 3500, 0, 0, 0, 0, 3500, 0, 1500, null),
        listOf("uniformed", "exempt", 0, 99, 50, 49, 0, 0, 0, 0, 49, 0, 50, null),
        listOf("uniformed", "zero_rated", 0, 3900, 0, 3510, 390, 0, 0, 0, 0, 3900, 0, "uniformed"),
        listOf("uniformed", "zero_rated", 0, 12345, 400, 11110, 1235, 0, 0, 0, 0, 12345, 0, "uniformed"),
        listOf("uniformed", "zero_rated", 0, 250050, 0, 225045, 25005, 0, 0, 0, 0, 250050, 0, "uniformed"),
        listOf("uniformed", "vatable", 1200, 11200, 0, 9000, 1000, 1200, 0, 0, 10000, 0, 0, "uniformed"),
        listOf("uniformed", "vatable", 1200, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, null),
        listOf("uniformed", "vatable", 1200, 7777, 3000, 4777, 0, 0, 4265, 512, 0, 0, 3000, null),
        listOf(null, "vatable", 1200, 5000, 1500, 3500, 0, 0, 3125, 375, 0, 0, 1500, null),
        listOf(null, "vatable", 1200, 99, 50, 49, 0, 0, 44, 5, 0, 0, 50, null),
        listOf(null, "exempt", 0, 3900, 0, 3900, 0, 0, 0, 0, 3900, 0, 0, null),
        listOf(null, "exempt", 0, 12345, 400, 11945, 0, 0, 0, 0, 11945, 0, 400, null),
        listOf(null, "exempt", 0, 250050, 0, 250050, 0, 0, 0, 0, 250050, 0, 0, null),
        listOf(null, "zero_rated", 0, 11200, 0, 11200, 0, 0, 0, 0, 0, 11200, 0, null),
        listOf(null, "zero_rated", 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, null),
        listOf(null, "zero_rated", 0, 7777, 3000, 4777, 0, 0, 0, 0, 0, 4777, 3000, null),
        listOf(null, "vatable", 1200, 5000, 1500, 3500, 0, 0, 3125, 375, 0, 0, 1500, null),
        listOf(null, "vatable", 1200, 99, 50, 49, 0, 0, 44, 5, 0, 0, 50, null),
    )
}
