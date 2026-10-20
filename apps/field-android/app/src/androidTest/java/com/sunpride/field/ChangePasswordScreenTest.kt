package com.sunpride.field

import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.sunpride.field.ui.ChangePasswordScreen
import com.sunpride.field.auth.PasswordChange
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ChangePasswordScreenTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun validatesMismatchAndSamePasswordBeforeSubmitting() {
        var submitted = false
        rule.setContent { MaterialTheme { ChangePasswordScreen(false, null, false, { _, _, _ -> submitted = true }, {}) } }
        rule.onNodeWithTag("change-password-current").performTextInput("old-password")
        rule.onNodeWithTag("change-password-new").performTextInput("old-password")
        rule.onNodeWithTag("change-password-confirm").performTextInput("old-password")
        rule.onNodeWithTag("change-password-submit").performClick()
        rule.onNodeWithTag("change-password-message").assertTextContains("Choose a different password", substring = true)
        rule.onNodeWithTag("change-password-new").performTextReplacement("new-password")
        rule.onNodeWithTag("change-password-submit").performClick()
        rule.onNodeWithTag("change-password-message").assertTextContains("do not match", substring = true)
        assertFalse(submitted)
    }

    @Test fun allThreeEyesToggleAndSubmissionClearsSecrets() {
        var submitted: Triple<String, String, String>? = null
        rule.setContent { MaterialTheme { ChangePasswordScreen(false, null, false, { a, b, c -> submitted = Triple(a,b,c) }, {}) } }
        for ((id, value) in listOf("current" to "old-password", "new" to "new-password", "confirm" to "new-password")) {
            rule.onNodeWithTag("change-password-$id").performTextInput(value)
            rule.onNodeWithTag("change-password-$id-toggle").performClick()
            rule.onNodeWithTag("change-password-$id").assertTextContains(value)
            rule.onNodeWithTag("change-password-$id-toggle").performClick()
        }
        rule.onNodeWithTag("change-password-submit").performClick()
        assertEquals(Triple("old-password", "new-password", "new-password"), submitted)
        for (id in listOf("current", "new", "confirm")) rule.onNodeWithTag("change-password-$id").assertTextEquals("")
    }

    @Test fun successHasDoneAndBiometricReminderWithoutPasswordFields() {
        var done = false
        rule.setContent { MaterialTheme { ChangePasswordScreen(false, PasswordChange.SUCCESS, true, { _, _, _ -> }, { done = true }) } }
        rule.onNodeWithText(PasswordChange.SUCCESS).assertExists()
        rule.onNodeWithText("If you used fingerprint or face sign-in, turn it on again in Account.").assertExists()
        rule.onNodeWithTag("change-password-current").assertDoesNotExist()
        rule.onNodeWithTag("change-password-submit").assertTextContains("Done").performClick()
        assertTrue(done)
    }
}
