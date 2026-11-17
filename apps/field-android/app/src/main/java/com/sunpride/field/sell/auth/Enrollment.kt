package com.sunpride.field.sell.auth

/** Whether the Sell area may use the Field phone's registration (the Field app owns registration itself). */
sealed interface EnrollmentState {
    data object SignedOut : EnrollmentState
    data object Unregistered : EnrollmentState
    data class Ready(val deviceId: String) : EnrollmentState
    data object Removed : EnrollmentState
}
