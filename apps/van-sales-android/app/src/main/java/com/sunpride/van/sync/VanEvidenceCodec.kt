package com.sunpride.van.sync

import com.sunpride.van.data.DamageRules
import com.sunpride.van.device.hex
import com.sunpride.van.device.sha256
import com.sunpride.van.evidence.DamagePhotoFiles
import com.sunpride.van.storage.OutboxRow
import org.json.JSONObject
import java.util.Base64

fun damagePhotoSha(row: OutboxRow): String? = if (row.kind != "truck.damage") null else
    JSONObject(row.operationJson).getJSONObject("payload").optString("photoSha256").takeIf { it.isNotEmpty() }
object VanEvidenceCodec {
    fun request(deviceId: String, digest: String, jpeg: ByteArray): ByteArray {
        require(DamageRules.SHA256.matches(digest) && jpeg.size <= 96_000 && DamagePhotoFiles.isJpeg(jpeg) && hex(sha256(jpeg)) == digest)
        val o = JSONObject().put("type","van.evidence.request").put("contractVersion",1).put("deviceId",deviceId)
            .put("contentType","image/jpeg").put("sha256",digest).put("dataBase64",Base64.getEncoder().encodeToString(jpeg))
        VanWireSchema.validate(o)
        return o.toString().toByteArray(Charsets.UTF_8).also { require(it.size < 128 * 1024) }
    }
    fun response(text: String, digest: String) {
        try {
            val o = JSONObject(text); VanWireSchema.validate(o)
            require(o.getString("type") == "van.evidence.response" && o.getString("sha256") == digest && o.getString("status") == "stored")
        } catch (_: Exception) { throw VanWireFailure() }
    }
}
