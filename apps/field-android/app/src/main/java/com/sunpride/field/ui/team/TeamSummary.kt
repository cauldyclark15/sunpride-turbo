package com.sunpride.field.ui.team

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ConvexFunctionError
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * AND-020 supervisor view: the server's `supervision/mobile:team` summary of direct-report coverage
 * and the day's exceptions. Scope is enforced on the server (people.read + visit.read in the
 * caller's current subtree); this file only decodes, caches and words what the server returned.
 */
data class TeamPerson(
    val profileId: String, val name: String, val positionLabel: String?, val channel: String,
    val direct: Boolean, val planned: Int, val plannedDone: Int, val done: Int, val productive: Int,
    val nonproductive: Int, val unplanned: Int, val inProgress: Boolean, val outOfSequence: Int,
    val openExceptions: Int, val lateSync: Int, val firstCheckInAt: Long?, val lastCheckOutAt: Long?,
    val lastActivityAt: Long?)

data class TeamException(
    val id: String, val kind: String, val open: Boolean, val profileId: String, val personName: String,
    val outletCode: String, val outletName: String, val at: Long?, val result: String?,
    val distanceMeters: Double?, val sequence: Int?, val after: Int?, val reason: String?,
    val decisionStatus: String?)

data class TeamSummary(
    val serviceDate: String, val generatedAt: Long, val dayCloseAt: Long, val directOnly: Boolean,
    val truncated: Boolean, val people: List<TeamPerson>, val openExceptions: Int, val totalExceptions: Int,
    val exceptions: List<TeamException>)

/** What the Team screen shows: a summary (live or saved), or a fixed explanation. */
data class TeamView(val summary: TeamSummary? = null, val saved: Boolean = false,
    val notAllowed: Boolean = false, val message: String? = null)

class TeamWireFailure : Exception("Invalid team summary")

object TeamCodec {
    const val PATH = "supervision/mobile:team"

    fun args(serviceDate: String, directOnly: Boolean): JSONObject =
        JSONObject().put("serviceDate", serviceDate).put("directOnly", directOnly)

    fun decode(text: String): TeamSummary = try {
        val o = JSONObject(text)
        TeamSummary(o.str("serviceDate"), o.whole("generatedAt"), o.whole("dayCloseAt"), o.bool("directOnly"),
            o.bool("truncated"), o.arr("people").objects().map(::person), o.count("openExceptions"),
            o.count("totalExceptions"), o.arr("exceptions").objects().map(::exception))
    } catch (e: TeamWireFailure) { throw e } catch (_: Exception) { throw TeamWireFailure() }

    private fun person(o: JSONObject) = TeamPerson(o.str("profileId"), o.str("name"), o.optStr("positionLabel"),
        o.str("channel"), o.bool("direct"), o.count("planned"), o.count("plannedDone"), o.count("done"),
        o.count("productive"), o.count("nonproductive"), o.count("unplanned"), o.bool("inProgress"),
        o.count("outOfSequence"), o.count("openExceptions"), o.count("lateSync"), o.wholeOrNull("firstCheckInAt"),
        o.wholeOrNull("lastCheckOutAt"), o.wholeOrNull("lastActivityAt"))

    private fun exception(o: JSONObject) = TeamException(o.str("id"), o.str("kind"), o.bool("open"),
        o.str("profileId"), o.str("personName"), o.str("outletCode"), o.str("outletName"), o.wholeOrNull("at"),
        o.optStr("result"), o.numOrNull("distanceMeters"), o.wholeOrNull("sequence")?.toInt(),
        o.wholeOrNull("after")?.toInt(), o.optStr("reason"), o.optStr("decisionStatus"))

    private fun JSONArray.objects() = (0 until length()).map { get(it) as? JSONObject ?: throw TeamWireFailure() }
    private fun JSONObject.str(k: String) = (opt(k) as? String)?.takeIf { it.isNotEmpty() } ?: throw TeamWireFailure()
    private fun JSONObject.optStr(k: String): String? = when (val v = opt(k)) {
        null, JSONObject.NULL -> null; is String -> v; else -> throw TeamWireFailure() }
    private fun JSONObject.bool(k: String) = opt(k) as? Boolean ?: throw TeamWireFailure()
    private fun JSONObject.arr(k: String) = opt(k) as? JSONArray ?: throw TeamWireFailure()
    private fun JSONObject.numOrNull(k: String): Double? = when (val v = opt(k)) {
        null, JSONObject.NULL -> null
        is Number -> v.toDouble().takeIf { it.isFinite() } ?: throw TeamWireFailure()
        else -> throw TeamWireFailure() }
    private fun JSONObject.wholeOrNull(k: String): Long? = numOrNull(k)?.let {
        if (it != Math.floor(it) || it < 0) throw TeamWireFailure(); it.toLong() }
    private fun JSONObject.whole(k: String) = wholeOrNull(k) ?: throw TeamWireFailure()
    private fun JSONObject.count(k: String) = whole(k).let { if (it > Int.MAX_VALUE) throw TeamWireFailure(); it.toInt() }
}

