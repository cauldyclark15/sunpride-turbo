package com.sunpride.van.storage

import androidx.room.withTransaction
import com.sunpride.van.location.LastPing
import com.sunpride.van.location.LocationFix
import com.sunpride.van.location.LocationPingCodec
import com.sunpride.van.location.LocationPolicy
import com.sunpride.van.location.PingCadence
import kotlinx.coroutines.flow.Flow
import org.json.JSONObject

/**
 * SP-0137: the truck's live-location pings in the scoped encrypted database. A ping is only
 * recorded while this scope's trip is on the road (active on the server or its start saved
 * here) and not closed on this phone; the check runs in the same transaction as the insert.
 */
class LocationPingStore(private val db: VanDatabase, val scope: StoreScope, private val clock: () -> Long = System::currentTimeMillis) {
    private val dao = db.rows()
    private val s = scope.fullAuthSubject
    private val d = scope.deviceId

    sealed interface Outcome {
        /** Kept, with the trigger it was recorded with. */
        data class Recorded(val clientPingId: String, val trigger: String) : Outcome
        /** Too soon / too close to the last ping, or too inaccurate: not kept. */
        data object Skipped : Outcome
        /** No trip on the road for this scope: tracking must stop. */
        data object NotOnTrip : Outcome
    }

    val pendingCount: Flow<Int> = dao.observePendingLocationPings(s,d)

    /** The trip whose location may be recorded now, or null. */
    private suspend fun trackableTrip(): TripRow? {
        val trip = dao.trip(s,d) ?: return null
        if (dao.tripClose(s,d,trip.tripId) != null) return null
        val started = dao.outboxRows(s,d).any { it.tripId == trip.tripId && it.kind == "trip.start" && it.status in setOf("pending","sending","done") }
        return trip.takeIf { it.status == "active" || started && it.status == "loaded" }
    }

    suspend fun onRoad(): Boolean = db.withTransaction { trackableTrip() != null }

    /** Records [fix] when the cadence wants it (first fix of the trip = `start`). */
    suspend fun record(fix: LocationFix, batteryPercent: Int?): Outcome = db.withTransaction {
        val trip = trackableTrip() ?: return@withTransaction Outcome.NotOnTrip
        val last = dao.latestLocationPing(s,d,trip.tripId)?.let { LastPing(it.recordedAt,it.latitude,it.longitude,it.pingTrigger) }
        // A stop ends sharing for this trip; a later fix on the same trip starts it again.
        val trigger = (if (last?.trigger == "stop") PingCadence.decide(null,fix)?.takeIf { fix.recordedAt > last.recordedAt } else PingCadence.decide(last,fix))
            ?: return@withTransaction Outcome.Skipped
        Outcome.Recorded(insert(trip.tripId,fix,trigger,batteryPercent),trigger)
    }

    /**
     * Records the `stop` ping when sharing ends (trip closed here, sign-out, consent withdrawn): at [fix], or at the
     * last kept position when no fresh fix is at hand. Once per run of pings; nothing when nothing was shared.
     */
    suspend fun recordStop(fix: LocationFix?, batteryPercent: Int?): String? = db.withTransaction {
        val tripId = dao.trip(s,d)?.tripId ?: return@withTransaction null
        val last = dao.latestLocationPing(s,d,tripId) ?: return@withTransaction null
        if (last.pingTrigger == "stop") return@withTransaction null
        val at = maxOf(clock(),last.recordedAt+1)
        val frozen = JSONObject(last.pingJson)
        val position = fix?.takeIf { it.recordedAt > last.recordedAt }?.copy(recordedAt = at) ?: LocationFix(at,last.latitude,last.longitude,
            frozen.getDouble("accuracyMeters"),null,null,frozen.getString("provider"),frozen.getBoolean("mockLocation"))
        insert(tripId,position,"stop",batteryPercent)
    }

    private suspend fun insert(tripId: String, fix: LocationFix, trigger: String, battery: Int?): String {
        val id = LocationPingCodec.newPingId()
        dao.insertLocationPing(LocationPingRow(s,d,id,tripId,fix.recordedAt,fix.latitude,fix.longitude,trigger,
            LocationPingCodec.ping(id,tripId,fix,trigger,battery)))
        return id
    }

    /**
     * Pings ready to upload: only for trips whose start the office already has (current trip active or later on
     * the server, or its `trip.start` acknowledged); earlier the server would refuse them as `trip_not_active`.
     */
    suspend fun pending(limit: Int = LocationPolicy.MAX_BATCH): List<LocationPingRow> = db.withTransaction {
        if (dao.meta(s,d)?.held != false) return@withTransaction emptyList()
        val started = dao.outboxRows(s,d).filter { it.kind == "trip.start" && it.status == "done" }.map { it.tripId }.toMutableSet()
        dao.trip(s,d)?.takeIf { it.status in SERVER_ON_ROAD }?.let { started += it.tripId }
        if (started.isEmpty()) emptyList() else dao.pendingLocationPings(s,d,started.toList(),limit)
    }

    /** Accepted or duplicate = the office has it: the row is deleted. Rejected = never retried (pruned later). */
    suspend fun recordResults(results: List<Pair<LocationPingRow,LocationPingCodec.Result>>) = db.withTransaction {
        results.forEach { (row,result) ->
            require(row.clientPingId == result.clientPingId && row.fullAuthSubject == s && row.deviceId == d)
            when (result.status) {
                "accepted","duplicate" -> dao.deleteLocationPing(s,d,row.clientPingId)
                else -> dao.rejectLocationPing(s,d,row.clientPingId,result.code ?: "rejected")
            }
        }
    }

    /** Drops refused pings and anything the server would refuse as too old. */
    suspend fun prune() = dao.pruneLocationPings(s,d,clock()-LocationPolicy.MAX_AGE_MS)

    companion object {
        /** Server trip states in which van pings are accepted (`location/ingest.ts` DRIVING). */
        val SERVER_ON_ROAD = setOf("active","closing","reconciling","closed","review_required")
    }
}
