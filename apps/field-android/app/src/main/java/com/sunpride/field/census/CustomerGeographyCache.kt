package com.sunpride.field.census

import kotlinx.coroutines.CancellationException

/** SP-0242: check the small nationwide postal pack whenever setup is opened online.
 * Barangay lists keep their long cache; a failed download still permits offline use. */
object CustomerGeographyCache {
    private const val MAX_AGE_MS = 30L * 24 * 3600_000

    suspend fun load(key: String, now: Long, savedJson: String?, savedAt: Long?,
        fetch: () -> String, save: suspend (String) -> Unit, forceRefresh: Boolean = false): String? {
        if (!forceRefresh && key != "pack" && savedJson != null && savedAt != null &&
            now - savedAt in 0 until MAX_AGE_MS) return savedJson
        val live = try { fetch() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (forceRefresh) throw e else return savedJson }
        try { save(live) }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            if (forceRefresh) throw e // An office refresh is not done until its new list is durable.
            /* Ordinary browsing may use the new list even if its cache could not be saved. */
        }
        return live
    }
}
