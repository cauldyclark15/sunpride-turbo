package com.sunpride.field.ui

import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** FLD-173: at the phone's largest font the bottom bar keeps all five labels whole. */
class FieldBottomBarTest {
    @get:Rule val rule = createComposeRule()

    @Test fun everyLabelFitsAtTheLargestFontOnANarrowPhone() {
        rule.setContent {
            val d = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(d.density, 2.0f)) {
                FieldBottomBar(FieldTab.TODAY, unread = 3, onSelect = {}, modifier = Modifier.width(360.dp))
            }
        }
        for (tab in FieldTab.entries) {
            val node = rule.onNodeWithText(tab.label, useUnmergedTree = true).fetchSemanticsNode()
            val layouts = mutableListOf<TextLayoutResult>()
            node.config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
            val needed = layouts.single().multiParagraph.intrinsics.maxIntrinsicWidth
            val item = rule.onNodeWithTag(tab.tag).fetchSemanticsNode().boundsInRoot
            val text = node.boundsInRoot
            // The whole word fits inside its own tab: not cut, not spilling under the neighbour.
            assertTrue("${tab.label} needs $needed px, shown in ${text.width} px, tab ${item.width} px",
                text.width + 0.5f >= needed && needed <= item.width - 8f &&
                    text.left >= item.left - 0.5f && text.right <= item.right + 0.5f)
        }
    }
}
