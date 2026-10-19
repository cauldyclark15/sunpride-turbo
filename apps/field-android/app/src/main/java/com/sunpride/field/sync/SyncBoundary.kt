package com.sunpride.field.sync

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ServerError
import com.sunpride.field.auth.NativeApi
import org.json.JSONObject

internal fun <T> syncBoundary(block: () -> T): T = try { block() }
catch (e: AuthFailure) { throw BootstrapFailure(when (e.kind) {
    AuthFailure.Kind.SESSION_EXPIRED -> BootstrapFailure.Kind.UNAUTHORIZED
    AuthFailure.Kind.OFFLINE -> BootstrapFailure.Kind.OFFLINE
    else -> BootstrapFailure.Kind.RETRYABLE
}) } catch (e: ServerError) { throw BootstrapFailure(when (e.code) {
    "device_revoked", "device_suspended", "scope_withdrawn", "profile_unavailable", "device_unavailable" -> BootstrapFailure.Kind.REMOVED
    "version_unsupported" -> BootstrapFailure.Kind.UPDATE_REQUIRED
    "cursor_invalid", "cursor_expired", "scope_changed", "snapshot_changed", "rebootstrap_required" -> BootstrapFailure.Kind.RESTART
    else -> BootstrapFailure.Kind.INVALID_RESPONSE
}) }
internal fun NativeApi.syncMe(): JSONObject = syncBoundary {
    me().also {
        val device = it.optJSONObject("device")
        if (device == null || device.optString("status") != "active" || !device.optBoolean("bound"))
            throw BootstrapFailure(BootstrapFailure.Kind.REMOVED)
    }
}
