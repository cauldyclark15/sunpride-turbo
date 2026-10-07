package com.sunpride.van.ids

import androidx.room.withTransaction
import com.sunpride.van.storage.*
import com.sunpride.van.device.hex
import com.sunpride.van.device.sha256
import java.util.UUID

data class TransactionIdentity(val receiptNumber: String, val idempotencyKey: String)

/** The issued pair is durable even before a sale is saved; printing/retry must reuse it. */
class TransactionIds(private val db: VanDatabase, private val scope: StoreScope) {
    suspend fun issue(tripId: String, tripNumber: String): TransactionIdentity = db.withTransaction {
        require(tripId.isNotBlank() && tripNumber.isNotBlank())
        val d = db.rows(); val s = scope.fullAuthSubject; val device = scope.deviceId
        val next = Math.addExact(d.counter(s,device,tripId)?.lastSequence ?: 0L,1L)
        val result = pair(tripNumber, deviceTag(device), next)
        d.insertSequenceCounter(SequenceCounterRow(s,device,tripId,next))
        d.insertTransactionId(TransactionIdRow(s,device,result.idempotencyKey,tripId,result.receiptNumber,next))
        result
    }
    companion object {
        fun deviceTag(deviceId: String): String = hex(sha256(deviceId.toByteArray(Charsets.UTF_8))).take(8).uppercase(java.util.Locale.ROOT)
        fun pair(tripNumber: String, deviceShortTag: String, sequence: Long): TransactionIdentity {
            require(tripNumber.isNotBlank() && deviceShortTag.isNotBlank() && sequence > 0)
            return TransactionIdentity("$tripNumber-$deviceShortTag-${sequence.toString().padStart(4,'0')}",UUID.randomUUID().toString())
        }
    }
}
