package com.sunpride.field.ui.customers

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeUp
import com.sunpride.field.ui.SunprideTokens
import com.sunpride.field.ui.TodayData
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * SP-0140 on the reference phone: the outlet list stays lazy with a large territory. 600 outlets
 * (several times a field rep's scope) must compose only the rows on screen, while flinging and at
 * the end of the list. (Frame timing under the Compose test clock is not a real-scroll measure, so
 * it is not reported here; see docs/PERFORMANCE.md.)
 */
class CustomerListPerformanceTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()

    private val outlets = (1..600).map { n ->
        CustomerRecord("o$n", "Sample Store $n", "OUT-%04d".format(n), "CUST-%04d".format(n),
            "$n Rizal Ave, Barangay ${n % 40}, Pasig City", routeId = "r${n % 12}")
    }

    @Test fun sixHundredOutletsComposeOnlyVisibleRowsAndScrollToTheLast() {
        rule.setContent {
            MaterialTheme(colorScheme = SunprideTokens.lightColors) {
                CustomerSearchScreen(TodayData(customers = outlets, stale = false), onOpen = {})
            }
        }
        rule.onNodeWithTag("customer-count").assertIsDisplayed()
        val composed = rule.onAllNodesWithTag("customer-result").fetchSemanticsNodes().size
        assertTrue("only on-screen rows are composed (got $composed of 600)", composed in 1..40)

        repeat(6) { rule.onNodeWithTag("customer-list").performTouchInput { swipeUp(durationMillis = 250) }; rule.waitForIdle() }
        repeat(3) { rule.onNodeWithTag("customer-list").performTouchInput { swipeDown(durationMillis = 250) }; rule.waitForIdle() }
        val scrolled = rule.onAllNodesWithTag("customer-result").fetchSemanticsNodes().size
        assertTrue("flinging keeps only on-screen rows (got $scrolled)", scrolled in 1..40)

        rule.onNodeWithTag("customer-list").performScrollToNode(hasText("Sample Store 600"))
        rule.onNodeWithText("Sample Store 600").assertIsDisplayed()
        val after = rule.onAllNodesWithTag("customer-result").fetchSemanticsNodes().size
        assertTrue("still lazy at the end of the list (got $after)", after in 1..40)
    }
}
