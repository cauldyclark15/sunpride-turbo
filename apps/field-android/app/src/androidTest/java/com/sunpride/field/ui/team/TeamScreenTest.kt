package com.sunpride.field.ui.team

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.sunpride.field.ui.SunprideTokens
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class TeamScreenTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()

    private val close = 2_000_000L
    private val now = 1_000_000L
    private fun person(name: String, open: Int = 0, inProgress: Boolean = false, done: Int = 1) =
        TeamPerson("p-$name", name, "Route Salesman", "PMOT", true, 3, done, done, done, 0, 0, inProgress, 0, open, 0,
            if (done > 0) now else null, null, if (done > 0) now else null)
    private fun exception(kind: String, open: Boolean) = TeamException("$kind:1", kind, open, "p-Ana", "Ana", "O1",
        "Outlet 1", now, "outside_radius", 320.0, null, null, null, null)
    private fun summary(directOnly: Boolean = true, people: List<TeamPerson> = listOf(person("Ana", 1, true), person("Ben", done = 0)),
        exceptions: List<TeamException> = listOf(exception("location", true), exception("nonproductive", false)),
        total: Int = exceptions.size) =
        TeamSummary("2026-09-28", now, close, directOnly, false, people, exceptions.count { it.open }, total, exceptions)

    private fun show(view: TeamView, directOnly: Boolean = true, loading: Boolean = false,
                     filters: MutableList<Boolean> = mutableListOf(), refreshes: IntArray = IntArray(1)) {
        rule.setContent {
            MaterialTheme(colorScheme = SunprideTokens.lightColors) {
                TeamScreen(view, directOnly, loading, now, onFilter = { filters += it }, onRefresh = { refreshes[0]++ })
            }
        }
    }

    @Test fun showsEachDirectReportsCoverageAndTheDaysExceptions() {
        val filters = mutableListOf<Boolean>()
        val refreshes = IntArray(1)
        show(TeamView(summary()), filters = filters, refreshes = refreshes)
        rule.onNodeWithTag("team-summary").assertTextContains("2 people · 1 of 6 planned calls done · 1 to review",
            substring = true)
        val people = rule.onAllNodesWithTag("team-person")
        people.assertCountEquals(2)
        people[0].assertTextContains("Ana", substring = true).assertTextContains("In a call", substring = true)
            .assertTextContains("1 of 3 planned · 1 productive", substring = true)
            .assertTextContains("1 to review", substring = true)
        people[1].assertTextContains("Ben", substring = true).assertTextContains("Not started", substring = true)
        rule.onNodeWithTag("team-exception-open").performScrollTo()
            .assertTextContains("Outside the store radius", substring = true)
            .assertTextContains("Needs review on the web", substring = true)
        rule.onNodeWithTag("team-exception").assertTextContains("Nonproductive call", substring = true)
        rule.onNodeWithTag("team-direct").assertIsNotEnabled() // the current filter
        rule.onNodeWithTag("team-all").assertIsEnabled().performClick()
        rule.onNodeWithTag("team-refresh").performClick()
        assertEquals(listOf(false), filters)
        assertEquals(1, refreshes[0])
    }

    @Test fun savedCopyIsLabelledAndEmptyDirectReportsPointToTheWholeArea() {
        show(TeamView(summary(people = emptyList(), exceptions = emptyList()), saved = true,
            message = "Offline — showing team saved at 11:00 AM"))
        rule.onNodeWithTag("team-summary").assertTextContains("Saved on this phone", substring = true)
        rule.onNodeWithTag("team-message").assertTextContains("Offline — showing team saved at 11:00 AM")
        rule.onNodeWithTag("team-empty").assertTextContains("No direct reports are assigned to you. Try Whole area.")
        rule.onNodeWithTag("team-no-exceptions").assertTextContains("No exceptions today")
    }

    @Test fun refusalShowsOnlyTheFixedMessageAndCappedListsSayWhereTheRestIs() {
        show(TeamView(notAllowed = true, message = "Team view isn't available for your account."))
        rule.onNodeWithTag("team-message").assertTextContains("Team view isn't available for your account.")
        rule.onAllNodesWithTag("team-person").assertCountEquals(0)
        rule.onNodeWithTag("team-summary").assertDoesNotExist()
    }

    @Test fun loadingDisablesFiltersAndUpdate() {
        show(TeamView(summary(total = 80)), loading = true)
        rule.onNodeWithTag("team-direct").assertIsNotEnabled()
        rule.onNodeWithTag("team-all").assertIsNotEnabled()
        rule.onNodeWithTag("team-refresh").assertIsNotEnabled().assertTextContains("Updating…")
        rule.onNodeWithTag("team-more").performScrollTo().assertTextContains("Showing 2 of 80. See the rest on the web.")
    }
}
