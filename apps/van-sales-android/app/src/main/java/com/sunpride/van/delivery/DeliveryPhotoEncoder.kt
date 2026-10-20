package com.sunpride.van.delivery

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import androidx.core.graphics.scale
import com.sunpride.van.evidence.BoundedJpeg
import com.sunpride.van.evidence.DamageCapture
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** F-303 SEAM(INTEGRITY): visible pixels are burned at the final encoded size BEFORE digest and private storage. */
object DeliveryPhotoEncoder {
    fun encode(capture: DamageCapture, watermark: JSONObject, actor: String, outlet: String, maxBytes: Int = 90_000): ByteArray {
        val bounds=BitmapFactory.Options().apply { inJustDecodeBounds=true }
        BitmapFactory.decodeByteArray(capture.jpeg,0,capture.jpeg.size,bounds)
        require(bounds.outWidth>0 && bounds.outHeight>0)
        var sample=1
        while(maxOf(bounds.outWidth,bounds.outHeight)/sample>2048) sample*=2
        val decoded=checkNotNull(BitmapFactory.decodeByteArray(capture.jpeg,0,capture.jpeg.size,BitmapFactory.Options().apply { inSampleSize=sample }))
        val oriented=if(capture.rotationDegrees==0) decoded else Bitmap.createBitmap(decoded,0,0,decoded.width,decoded.height,Matrix().apply {postRotate(capture.rotationDegrees.toFloat())},true)
        val time=DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss 'Manila'").withZone(ZoneId.of("Asia/Manila")).format(Instant.ofEpochMilli(watermark.getLong("capturedAt")))
        val lines=listOf("DELIVERY · ${outlet.take(50)}", "${actor.take(50)} · $time", "GPS %.5f, %.5f".format(java.util.Locale.US,watermark.getDouble("latitude"),watermark.getDouble("longitude")))
        try {
            return BoundedJpeg.encode(oriented.width,oriented.height,maxBytes) { w,h,q ->
                require(w>=240 && h>=180) { "Photo cannot retain a readable watermark at this size." }
                val scaled=oriented.scale(w,h,true)
                val output=scaled.copy(Bitmap.Config.ARGB_8888,true)
                try {
                    val canvas=Canvas(output);val paint=Paint(Paint.ANTI_ALIAS_FLAG)
                    val textSize=maxOf(10f,w/50f);val lineHeight=textSize*1.45f
                    paint.color=Color.BLACK;canvas.drawRect(0f,h-lineHeight*3-12,w.toFloat(),h.toFloat(),paint)
                    paint.color=Color.WHITE;paint.textSize=textSize
                    lines.forEachIndexed { i,line -> canvas.drawText(line,6f,h-lineHeight*(2-i)-8,paint) }
                    ByteArrayOutputStream().use { out -> check(output.compress(Bitmap.CompressFormat.JPEG,q,out));out.toByteArray() }
                } finally {output.recycle();if(scaled!==oriented)scaled.recycle()}
            }
        } finally {if(oriented!==decoded)oriented.recycle();decoded.recycle()}
    }
}
