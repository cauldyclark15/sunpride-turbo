package com.sunpride.field.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Lane 2: plain Add/Edit/Save words on the visit screens, short dates. */
class VisitWordingTest {
    @Test fun shortDayDropsIso() {
        assertEquals("Nov 9", shortDay("2026-11-09"))
        assertEquals("soon", shortDay("soon"))
    }
    private val root = listOf(File("src/main/java/com/sunpride/field/ui"), File("app/src/main/java/com/sunpride/field/ui")).first { it.isDirectory }
    private val files = listOf("orders/OrderDraftScreen.kt", "orders/OrderReviewScreen.kt", "diagnosticvisit/DiagnosticVisitScreen.kt",
        "diagnosticvisit/CallSheetScreen.kt", "diagnosticvisit/RetailAuditPanel.kt", "CollectorScreen.kt", "workforce/WorkforceScreen.kt",
        "JointCallScreen.kt", "team/TeamScreen.kt", "DsrScreen.kt")
    @Test fun oldLabelsAreGone() {
        val banned = listOf("\"Update\"", "\"Updating…\"", "\"New order\"", "\"New prospect\"", "\"New joint call\"", "\"New SKU\"",
            "on phone\"", "\"Save call sheet\"", "Continue retained draft", "Record returned", "Sync retained", "Refresh authorized",
            "Refresh assigned route", "Sync distributor work")
        val hits = files.flatMap { f -> val s = File(root, f).readText(); banned.filter { s.contains(it) }.map { "$f: $it" } }
        assertTrue(hits.joinToString(), hits.isEmpty())
    }
    @Test fun savedDraftsAndAddsUsePlainWords() {
        val visit = File(root, "diagnosticvisit/DiagnosticVisitScreen.kt").readText()
        assertTrue(visit.contains("\"Edit order\"") && visit.contains("\"Add order\""))
        assertTrue(File(root, "orders/OrderDraftScreen.kt").readText().contains("\"Add order\" else \"Edit order\""))
        assertTrue(File(root, "JointCallScreen.kt").readText().contains("AddFab(\"Add joint call\""))
        assertTrue(File(root, "team/TeamScreen.kt").readText().contains("\"Refresh\""))
    }
}
