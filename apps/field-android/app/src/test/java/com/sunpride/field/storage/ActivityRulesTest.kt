package com.sunpride.field.storage

import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ActivityRulesTest {
    private val scope = StoreScope("a", "d", "s")
    private val rules = listOf(
        ActivityRule("merchandise", "v1", listOf(RuleActivity("merchandising", true), RuleActivity("price_check", false))),
        ActivityRule("audit", "v2", listOf(RuleActivity("inventory_check", true), RuleActivity("price_check", true))),
        ActivityRule("complaint", "v3", listOf(RuleActivity("note", true))),
        ActivityRule("future", "v4", listOf(RuleActivity("future_form", true))))
    private val sheet = CallSheet("outlet-1", 1, CallSheetCodec.header(JSONObject().put("accountName", "A")
        .put("address", JSONObject.NULL).put("buyerName", JSONObject.NULL).put("contactNumber", JSONObject.NULL)
        .put("accountInCharge", JSONObject.NULL).put("receivingInCharge", JSONObject.NULL)
        .put("distributorName", JSONObject.NULL).put("distributorSchedule", JSONObject.NULL)
        .put("foc", JSONObject.NULL).put("pricing", JSONObject.NULL)),
        listOf(CallSheetProduct("product-1", "P1", "Product 1", "CAN", null, null)))

    @Test fun decodeIsStrictAndRoundTrips() {
        val rule = rules.first()
        assertEquals(rule, ActivityRules.decode(ActivityRules.encode(rule)))
        val good = ActivityRules.encode(rule)
        for (bad in listOf(JSONObject(good.toString()).put("label", "x"),
            JSONObject(good.toString()).put("intent", ""),
            JSONObject(good.toString()).put("activities", org.json.JSONArray().put(JSONObject().put("kind", "note")
                .put("required", true)).put(JSONObject().put("kind", "note").put("required", false))),
            JSONObject(good.toString()).put("activities", org.json.JSONArray().put(JSONObject().put("kind", "note")
                .put("required", "yes"))))) {
            assertThrows(Exception::class.java) { ActivityRules.decode(bad) }
        }
    }

    @Test fun checklistUnionsIntentsAndMarksDoneUnavailableAndOptional() {
        val list = ActivityRules.checklist(rules, listOf("merchandise", "audit", "future"), setOf("merchandising")) {
            ActivityRules.capturable(it, sheet)
        }
        assertEquals(listOf("merchandising", "price_check", "inventory_check", "future_form"), list.map { it.kind })
        // Optional for merchandise, required for audit: required wins.
        assertTrue(list.single { it.kind == "price_check" }.required)
        assertEquals(ActivityRequirement.Status.DONE, list[0].status)
        assertEquals(ActivityRequirement.Status.UNAVAILABLE, list.single { it.kind == "future_form" }.status)
        assertEquals(listOf("price_check", "inventory_check"), ActivityRules.missing(list))
        // Without account products the product forms cannot be captured, so they never block End.
        val bare = ActivityRules.checklist(rules, listOf("audit"), emptySet()) { ActivityRules.capturable(it, null) }
        assertTrue(ActivityRules.missing(bare).isEmpty())
        assertTrue(ActivityRules.checklist(rules, listOf("deliver"), emptySet()) { true }.isEmpty())
    }

    @Test fun completedEndNeedsRequiredFormsButNotProductiveEndDoesNot() {
        val start = VisitIntentFactory.create(scope, "visit.checkIn", null, null, null, null, "outlet-1",
            listOf("merchandise", "complaint"), "Walk-in", null, null, null, null, at = 1)
        val note = VisitIntentFactory.create(scope, "visit.activity", start.clientVisitId, start.requestId, start.requestId,
            null, "outlet-1", emptyList(), null, "Buyer complaint", null, null, null, at = 2)
        var rows = listOf(start to "done", note to "pending")
        assertEquals(listOf("merchandise", "complaint"), ActivityRules.intentsOf(start.clientVisitId, rows))
        val failure = assertThrows(VisitRuleFailure::class.java) {
            ActivityRules.requireForEnd(start.clientVisitId, "completed", rules, rows, sheet)
        }
        assertEquals(VisitRuleFailure.Code.ACTIVITIES_REQUIRED, failure.code)
        ActivityRules.requireForEnd(start.clientVisitId, "nonproductive", rules, rows, sheet)
        val merch = VisitIntentFactory.create(scope, "visit.activity", start.clientVisitId, start.requestId, note.requestId,
            null, "outlet-1", emptyList(), null, null, null, null, null, at = 3,
            activity = JSONObject().put("kind", "merchandising").put("displayCondition", "compliant"))
        // A rejected (review) form does not count as recorded.
        assertThrows(VisitRuleFailure::class.java) {
            ActivityRules.requireForEnd(start.clientVisitId, "completed", rules, rows + (merch to "review"), sheet)
        }
        rows = rows + (merch to "pending")
        assertEquals(setOf("note", "merchandising"), ActivityRules.recordedKinds(start.clientVisitId, rows))
        ActivityRules.requireForEnd(start.clientVisitId, "completed", rules, rows, sheet)
        // An older server sent no rules: nothing is required.
        ActivityRules.requireForEnd(start.clientVisitId, "completed", emptyList(), listOf(start to "done"), sheet)
    }
}
