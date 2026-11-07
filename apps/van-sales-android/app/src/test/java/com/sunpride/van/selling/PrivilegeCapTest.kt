package com.sunpride.van.selling

import com.sunpride.van.data.*
import com.sunpride.van.pos.*
import com.sunpride.van.printing.ReceiptDiscounts
import com.sunpride.van.storage.OutboxRow
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * IP-SCPWD-CAP: the weekly limit on the phone. The allocation is the SAME as the server's (`computeWithBudget`); both are held to
 * `privilege-cap-vectors.json` (copied from `apps/api/test/fixtures`, the API suite checks the two files are identical).
 */
class PrivilegeCapTest {
    private val manila = ZoneId.of("Asia/Manila")
    private fun ms(text: String) = ZonedDateTime.parse(text).toInstant().toEpochMilli()

    @Test fun everySharedVectorGivesTheServersNumbers() {
        val root = JSONObject(checkNotNull(javaClass.getResourceAsStream("/privilege-cap-vectors.json")).bufferedReader().use { it.readText() })
        val vectors = root.getJSONArray("vectors")
        assertTrue(vectors.length() >= 12)
        for (i in 0 until vectors.length()) {
            val v = vectors.getJSONObject(i); val name = v.getString("name")
            val type = PrivilegeType.of(v.getString("type"))!!
            val lines = v.getJSONArray("lines")
            val eligible = (0 until lines.length()).map { lines.getJSONObject(it) }.filter { it.getBoolean("eligible") }.map { it.getString("productId") }.toSet()
            val inputs = (0 until lines.length()).map { lines.getJSONObject(it) }.map { l ->
                LegalInput(l.getString("productId"), l.getLong("gross"), l.getLong("promo"), TaxFact(l.getString("treatment"), l.getInt("vatBps")).takeIf { l.getLong("gross") > 0 } ?: TaxFact("vatable", 1200))
            }
            val budget = if (v.isNull("budget")) null else v.getLong("budget")
            val cart = Privilege.cart(inputs, DiscountClaim(type, "SC-123456", "Test Person", eligible), budget).getOrThrow()
            val e = v.getJSONObject("expect")
            assertEquals(name, e.getLong("appliedGross"), cart.appliedGross)
            assertEquals(name, e.getLong("eligibleGross"), cart.eligibleGross)
            assertEquals(name, e.getLong("total"), cart.total)
            assertEquals(name, e.getLong("privilegeDiscount"), cart.privilegeDiscount)
            assertEquals(name, e.getLong("vatRemoved"), cart.vatRemoved)
            val rows = e.getJSONArray("lines")
            for (j in 0 until rows.length()) {
                val r = rows.getJSONObject(j); val l = cart.lines[j]
                assertEquals("$name line $j net", r.getLong("net"), l.net)
                assertEquals("$name line $j discount", r.getLong("privilegeDiscount"), l.privilegeDiscount)
                assertEquals("$name line $j vatable", r.getLong("vatable"), l.vatable)
                assertEquals("$name line $j vat", r.getLong("vat"), l.vat)
                assertEquals("$name line $j exempt", r.getLong("exempt"), l.vatExempt)
                assertEquals("$name line $j zero", r.getLong("zero"), l.zeroRated)
                assertEquals("$name line $j privileged", r.getBoolean("privileged"), l.privilegeType != null)
                // BIR identity: buckets = amount paid + privilege discount
                assertEquals(l.net + l.privilegeDiscount, l.vatable + l.vat + l.vatExempt + l.zeroRated)
            }
        }
    }

    @Test fun noBudgetIsTheSameAsBeforeThisChange() {
        val inputs = listOf(LegalInput("a", 3_900, 0, TaxFact("vatable", 1200)))
        val claim = DiscountClaim(PrivilegeType.SENIOR, "SC-1", "Ana")
        val plain = Privilege.cart(inputs, claim).getOrThrow()
        assertEquals(2_786L, plain.total); assertNull(plain.budget)
        assertEquals(plain.total, Privilege.cart(inputs, claim, null).getOrThrow().total)
        // a claim with no budget sends no capBasis: an older server and the server's "no limit on this phone" reading both see the old shape
        assertFalse(claim.json("privilegeDiscountCentavos", "vatRemovedCentavos", plain).has("capBasis"))
    }

    @Test fun theClaimCarriesWhatTheWeeklyLimitLeftOutOnTheWire() {
        val inputs = listOf(LegalInput("a", 100_000, 0, TaxFact("vatable", 1200)))
        val claim = DiscountClaim(PrivilegeType.PWD, "PWD-9", "Mario")
        val cart = Privilege.cart(inputs, claim, 30_000).getOrThrow()
        val json = claim.copy(capBudget = cart.budget).json("privilegeDiscountMinor", "vatRemovedMinor", cart)
        assertEquals("30000", json.getJSONObject("capBasis").getString("budgetCentavos"))
        assertEquals("30000", json.getJSONObject("capBasis").getString("appliedCentavos"))
        assertEquals("5357", json.getString("privilegeDiscountMinor")); assertEquals("91429", cart.total.toString())
    }

