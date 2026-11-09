package com.sunpride.catalogue

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.math.BigDecimal

/** Renders the month-targets card for review screenshots (emulator only). */
@RunWith(AndroidJUnit4::class)
class TargetProgressShotsTest {
    @get:Rule val ui=createComposeRule()
    companion object {
        fun m(metric:String,label:String,unit:String,target:Long?,actual:Long?,prior:Long?,status:String,code:String="")=
            TargetMeasure(metric,label,unit,target?.let(::BigDecimal),actual?.let(::BigDecimal),prior?.let(::BigDecimal),target?.let{BigDecimal(it*2/3)},status,
                if(target==null)"Ask the office to publish your personal allocation" else "Review the next planned store and held orders",if(target==null)null else "Office plan")
        const val DEF="Approved orders and accepted van sales before returns; product volume in governed base units. Calls are completed visits / recorded van departures. Missing MSL assessment remains unknown. Pending phone work is not yet an office actual."
        fun data(rows:List<TargetMeasure>)=TargetProgress("profile","2026-11","2026-11-09",Long.MAX_VALUE,DEF,rows)
        val notSet=data(listOf(
            m("sales_value","Sales value","centavos",null,0,35489551,"not_set"),
            m("coverage_stores","Buying stores","stores",null,0,41,"not_set"),
            m("distribution_points","Distribution points","store-SKU points",null,0,212,"not_set"),
            m("calls","Calls","calls",null,0,96,"not_set"),
            m("msl_compliance","MSL compliance","basis points",null,null,null,"unknown"),
            m("volume","Sales volume · Sunpride Banana Chips 100g","EA",null,0,480,"not_set","SKU-1")))
        val someSet=data(listOf(
            m("sales_value","Sales value","centavos",50000000,12345600,35489551,"behind"),
            m("coverage_stores","Buying stores","stores",60,22,41,"on_pace"),
            m("distribution_points","Distribution points","store-SKU points",null,140,212,"not_set"),
            m("calls","Calls","calls",null,38,96,"not_set"),
            m("msl_compliance","MSL compliance","basis points",null,null,null,"unknown"),
            m("volume","Sales volume · Sunpride Banana Chips 100g","EA",null,120,480,"not_set","SKU-1")))
        val allSet=data(listOf(
            m("sales_value","Sales value","centavos",50000000,41000000,35489551,"on_pace"),
            m("coverage_stores","Buying stores","stores",60,31,41,"behind"),
            m("distribution_points","Distribution points","store-SKU points",250,230,212,"on_target"),
            m("calls","Calls","calls",120,70,96,"behind"),
            m("msl_compliance","MSL compliance","basis points",9000,9200,null,"on_target"),
            m("volume","Sales volume · Sunpride Banana Chips 100g","EA",600,350,480,"behind","SKU-1")))
    }
    private fun shot(name:String,view:TargetProgressView,width:Int,font:Float=1f){
        val state=mutableStateOf(view)
        ui.setContent{
            val d=LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(d.density,font)){
                MaterialTheme{Box(Modifier.width(width.dp)){TargetProgressCard(state.value)}}
            }
        }
        ui.waitForIdle()
        val bmp=ui.onNodeWithTag("month-targets").captureToImage().asAndroidBitmap()
        val dir=File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null),"targets-card").apply{mkdirs()}
        File(dir,"$name-${width}dp${if(font!=1f)"-large" else ""}.png").outputStream().use{bmp.compress(Bitmap.CompressFormat.PNG,100,it)}
    }
    @Test fun notSet360()=shot("all-not-set",TargetProgressView(notSet),360)
    @Test fun notSet411()=shot("all-not-set",TargetProgressView(notSet),411)
    @Test fun someSet360()=shot("some-set",TargetProgressView(someSet),360)
    @Test fun someSet411()=shot("some-set",TargetProgressView(someSet),411)
    @Test fun allSet360()=shot("behind-on-track",TargetProgressView(allSet),360)
    @Test fun allSet411()=shot("behind-on-track",TargetProgressView(allSet),411)
    @Test fun largeText360()=shot("some-set",TargetProgressView(someSet),360,1.3f)
}
