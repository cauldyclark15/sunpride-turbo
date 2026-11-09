package com.sunpride.catalogue

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TargetProgressCardTest {
    @get:Rule val ui=createComposeRule()
    private fun show(d:TargetProgress)=ui.setContent{MaterialTheme{TargetProgressCard(TargetProgressView(d))}}
    @Test fun allMissingShowsPlainRowsAndOneNote(){
        show(TargetProgressShotsTest.notSet)
        ui.onNodeWithText("This month").assertIsDisplayed();ui.onNodeWithText("Updated Nov 9").assertIsDisplayed()
        ui.onNodeWithText("₱0").assertIsDisplayed()
        assertEquals(4,ui.onAllNodesWithText("No target yet").fetchSemanticsNodes().size)
        ui.onNodeWithText("Last month ₱354,896").assertIsDisplayed()
        assertEquals(1,ui.onAllNodesWithText(TargetProgressText.MISSING_NOTE).fetchSemanticsNodes().size)
        ui.onAllNodesWithText("Not published",substring=true).assertCountEquals(0)
        ui.onAllNodesWithText("Pace",substring=true).assertCountEquals(0)
        ui.onAllNodesWithText(TargetProgressShotsTest.DEF).assertCountEquals(0)
        ui.onNodeWithTag("targets-details").performClick()
        ui.onNodeWithText(TargetProgressShotsTest.DEF).assertExists()
    }
    @Test fun targetRowShowsOfAndStatusAndShowAllToggles(){
        show(TargetProgressShotsTest.allSet)
        ui.onNodeWithText("of ₱500,000").assertIsDisplayed()
        ui.onAllNodesWithText(TargetProgressText.MISSING_NOTE).assertCountEquals(0)
        ui.onAllNodesWithText("MSL compliance").assertCountEquals(0)
        ui.onNodeWithText("Show all (6)").performClick()
        ui.onNodeWithText("MSL compliance").assertExists()
        ui.onNodeWithText("Show less").assertExists()
    }
    private fun assertEquals(a:Int,b:Int)=org.junit.Assert.assertEquals(a,b)
}
