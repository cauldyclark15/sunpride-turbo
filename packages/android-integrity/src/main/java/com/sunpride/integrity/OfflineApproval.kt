package com.sunpride.integrity

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.UUID

/** F-110/F-124: verify a server-issued, exact-facts approval offline using public key only.
 * Server upload STILL rechecks current scope, approver, rule, expiry and one-time consumption. */
object OfflineApproval {
    data class Grant(val requestId:String,val expiresAt:Long,val factsHash:String,val mode:String)
    private val hex=Regex("[a-f0-9]{64}")
    private fun sha(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}
    /** JS JSON.stringify string escaping (org.json variants differ for / and U+2028). */
    private fun quote(text:String)=buildString {
        append('"');var i=0
        while(i<text.length){val c=text[i]
            when(c){
                '"'->append("\\\"");'\\'->append("\\\\");'\b'->append("\\b");'\u000c'->append("\\f");'\n'->append("\\n");'\r'->append("\\r");'\t'->append("\\t")
                else->when {
                    c.code<32->append("\\u"+c.code.toString(16).padStart(4,'0'))
                    c.isHighSurrogate()&&i+1<text.length&&text[i+1].isLowSurrogate()->{append(c);append(text[++i])}
                    c.isSurrogate()->append("\\u"+c.code.toString(16).padStart(4,'0'))
                    else->append(c)
                }
            };i++
        };append('"')
    }
    fun factsHash(facts:JSONObject)=sha(canonical(facts).toByteArray(Charsets.UTF_8))
    fun canonical(value:Any?):String=when(value){
        null,JSONObject.NULL->"null"
        is JSONObject->value.keys().asSequence().toList().sorted().joinToString(",","{","}"){quote(it)+":"+canonical(value.get(it))}
        is JSONArray->(0 until value.length()).joinToString(",","[","]"){canonical(value.get(it))}
        is String->quote(value)
        is Boolean->value.toString()
        is Number->JSONObject.numberToString(value)
        else->error("Unsupported approval facts")
    }
    private fun decode(text:String):ByteArray {
        require(text.matches(Regex("[A-Za-z0-9_-]+")))
        return Base64.getUrlDecoder().decode(text).also{require(Base64.getUrlEncoder().withoutPadding().encodeToString(it)==text)}
    }
    private fun der(signature:ByteArray):ByteArray {
        require(signature.size==64)
        val r=BigInteger(1,signature.copyOfRange(0,32)).toByteArray()
        val s=BigInteger(1,signature.copyOfRange(32,64)).toByteArray()
        return ByteArrayOutputStream().apply{write(0x30);write(4+r.size+s.size);write(2);write(r.size);write(r);write(2);write(s.size);write(s)}.toByteArray()
    }
    fun verify(token:String,key:JSONObject,facts:JSONObject,requesterId:String,orgUnitId:String,kind:String,channel:String,amountMinor:Long,at:Long,reason:String,ruleId:String):Grant {
        require(token.length<=6000&&amountMinor>=0)
        val parts=token.split('.');require(parts.size==3&&parts[0]=="SP-APPROVAL1")
        require(key.getString("algorithm")=="ES256")
        val spki=key.getString("publicKeySpki")
        val keyId=sha(spki.toByteArray(Charsets.UTF_8));require(keyId==key.getString("keyId"))
        val publicKey=KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(spki))) as ECPublicKey
        require(publicKey.params.curve.field.fieldSize==256)
        require(Signature.getInstance("SHA256withECDSA").run{initVerify(publicKey);update(parts[1].toByteArray(Charsets.US_ASCII));verify(der(decode(parts[2])))})
        val payload=JSONObject(decode(parts[1]).toString(Charsets.UTF_8))
        require(payload.getInt("version")==1&&payload.getString("keyId")==keyId)
        val requestId=payload.getString("requestId");UUID.fromString(requestId)
        val approver=payload.getString("approverId");UUID.fromString(approver);require(approver!=requesterId)
        require(payload.getString("requesterId")==requesterId&&payload.getString("orgUnitId")==orgUnitId)
        require(payload.getString("kind")==kind&&payload.getString("channel")==channel&&payload.getString("amountCentavos")==amountMinor.toString())
        require(payload.getString("ruleId")==ruleId&&payload.getString("reasonHash")==sha(reason.toByteArray(Charsets.UTF_8)))
        val hash=payload.getString("factsHash");require(hex.matches(hash)&&hash==factsHash(facts))
        val issued=payload.getLong("issuedAt");val expires=payload.getLong("expiresAt")
        val mode=payload.getString("mode");require(mode in listOf("offline","live"))
        require(issued>0&&expires>issued&&expires-issued<=(if(mode=="live") 60_000 else 86_400_000)&&at>=issued-60_000&&at<expires)
        return Grant(requestId,expires,hash,mode)
    }
}
