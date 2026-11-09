package com.sunpride.field.ui

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Button words are Add / Edit / Save / Cancel / Remove (docs/ui-actions.md). Fails on any NEW string literal in app
 * sources that starts with "New ", "Create " or "Manage" (not "Manager"). Existing ones sit in `label-lint-allowlist.txt`
 * (`<path under src/main>|<literal>`); later lanes delete lines from it as they fix screens. Never add lines.
 */
class ButtonLabelLintTest {
    private val pattern = Regex("\"((?:New |Create |Manage(?![a-z]))[^\"\\\\$]*)")

    private fun found(): Set<String> {
        val main = File("src/main/java")
        check(main.isDirectory) { "run from the app module: ${File(".").absolutePath}" }
        return main.walkTopDown().filter { it.isFile && it.extension == "kt" }.flatMap { file ->
            val rel = file.relativeTo(File("src/main")).invariantSeparatorsPath
            pattern.findAll(file.readText()).map { "$rel|${it.groupValues[1]}" }
        }.toSet()
    }

    private fun allowed(): Set<String> = javaClass.classLoader!!.getResource("label-lint-allowlist.txt")!!.readText()
        .lines().map { it.trimEnd() }.filter { it.isNotEmpty() && !it.startsWith("#") }.toSet()

    @Test fun noNewCreateOrManageLabels() {
        val extra = found() - allowed()
        assertTrue("Use Add / Edit / Save / Cancel / Remove, not:\n" + extra.sorted().joinToString("\n"), extra.isEmpty())
    }

    @Test fun patternCatchesTheBannedWords() {
        val sample = "Button(\"New order\") Text(\"Create route\") Text(\"Manage stores\") Text(\"Add store\")"
        assertTrue(pattern.findAll(sample).map { it.groupValues[1] }.toList() == listOf("New order", "Create route", "Manage stores"))
    }
}
