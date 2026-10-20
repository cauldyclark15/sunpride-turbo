package com.sunpride.integrity

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.media.ExifInterface
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** F-312: the SAME pixel/provenance pipeline in field and van; never text added after hashing. */
object ExecutionWatermark {
    private val zone = ZoneId.of("Asia/Manila")
    private val clock = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss XXX").withZone(zone)
    private val exifClock = DateTimeFormatter.ofPattern("yyyy:MM:dd HH:mm:ss").withZone(zone)
    data class Facts(val latitude: Double, val longitude: Double, val accuracyMeters: Double,
        val capturedAt: Long, val user: String, val profileId: String, val outlet: String, val outletId: String,
        val mockSignal: Boolean = false) {
        init {
            require(latitude.isFinite() && latitude in -90.0..90.0 && longitude.isFinite() && longitude in -180.0..180.0)
            require(accuracyMeters.isFinite() && accuracyMeters in 0.0..10_000.0 && capturedAt > 0)
            require(user.isNotBlank() && user.length <= 150 && outlet.isNotBlank() && outlet.length <= 200)
            require(profileId.isNotBlank() && outletId.isNotBlank() && !mockSignal) { "Mock location cannot be used for evidence" }
        }
    }
    fun burn(jpeg: ByteArray, facts: Facts, rotationDegrees: Int? = null, quality: Int = 85, maxDimension: Int = 1600): ByteArray {
        val exif = runCatching { ExifInterface(ByteArrayInputStream(jpeg)) }.getOrNull()
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(jpeg,0,jpeg.size,bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0)
        var sample=1
        while (maxOf(bounds.outWidth,bounds.outHeight)/sample > maxDimension) sample*=2
        val decoded=checkNotNull(BitmapFactory.decodeByteArray(jpeg,0,jpeg.size,BitmapFactory.Options().apply { inSampleSize=sample }))
        val orientation=exif?.getAttributeInt(ExifInterface.TAG_ORIENTATION,1) ?: 1
        val matrix=Matrix().apply {
            if (rotationDegrees != null) postRotate(rotationDegrees.toFloat()) else when(orientation) {
                2 -> postScale(-1f,1f); 3 -> postRotate(180f); 4 -> postScale(1f,-1f)
                5 -> { postRotate(90f); postScale(-1f,1f) }; 6 -> postRotate(90f)
                7 -> { postRotate(270f); postScale(-1f,1f) }; 8 -> postRotate(270f)
            }
        }
        val rotated=Bitmap.createBitmap(decoded,0,0,decoded.width,decoded.height,matrix,true)
        val bitmap=rotated.copy(Bitmap.Config.ARGB_8888,true)
        try {
            // dHash covers the PHOTO, not the watermark text (same image at different stores still matches).
            val hash=differenceHash(bitmap)
            val canvas=Canvas(bitmap)
            val paint=Paint(Paint.ANTI_ALIAS_FLAG).apply { color=Color.WHITE; textSize=maxOf(12f,bitmap.width/40f); typeface=android.graphics.Typeface.MONOSPACE }
            val line=paint.textSize*1.45f; val margin=bitmap.width/40f
            val lines=listOf(String.format(Locale.US,"%.5f, %.5f  +/- %.0f m",facts.latitude,facts.longitude,facts.accuracyMeters),
                clock.format(Instant.ofEpochMilli(facts.capturedAt)),facts.user,facts.outlet)
            val top=bitmap.height-line*4-margin*2
            canvas.drawRect(0f,top,bitmap.width.toFloat(),bitmap.height.toFloat(),Paint().apply {color=0xDF000000.toInt()})
            for((n,text) in lines.withIndex()) canvas.drawText(fit(text,paint,bitmap.width-margin*2),margin,top+margin+line*(n+0.85f),paint)
            val out=ByteArrayOutputStream(); check(bitmap.compress(Bitmap.CompressFormat.JPEG,quality,out))
            val original=JSONObject().apply {
                exif?.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL)?.let { put("dateTimeOriginal",it) }
                exif?.getAttribute(ExifInterface.TAG_OFFSET_TIME_ORIGINAL)?.let { put("offsetTimeOriginal",it) }
                val coords=FloatArray(2); if(exif?.getLatLong(coords)==true) {put("latitude",coords[0]);put("longitude",coords[1])}
                put("orientation",orientation)
            }
            val manifest=JSONObject().put("version",1).put("latitude",facts.latitude).put("longitude",facts.longitude)
                .put("accuracyMeters",facts.accuracyMeters).put("capturedAt",facts.capturedAt).put("user",facts.user)
                .put("profileId",facts.profileId).put("outlet",facts.outlet).put("outletId",facts.outletId)
                .put("mockSignal",facts.mockSignal).put("perceptualHash",hash).put("sourceExif",original)
                .put("exifSource","derivative_with_original_provenance")
            return decorate(out.toByteArray(),facts,manifest)
        } finally { bitmap.recycle(); if(rotated !== decoded) rotated.recycle(); decoded.recycle() }
    }
    private fun fit(text: String,p: Paint,max: Float): String {
        val clean=text.replace(Regex("[\\r\\n\\t]")," ")
        if(p.measureText(clean)<=max) return clean
        var end=clean.length
        while(end>0 && p.measureText(clean.substring(0,end)+"…")>max) end--
        return clean.substring(0,end)+"…"
    }
    internal fun differenceHash(bitmap: Bitmap): String {
        val small=Bitmap.createScaledBitmap(bitmap,9,8,true)
        var bits=0UL
        try {
            fun light(c:Int)=Color.red(c)*299+Color.green(c)*587+Color.blue(c)*114
            for(y in 0..7) for(x in 0..7) bits=(bits shl 1) or if(light(small.getPixel(x,y))>light(small.getPixel(x+1,y))) 1UL else 0UL
        } finally { if(small !== bitmap) small.recycle() }
        return bits.toString(16).padStart(16,'0')
    }
    /** APP1 is a real EXIF TIFF. APP15 carries bounded capture facts inside the same hashed JPEG. */
    private fun decorate(jpeg:ByteArray,f:Facts,manifest:JSONObject):ByteArray {
        val t=ByteBuffer.allocate(242).order(ByteOrder.BIG_ENDIAN)
        t.put('M'.code.toByte()).put('M'.code.toByte()).putShort(42).putInt(8)
        t.putShort(4)
        fun tag(id:Int,type:Int,count:Int,value:Int) {t.putShort(id.toShort()).putShort(type.toShort()).putInt(count).putInt(value)}
        tag(274,3,1,1 shl 16);tag(306,2,20,62);tag(34665,4,1,82);tag(34853,4,1,120);t.putInt(0)
        t.position(62);t.put((exifClock.format(Instant.ofEpochMilli(f.capturedAt))+"\u0000").toByteArray(Charsets.US_ASCII))
        t.position(82);t.putShort(2);tag(36867,2,20,62);tag(36881,2,7,112);t.putInt(0)
        t.position(112);t.put("+08:00\u0000".toByteArray(Charsets.US_ASCII))
        t.position(120);t.putShort(5)
        tag(1,2,2,(if(f.latitude<0) 'S' else 'N').code shl 24);tag(2,5,3,186)
        tag(3,2,2,(if(f.longitude<0) 'W' else 'E').code shl 24);tag(4,5,3,210);tag(31,5,1,234);t.putInt(0)
        fun coordinate(value:Double) {val v=kotlin.math.abs(value);val d=v.toInt();val m=((v-d)*60).toInt();val sec=(((v-d)*60-m)*60*1_000_000).toInt();t.putInt(d).putInt(1).putInt(m).putInt(1).putInt(sec).putInt(1_000_000)}
        t.position(186);coordinate(f.latitude);coordinate(f.longitude);t.putInt((f.accuracyMeters*1000).toInt()).putInt(1000)
        val out=ByteArrayOutputStream()
        out.write(jpeg,0,2)
        fun segment(marker:Int,payload:ByteArray) {require(payload.size<65533);out.write(255);out.write(marker);out.write((payload.size+2) ushr 8);out.write((payload.size+2) and 255);out.write(payload)}
        segment(225,"Exif\u0000\u0000".toByteArray()+t.array())
        segment(239,"SP-INTEGRITY-1\u0000\u0000".toByteArray()+manifest.toString().toByteArray(Charsets.UTF_8))
        out.write(jpeg,2,jpeg.size-2)
        return out.toByteArray()
    }
}
