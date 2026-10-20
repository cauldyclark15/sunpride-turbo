package com.sunpride.van.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.sunpride.van.auth.PasswordChange

@Composable fun AccountScreen(c: VanController) {
    ScreenFrame("Account",c::back,message = c.message) {
        Text(c.seller?.name ?: "Your account",style = MaterialTheme.typography.titleLarge)
        ListRow("Change password","Use your current password to choose a new one","open-change-password",
            enabled = !c.busy,onClick = { c.open(Page.CHANGE_PASSWORD) })
        Text("Saved work stays on this phone when you sign out.",style = MaterialTheme.typography.bodyMedium)
        SecondaryButton("Sign out",c::signOut,Modifier.testTag("account-sign-out"),!c.busy)
    }
}

@Composable fun ChangePasswordScreen(c: VanController) {
    // No saveable state: passwords never enter saved-state, disk, diagnostics or a request retry queue.
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var currentEye by remember { mutableStateOf(false) }
    var nextEye by remember { mutableStateOf(false) }
    var confirmEye by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) {
                currentEye = false; nextEye = false; confirmEye = false
                current = ""; next = ""; confirm = ""
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    ScreenFrame("Change password",c::back,action = if (c.busy) "Changing…" else "Change password",
        actionTag = "change-password",enabled = !c.busy && current.isNotEmpty() && next.isNotEmpty() && confirm.isNotEmpty(),
        message = error ?: c.message,onAction = {
            error = PasswordChange.problem(current,next,confirm)?.words
            if (error == null) {
                val old = current; val fresh = next; val again = confirm
                current = ""; next = ""; confirm = ""; currentEye = false; nextEye = false; confirmEye = false
                c.changePassword(old,fresh,again)
            }
        }) {
        Text("Use 8–128 characters. Your other sign-ins will end; this handheld stays signed in.",style = MaterialTheme.typography.bodyMedium)
        LabeledField("Current password",current,{ current = it; error = null },"current-password",password = true,
            maxLength = 256,enabled = !c.busy,revealed = currentEye,onToggleReveal = { currentEye = !currentEye })
        LabeledField("New password",next,{ next = it; error = null },"new-password",password = true,
            maxLength = 128,enabled = !c.busy,revealed = nextEye,onToggleReveal = { nextEye = !nextEye })
        LabeledField("Confirm new password",confirm,{ confirm = it; error = null },"confirm-password",password = true,
            maxLength = 128,enabled = !c.busy,revealed = confirmEye,onToggleReveal = { confirmEye = !confirmEye })
    }
}
