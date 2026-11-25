package com.sunpride.field.census

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.sunpride.field.ui.TonalButton

/** The count comes only from the current account's encrypted draft book. */
@Composable
fun CustomerDraftAlert(count: Int, onOpen: (() -> Unit)?, modifier: Modifier = Modifier) {
    if (onOpen != null && count > 0) TonalButton("$count drafts to complete", onOpen,
        modifier.testTag("customer-draft-alert"))
}
