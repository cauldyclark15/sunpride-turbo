package com.sunpride.field.retail

import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer

class EquipmentBarcodeDecoderTest {
    @Test fun F315_offlineQrAndCode128PreserveTheExactSerial() {
        for(format in listOf(BarcodeFormat.QR_CODE,BarcodeFormat.CODE_128)) {
            val serial="SAMPLE-FR-000123";val bits=MultiFormatWriter().encode(serial,format,320,160)
            val pixels=ByteArray(bits.width*bits.height){i->if(bits[i%bits.width,i/bits.width])0 else 255.toByte()}
            assertEquals(serial,EquipmentBarcodeDecoder().decode(pixels,bits.width,bits.height))
            val rotated=ByteArray(pixels.size)
            for(y in 0 until bits.height)for(x in 0 until bits.width)rotated[x*bits.height+bits.height-1-y]=pixels[y*bits.width+x]
            assertEquals(serial,EquipmentBarcodeDecoder().decode(rotated,bits.height,bits.width))
        }
    }
    @Test fun F315_cameraPaddingAndPixelStrideDoNotInventCharacters() {
        val source=ByteBuffer.wrap(byteArrayOf(99,1,88,2,88,3,88,4,88,77,77));source.position(1)
        assertArrayEquals(byteArrayOf(1,2,3,4),EquipmentBarcodeDecoder.pack(source,2,2,4,2))
        assertNull(EquipmentBarcodeDecoder().decode(ByteArray(320*160){255.toByte()},320,160))
    }
}
