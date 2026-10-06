package com.sunpride.van.scanning

import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test

class CameraBarcodeDecoderTest {
    @Test fun decodesRealZxingQrAndCode128() {
        for (format in listOf(BarcodeFormat.QR_CODE, BarcodeFormat.CODE_128)) {
            val code = "SUNPRIDE-VAN-TEST"
            val matrix = MultiFormatWriter().encode(code, format, 384, 240)
            val bytes = ByteArray(matrix.width * matrix.height) { i -> if (matrix[i % matrix.width, i / matrix.width]) 0 else 255.toByte() }
            assertEquals(code, CameraBarcodeDecoder().decode(bytes, matrix.width, matrix.height))
        }
    }
    @Test fun extractsYPlaneWithRowAndPixelStrideAndPosition() {
        val data = ByteBuffer.wrap(byteArrayOf(99, 1, 0, 2, 0, 88, 3, 0, 4, 0))
        data.position(1)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), CameraBarcodeDecoder.packLuminance(data, 2, 2, 5, 2))
    }
    @Test fun rotatesLuminanceWithoutDroppingPixels() {
        assertArrayEquals(byteArrayOf(4, 1, 5, 2, 6, 3), CameraBarcodeDecoder.rotateClockwise(byteArrayOf(1, 2, 3, 4, 5, 6), 3, 2))
    }
    @Test fun blankFrameDoesNotEmit() { assertNull(CameraBarcodeDecoder().decode(ByteArray(10000) { 255.toByte() }, 100, 100)) }
}
