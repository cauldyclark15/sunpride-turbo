package com.sunpride.van.pos

import com.sunpride.van.device.hex
import com.sunpride.van.device.sha256
import org.json.JSONObject
import java.util.Base64

/** F-113 bounded customer acknowledgement and photo; validated before any receipt/stock write. */
object ReturnEvidence {
    fun validate(request: ReturnRequest) {
        val ack=JSONObject(checkNotNull(request.acknowledgementJson) { "Customer signature is required" })
        require(ack.getString("name").isNotBlank() && ack.getString("name").length<=100 && ack.getBoolean("accepted"))
        val signature=ack.getJSONArray("strokes")
        require(signature.length() in 1..30)
        var points=0
        for(i in 0 until signature.length()) {
            val stroke=signature.getJSONArray(i); require(stroke.length() in 2..1000); points+=stroke.length()
            for(j in 0 until stroke.length()) {val point=stroke.getJSONArray(j);require(point.length()==2 && point.getInt(0) in 0..10000 && point.getInt(1) in 0..10000)}
        }
        require(points<=2000)
        val photo=JSONObject(checkNotNull(request.photoJson) { "Return photo is required" })
        val bytes=Base64.getDecoder().decode(photo.getString("base64"))
        require(bytes.size in 100..32000 && hex(sha256(bytes))==photo.getString("sha256"))
        require(bytes[0]==0xff.toByte() && bytes[1]==0xd8.toByte() && bytes[2]==0xff.toByte() && bytes[bytes.size-2]==0xff.toByte() && bytes.last()==0xd9.toByte())
        require(request.lines.all { !it.lotNumber.isNullOrBlank() }) { "Capture the batch for every returned item" }
    }
}
