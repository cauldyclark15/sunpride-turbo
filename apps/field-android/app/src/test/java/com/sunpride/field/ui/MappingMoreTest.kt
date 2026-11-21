package com.sunpride.field.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** SP-0195: Customer mapping's More keeps only Products, Add customer and Sync; the other modes are unchanged. */
class MappingMoreTest {
    private val hidden = listOf(MoreRow.ATTENDANCE, MoreRow.COLLECTIONS, MoreRow.TRUCK_STOCK, MoreRow.EARNED_STATEMENTS, MoreRow.WORK_WITH, MoreRow.TEAM)

    @Test fun mappingMoreHasOnlyProductsAndAddCustomer() {
        for (visits in listOf(true, false)) for (supervisor in listOf(true, false)) for (team in listOf(true, false)) {
            val rows = FieldNav.moreWorkRows(AppMode.MAPPING, visits, supervisor, team)
            assertEquals(listOf(MoreRow.PRODUCTS, MoreRow.ADD_CUSTOMER), rows)
            hidden.forEach { assertFalse("$it", it in rows) }
        }
    }

    @Test fun visitsAndSellingMoreAreUnchanged() {
        for (mode in listOf(AppMode.VISITS, AppMode.SELLING)) {
            assertEquals(MoreRow.entries.toList(), FieldNav.moreWorkRows(mode, visits = true, supervisor = true, team = true, remit = true))
            assertEquals(listOf(MoreRow.PRODUCTS, MoreRow.ATTENDANCE, MoreRow.COLLECTIONS, MoreRow.TRUCK_STOCK, MoreRow.EARNED_STATEMENTS),
                FieldNav.moreWorkRows(mode, visits = false, supervisor = false, team = true))
            assertEquals(listOf(MoreRow.PRODUCTS, MoreRow.ADD_CUSTOMER, MoreRow.ATTENDANCE, MoreRow.COLLECTIONS,
                MoreRow.TRUCK_STOCK, MoreRow.WORK_WITH, MoreRow.EARNED_STATEMENTS), FieldNav.moreWorkRows(mode, visits = true, supervisor = true, team = false))
        }
    }

    @Test fun mappingSendsHiddenMorePagesHome() {
        for (page in listOf("workforce", "collections", "incentives", "jointcall", "team")) {
            assertEquals(page, "home", FieldNav.pageForMode(page, AppMode.MAPPING))
            assertEquals(page, page, FieldNav.pageForMode(page, AppMode.VISITS))
            assertEquals(page, page, FieldNav.pageForMode(page, AppMode.SELLING))
        }
        for (page in listOf("catalogue", "census", "sync", "account", "support", "location-battery", "more"))
            assertEquals(page, page, FieldNav.pageForMode(page, AppMode.MAPPING))
    }

    // The screen draws a row only for a non-null action, and FieldApp derives every action from moreWorkRows.
    @Test fun moreScreenAndFieldAppFollowTheRows() {
        val main = File("src/main/java/com/sunpride/field/ui")
        val more = File(main, "MoreScreen.kt").readText()
        for ((action, label) in listOf("onWorkforce" to "Attendance", "onCollections" to "Collections", "onIncentives" to "Earned statements",
            "onJointCall" to "Work-With & coaching", "onTeam" to "Your team", "onCensus" to "Add customer",
            "onRemitCash" to "Remit cash"))
            assertTrue(label, Regex("""if \($action != null\) \{ Rule\(\); ListRow\("${Regex.escape(label)}"""").containsMatchIn(more))
        assertTrue(Regex("""\n\s+ListRow\("Products"""").containsMatchIn(more))
        assertTrue(Regex("""\n\s+ListRow\("Sync"""").containsMatchIn(more))
        val app = File(main, "FieldApp.kt").readText()
        assertTrue(app.contains("FieldNav.moreWorkRows(mode, visits,"))
        for ((action, row) in listOf("onCensus" to "ADD_CUSTOMER", "onWorkforce" to "ATTENDANCE", "onJointCall" to "WORK_WITH",
            "onCollections" to "COLLECTIONS", "onTeam" to "TEAM", "onIncentives" to "EARNED_STATEMENTS",
            "onRemitCash" to "REMIT_CASH"))
            assertTrue(action, app.contains("$action = if (MoreRow.$row in rows)"))
    }
}
