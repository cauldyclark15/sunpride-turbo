package com.sunpride.field.census

import kotlinx.coroutines.CancellationException
import org.json.JSONObject

/** SP-0246: upgrade old postal metadata without replacing the normal geography-cache policy. */
object CustomerPostalPack {
    suspend fun upgrade(pack: String, fetch: () -> String, save: suspend (String) -> Unit): String {
        if (JSONObject(pack).optInt("postalAreasVersion") >= 1) return pack
        val live = try {
            fetch().takeIf { JSONObject(it).optInt("postalAreasVersion") >= 1 } ?: return pack
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return pack
        }
        try {
            save(live)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // The fresh list is still usable if the encrypted cache cannot be updated.
        }
        return live
    }
}
