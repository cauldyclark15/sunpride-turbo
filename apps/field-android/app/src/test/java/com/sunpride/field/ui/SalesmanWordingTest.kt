package com.sunpride.field.ui

import com.sunpride.field.ui.syncstatus.SyncStatus
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * SP-0189: no salesman screen talks about sync problems. Greps every string literal in the app's main sources for the
 * forbidden sync wording. Internal-only places are excluded explicitly: the refusal-code wording table (support /
 * office reuse), and the supervisor-only Team summary.
 */
class SalesmanWordingTest {
    private val phrases = listOf("needs review", "need review", "not accepted", "ask your supervisor", "remove from this phone",
        "reconcil", "office will review", "supervisor will review", "held for review", "for office review",
        "sent for review", "to review", "office system")
    private val internal = setOf("ui/syncstatus/SyncStatus.kt", "ui/team/TeamSummary.kt", "ui/team/TeamScreen.kt")

    private fun root(): File = File("src/main/java/com/sunpride/field").absoluteFile.also { check(it.isDirectory) { "run from the app module" } }

    @Test fun noSyncProblemWordingOnSalesmanScreens() {
        val base = root()
        val hits = mutableListOf<String>()
        base.walk().filter { it.isFile && it.extension == "kt" }.forEach { file ->
            val rel = file.relativeTo(base).path
            if (rel in internal) return@forEach
            file.readLines().forEachIndexed { i, line ->
                val code = line.trimStart()
                if (code.startsWith("//") || code.startsWith("*")) return@forEachIndexed
                Regex("\"[^\"]*\"").findAll(line).map { it.value }
                    .filter { lit -> phrases.any { lit.lowercase().contains(it) } }
                    .forEach { hits += "$rel:${i + 1} $it" }
            }
        }
        assertTrue("forbidden wording: $hits", hits.isEmpty())
    }

    @Test fun syncPageWordsAreAllowed() {
        for (label in listOf(SyncStatus.ALL_SENT, SyncStatus.WAITING_FOR_SIGNAL, SyncStatus.waitingToSend(3)))
            SyncStatus.FORBIDDEN_WORDS.forEach { assertTrue(label, !label.lowercase().contains(it)) }
    }
}
