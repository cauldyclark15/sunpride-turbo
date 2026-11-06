package com.sunpride.van.storage

import androidx.room.withTransaction
import com.sunpride.van.security.PinProofs
import com.sunpride.van.vanday.AcceptCount
import com.sunpride.van.vanday.CrewMember
import com.sunpride.van.vanday.CrewSwitch
import com.sunpride.van.vanday.LoadAccept
import com.sunpride.van.vanday.VanDayInfo
import org.json.JSONObject
import java.util.UUID

/**
 * IP-HH2: the two van-day operations the phone captures: the seller's count of the load (`load.accept`) and a crew member taking over the
 * phone (`crew.switch`). Both are saved in the encrypted outbox like every other operation and sent at the next sync. Neither signs the
 * phone out or touches its registration.
 */
class VanDayStore(private val store: RoomVanStore) {
    private val dao = store.db.rows()
    private val s = store.scope.fullAuthSubject
    private val d = store.scope.deviceId

    private suspend fun nextTime(): Long = maxOf(store.now(), Math.addExact(dao.latestCreatedAt(s, d) ?: 0L, 1L))

    /** True while a count is saved on this phone and the office has not answered yet. */
    suspend fun acceptWaiting(tripId: String): Boolean = dao.outboxRows(s, d).any { it.kind == "load.accept" && it.tripId == tripId && it.status in setOf("pending", "sending") }

    suspend fun acceptLoad(info: VanDayInfo, counts: Map<String, AcceptCount>, note: String?): String = store.db.withTransaction {
        check(store.canSync()) { "This phone needs a current office authorization" }
        val load = checkNotNull(info.load) { "There is no load to accept" }
        check(load.canAccept) { "The clerk has not sent this load yet" }
        val trip = checkNotNull(dao.trip(s, d)) { "No trip assigned" }
        check(info.tripId == null || info.tripId == trip.tripId) { "That load belongs to another trip" }
        check(!acceptWaiting(trip.tripId)) { "Your count is already saved. Sync to send it" }
        check(LoadAccept.ready(load.lines, counts, load.reasons)) { LoadAccept.problem(load.lines, counts, load.reasons) ?: "Count every line first" }
        val at = nextTime(); val id = UUID.randomUUID().toString()
        val payload = LoadAccept.payload(trip.tripId, load.loadId, load.lines, counts, note, at)
        val op = JSONObject().put("kind", "load.accept").put("clientRequestId", id).put("payload", payload).toString()
        dao.insertOutbox(OutboxRow(s, d, id, trip.tripId, "load.accept", op, at, null, store.capturedStatus))
        id
    }

    /**
     * A person on the trip's crew takes over the phone. [key] is the key already derived from their PIN and checked against the downloaded
     * verifier by the caller; it signs this one switch (device, trip, person, PIN version and the operation's own time).
     */
    suspend fun switchCrew(info: VanDayInfo, member: CrewMember, key: ByteArray): String = store.db.withTransaction {
        check(store.canSync()) { "This phone needs a current office authorization" }
        val trip = checkNotNull(dao.trip(s, d)) { "No trip assigned" }
        check(member.hasPin && member in CrewSwitch.candidates(info)) { "That person cannot take over this phone" }
        val at = nextTime(); val id = UUID.randomUUID().toString()
        val proof = PinProofs.hmacHex(key, PinProofs.crewMessage(d, trip.tripId, member.profileId, checkNotNull(member.pinId), at))
        val op = JSONObject().put("kind", "crew.switch").put("clientRequestId", id).put("payload", CrewSwitch.payload(trip.tripId, member, proof, at)).toString()
        dao.insertOutbox(OutboxRow(s, d, id, trip.tripId, "crew.switch", op, at, null, store.capturedStatus))
        id
    }
}
