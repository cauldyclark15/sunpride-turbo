package com.sunpride.van.scanning

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer

/** Pure decoder shared with unit tests. Input is a tightly packed Y plane, not an NV21 guess. */
class CameraBarcodeDecoder {
    private val reader = MultiFormatReader().apply {
        setHints(mapOf(
            DecodeHintType.POSSIBLE_FORMATS to listOf(
                BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A,
                BarcodeFormat.UPC_E, BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE,
            ),
            DecodeHintType.TRY_HARDER to true,
        ))
    }
    fun decode(luminance: ByteArray, width: Int, height: Int): String? {
        require(width > 0 && height > 0 && luminance.size >= width * height)
        val source = PlanarYUVLuminanceSource(luminance, width, height, 0, 0, width, height, false)
        return try { reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text }
        catch (_: NotFoundException) { null }
        finally { reader.reset() }
    }
    companion object {
        /** CameraX may pad rows or interleave pixels. Respect BOTH strides and buffer position. */
        fun packLuminance(buffer: java.nio.ByteBuffer, width: Int, height: Int, rowStride: Int, pixelStride: Int): ByteArray {
            val data = buffer.duplicate()
            val start = data.position()
            return ByteArray(width * height) { index ->
                data.get(start + (index / width) * rowStride + (index % width) * pixelStride)
            }
        }
        fun rotateClockwise(data: ByteArray, width: Int, height: Int): ByteArray =
            ByteArray(data.size).also { rotated ->
                for (y in 0 until height) for (x in 0 until width) rotated[x * height + height - 1 - y] = data[y * width + x]
            }
    }
}
