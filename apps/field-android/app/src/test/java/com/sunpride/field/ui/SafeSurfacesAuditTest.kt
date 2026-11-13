package com.sunpride.field.ui

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Source audits for rules a JVM test cannot render (the phone proof runs separately on the Redmi):
 * FLD-074 every bottom sheet goes through SafeBottomSheet; FLD-075 saved customers refresh the waiting-work status.
 */
class SafeSurfacesAuditTest {
    private val main = File("src/main/java/com/sunpride/field")
    private fun sources() = main.walkTopDown().filter { it.extension == "kt" }.toList()

    @Test fun fld074EveryBottomSheetOpensFullyAndClearsTheNavigationBar() {
        assertTrue(main.isDirectory)
        val raw = sources().filter { f -> Regex("""(?<![A-Za-z.])ModalBottomSheet\(|material3\.ModalBottomSheet\(""").containsMatchIn(f.readText()) }
            .map { it.name }
        assertEquals("Only SafeBottomSheet may call ModalBottomSheet", listOf("CalmComponents.kt"), raw)
        val calm = File(main, "ui/CalmComponents.kt").readText()
        val sheet = calm.substringAfter("fun SafeBottomSheet(").substringBefore("\n}\n")
        assertTrue(sheet.contains("skipPartiallyExpanded = true"))
        assertTrue(sheet.contains("verticalScroll("))
        assertTrue(sheet.contains("bottomSafe()"))
        val census = File(main, "census/CensusScreen.kt").readText()
        assertEquals(2, Regex("""SafeBottomSheet\(""").findAll(census).count())
    }

    @Test fun fld075SavedCustomerRefreshesThePillAndSyncScreen() {
        val census = File(main, "census/CensusScreen.kt").readText()
        assertTrue(Regex("""queueCensus\(p\) \}\s*\n\s*onQueued\?\.invoke\(\)""").containsMatchIn(census))
        val app = File(main, "ui/FieldApp.kt").readText()
        assertTrue(app.contains("onQueued = { controller.refreshCache() }"))
        assertTrue(app.contains("""LaunchedEffect(page) { if (page == "sync") controller.refreshCache() }"""))
    }
}