    @Test fun weekIsMondayToSundayInManilaAndMatchesTheServer() {
        // Sunday 8 Nov 2026 23:59:59 Manila is still the week of Monday 2 Nov; Monday 9 Nov 00:00 starts the next one.
        assertEquals("2026-11-02", PrivilegeCap.weekStart(ms("2026-11-08T23:59:59+08:00")))
        assertEquals("2026-11-09", PrivilegeCap.weekStart(ms("2026-11-09T00:00:00+08:00")))
        assertEquals("2026-10-26", PrivilegeCap.weekStart(ms("2026-11-01T23:59:59+08:00")))
        assertEquals("2026-11-09", PrivilegeCap.weekStart(ms("2026-11-08T16:00:00Z")))
        assertEquals(ms("2026-11-02T00:00:00+08:00"), PrivilegeCap.weekStartMs(ms("2026-11-04T15:00:00+08:00")))
        // the same key and hash the server computes for this card (apps/api test: idHash(idKey("senior","SC-2026-004411")))
        assertEquals("senior:SC2026004411", PrivilegeCap.idKey(PrivilegeType.SENIOR, "SC-2026-004411"))
        assertEquals("senior:SC2026004411", PrivilegeCap.idKey(PrivilegeType.SENIOR, "sc 2026/004411."))
        assertEquals("1caffdc2449f3bcb102807539cdbb114", PrivilegeCap.idHash(PrivilegeCap.idKey(PrivilegeType.SENIOR, "SC-2026-004411")))
        assertNotEquals(PrivilegeCap.idKey(PrivilegeType.PWD, "SC-2026-004411"), PrivilegeCap.idKey(PrivilegeType.SENIOR, "SC-2026-004411"))
    }

    private val now = ms("2026-11-05T10:00:00+08:00")
    private fun bundle(used: Map<String, Long> = emptyMap(), week: String = "2026-11-02", enabled: Boolean = true, asOf: Long = now - 60_000): JSONObject = JSONObject()
        .put("version", 1).put("enabled", enabled).put("capCentavos", "130000").put("confirmed", false).put("weekStart", week).put("weekEndsAt", now + 1).put("asOf", asOf).put("complete", true)
        .put("used", JSONArray(used.map { (k, v) -> JSONObject().put("k", k).put("v", v.toString()) }))
    private val senior = DiscountClaim(PrivilegeType.SENIOR, "SC-2026-004411", "Juana")
    private val hash = PrivilegeCap.idHash(PrivilegeCap.idKey(PrivilegeType.SENIOR, "SC-2026-004411"))

    @Test fun whatIsLeftIsTheLimitMinusTheBundlesUseMinusWhatThisPhoneSoldSince() {
        val info = PrivilegeCapInfo.decode(bundle(mapOf(hash to 100_000)))!!
        assertEquals(30_000L, PrivilegeCap.remaining(info, senior, emptyMap(), now))
        assertEquals(10_000L, PrivilegeCap.remaining(info, senior, mapOf(PrivilegeCap.idKey(PrivilegeType.SENIOR, "SC-2026-004411") to 20_000L), now))
        assertEquals(0L, PrivilegeCap.remaining(info, senior, mapOf(PrivilegeCap.idKey(PrivilegeType.SENIOR, "SC-2026-004411") to 90_000L), now))
        assertEquals(130_000L, PrivilegeCap.remaining(info, senior.copy(idNumber = "SC-OTHER-1"), emptyMap(), now))
        // spacing and case in the typed number are the same card
        assertEquals(30_000L, PrivilegeCap.remaining(info, senior.copy(idNumber = "sc 2026 004411"), emptyMap(), now))
    }

    @Test fun noLimitIsKnownWhenTheBundleHasNoneItIsSwitchedOffOrTheTypeHasNoLimit() {
        assertNull(PrivilegeCapInfo.decode(null))
        assertNull(PrivilegeCapInfo.decode(JSONObject().put("version", 2)))
        assertNull(PrivilegeCapInfo.decode(bundle().put("capCentavos", "oops")))
        assertNull(PrivilegeCap.remaining(null, senior, emptyMap(), now))
        assertNull(PrivilegeCap.remaining(PrivilegeCapInfo.decode(bundle(enabled = false)), senior, emptyMap(), now))
        assertNull(PrivilegeCap.remaining(PrivilegeCapInfo.decode(bundle()), senior.copy(type = PrivilegeType.SOLO_PARENT), emptyMap(), now))
        assertNull(PrivilegeCap.remainingFn(null, emptyMap(), now))
    }

    @Test fun aBundleFromLastWeekSaysNothingAboutThisWeek() {
        val old = PrivilegeCapInfo.decode(bundle(mapOf(hash to 100_000), week = "2026-10-26"))!!
        assertEquals(130_000L, PrivilegeCap.remaining(old, senior, emptyMap(), now))
    }