/** Where the last good summary is kept (encrypted store, per signed-in partition). */
interface TeamCache {
    fun read(key: String): Pair<String, Long>?
    fun write(key: String, json: String, savedAt: Long)
}

object TeamRepository {
    /** Roles the server lets read the team (people.read ∩ visit.read). The server still decides. */
    val SUPERVISOR_ROLES = setOf("manager", "super_admin", "admin", "analyst", "viewer")
    fun offered(role: String?) = role in SUPERVISOR_ROLES

    fun key(serviceDate: String, directOnly: Boolean) = "$serviceDate|${if (directOnly) "direct" else "all"}"

    /**
     * Fetch live and save; when the server can't be reached, show today's saved summary for the same
     * filter. A server refusal never shows saved data (access may have been withdrawn).
     */
    fun load(serviceDate: String, directOnly: Boolean, cache: TeamCache, now: Long,
             fetch: () -> String): TeamView {
        val key = key(serviceDate, directOnly)
        return try {
            val text = fetch()
            val summary = TeamCodec.decode(text)
            if (summary.serviceDate != serviceDate || summary.directOnly != directOnly) throw TeamWireFailure()
            runCatching { cache.write(key, text, now) }
            TeamView(summary)
        } catch (_: ConvexFunctionError) {
            TeamView(notAllowed = true, message = "Team view isn't available for your account.")
        } catch (e: AuthFailure) {
            if (e.kind == AuthFailure.Kind.SESSION_EXPIRED) TeamView(message = "Sign in again to see your team.")
            else saved(cache, key, "Offline")
        } catch (_: TeamWireFailure) {
            saved(cache, key, "Couldn't read the latest team update")
        }
    }

    private fun saved(cache: TeamCache, key: String, reason: String): TeamView {
        val hit = runCatching { cache.read(key) }.getOrNull()
        val summary = hit?.let { runCatching { TeamCodec.decode(it.first) }.getOrNull() }
            ?: return TeamView(message = "$reason. Connect and try again.")
        return TeamView(summary, saved = true, message = "$reason — showing team saved at ${clock(hit.second)}")
    }

    private val MANILA = ZoneId.of("Asia/Manila")
    fun clock(at: Long): String = DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)
        .format(Instant.ofEpochMilli(at).atZone(MANILA))
}

/** Fixed plain-language wording; server text is never shown except the person/outlet names and reasons. */
object TeamText {
    fun headline(s: TeamSummary): String {
        val planned = s.people.sumOf { it.planned }
        val done = s.people.sumOf { it.plannedDone }
        val people = if (s.people.size == 1) "1 person" else "${s.people.size} people"
        return "$people · $done of $planned planned calls done · ${s.openExceptions} to review"
    }

    fun status(p: TeamPerson, now: Long, dayCloseAt: Long): String = when {
        p.inProgress -> "In a call"
        p.planned > 0 && p.plannedDone >= p.planned -> "Route done"
        p.done == 0 && p.firstCheckInAt == null -> if (now >= dayCloseAt) "No calls" else "Not started"
        now >= dayCloseAt -> "Day closed"
        else -> "Between calls"
    }

    fun coverage(p: TeamPerson): String = listOfNotNull(
        "${p.plannedDone} of ${p.planned} planned",
        "${p.productive} productive",
        p.unplanned.takeIf { it > 0 }?.let { "$it unplanned" },
    ).joinToString(" · ")

    fun flags(p: TeamPerson): String = listOfNotNull(
        p.openExceptions.takeIf { it > 0 }?.let { "$it to review" },
        p.outOfSequence.takeIf { it > 0 }?.let { "$it out of order" },
        p.nonproductive.takeIf { it > 0 }?.let { "$it nonproductive" },
        p.lateSync.takeIf { it > 0 }?.let { "$it late sync" },
    ).joinToString(" · ")

    fun kind(e: TeamException, now: Long, dayCloseAt: Long): String = when (e.kind) {
        "location" -> if (e.result == "unreliable") "Location unreliable" else "Outside the store radius"
        "out_of_sequence" -> "Out of MCP order"
        "unplanned" -> "Unplanned call"
        "nonproductive" -> "Nonproductive call"
        "rescheduled" -> "Rescheduled"
        "cancelled" -> "Cancelled"
        "not_visited" -> if (now >= dayCloseAt) "Not visited" else "Not visited yet"
        else -> "Exception"
    }

    fun detail(e: TeamException): String = listOfNotNull(
        e.personName,
        e.outletName,
        e.distanceMeters?.takeIf { e.kind == "location" }?.let { "${Math.round(it)} m away" },
        if (e.kind == "out_of_sequence" && e.sequence != null && e.after != null) "stop ${e.sequence} after ${e.after}" else null,
        e.reason?.takeIf { it.isNotBlank() },
        when {
            e.open -> "Needs review on the web"
            e.decisionStatus == "approved_exception" -> "Approved"
            e.decisionStatus == "rejected" -> "Rejected"
            e.decisionStatus != null -> "Decided"
            else -> null
        },
    ).joinToString(" · ")
}
