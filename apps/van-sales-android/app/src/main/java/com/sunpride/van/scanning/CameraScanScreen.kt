package com.sunpride.van.scanning

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/** F-616: retain the existing van scanner entry point and test tags. */
@Composable
fun CameraScanScreen(onCode: (String) -> Unit, onClose: () -> Unit, modifier: Modifier = Modifier,
    closeLabel: String = "Back to printer & scanner") =
    com.sunpride.catalogue.CameraScanScreen(onCode, onClose, modifier, closeLabel)
