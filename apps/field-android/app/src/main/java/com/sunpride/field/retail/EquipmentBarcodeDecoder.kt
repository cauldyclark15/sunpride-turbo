package com.sunpride.field.retail

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import java.nio.ByteBuffer

/** F-315: offline serial decoding, following the existing van CameraX luminance boundary. */
class EquipmentBarcodeDecoder {
    private val reader=MultiFormatReader().apply { setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(
        BarcodeFormat.CODE_128,BarcodeFormat.CODE_39,BarcodeFormat.QR_CODE,BarcodeFormat.DATA_MATRIX,BarcodeFormat.EAN_13,BarcodeFormat.EAN_8))) }
    fun decode(data:ByteArray,width:Int,height:Int):String? {
        val first=read(data,width,height)
        if(first!=null)return first
        val rotated=ByteArray(width*height)
        for(y in 0 until height) for(x in 0 until width) rotated[x*height+height-1-y]=data[y*width+x]
        return read(rotated,height,width)
    }
    private fun read(data:ByteArray,width:Int,height:Int):String? {
        require(width>0&&height>0&&data.size>=width*height)
        return try { reader.decodeWithState(BinaryBitmap(HybridBinarizer(PlanarYUVLuminanceSource(data,width,height,0,0,width,height,false)))).text }
        catch(_:ReaderException){null}finally{reader.reset()}
    }
    companion object {
        fun pack(buffer:ByteBuffer,width:Int,height:Int,rowStride:Int,pixelStride:Int):ByteArray {
            val bytes=buffer.duplicate();val start=bytes.position()
            return ByteArray(width*height){i->bytes.get(start+(i/width)*rowStride+(i%width)*pixelStride)}
        }
    }
}
