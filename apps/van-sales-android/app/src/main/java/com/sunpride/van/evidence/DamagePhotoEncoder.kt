package com.sunpride.van.evidence

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.core.graphics.scale
import java.io.ByteArrayOutputStream

data class DamageCapture(val jpeg: ByteArray, val rotationDegrees: Int = 0)
object DamagePhotoEncoder {
    fun compress(capture: DamageCapture, maxBytes: Int): ByteArray {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(capture.jpeg,0,capture.jpeg.size,bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0)
        var sample = 1
        while (maxOf(bounds.outWidth,bounds.outHeight) / sample > 2048) sample *= 2
        val decoded = checkNotNull(BitmapFactory.decodeByteArray(capture.jpeg,0,capture.jpeg.size,
            BitmapFactory.Options().apply { inSampleSize = sample }))
        val bitmap = if (capture.rotationDegrees == 0) decoded else Bitmap.createBitmap(decoded,0,0,decoded.width,decoded.height,
            Matrix().apply { postRotate(capture.rotationDegrees.toFloat()) },true)
        try {
            return BoundedJpeg.encode(bitmap.width,bitmap.height,maxBytes) { w,h,quality ->
                val scaled = bitmap.scale(w,h,true)
                try { ByteArrayOutputStream().use { out -> check(scaled.compress(Bitmap.CompressFormat.JPEG,quality,out)); out.toByteArray() } }
                finally { if (scaled !== bitmap) scaled.recycle() }
            }
        } finally { if (bitmap !== decoded) bitmap.recycle(); decoded.recycle() }
    }
}
