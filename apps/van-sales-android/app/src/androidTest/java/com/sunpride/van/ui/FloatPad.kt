package com.sunpride.van.ui

import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo

/** IP-P0: types the opening float on the Start trip keypad ("2000" = ₱2,000). */
fun typeOpeningFloat(rule: SemanticsNodeInteractionsProvider, pesos: String) {
    pesos.forEach { rule.onNodeWithTag("float-key-$it").performScrollTo().performClick() }
}