    private fun sale(status: String, at: Long, claim: JSONObject?) = Triple(status, at, claim ?: JSONObject())
    private fun claimJson(applied: Long, id: String = "SC-2026-004411", type: String = "senior") = JSONObject().put("type", type).put("idNumber", id)
        .put("capBasis", JSONObject().put("budgetCentavos", "130000").put("appliedCentavos", applied.toString()))

    @Test fun localUseCountsOnlySalesTheBundleCannotKnowAbout() {
        val info = PrivilegeCapInfo.decode(bundle(asOf = now - 60_000))!!
        val key = PrivilegeCap.idKey(PrivilegeType.SENIOR, "SC-2026-004411")
        val used = PrivilegeCap.localUsed(info, now, listOf(
            sale("pending", now - 30_000, claimJson(10_000)),                      // not sent yet: counts
            sale("sending", now - 20_000, claimJson(5_000, id = "sc 2026 004411")), // same card, other spelling: counts
            sale("done", now - 10_000, claimJson(7_000)),                          // sent after the bundle was made: counts
            sale("done", now - 120_000, claimJson(40_000)),                        // already inside the bundle
            sale("rejected", now - 5_000, claimJson(50_000)),                      // never reached the books
            sale("pending", ms("2026-10-30T10:00:00+08:00"), claimJson(60_000)),   // last week
            sale("pending", now - 1_000, claimJson(9_000, type = "solo_parent")),  // no limit on this type
            sale("pending", now - 1_000, JSONObject().put("type", "senior").put("idNumber", "SC-2026-004411")), // made before this feature
            sale("pending", now - 1_000, claimJson(3_000, id = "SC-OTHER-9")),
        ))
        assertEquals(22_000L, used[key]); assertEquals(3_000L, used[PrivilegeCap.idKey(PrivilegeType.SENIOR, "SC-OTHER-9")]); assertEquals(2, used.size)
        assertTrue(PrivilegeCap.localUsed(null, now, listOf(sale("pending", now, claimJson(1)))).isEmpty())
    }

    @Test fun theReceiptSaysWhatIsLeftInPlainWords() {
        assertEquals("Weekly limit: ₱300.00 left", PrivilegeCap.leftText(30_000))
        assertEquals("Weekly limit: ₱0.00 left", PrivilegeCap.leftText(0))
        val inputs = listOf(LegalInput("a", 100_000, 0, TaxFact("vatable", 1200)))
        val cart = Privilege.cart(inputs, senior, 130_000).getOrThrow()
        val fiscal = JSONObject().put("discountClaim", ReceiptDiscounts.claimJson(senior.copy(capBudget = cart.budget), cart))
        val lines = ReceiptDiscounts.claimLines(fiscal) { "P" + it }.map { it.first }
        assertTrue(lines.toString(), "Weekly limit: P30000 left" in lines)
        // nothing left: no discount is taken and the receipt says why
        val none = Privilege.cart(inputs, senior, 0).getOrThrow()
        val used = JSONObject().put("discountClaim", ReceiptDiscounts.claimJson(senior.copy(capBudget = none.budget), none))
        val usedLines = ReceiptDiscounts.claimLines(used) { "P" + it }.map { it.first }
        assertTrue(usedLines.toString(), "Senior citizen: weekly limit reached, no discount" in usedLines)
        assertTrue("Weekly limit: P0 left" in usedLines)
        // a sale on a phone that knew no limit prints no limit line (same receipt as before this change)
        val plain = JSONObject().put("discountClaim", ReceiptDiscounts.claimJson(senior, Privilege.cart(inputs, senior).getOrThrow()))
        assertTrue(ReceiptDiscounts.claimLines(plain) { "P$it" }.none { it.first.startsWith("Weekly limit") })
    }

    @Test fun theBundleBlockRidesInsideStorePosAndTheV1PolicyValidatorNeverSeesIt() {
        val policy = JSONObject().put("allowNegativeStock", false).put("loadDiscrepancyRequiresApproval", true).put("walkInAllowed", false)
            .put("loadDiscrepancyReasons", JSONArray()).put("damageReasons", JSONArray())
        assertNull(com.sunpride.van.sync.VanBootstrapCodec.policy(policy).privilegeCap)
        val withCap = JSONObject(policy.toString()).put("storePos", JSONObject().put("privilegeCap", bundle(mapOf(hash to 100_000))))
        assertEquals(130_000L, com.sunpride.van.sync.VanBootstrapCodec.policy(withCap).privilegeCap!!.capMinor)
        val badCap = JSONObject(policy.toString()).put("storePos", JSONObject().put("privilegeCap", JSONObject().put("version", 1).put("enabled", "yes")))
        assertNull(com.sunpride.van.sync.VanBootstrapCodec.policy(badCap).privilegeCap)
    }

    @Test fun thePhoneSaysWhichBuildItIs() {
        val h = com.sunpride.van.sync.VanSyncClient.versionHeaders()
        assertTrue(h.getValue("x-app-version-code").matches(Regex("^[1-9][0-9]{0,5}$")))
        assertTrue(h.getValue("x-app-version-name").matches(Regex("^[0-9A-Za-z._+-]{1,40}$")))
    }
}
